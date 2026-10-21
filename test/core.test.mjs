import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildPrompt,
  echoesAssistant,
  joinCompletion,
  normalizeConfig,
  sanitizeCompletion,
  sanitizePartial,
  textOfContent,
  transcriptOf,
  transcriptOfMessages,
} from '../lib/core.js'

test('transcriptOfMessages keeps the newest exchange', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: '系统' }] },
    { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'bash' }] },
    { role: 'user', content: [{ type: 'text', text: '第二个问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第二个回答' }] },
  ]
  const transcript = transcriptOfMessages(messages)
  // The system prompt is not conversation, and a tool-only turn adds no text.
  assert.deepEqual(transcript.map((entry) => entry.text), ['第一个问题', '第二个问题', '第二个回答'])
  assert.equal(transcript[2].role, 'assistant')
})

test('textOfContent keeps only text blocks', () => {
  assert.equal(textOfContent('plain'), 'plain')
  assert.equal(
    textOfContent([
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '你好' },
      { type: 'tool-call', id: 'x', name: 'bash', arguments: '{}' },
    ]),
    '你好',
  )
  assert.equal(textOfContent(undefined), '')
  assert.equal(textOfContent([{ type: 'text', text: '' }]), '')
})

test('transcriptOf reads the tail in chronological order', () => {
  const log = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第一句' }] } },
    { seq: 2, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '回答一' }] } },
    { seq: 3, type: 'tool/call', data: {} },
    { seq: 4, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第二句' }] } },
    { seq: 5, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '回答二' }] } },
  ]
  const out = transcriptOf(log, { maxMessages: 3, maxChars: 1000 })
  assert.deepEqual(out.map((entry) => entry.text), ['回答一', '第二句', '回答二'])
  assert.deepEqual(out.map((entry) => entry.role), ['assistant', 'user', 'assistant'])
})

test('transcriptOf drops the oldest entries first and never returns junk', () => {
  const log = []
  for (let index = 0; index < 10; index += 1) {
    log.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(100) }] } })
  }
  const out = transcriptOf(log, { maxMessages: 10, maxChars: 250 })
  assert.ok(out.length >= 1)
  assert.ok(out.length <= 3)
  assert.equal(transcriptOf([], {}).length, 0)
  assert.equal(transcriptOf(undefined, {}).length, 0)
  assert.equal(transcriptOf(log, { maxMessages: 0 }).length, 0)
})

test('sanitizeCompletion strips wrapping punctuation and the echoed draft', () => {
  assert.equal(sanitizeCompletion('“接着写测试”', '接着'), '接着写测试'.slice(2))
  assert.equal(sanitizeCompletion(' world', 'hello'), 'world')
  assert.equal(sanitizeCompletion('hello world', 'hello'), 'world')
  assert.equal(sanitizeCompletion('补全：然后提交', '然后'), '提交')
  assert.equal(sanitizeCompletion('第一行\n第二行', ''), '第一行')
  assert.equal(sanitizeCompletion('', ''), null)
  assert.equal(sanitizeCompletion('   ', ''), null)
  assert.equal(sanitizeCompletion('。。。', ''), null)
  assert.equal(sanitizeCompletion('（空字符串）', ''), null)
  assert.equal(sanitizeCompletion('空字符串', ''), null)
  assert.equal(sanitizeCompletion('(empty)', ''), null)
  assert.equal(sanitizeCompletion(42, ''), null)
  assert.equal(
    echoesAssistant('二分查找是通过折半定位的算法', [{ role: 'assistant', text: '二分查找是通过折半定位的算法。' }]),
    true,
  )
  assert.equal(echoesAssistant('那它时间复杂度是多少？', [{ role: 'assistant', text: '二分查找是 O(log n)' }]), false)
  assert.equal(echoesAssistant('继续', [{ role: 'assistant', text: '继续继续说' }]), false)
})

test('sanitizeCompletion caps length without breaking a surrogate pair', () => {
  const long = 'a'.repeat(500)
  assert.equal(sanitizeCompletion(long, '', 20).length, 20)
  const emoji = '😀'.repeat(100)
  const cut = sanitizeCompletion(emoji, '', 5)
  assert.ok(cut === null || !/[\uD800-\uDBFF]$/.test(cut))
})

test('joinCompletion inserts one space between English words only', () => {
  assert.equal(joinCompletion('hello', 'world'), ' world')
  assert.equal(joinCompletion('hello ', 'world'), 'world')
  assert.equal(joinCompletion('', 'world'), 'world')
  assert.equal(joinCompletion('帮我', '看看这个'), '看看这个')
  assert.equal(joinCompletion('写一个', 'world'), 'world')
  assert.equal(joinCompletion('code', ' test'), ' test')
})

test('buildPrompt marks an empty composer and includes the transcript', () => {
  const filled = buildPrompt({
    transcript: [{ role: 'user', text: '修 bug' }, { role: 'assistant', text: '修好了' }],
    draft: '再跑',
  })
  assert.match(filled.user, /用户：修 bug/)
  assert.match(filled.user, /助手：修好了/)
  assert.match(filled.user, /用户当前输入：再跑/)
  assert.match(filled.system, /输入框补全引擎/)

  const empty = buildPrompt({ transcript: [], draft: '' })
  assert.match(empty.user, /这是本次对话的第一条消息/)
  assert.match(empty.user, /<空>/)
})

test('normalizeConfig clamps and defaults', () => {
  const config = normalizeConfig({
    debounceMs: 5,
    maxTokens: 100000,
    temperature: -3,
    provider: '  p  ',
    model: 'm',
    enabled: false,
  })
  assert.equal(config.debounceMs, 150)
  assert.equal(config.maxTokens, 512)
  assert.equal(config.temperature, 0)
  assert.equal(config.provider, 'p')
  assert.equal(config.model, 'm')
  assert.equal(config.enabled, false)

  const fallback = normalizeConfig(null)
  assert.equal(fallback.enabled, true)
  assert.equal(fallback.debounceMs, 280)
})

test('sanitizePartial is safe on a half-arrived stream', () => {
  // A growing prefix must render as-is, character by character.
  assert.equal(sanitizePartial('把这段逻辑'), '把这段逻辑')
  // A newline ends the suggestion: a completion is one line, never a list.
  assert.equal(sanitizePartial('把这段逻辑\n再展开讲'), '把这段逻辑')
  // The prefix the model likes to add is not part of the text.
  assert.equal(sanitizePartial('补全：封装成函数'), '封装成函数')
  // A placeholder answer must not paint even for one frame.
  assert.equal(sanitizePartial('空字符串'), '')
  assert.equal(sanitizePartial('null'), '')
  // Length is capped so a runaway stream cannot paint a wall of ghost text.
  assert.equal(sanitizePartial('字'.repeat(200), 10), '字'.repeat(10))
})
