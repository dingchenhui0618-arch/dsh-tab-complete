// Host half of dsh-tab-complete.
//
// One HTTP route, deliberately hand-rolled like the other local DSH plugins:
//
//   GET  /dsh-tab-complete/state    -> config + counters (panel/debug)
//   POST /dsh-tab-complete/suggest  -> { sessionId, draft } => { completion }
//   POST /dsh-tab-complete/enabled  -> { enabled } in-memory switch
//   GET  /dsh-tab-complete/style    -> accepted suggestions used as examples
//   POST /dsh-tab-complete/style    -> { text } remember one, { clear } forget
//
// Everything is soft-read through `ctx.get(...)` so the plugin still loads on a
// host without `llm` or `webServer`; the client half simply gets no completion.
//
// Security: the suggestion endpoint spends model tokens, so it only answers
// loopback callers and only for a draft small enough to be a draft.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  DEFAULT_CONFIG,
  NAME,
  ROUTE,
  VERSION,
  buildPrompt,
  normalizeConfig,
  normalizeExample,
  sanitizeCompletion,
  sanitizePartial,
  textOfContent,
  transcriptOf,
  transcriptOfMessages,
  echoesAssistant,
} from './core.js'

export const name = NAME
export const inject = ['webServer']

const MAX_BODY = 64 * 1024
const MAX_DRAFT = 4000
const CACHE_LIMIT = 64
const CACHE_TTL_MS = 2 * 60 * 1000
const MISS_TTL_MS = 20 * 1000
const MIN_INTERVAL_MS = 120

/**
 * Accepted suggestions, kept beside the other DSH state. They are the user's
 * own sentences, so this stays a local file and is never sent anywhere except
 * back into the prompt that produced it.
 */
const STYLE_LIMIT = 40
const stylePath = join(homedir(), '.dsh', 'tab-complete-style.json')

function loadStyle() {
  try {
    const raw = JSON.parse(readFileSync(stylePath, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeExample).filter(function (entry) { return entry.length > 0 }).slice(-STYLE_LIMIT)
  } catch (error) {
    return []
  }
}

function wantsStream(req) {
  const accept = req.headers !== undefined ? req.headers.accept : undefined
  return typeof accept === 'string' && accept.indexOf('text/event-stream') !== -1
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    let failed = false
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) {
        failed = true
        req.destroy()
      }
    })
    req.on('end', function () {
      if (failed) return resolve({})
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

/** Method tail of the URL below ROUTE, e.g. `/dsh-tab-complete/suggest` -> `suggest`. */
function tailOf(url) {
  const path = String(url || '').split('?')[0]
  return path.replace(new RegExp('^' + ROUTE + '/?'), '') || 'state'
}

/** Value of one query parameter, decoded, or '' when absent. */
function queryOf(url, key) {
  const raw = String(url || '')
  const mark = raw.indexOf('?')
  if (mark === -1) return ''
  const pairs = raw.slice(mark + 1).split('&')
  for (const pair of pairs) {
    const split = pair.indexOf('=')
    const name = split === -1 ? pair : pair.slice(0, split)
    if (name !== key) continue
    const value = split === -1 ? '' : pair.slice(split + 1)
    try {
      return decodeURIComponent(value)
    } catch (error) {
      return value
    }
  }
  return ''
}

/** Loopback only: this endpoint spends money, so it is not a LAN service. */function isLoopback(req) {
  const address = req.socket === undefined || req.socket === null ? '' : String(req.socket.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  const state = {
    enabled: config.enabled,
    requests: 0,
    completions: 0,
    empty: 0,
    failures: 0,
    calls: 0,
    cacheHits: 0,
    lastMs: 0,
    lastError: '',
    lastReason: '',
    lastTranscript: 0,
    lastSession: '',
    lastProvider: '',
    lastModel: '',
    lastWorkspace: '',
  }

  const cache = new Map()
  const misses = new Map()
  const inflight = new Map()
  let lastCallAt = 0
  let examples = loadStyle()
  let saveTimer = 0

  /** Remember one accepted suggestion; returns whether it was new. */
  function rememberExample(text) {
    const clean = normalizeExample(text)
    if (clean.length === 0) return false
    if (examples[examples.length - 1] === clean) return false
    examples = examples.filter(function (entry) { return entry !== clean }).concat(clean).slice(-STYLE_LIMIT)
    if (saveTimer !== 0) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      saveTimer = 0
      try {
        writeFileSync(stylePath, JSON.stringify(examples), 'utf8')
      } catch (error) {
        // A read-only home is not worth failing a suggestion over.
      }
    }, 1500)
    return true
  }

  function safeGet(key) {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
      return value === undefined || value === null ? undefined : value
    } catch (error) {
      return undefined
    }
  }

  /** The model route: explicit config first, otherwise the session default. */
  function resolveRoute() {
    if (config.provider.length > 0 && config.model.length > 0) {
      return { provider: config.provider, model: config.model }
    }
    const owner = safeGet('agentDefaultModel')
    if (owner !== undefined && typeof owner.currentSelection === 'function') {
      try {
        const selection = owner.currentSelection()
        if (selection !== undefined && selection !== null && typeof selection.provider === 'string' && typeof selection.model === 'string') {
          return { provider: selection.provider, model: selection.model }
        }
      } catch (error) {
        // fall through
      }
    }
    return undefined
  }

  /** Recent conversation tail of one live session, or [] when unavailable. */
  function liveSession(sessionId) {
    if (sessionId.length === 0) return undefined
    const sessions = safeGet('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      const session = sessions.get(sessionId)
      if (session === undefined || session === null || !Array.isArray(session.log)) return undefined
      return session
    } catch (error) {
      return undefined
    }
  }

  /**
   * Route for one call: an explicit provider+model wins (experiments, replay),
   * otherwise the configured pair, otherwise the agent's default selection.
   */
  function routeFor(provider, model) {
    if (provider.length > 0 && model.length > 0) return { provider: provider, model: model }
    return resolveRoute()
  }

  /** Recent conversation tail of one live session, or [] when unavailable. */
  function transcriptFor(sessionId) {
    const session = liveSession(sessionId)
    if (session === undefined) return []
    const options = { maxMessages: config.contextMessages, maxChars: config.contextChars }
    // `deriveMessages()` is the live projected history; the raw log is the
    // fallback for hosts whose session objects are event-only.
    if (typeof session.deriveMessages === 'function') {
      try {
        const transcript = transcriptOfMessages(session.deriveMessages(), options)
        if (transcript.length > 0) return transcript
      } catch (error) {
        // fall through to the event log
      }
    }
    return transcriptOf(session.log, options)
  }

  /** Directory the session belongs to, when the host exposes it. */
  function workspaceOf(session) {
    if (session === null || typeof session !== 'object') return ''
    const candidates = [
      session.cwd,
      session.meta !== null && typeof session.meta === 'object' ? session.meta.cwd : undefined,
      session.header !== null && typeof session.header === 'object' ? session.header.cwd : undefined,
      session.info !== null && typeof session.info === 'object' ? session.info.cwd : undefined,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }

  /**
   * One line about the working directory. Predicting "改一下 src/plugins"
   * when the project has no such directory is the failure mode this fixes:
   * the model needs the real top-level names to anchor on.
   */
  function workspaceHint(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return ''
    let entries = []
    try {
      entries = readdirSync(cwd, { withFileTypes: true }).filter(function (entry) {
        return entry.name.charAt(0) !== '.' && entry.name !== 'node_modules'
      })
    } catch (error) {
      return ''
    }
    // A directory with this many children is a container of projects, not the
    // project: naming it would just anchor the model on the wrong thing.
    if (entries.length === 0 || entries.length > 30) return ''
    const names = entries.slice(0, 12).map(function (entry) {
      return entry.isDirectory() ? entry.name + '/' : entry.name
    })
    return basename(cwd) + '：' + names.join('  ')
  }

  /** Last few event types, so an empty suggestion can be diagnosed. */  function eventTypes(sessionId) {
    const session = liveSession(sessionId)
    if (session === undefined) return []
    return session.log.slice(-8).map(function (event) {
      return event !== null && typeof event === 'object' && typeof event.type === 'string' ? event.type : '?'
    })
  }

  /** Shape of the last few derived messages, for the same reason. */
  function messageDigest(sessionId) {
    const session = liveSession(sessionId)
    if (session === undefined || typeof session.deriveMessages !== 'function') return null
    try {
      const messages = session.deriveMessages()
      return messages.slice(-3).map(function (message) {
        const content = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
        return {
          role: message !== null && typeof message === 'object' ? String(message.role) : '?',
          blocks: content.map(function (block) {
            return block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : '?'
          }),
          text: textOfContent(content).slice(0, 60),
        }
      })
    } catch (error) {
      return String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error)
    }
  }

  function cacheGet(key) {
    const hit = cache.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key)
      return undefined
    }
    return hit.completion
  }

  function cachePut(key, completion) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: Date.now(), completion: completion })
  }

  function missGet(key) {
    const hit = misses.get(key)
    if (hit === undefined) return false
    if (Date.now() - hit > MISS_TTL_MS) {
      misses.delete(key)
      return false
    }
    return true
  }

  function missPut(key) {
    if (misses.size >= CACHE_LIMIT) {
      const oldest = misses.keys().next()
      if (!oldest.done) misses.delete(oldest.value)
    }
    misses.set(key, Date.now())
  }

  /**
   * One model call. Kept separate from the route so a future tool/CLI can reuse
   * exactly the same prompt and sanitising.
   * @returns {Promise<{ completion: string, raw: string }>}
   */
  async function complete(input, onDelta) {    const llm = safeGet('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('宿主没有可用的 llm 服务')
    }
    const route = routeFor(asText(input.provider), asText(input.model))
    if (route === undefined) throw new Error('没有可用的默认模型')

    const prompt = buildPrompt({ transcript: input.transcript, draft: input.draft, workspace: input.workspace, examples: examples })
    // Experiment hook (loopback replay only): let a caller swap the prompt and
    // the sampling knobs so a variant can be measured without a rebuild.
    if (asText(input.system).length > 0) prompt.system = input.system
    if (asText(input.user).length > 0) prompt.user = input.user
    // `raw` sends the user text exactly as given, with no completion framing:
    // that is how an offline judge call is expressed.
    const rawPrompt = input.raw === true
    const maxTokens = Number.isInteger(input.maxTokens) ? input.maxTokens : config.maxTokens
    const controller = new AbortController()
    const timer = setTimeout(function () {
      controller.abort()
    }, config.timeoutMs)

    let raw = ''
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        temperature: config.temperature,
        maxTokens: maxTokens,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          const piece = typeof chunk.text === 'string' ? chunk.text : ''
          if (piece.length > 0) {
            raw += piece
            if (typeof onDelta === 'function') onDelta(raw)
          }
        } else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object' && chunk.reason.kind === 'error') {
          const failure = chunk.reason.failure
          throw new Error(failure !== undefined && typeof failure.message === 'string' ? failure.message : '模型调用失败')
        }
      }
    } finally {
      clearTimeout(timer)
    }

    state.calls += 1
    state.lastProvider = route.provider
    state.lastModel = route.model
    // A judge reply is not a completion: no draft de-duplication, no length cap.
    if (rawPrompt) return { raw: raw, completion: raw.trim() }
    return { raw: raw, completion: sanitizeCompletion(raw, input.draft, config.maxCompletionChars, { suppressSteps: config.suppressSteps }) || '' }
  }

  async function suggest(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'post-only' })

    const body = await readBody(req)
    const sessionId = asText(body.sessionId)
    const draft = asText(body.draft)

    // A prediction that arrives in one lump is a prediction the user has
    // already outtyped. Stream the deltas and let the ghost grow with them.
    let sse = null
    if (wantsStream(req)) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      let closed = false
      res.on('close', function () {
        closed = true
      })
      sse = {
        event: function (payload) {
          if (closed) return
          try {
            res.write('data: ' + JSON.stringify(payload) + '\n\n')
          } catch (error) {
            closed = true
          }
        },
        end: function () {
          if (closed) return
          closed = true
          try {
            res.end()
          } catch (error) {
            // ignore
          }
        },
      }
    }

    function out(payload) {
      if (sse === null) return sendJson(res, 200, payload)
      sse.event(payload)
      sse.end()
      return undefined
    }

    state.requests += 1
    state.lastSession = sessionId
    if (!state.enabled) return out({ ok: false, reason: 'disabled' })
    if (draft.length > MAX_DRAFT) return out({ ok: false, reason: 'draft-too-long' })
    if (draft.length < config.minDraftChars) return out({ ok: false, reason: 'draft-too-short' })

    const started = Date.now()
    const transcript = transcriptFor(sessionId)
    const live = liveSession(sessionId)
    const workspace = workspaceHint(workspaceOf(live))
    state.lastWorkspace = workspace
    state.lastTranscript = transcript.length
    // An empty composer is only worth guessing at once there is something to
    // guess *from*.
    if (draft.trim().length === 0 && transcript.length === 0) {
      state.empty += 1
      state.lastReason = 'no-context'
      return out({ ok: false, reason: 'no-context', types: eventTypes(sessionId), messages: messageDigest(sessionId) })
    }

    const key = sessionId + '\u0000' + draft
    const cached = cacheGet(key)
    if (cached !== undefined) {
      state.cacheHits += 1
      state.completions += 1
      return out({
        ok: true,
        completion: cached,
        cached: true,
        ms: Date.now() - started,
      })
    }
    // A miss is worth remembering too: the client re-asks when the composer is
    // empty, and "the model had nothing" must not cost a call every few seconds.
    if (missGet(key)) {
      state.empty += 1
      state.lastReason = 'miss'
      return out({ ok: false, reason: 'miss', cached: true })
    }

    // One in-flight call per session: a stale request must not race the fresh one.
    const previous = inflight.get(sessionId)
    if (previous !== undefined) {
      try {
        previous.abort()
      } catch (error) {
        // ignore
      }
    }
    const gate = new AbortController()
    inflight.set(sessionId, gate)

    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt))
    if (wait > 0) await new Promise(function (resolve) { setTimeout(resolve, wait) })
    lastCallAt = Date.now()

    let shown = ''
    function onDelta(text) {
      if (sse === null) return
      const partial = sanitizePartial(text, config.maxCompletionChars, { suppressSteps: config.suppressSteps, draft: draft })
      if (partial.length === 0 || partial === shown) return
      shown = partial
      sse.event({ delta: partial })
    }

    try {
      const result = await Promise.race([
        complete({ draft: draft, transcript: transcript, workspace: workspace }, onDelta),
        new Promise(function (_resolve, reject) {
          gate.signal.addEventListener('abort', function () {
            reject(new Error('aborted'))
          })
        }),
      ])
      if (!result.completion) {
        missPut(key)
        state.empty += 1
        state.lastReason = 'empty'
        return out({ ok: false, reason: 'empty', raw: result.raw.slice(0, 200), types: eventTypes(sessionId), messages: messageDigest(sessionId) })
      }
      if (draft.trim().length === 0 && echoesAssistant(result.completion, transcript)) {
        // The model summarised the assistant instead of predicting the user.
        missPut(key)
        state.empty += 1
        state.lastReason = 'echo'
        return out({ ok: false, reason: 'echo', raw: result.raw.slice(0, 200) })
      }
      cachePut(key, result.completion)
      state.completions += 1
      state.lastMs = Date.now() - started
      state.lastError = ''
      state.lastReason = ''
      return out({
        ok: true,
        completion: result.completion,
        ms: state.lastMs,
        provider: state.lastProvider,
        model: state.lastModel,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'aborted') return out({ ok: false, reason: 'aborted' })
      state.failures += 1
      state.lastError = message
      return out({ ok: false, reason: 'error', error: message })
    } finally {
      if (inflight.get(sessionId) === gate) inflight.delete(sessionId)
    }
  }

  function describe() {    return {
      ok: true,
      plugin: { name: NAME, version: VERSION },
      config: {
        enabled: state.enabled,
        debounceMs: config.debounceMs,
        minDraftChars: config.minDraftChars,
        maxTokens: config.maxTokens,
        maxCompletionChars: config.maxCompletionChars,
        contextMessages: config.contextMessages,
        provider: config.provider,
        model: config.model,
      },
      stats: Object.assign({}, state),
    }
  }

  ctx.effect(function () {
    const webServer = safeGet('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return function () {}

    let dispose
    try {
      dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async function (req, res) {
          try {
            const tail = tailOf(req.url)
            if (tail === 'state') {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                return sendJson(res, 405, { ok: false, reason: 'get-only' })
              }
              return sendJson(res, 200, describe())
            }
            if (tail === 'enabled') {
              if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
              if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'post-only' })
              const body = await readBody(req)
              if (typeof body.enabled === 'boolean') state.enabled = body.enabled
              return sendJson(res, 200, describe())
            }
            if (tail === 'prompt') {
              if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
              const sessionId = queryOf(req.url, 'sessionId')
              const draft = queryOf(req.url, 'draft')
              const workspace = workspaceHint(workspaceOf(liveSession(sessionId)))
              const prompt = buildPrompt({ transcript: transcriptFor(sessionId), draft: draft, workspace: workspace })
              return sendJson(res, 200, { ok: true, sessionId: sessionId, draft: draft, workspace: workspace, prompt: prompt })
            }
            if (tail === 'style') {
              if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
              if (req.method === 'GET') return sendJson(res, 200, { ok: true, examples: examples })
              if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'post-only' })
              const body = await readBody(req)
              if (body.clear === true) {
                examples = []
                try {
                  writeFileSync(stylePath, '[]', 'utf8')
                } catch (error) {
                  // ignore
                }
                return sendJson(res, 200, { ok: true, cleared: true })
              }
              const stored = rememberExample(asText(body.text))
              return sendJson(res, 200, { ok: true, stored: stored, count: examples.length })
            }
            if (tail === 'replay') {
              // Offline evaluation: same prompt, same sanitiser, but the
              // transcript is supplied instead of read from a live session.
              // Loopback only — it spends money just like /suggest.
              if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
              if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'post-only' })
              const body = await readBody(req)
              const messages = Array.isArray(body.messages) ? body.messages : []
              const draft = asText(body.draft)
              const started = Date.now()
              const result = await complete({
                draft: draft,
                transcript: messages,
                workspace: asText(body.workspace),
                provider: asText(body.provider),
                model: asText(body.model),
                system: asText(body.system),
                user: asText(body.user),
                raw: body.raw === true,
                maxTokens: Number.isInteger(body.maxTokens) ? body.maxTokens : undefined,
              })
              return sendJson(res, 200, {
                ok: true,
                completion: result.completion,
                provider: state.lastProvider,
                model: state.lastModel,
                ms: Date.now() - started,
              })
            }
            if (tail === 'suggest') return await suggest(req, res)
            if (tail === 'transcript') {
              if (!isLoopback(req)) return sendJson(res, 403, { ok: false, reason: 'loopback-only' })
              const sessionId = queryOf(req.url, 'sessionId')
              const transcript = transcriptFor(sessionId)
              const workspace = workspaceHint(workspaceOf(liveSession(sessionId)))
              return sendJson(res, 200, {
                ok: true,
                sessionId: sessionId,
                workspace: workspace,
                messages: transcript.length,
                chars: transcript.reduce(function (total, entry) { return total + entry.text.length }, 0),
                transcript: transcript,
                digest: messageDigest(sessionId),
                events: eventTypes(sessionId),
              })
            }
            return sendJson(res, 404, { ok: false, reason: 'unknown-method' })
          } catch (error) {
            state.failures += 1
            const message = error instanceof Error ? error.message : String(error)
            state.lastError = message
            sendJson(res, 500, { ok: false, reason: 'error', error: message })
          }
        },
      })
    } catch (error) {
      dispose = undefined
      state.lastError = error instanceof Error ? error.message : String(error)
    }
    return function () {
      if (typeof dispose === 'function') dispose()
    }
  })

  return {
    config: Object.assign({}, config, { enabled: state.enabled }),
    defaults: DEFAULT_CONFIG,
  }
}

