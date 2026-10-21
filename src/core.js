// Pure helpers for dsh-tab-complete.
//
// Everything here is deterministic and dependency-free so the host route, the
// unit tests and (conceptually) any future CLI can share one implementation:
//   - config normalisation,
//   - session-log -> compact transcript,
//   - prompt assembly,
//   - completion sanitising and caret joining.

export const NAME = 'dsh-tab-complete'
export const VERSION = '0.1.0'
export const ROUTE = '/dsh-tab-complete'

/** Every knob the plugin owns, with the shipped defaults. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; false turns the route into a cheap no-op. */
  enabled: true,
  /** Idle time after the last keystroke before asking for a completion. */
  debounceMs: 550,
  /** Empty composer is allowed; the host requires *some* conversation first. */
  minDraftChars: 0,
  /** Reply budget. A tab completion must stay short to feel instant. */
  maxTokens: 48,
  temperature: 0.3,
  /** Hard ceiling for one suggestion, in characters. */
  maxCompletionChars: 120,
  /** Conversation tail fed to the model. */
  contextMessages: 8,
  contextChars: 2400,
  /** Request timeout. */
  timeoutMs: 9000,
  /** Optional explicit route; empty means "the session default model". */
  provider: '',
  model: '',
})

function pickNumber(raw, key, min, max) {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG[key]
  return Math.min(max, Math.max(min, value))
}

function pickBoolean(raw, key) {
  const value = raw[key]
  return typeof value === 'boolean' ? value : DEFAULT_CONFIG[key]
}

function pickString(raw, key) {
  const value = raw[key]
  return typeof value === 'string' ? value.trim() : DEFAULT_CONFIG[key]
}

/**
 * Coerce the loader-supplied config object into the full shape.
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return Object.freeze({
    enabled: pickBoolean(input, 'enabled'),
    debounceMs: pickNumber(input, 'debounceMs', 150, 5000),
    minDraftChars: pickNumber(input, 'minDraftChars', 0, 200),
    maxTokens: pickNumber(input, 'maxTokens', 8, 512),
    temperature: pickNumber(input, 'temperature', 0, 2),
    maxCompletionChars: pickNumber(input, 'maxCompletionChars', 16, 600),
    contextMessages: pickNumber(input, 'contextMessages', 0, 40),
    contextChars: pickNumber(input, 'contextChars', 0, 20000),
    timeoutMs: pickNumber(input, 'timeoutMs', 1000, 60000),
    provider: pickString(input, 'provider'),
    model: pickString(input, 'model'),
  })
}

/**
 * Flatten one message's content blocks into plain text.
 * Reasoning and tool blocks are deliberately dropped: a completion should see
 * what the user saw, not the machinery behind it.
 * @param {unknown} content
 * @returns {string}
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Build a compact transcript from a session event log.
 *
 * Reads backwards from the newest event so a long session costs nothing, then
 * restores chronological order. Both budget limits apply; the oldest lines are
 * dropped first.
 * @param {readonly unknown[]} log
 * @param {{ maxMessages?: number, maxChars?: number }} [options]
 * @returns {{ role: 'user' | 'assistant', text: string }[]}
 */
export function transcriptOf(log, options) {
  const opts = options || {}
  const maxMessages = Number.isInteger(opts.maxMessages) ? opts.maxMessages : DEFAULT_CONFIG.contextMessages
  const maxChars = Number.isInteger(opts.maxChars) ? opts.maxChars : DEFAULT_CONFIG.contextChars
  if (!Array.isArray(log) || maxMessages <= 0 || maxChars <= 0) return []

  const collected = []
  for (let index = log.length - 1; index >= 0 && collected.length < maxMessages; index -= 1) {
    const event = log[index]
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
    const text = textOfContent(data === undefined ? undefined : data.content)
    if (text.length === 0) continue
    collected.push({ role: type === 'user/message' ? 'user' : 'assistant', text })
  }
  collected.reverse()
  return trimTranscript(collected, maxChars)
}

/**
 * Same transcript, built from `session.deriveMessages()` — the live, already
 * projected model history, which is what an open conversation actually holds.
 * @param {readonly unknown[]} messages
 * @param {{ maxMessages?: number, maxChars?: number }} [options]
 * @returns {{ role: 'user' | 'assistant', text: string }[]}
 */
export function transcriptOfMessages(messages, options) {
  const opts = options || {}
  const maxMessages = Number.isInteger(opts.maxMessages) ? opts.maxMessages : DEFAULT_CONFIG.contextMessages
  const maxChars = Number.isInteger(opts.maxChars) ? opts.maxChars : DEFAULT_CONFIG.contextChars
  if (!Array.isArray(messages) || maxMessages <= 0 || maxChars <= 0) return []

  const collected = []
  for (let index = messages.length - 1; index >= 0 && collected.length < maxMessages; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOfContent(message.content)
    if (text.length === 0) continue
    collected.push({ role: message.role, text })
  }
  collected.reverse()
  return trimTranscript(collected, maxChars)
}

/** Keep the newest messages that fit the character budget. */
function trimTranscript(collected, maxChars) {
  const trimmed = []
  let budget = maxChars
  for (let index = collected.length - 1; index >= 0; index -= 1) {
    const entry = collected[index]
    if (entry.text.length > budget) {
      if (trimmed.length === 0) {
        // Always keep a tail of the newest message, even when it alone is long.
        trimmed.unshift({ role: entry.role, text: entry.text.slice(-Math.max(200, Math.min(maxChars, 1200))) })
      }
      break
    }
    budget -= entry.text.length
    trimmed.unshift(entry)
  }
  return trimmed
}

/** The instruction the model receives as `system`. */
export const SYSTEM_PROMPT = [
  '你是输入框补全引擎，服务于一个正在和 AI 编程助手对话的用户。',
  '你的任务是预测用户接下来会在输入框里继续输入的文字。',
  '规则：',
  '1. 只输出「应当补在光标处」的文本本身，不要引号、不要解释、不要前缀、不要 Markdown。',
  '2. 不要重复用户已经输入的内容。',
  '3. 保持用户正在使用的语言；中英文混排按用户的习惯。',
  '4. 输入框为空时，预测用户下一句会说的话，像用户自己的口吻，不要写成助手口吻。',
  '5. 尽量简短：一行，不超过 40 个汉字或 25 个英文单词。',
  '6. 没有把握时输出空内容：不要输出任何字符，也不要写「空字符串」「无」「暂无」这类占位词。',
].join('\n')

function renderTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '（这是本次对话的第一条消息）'
  return transcript
    .map(function (entry) {
      const label = entry.role === 'user' ? '用户' : '助手'
      return label + '：' + entry.text.replace(/\s+/g, ' ').trim()
    })
    .join('\n')
}

/**
 * Assemble the one-shot chat request body.
 * @param {{ transcript?: readonly {role: string, text: string}[], draft: string }} input
 * @returns {{ system: string, user: string }}
 */
export function buildPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const draft = typeof input.draft === 'string' ? input.draft : ''
  const head = ['<对话历史>', renderTranscript(transcript), '</对话历史>', '']
  if (draft.trim().length === 0) {
    head.push('用户当前输入：<空>（用户准备开始新的一条消息）')
    head.push('请预测用户接下来会打出的下一条消息：用用户自己的口吻，第一人称，不要复述或总结助手刚说过的话。')
  } else {
    head.push('用户当前输入：' + draft)
    head.push('（光标在输入内容的末尾）')
  }
  head.push('')
  head.push('补全：')
  return { system: SYSTEM_PROMPT, user: head.join('\n') }
}

const LEADING_QUOTES = /^[`"'“”‘’「」『』《》]+/
const TRAILING_QUOTES = /[`"'“”‘’「」『』《》]+$/
const ONLY_PUNCTUATION = /^[\s。，、；：！？.,;:!?~`'"()（）[\]【】\-—_]+$/
/**
 * Models sometimes answer the "empty output" instruction literally. Those are
 * not completions, and pasting them into the composer would be an insult.
 */
const PLACEHOLDER_ANSWER = /^[（(【\[]?\s*(空字符串|空内容|空|无|暂无|没有|none|empty|n\/a|null|nothing)\s*[）)】\]]?$/i

/**
 * True when a "next prompt" is really the assistant's own last words repeated.
 * Given an empty composer there is nothing but the conversation to predict
 * from, and models happily summarise instead of predicting.
 * @param {string} completion
 * @param {readonly {role: string, text: string}[]} transcript
 * @returns {boolean}
 */
export function echoesAssistant(completion, transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return false
  let last = null
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]
    if (entry !== null && typeof entry === 'object' && entry.role === 'assistant' && typeof entry.text === 'string') {
      last = entry.text
      break
    }
  }
  if (last === null) return false
  const normalise = function (value) {
    return value.replace(/\s+/g, '').toLowerCase()
  }
  const candidate = normalise(completion)
  const source = normalise(last)
  if (candidate.length < 6) return false
  if (source.includes(candidate)) return true
  return source.length > 20 && candidate.includes(source.slice(0, 20))
}

/**
 * Turn one raw model reply into text that is safe to paste at the caret.
 * @param {unknown} raw
 * @param {string} draft the draft the request was built from
 * @param {number} [maxChars]
 * @returns {string | null}
 */
export function sanitizeCompletion(raw, draft, maxChars) {
  if (typeof raw !== 'string') return null
  const limit = Number.isInteger(maxChars) ? maxChars : DEFAULT_CONFIG.maxCompletionChars

  // One line only: a completion that opens a bullet list is a wrong answer,
  // not a long one.
  let text = raw.split(/\r?\n/)[0]
  text = text.replace(/^补全[:：]\s*/, '')
  text = text.trim()
  text = text.replace(LEADING_QUOTES, '').replace(TRAILING_QUOTES, '')
  text = text.trim()

  const base = typeof draft === 'string' ? draft : ''
  if (base.length > 0) {
    const trimmedBase = base.replace(/\s+$/, '')
    if (trimmedBase.length > 0 && text.startsWith(trimmedBase)) {
      text = text.slice(trimmedBase.length)
    }
  }

  text = text.trim()
  if (text.length === 0 || ONLY_PUNCTUATION.test(text)) return null
  if (PLACEHOLDER_ANSWER.test(text)) return null
  if (text.length > limit) {
    text = text.slice(0, limit)
    // Never leave half a surrogate pair behind.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    text = text.replace(/\s+\S*$/, '').trim()
  }
  return text.length === 0 ? null : text
}

/**
 * Decide what string to actually splice in at the caret.
 *
 * The model is told not to repeat the draft, but English still needs one
 * separating space when the caret sits right after a word character.
 * @param {string} before text already in the composer before the caret
 * @param {string} completion sanitised completion
 * @returns {string}
 */
export function joinCompletion(before, completion) {
  const text = typeof completion === 'string' ? completion : ''
  if (text.length === 0) return ''
  const base = typeof before === 'string' ? before : ''
  if (base.length === 0) return text
  if (/\s$/.test(base)) return text
  if (/^\s/.test(text)) return text
  if (/[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(text)) return ' ' + text
  return text
}
