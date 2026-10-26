/* dsh-tab-complete client bundle — generated from src/client.cjs */
window.__ModuleLoader__.load({
  id: "dsh-tab-complete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// Client half of dsh-tab-complete.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// What it does:
//   1. sits in the composer's `conversation.input.overlay` seat,
//   2. watches the draft through `useInput`, debounces, and asks the host route
//      for one prediction,
//   3. paints that prediction as dim ghost text at the caret,
//   4. captures Tab on the window (capture phase, so Lexical never sees it) and
//      commits the text through `inputActions.insertText` with a revision-checked
//      caret span.
//
// Nothing here talks to a model directly: the host owns credentials and the
// conversation transcript.

const React = require('react')
const h = React.createElement
const CSS = ".tc-layer{position:absolute;inset:0 0 auto;pointer-events:none;z-index:6}.tc-ghost{position:absolute;display:block;pointer-events:none;user-select:none;-webkit-user-select:none;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);opacity:.58;animation:tc-fade .16s ease-out both;}.tc-ghost .tc-kbd{display:inline-block;margin-left:6px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;font-family:inherit;font-size:10px;line-height:14px;letter-spacing:0;vertical-align:baseline;opacity:.85;}@keyframes tc-fade{from{opacity:0}to{opacity:.58}}/* The empty-composer ghost owns the placeholder line while it is visible. */[data-composer-card].tc-ghost-empty [class*=\"_placeholder\"]{opacity:0}@media (prefers-reduced-motion:reduce){.tc-ghost{animation:none}}"

const API = '/dsh-tab-complete'
const FALLBACK_DEBOUNCE_MS = 550

/**
 * Tell the host which sentence was just accepted. Fire and forget: a failed
 * report must never disturb the composer.
 * @param {string} text
 */
function rememberStyle(text) {
  try {
    fetch(API + '/style', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).catch(function () {})
  } catch (error) {
    // ignore: the style file is an optimisation, not a feature the user waits on
  }
}

const DEFAULT_STATE = {
  ready: false,
  enabled: false,
  debounceMs: FALLBACK_DEBOUNCE_MS,
  minDraftChars: 0,
}

/** Rectangle of a range, tolerant across engines. Width is kept: the right
 * edge is where the last glyph ends, which is the true caret position. */
function rectOf(range) {
  try {
    const rect = range.getBoundingClientRect()
    if (rect !== null && rect !== undefined && (rect.width > 0 || rect.height > 0)) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
  } catch (error) {
    // fall through
  }
  try {
    const rects = range.getClientRects()
    if (rects !== null && rects !== undefined && rects.length > 0) {
      const last = rects[rects.length - 1]
      return { left: last.left, top: last.top, width: last.width, height: last.height }
    }
  } catch (error) {
    // fall through
  }
  return null
}

/**
 * Collapsed caret at a character offset of the editor's plain text. `\n` in the
 * draft is a block boundary, not a text node, so this is only used for
 * single-line drafts; multi-line drafts measure from the last line's end.
 */
function pointAtOffset(editor, offset) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null)
  let remaining = Math.max(0, offset)
  let node = walker.nextNode()
  let target = null
  while (node !== null) {
    const length = node.textContent === null ? 0 : node.textContent.length
    if (remaining <= length) {
      target = { node: node, offset: remaining }
      break
    }
    remaining -= length
    target = { node: node, offset: length }
    node = walker.nextNode()
  }
  if (target === null) return null
  const range = document.createRange()
  range.setStart(target.node, target.offset)
  range.collapse(true)
  return rectOf(range)
}

/** Caret after the final character, which is where typing continues. */
function pointAtEnd(editor) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null)
  let last = null
  let node = walker.nextNode()
  while (node !== null) {
    if (node.textContent !== null && node.textContent.length > 0) last = node
    node = walker.nextNode()
  }
  if (last === null) return null
  const length = last.textContent.length
  const collapsed = document.createRange()
  collapsed.setStart(last, length)
  collapsed.collapse(true)
  const end = rectOf(collapsed)
  // The right edge of the final glyph is the insertion point. A collapsed range
  // at a text node's end sometimes reports the *start* of the last character,
  // which parks the ghost a full glyph to the left of the caret.
  const glyph = document.createRange()
  glyph.setStart(last, Math.max(0, length - 1))
  glyph.setEnd(last, length)
  const box = rectOf(glyph)
  if (box !== null && Number.isFinite(box.width) && box.width > 0) {
    const right = box.left + box.width
    if (end === null) return { left: right, top: box.top, width: 0, height: box.height }
    if (Math.abs(end.top - box.top) <= 2) {
      return {
        left: Math.max(right, end.left),
        top: end.top,
        width: 0,
        height: end.height > 0 ? end.height : box.height,
      }
    }
  }
  return end
}

/**
 * Where the ghost text belongs: the caret when the editor holds the selection,
 * otherwise the editor's first line (an empty composer still deserves a guess).
 */
function measureCaret(card, options) {
  const editor = card.querySelector('[data-composer-input]')
  if (editor === null) return null
  const settings = options === null || options === undefined ? {} : options
  const draft = typeof settings.draft === 'string' ? settings.draft : null
  const caret = Number.isInteger(settings.caret) ? settings.caret : null
  const style = window.getComputedStyle(editor)
  const font = {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
  }

  let point = null
  // The caret is authoritative, but the DOM selection can lag behind Lexical's
  // own state; the caret offset reported by the composer does not.
  if (draft !== null && caret !== null && caret >= draft.length) point = pointAtEnd(editor)
  if (point === null && draft !== null && caret !== null && draft.indexOf('\n') === -1) {
    point = pointAtOffset(editor, caret)
  }
  if (point === null) {
    const selection = window.getSelection()
    if (selection !== null && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      if (range.collapsed && editor.contains(range.startContainer)) {
        const measured = rectOf(range)
        // A selection collapsed on the container itself reads as the line start.
        if (measured !== null && measured.left > 0) point = measured
      }
    }
  }
  if (point === null) point = pointAtEnd(editor)
  if (point === null) {
    // An empty composer has no text node at all: type at the content box, not
    // at the border box, or the ghost sits one padding to the left.
    const rect = editor.getBoundingClientRect()
    const lineHeight = parseFloat(style.lineHeight)
    point = {
      left: rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0),
      top: rect.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0),
      width: 0,
      height: Number.isFinite(lineHeight) ? lineHeight : 20,
    }
  }
  if (!Number.isFinite(point.left) || !Number.isFinite(point.top)) return null

  const editorRect = editor.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  // A caret scrolled out of view must not paint at the clip edge.
  if (point.top < editorRect.top - 2 || point.top > editorRect.bottom + 2) return null

  const lineHeight = parseFloat(style.lineHeight)
  const height = point.height > 0 ? point.height : (Number.isFinite(lineHeight) ? lineHeight : 20)
  return {
    left: point.left,
    top: point.top,
    height: height,
    maxWidth: Math.max(64, cardRect.right - 14 - point.left),
    font: font,
  }
}

function TabCompleteOverlay(props) {
  const useInput = props.useInput
  const inputActions = props.inputActions
  const sessionId = props.sessionId

  const draft = useInput(function (state) {
    return state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
  })
  const phase = useInput(function (state) {
    return state !== null && state !== undefined && typeof state.phase === 'string' ? state.phase : 'plain'
  })

  const [state, setState] = React.useState(DEFAULT_STATE)
  const [suggestion, setSuggestion] = React.useState(null)
  const [view, setView] = React.useState(null)
  const [tick, setTick] = React.useState(0)

  const rootRef = React.useRef(null)
  const viewRef = React.useRef(null)
  const draftRef = React.useRef(draft)
  const seqRef = React.useRef(0)
  const abortRef = React.useRef(null)
  const composingRef = React.useRef(false)
  const dismissedRef = React.useRef(null)
  // Empty-composer asks are the expensive kind: keep a floor between them so a
  // busy UI can never turn into a model-call storm.
  const emptyAskRef = React.useRef(0)

  draftRef.current = draft

  // Host state (enabled + debounce) is fetched once, then kept for the session.
  React.useEffect(function () {
    let alive = true
    fetch(API + '/state', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (!alive || data === null || data === undefined || data.config === undefined) return
        setState({
          ready: true,
          enabled: data.config.enabled !== false,
          debounceMs: typeof data.config.debounceMs === 'number' ? data.config.debounceMs : FALLBACK_DEBOUNCE_MS,
          minDraftChars: typeof data.config.minDraftChars === 'number' ? data.config.minDraftChars : 0,
        })
      })
      .catch(function () {})
    return function () { alive = false }
  }, [])

  // IME: never predict or splice mid-composition.
  React.useEffect(function () {
    function cardFor(target) {
      const root = rootRef.current
      if (root === null || !(target instanceof Node)) return null
      const card = root.closest('[data-composer-card]')
      return card !== null && card.contains(target) ? card : null
    }
    function onStart(event) {
      if (cardFor(event.target) !== null) composingRef.current = true
    }
    function onEnd(event) {
      if (cardFor(event.target) === null) return
      composingRef.current = false
      setTick(function (value) { return value + 1 })
    }
    document.addEventListener('compositionstart', onStart, true)
    document.addEventListener('compositionend', onEnd, true)
    return function () {
      document.removeEventListener('compositionstart', onStart, true)
      document.removeEventListener('compositionend', onEnd, true)
    }
  }, [])

  // Ask for a prediction.
  React.useEffect(function () {
    setSuggestion(null)
    if (!state.ready || !state.enabled) return undefined
    if (phase !== 'plain') return undefined
    if (typeof draft !== 'string') return undefined
    if (draft.length < state.minDraftChars) return undefined
    if (draft.trimStart().charAt(0) === '/') return undefined
    if (composingRef.current) return undefined
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    if (dismissedRef.current === draft) return undefined
    if (draft.trim().length === 0) {
      const now = Date.now()
      if (now - emptyAskRef.current < 3000) return undefined
      emptyAskRef.current = now
    }

    const ticket = seqRef.current + 1
    seqRef.current = ticket
    const asked = draft
    function accept(text) {
      if (seqRef.current !== ticket) return
      if (draftRef.current !== asked) return
      if (typeof text !== 'string' || text.length === 0) return
      setSuggestion({ text: text, before: asked })
    }

    function withdraw() {
      if (seqRef.current !== ticket) return
      if (draftRef.current !== asked) return
      setSuggestion(null)
      setView(null)
    }

    const timer = setTimeout(function () {
      if (abortRef.current !== null) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller
      fetch(API + '/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId: sessionId, draft: asked }),
        signal: controller.signal,
      })
        .then(function (res) {
          const type = res.headers.get('content-type') || ''
          // An older host answers in one JSON lump; a current one streams the
          // deltas so the ghost starts growing with the first token.
          if (type.indexOf('text/event-stream') === -1) {
            return res.json().then(function (data) {
              if (data === null || data === undefined || data.ok !== true) return
              if (typeof data.completion !== 'string') return
              accept(data.completion)
            })
          }
          if (res.body === null || res.body === undefined) return undefined
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let shown = ''
          function handle(payload) {
            if (payload === null || typeof payload !== 'object') return
            if (typeof payload.delta === 'string') {
              if (payload.delta.length === 0 || payload.delta === shown) return
              shown = payload.delta
              accept(payload.delta)
              return
            }
            if (payload.ok === true && typeof payload.completion === 'string') {
              if (payload.completion.length === 0) return withdraw()
              if (payload.completion !== shown) accept(payload.completion)
              return
            }
            // The final verdict may retract what the partial stream showed.
            if (shown.length > 0) withdraw()
          }
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return undefined
              buffer += decoder.decode(chunk.value, { stream: true })
              const frames = buffer.split('\n\n')
              buffer = frames.pop()
              for (const frame of frames) {
                const line = frame.trim()
                if (line.indexOf('data:') !== 0) continue
                try {
                  handle(JSON.parse(line.slice(5).trim()))
                } catch (error) {
                  // ignore a torn frame
                }
              }
              return pump()
            })
          }
          return pump()
        })
        .catch(function () {})
    }, state.debounceMs)

    return function () {
      clearTimeout(timer)
      if (abortRef.current !== null) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [draft, phase, state.ready, state.enabled, state.debounceMs, state.minDraftChars, sessionId, tick])

  // An empty composer has nothing to type against: the conversation itself is
  // the trigger. Watch the conversation's own phase attribute (idle / streaming)
  // instead of the whole document — a blinking clock or a token counter must
  // not be read as "the answer changed", or every repaint costs a model call.
  React.useEffect(function () {
    if (typeof draft !== 'string' || draft.trim().length > 0) return undefined
    if (phase !== 'plain') return undefined
    if (!state.ready || !state.enabled) return undefined
    let timer = 0
    let pending = 0
    let seen = null
    function bump() {
      if (pending !== 0) return
      pending = window.setTimeout(function () {
        pending = 0
        setTick(function (value) { return value + 1 })
      }, 900)
    }
    function phaseOf(element) {
      if (element === null) return ''
      const phaseAttribute = element.getAttribute('data-content-phase') || element.getAttribute('data-phase') || ''
      return phaseAttribute + ':' + element.querySelectorAll('[data-lexical-editor]').length
    }
    const content = document.querySelector('[data-conversation-content]')
    if (content === null) {
      // No transcript yet: one delayed try, then let a later render re-arm this.
      timer = window.setTimeout(bump, 1600)
      return function () {
        if (timer !== 0) clearTimeout(timer)
        if (pending !== 0) clearTimeout(pending)
      }
    }
    seen = phaseOf(content)
    const observer = new MutationObserver(function () {
      const current = phaseOf(content)
      if (current === seen) return
      seen = current
      bump()
    })
    observer.observe(content, { attributes: true, attributeFilter: ['data-content-phase', 'data-phase'], childList: true, subtree: false })
    return function () {
      if (timer !== 0) clearTimeout(timer)
      if (pending !== 0) clearTimeout(pending)
      observer.disconnect()
    }
  }, [draft, phase, state.ready, state.enabled, suggestion === null, sessionId, tick])

  // Place the ghost at the caret, and keep it there while the composer scrolls.
  React.useLayoutEffect(function () {
    if (suggestion === null) {
      setView(null)
      return undefined
    }
    let frame = 0
    let marked = null
    function place() {
      const root = rootRef.current
      if (root === null) return
      const card = root.closest('[data-composer-card]')
      if (card === null) return setView(null)
      // An empty composer sits under the placeholder line: hide it while the
      // ghost occupies the same baseline, or the two texts interleave.
      if (marked !== card) {
        if (marked !== null) marked.classList.remove('tc-ghost-empty')
        marked = card
      }
      card.classList.toggle('tc-ghost-empty', suggestion.before.trim().length === 0)
      let caret = null
      try {
        const span = inputActions.captureInsertion()
        if (span !== null && span !== undefined && Number.isInteger(span.end)) caret = span.end
      } catch (error) {
        caret = null
      }
      const geometry = measureCaret(card, { draft: draftRef.current, caret })
      if (geometry === null) return setView(null)
      const anchor = root.getBoundingClientRect()
      setView(function (previous) {
        const next = {
          text: suggestion.text,
          before: suggestion.before,
          left: Math.round(geometry.left - anchor.left),
          top: Math.round(geometry.top - anchor.top),
          height: Math.round(geometry.height),
          maxWidth: Math.round(geometry.maxWidth),
          font: geometry.font,
        }
        if (
          previous !== null &&
          previous.text === next.text &&
          previous.before === next.before &&
          previous.left === next.left &&
          previous.top === next.top &&
          previous.maxWidth === next.maxWidth &&
          previous.height === next.height
        ) {
          return previous
        }
        return next
      })
    }
    place()
    function schedule() {
      if (frame !== 0) return
      frame = requestAnimationFrame(function () {
        frame = 0
        place()
      })
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    document.addEventListener('selectionchange', schedule)
    return function () {
      if (frame !== 0) cancelAnimationFrame(frame)
      if (marked !== null) marked.classList.remove('tc-ghost-empty')
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('selectionchange', schedule)
    }
  }, [suggestion])

  React.useEffect(function () {
    viewRef.current = view
  }, [view])

  // Tab accepts, Escape dismisses. Capture phase: the editor never sees them.
  React.useEffect(function () {
    function dismiss() {
      seqRef.current += 1
      // Escape means "not now": do not let the observer immediately re-ask.
      dismissedRef.current = draftRef.current
      setSuggestion(null)
      setView(null)
    }

    function onKeyDown(event) {
      const current = viewRef.current
      if (current === null) return
      let root
      try {
        root = rootRef.current
      } catch (error) {
        return
      }
      if (root === null || root === undefined) return

      if (event.key === 'Escape') {
        dismiss()
        return
      }
      if (event.key !== 'Tab') return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.isComposing || composingRef.current) return

      const card = root.closest('[data-composer-card]')
      if (card === null) return
      if (!(event.target instanceof Node) || !card.contains(event.target)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      const text = joinCompletion(current.before, current.text)
      let span = null
      try {
        span = inputActions.captureInsertion()
      } catch (error) {
        span = null
      }
      let applied = false
      if (span !== null && span !== undefined) {
        try {
          applied = inputActions.insertText(text, span) === true
        } catch (error) {
          applied = false
        }
      }
      if (!applied) {
        // The caret moved between prediction and accept: still honour the
        // promise of "Tab fills it in", at the end of the draft.
        try {
          inputActions.setDraft(current.before + text)
          applied = true
        } catch (error) {
          applied = false
        }
      }
      // Accepting is the only feedback signal we get for free: remember the
      // sentence so later suggestions copy this person's actual register.
      if (applied && text.trim().length >= 4) rememberStyle((current.before + text).trim())
      dismiss()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return function () {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [inputActions])

  const children = []
  if (view !== null) {
    children.push(
      h(
        'span',
        {
          key: 'ghost',
          className: 'tc-ghost',
          style: {
            left: view.left + 'px',
            top: view.top + 'px',
            height: view.height + 'px',
            maxWidth: view.maxWidth + 'px',
            lineHeight: view.height + 'px',
            fontFamily: view.font.fontFamily,
            fontSize: view.font.fontSize,
            fontWeight: view.font.fontWeight,
            fontStyle: view.font.fontStyle,
            letterSpacing: view.font.letterSpacing,
          },
        },
        view.text,
        h('kbd', { className: 'tc-kbd' }, 'Tab'),
      ),
    )
  }

  return h('div', { ref: rootRef, className: 'tc-layer' }, children)
}

/** Caret-join rule, duplicated from core.js because the client bundle carries no relative imports. */
function joinCompletion(before, completion) {
  const text = typeof completion === 'string' ? completion : ''
  if (text.length === 0) return ''
  const base = typeof before === 'string' ? before : ''
  if (base.length === 0) return text
  if (/\s$/.test(base)) return text
  if (/^\s/.test(text)) return text
  if (/[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(text)) return ' ' + text
  return text
}

function apply(ctx) {
  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-tab-complete'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // The overlay is a droppable half: a changed slot contract costs the ghost,
  // never the whole client boot.
  ctx.slots.inject('conversation.input.overlay', function () {
    let dispose
    try {
      dispose = ctx.slots.register(
        { name: 'conversation.input.overlay', id: 'tab-complete', order: 90 },
        TabCompleteOverlay,
      )
    } catch (error) {
      dispose = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-tab-complete] 注册输入框补全层失败；宿主路由仍然可用', error)
      }
    }
    return typeof dispose === 'function' ? dispose : function () {}
  })
}

module.exports = {
  name: 'dsh-tab-complete',
  inject: ['slots'],
  apply: apply,
}
    return module.exports;
  },
});
