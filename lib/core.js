// Pure helpers for dsh-tab-complete.
//
// Everything here is deterministic and dependency-free so the host route, the
// unit tests and (conceptually) any future CLI can share one implementation:
//   - config normalisation,
//   - session-log -> compact transcript,
//   - prompt assembly,
//   - completion sanitising and caret joining.

export const NAME = 'dsh-tab-complete'
export const VERSION = '0.2.0'
export const ROUTE = '/dsh-tab-complete'

/** Every knob the plugin owns, with the shipped defaults. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; false turns the route into a cheap no-op. */
  enabled: true,
  /** Idle time after the last keystroke before asking for a completion. */
  debounceMs: 280,
  /** Empty composer is allowed; the host requires *some* conversation first. */
  minDraftChars: 0,
  /** Reply budget. A tab completion must stay short to feel instant. */
  maxTokens: 96,
  temperature: 0.2,
  /** Hard ceiling for one suggestion, in characters. */
  maxCompletionChars: 180,
  /** Conversation tail fed to the model. */
  contextMessages: 6,
  contextChars: 2200,
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
 * Harness scaffolding that rides along in the model history but is not
 * conversation: the skills catalog, system reminders, injected skill bodies.
 * A prediction built on those invents topics the user never mentioned — this
 * filter is why an empty composer used to answer with "load the typesafe-ai
 * skill" instead of anything about the actual task.
 */
const SCAFFOLDING = /<available_skills>|<system-reminder>|<skill_content|<skills\b|If the user names a skill|可用技能如果|This catalog contains summaries only|Current runtime context|supersedes earlier runtime-context|<runtime_context>|You are an AI agent powered by/

/** Text longer than this is injected context, not something a human typed. */
const MAX_MESSAGE_CHARS = 4000

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
    if (isScaffolding(text)) continue
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
    if (isScaffolding(text)) continue
    collected.push({ role: message.role, text })
  }
  collected.reverse()
  return trimTranscript(collected, maxChars)
}

/**
 * True when a message is harness scaffolding rather than something the user or
 * the assistant actually said.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isScaffolding(text) {
  if (typeof text !== 'string' || text.length === 0) return true
  if (text.length > MAX_MESSAGE_CHARS) return true
  return SCAFFOLDING.test(text)
}

/** Keep the newest messages that fit the character budget. */
function trimTranscript(collected, maxChars) {
  const trimmed = []
  let budget = maxChars
  for (let index = collected.length - 1; index >= 0; index -= 1) {
    const entry = collected[index]
    if (entry.text.length > budget) {
      if (trimmed.length === 0) {
        // The newest message alone is longer than the whole budget. A user
        // message is worth its beginning, an assistant reply its ending (that
        // is where "what it just finished" lives).
        const slice = Math.max(300, Math.min(maxChars, 1400))
        const text = entry.role === 'assistant' ? entry.text.slice(-slice) : entry.text.slice(0, slice)
        trimmed.unshift({ role: entry.role, text: text })
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
  '你是用户的「下一句预测器」。用户正在 DeepSeek Harness 里和 AI 助手协作，你要说出他接下来会打出的那句话。',
  '',
  '怎么写：',
  '1. 只输出要补在光标处的文本，不要引号、不要解释、不要 Markdown、不要「补全：」这类前缀。',
  '2. 用用户自己的口吻：第一人称，是他在使唤助手，不是助手在回答。',
  '3. 必须扣住这段对话正在做的事：沿用对话里出现过的人名、文件名、函数名、路径、版本号、术语。',
  '   绝对不要引入对话里没出现过的新话题、新技术、新产品；宁可平淡地贴着当前任务，也不要另起炉灶。',
  '   提到文件或目录时，只用对话历史或工作区里真实出现过的名字——不要编造 src/plugins、index.ts 这种这里根本没有的路径。',
  '4. 给完整、能独立读懂的一句（必要时两句）：说清「做什么 + 对什么 + 什么约束」。',
  '   20–60 个字比半句好——用户是要直接按 Tab 收下的，不是拿来接着想的。',
  '5. 不要复述、总结或称赞助手刚说过的话。',
  '6. 不要重复用户已经打出来的内容，接着光标处往下写。',
  '7. 语言跟用户走：中文就写中文，中英混排按他的习惯。',
  '8. 实在没有依据时，给一个具体的下一步动作（比如「再补一个测试用例」），不要输出空内容；',
  '   也绝不要输出「空字符串」「无」「暂无」「null」这类占位词。',
  '',
  '示例一（输入框为空）：',
  '对话：用户「把 parseDate 改成用正则」／助手「改好了，日期格式现在由正则收口」',
  '输出：再补一个测试用例，覆盖闰年和非法输入',
  '',
  '示例二（用户已经打了半句）：',
  '对话：用户「帮我把 README 更新一下」／助手「已更新到 v0.2.0，补了流式说明」',
  '用户当前输入：顺便把新增的',
  '输出：/prompt 路由也写进去，附一段 curl 示例',
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
 * @param {{ transcript?: readonly {role: string, text: string}[], draft: string, workspace?: string }} input
 * @returns {{ system: string, user: string }}
 */
export function buildPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const draft = typeof input.draft === 'string' ? input.draft : ''
  const workspace = typeof input.workspace === 'string' ? input.workspace : ''
  const head = ['<对话历史>', renderTranscript(transcript), '</对话历史>', '']
  if (workspace.length > 0) {
    head.push('<当前工作区>')
    head.push(workspace)
    head.push('</当前工作区>')
    head.push('')
  }
  if (draft.trim().length === 0) {
    head.push('用户当前输入：<空>（他正准备开始新的一条消息）')
    head.push('请预测他下一条消息的完整内容：一句能直接发出去的话，说清要做什么、对哪个具体对象，20–60 字。')
  } else {
    head.push('用户当前输入：' + draft)
    head.push('（光标在末尾；只补剩余部分，补到这句话自然结束，能独立读通。）')
  }
  head.push('')
  head.push('补全：')
  return { system: SYSTEM_PROMPT, user: head.join('\n') }
}

const LEADING_QUOTES = /^[`"'“”‘’「」『』《》]+/
const TRAILING_QUOTES = /[`"'“”‘’「」『』《》]+$/
/** A trailing separator reads as a sentence the model forgot to finish. */
const TRAILING_SEPARATOR = /[，、；：,;:]$/
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
  text = text.trim()
  if (text.length === 0 || ONLY_PUNCTUATION.test(text)) return null
  if (PLACEHOLDER_ANSWER.test(text)) return null
  if (text.length > limit) {
    text = text.slice(0, limit)
    // Never leave half a surrogate pair behind.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    text = text.replace(/\s+\S*$/, '').trim()
  }
  // "把路由写进去，" ends where the user still has to think: drop the dangling
  // separator so the suggestion reads as a finished clause.
  text = text.replace(TRAILING_SEPARATOR, '').trim()
  return text.length === 0 ? null : text
}

/**
 * The same cleanup, but safe to run on a half-arrived stream: a partial
 * completion is shown as it grows, so it must never carry a newline, a
 * "补全：" prefix or an unbounded length into the composer.
 * @param {string} raw
 * @param {number} [maxChars]
 * @returns {string}
 */
export function sanitizePartial(raw, maxChars) {
  if (typeof raw !== 'string') return ''
  const limit = Number.isInteger(maxChars) ? maxChars : DEFAULT_CONFIG.maxCompletionChars
  let text = raw.split(/\r?\n/)[0]
  text = text.replace(/^补全[:：]\s*/, '')
  text = text.trimStart()
  text = text.replace(LEADING_QUOTES, '')
  if (PLACEHOLDER_ANSWER.test(text)) return ''
  if (text.length > limit) {
    text = text.slice(0, limit)
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  }
  return text
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
