// Pure helpers for dsh-tab-complete.
//
// Everything here is deterministic and dependency-free so the host route, the
// unit tests and (conceptually) any future CLI can share one implementation:
//   - config normalisation,
//   - session-log -> compact transcript,
//   - prompt assembly,
//   - completion sanitising and caret joining.

export const NAME = 'dsh-tab-complete'
export const VERSION = '0.3.0'
export const ROUTE = '/dsh-tab-complete'

/** Every knob the plugin owns, with the shipped defaults. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; false turns the route into a cheap no-op. */
  enabled: true,
  /** Idle time after the last keystroke before asking for a completion. */
  debounceMs: 280,
  /** Empty composer is allowed; the host requires *some* conversation first. */
  minDraftChars: 0,
  /** Reply budget. One sentence; more only adds latency. */
  maxTokens: 64,
  temperature: 0.2,
  /** Hard ceiling for one suggestion, in characters. */
  maxCompletionChars: 180,
  /** Conversation tail fed to the model. */
  contextMessages: 6,
  contextChars: 2200,
  /** Request timeout. */
  timeoutMs: 9000,
  /**
   * Hide completions shaped like the assistant's next move. Measured: those
   * score 2.2/10 against what the user actually types, and dropping them costs
   * nothing, because a missing ghost is invisible and a wrong one is noise.
   */
  suppressSteps: true,
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
    suppressSteps: pickBoolean(input, 'suppressSteps'),
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

/**
 * The instruction the model receives as `system`.
 *
 * The measured failure mode (judged on real sessions) was register, not topic:
 * the model kept writing the assistant's next action — "先翻一下日志…",
 * "建议把 maxTokens 调到 64" — instead of the user's next sentence. Most of the
 * prompt is therefore about whose voice this is.
 */
export const SYSTEM_PROMPT = [
  '你是「下一句预测器」：在一段人和 AI 助手的对话里，写出**那个人**接下来会打的字。',
  '你不是那个助手，不用替他干活，也不用续写他的回答——你只模仿那个人说话的口气。',
  '',
  '他通常这样写（一句话，10–50 字，能直接发出去）：',
  '- 说现象和感受：「我看了一下，幽灵文本还是偏左」「这个改动好像没生效」',
  '- 提要求：「把开关改成默认关闭」「顺便在 README 里加一句」',
  '- 给判断：「这个方向可以，继续」「不对，我说的是缓存那条」',
  '',
  '绝对不要：',
  '- 写执行步骤（「先翻日志」「再跑一遍测试」「打开 X 看一下」）——那是助手的工作',
  '- 对读者下指令（「你可以试试」「建议你…」「你先把 X 调大」）',
  '- 复述或夸奖助手刚说过的话；不要重复用户已经打出来的字',
  '- 编造对话里没出现过的技术、产品、文件路径；提到文件只用对话里真实出现过的名字',
  '- 输出引号、Markdown、列表、「补全：」这类前缀或任何解释',
  '',
  '其它：',
  '- 完整一句：说清做什么、对哪个对象。20–60 字比半句好，用户是要直接按 Tab 收下的。',
  '- 语言跟用户走：中文就写中文，中英混排按他的习惯。',
  '- 实在没有依据时，给一个具体的下一步请求；绝不要输出「无」「空字符串」「null」这类占位词。',
  '',
  '对照（左边是错的写法，右边才是他）：',
  '✗「先翻一下日志，确认插件是不是没加载」 → ✓「日志里没看到报错，是不是根本没加载」',
  '✗「建议把 maxTokens 调到 64」 → ✓「先把速度提上去，一句话够了」',
  '',
  '示例（输入框为空）：',
  '对话：用户「把 parseDate 改成用正则」／助手「改好了，日期格式现在由正则收口」',
  '输出：再补一个测试用例，覆盖闰年和非法输入',
].join('\n')

/**
 * How much of one assistant reply the predictor gets to see. A long report in
 * the history drags the model into the assistant's register ("先翻日志…"),
 * while the user's own short lines are what should set the tone.
 */
const ASSISTANT_HEAD = 140
const ASSISTANT_TAIL = 100

function renderTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '（这是本次对话的第一条消息）'
  return transcript
    .map(function (entry) {
      const label = entry.role === 'user' ? '用户' : '助手'
      const flat = entry.text.replace(/\s+/g, ' ').trim()
      if (entry.role === 'assistant' && flat.length > ASSISTANT_HEAD + ASSISTANT_TAIL) {
        return label + '：' + flat.slice(0, ASSISTANT_HEAD) + ' …（略）… ' + flat.slice(-ASSISTANT_TAIL)
      }
      return label + '：' + flat
    })
    .join('\n')
}

/**
 * Clean one accepted suggestion before it becomes a style example.
 * Rejects placeholder noise so a bad accept cannot poison the prompt.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeExample(raw) {
  if (typeof raw !== 'string') return ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length < 4 || flat.length > 80) return ''
  if (ONLY_PUNCTUATION.test(flat)) return ''
  if (PLACEHOLDER_ANSWER.test(flat)) return ''
  if (SCAFFOLDING.test(flat)) return ''
  return flat
}

/**
 * Assemble the one-shot chat request body.
 * @param {{ transcript?: readonly {role: string, text: string}[], draft: string, workspace?: string, examples?: readonly string[] }} input
 * @returns {{ system: string, user: string }}
 */
export function buildPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const draft = typeof input.draft === 'string' ? input.draft : ''
  const workspace = typeof input.workspace === 'string' ? input.workspace : ''
  const head = ['<对话历史>', renderTranscript(transcript), '</对话历史>', '']
  // The user's own last lines, right before the ask: recency is what makes the
  // model copy the user's voice instead of the assistant's reports.
  const voices = transcript.filter(function (entry) { return entry.role === 'user' }).slice(-2)
  if (voices.length > 0) {
    head.push('<他的说法（口吻模仿这个，不要模仿助手）>')
    for (const voice of voices) {
      head.push('「' + voice.text.replace(/\s+/g, ' ').trim().slice(0, 80) + '」')
    }
    head.push('</他的说法（口吻模仿这个，不要模仿助手）>')
    head.push('')
  }
  if (workspace.length > 0) {
    head.push('<当前工作区>')
    head.push(workspace)
    head.push('</当前工作区>')
    head.push('')
  }
  // What this person actually accepted before is the strongest signal about
  // what "sounds right" to them — stronger than any generic example.
  const examples = Array.isArray(input.examples)
    ? input.examples.map(normalizeExample).filter(function (entry) { return entry.length > 0 }).slice(-6)
    : []
  if (examples.length > 0) {
    head.push('<他以前按 Tab 收下的写法（照着这个味道写）>')
    for (const example of examples) head.push('- ' + example)
    head.push('</他以前按 Tab 收下的写法（照着这个味道写）>')
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

/** Sentence starts that belong to the helper, not to the person typing. */
const ACTION_START = /^(先|然后|接着|再|查|读|看|翻|改|跑|试|建|删|调|装|重启|打开|确认|核对|检查|同步|推送|执行|列出|找|搜)/
/** Naming one of these is a sign the line is about the tooling, not the work. */
const TECH_OBJECT = /(日志|log|startup|\.mjs|\.js|\.json|\.yml|\.ts\b|路由|配置|config|maxTokens|函数|接口|文件|目录|终端|命令|测试|脚本|commit|README|prompt|SYSTEM_PROMPT)/i
/** "先…，再…" is a plan: assistants write plans, people ask for one thing. */
const PLAN_TAIL = /[，,].*(再|然后|接着)/
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
 * Does this read like the assistant's next move rather than the user's line?
 *
 * Measured on 148 judged predictions from real sessions: the ones matching this
 * rule score 2.2/10 against the user's actual next message, while the rest score
 * 4.1 — and it rejected none of the good ones. Suppressing them is a free win:
 * a missing ghost costs nothing, a wrong one costs the user's trust.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeAssistantStep(text) {
  if (typeof text !== 'string') return false
  const flat = text.trim()
  if (flat.length === 0) return false
  if (!ACTION_START.test(flat)) return false
  return TECH_OBJECT.test(flat) || PLAN_TAIL.test(flat)
}

/**
 * Turn one raw model reply into text that is safe to paste at the caret.
 * @param {unknown} raw
 * @param {string} draft the draft the request was built from
 * @param {number} [maxChars]
 * @param {{ suppressSteps?: boolean }} [options]
 * @returns {string | null}
 */
export function sanitizeCompletion(raw, draft, maxChars, options) {
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
  // "把路由写进去，" ends where the user still has to think: drop the dangling
  // separator so the suggestion reads as a finished clause.
  text = text.replace(TRAILING_SEPARATOR, '').trim()
  if (text.length === 0) return null
  const suppress = options === undefined || options.suppressSteps !== false
  if (suppress && looksLikeAssistantStep(base + text)) return null
  return text
}

/**
 * The same cleanup, but safe to run on a half-arrived stream: a partial
 * completion is shown as it grows, so it must never carry a newline, a
 * "补全：" prefix or an unbounded length into the composer.
 * @param {string} raw
 * @param {number} [maxChars]
 * @param {{ suppressSteps?: boolean, draft?: string }} [options]
 * @returns {string}
 */
export function sanitizePartial(raw, maxChars, options) {
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
  // Hide a step-shaped ghost while it streams instead of growing it and then
  // withdrawing it: the flicker is worse than showing nothing.
  const suppress = options === undefined || options.suppressSteps !== false
  const base = options !== undefined && typeof options.draft === 'string' ? options.draft : ''
  if (suppress && looksLikeAssistantStep(base + text)) return ''
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
