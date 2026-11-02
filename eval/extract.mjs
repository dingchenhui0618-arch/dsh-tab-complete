// Turn recent real sessions into a replayable evaluation set.
//
// Reads your own session transcripts (nothing leaves the machine here), keeps
// the last few exchanges plus the message the user actually sent next, and
// writes eval/cases.json. That file holds your conversation text: it is
// gitignored, keep it local.
//
// Usage: node eval/extract.mjs [--sessions <dir>] [--sessions-limit 14] [--cases 60]
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}

const ROOT = flag('sessions', join(homedir(), '.dsh', 'sessions'))
const OUT = flag('out', fileURLToPath(new URL('./cases.json', import.meta.url)))
const MAX_SESSIONS = Number(flag('sessions-limit', '14'))
const MAX_CASES = Number(flag('cases', '60'))

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SCAFFOLDING = /<available_skills>|<system-reminder>|<skill_content|Current runtime context|<runtime_context>|You are an AI agent powered by/

function frames(buffer) {
  const starts = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) !== -1) {
    starts.push(index)
    index += 4
  }
  const pieces = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      pieces.push(zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8'))
    } catch (error) {
      // A truncated tail frame is not worth failing the whole extraction over.
    }
  }
  return pieces.join('')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function sessionsOf(root) {
  const found = []
  for (const workspace of readdirSync(root)) {
    const workspacePath = root + '/' + workspace
    if (!statSync(workspacePath).isDirectory()) continue
    for (const name of readdirSync(workspacePath)) {
      const file = workspacePath + '/' + name + '/session.v4.jsonl.zstd'
      try {
        found.push({ file, mtime: statSync(file).mtimeMs, name })
      } catch (error) {
        // no compressed log for this session
      }
    }
  }
  return found.sort((left, right) => right.mtime - left.mtime).slice(0, MAX_SESSIONS)
}

function messagesOf(file) {
  const text = frames(readFileSync(file))
  const messages = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const body = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const content = textOf(body.content)
    if (content.length === 0) continue
    if (SCAFFOLDING.test(content)) continue
    messages.push({ role: type === 'user/message' ? 'user' : 'assistant', text: content })
  }
  return messages
}

/** Cut a message mid-way, on a comma when one is nearby, to imitate typing. */
function draftOf(text) {
  const target = Math.max(4, Math.floor(text.length * 0.45))
  const window = text.slice(Math.max(0, target - 8), target + 8)
  const comma = window.search(/[，,、；;\s]/)
  if (comma !== -1) {
    const cut = Math.max(2, target - 8 + comma + 1)
    if (cut < text.length - 1) return text.slice(0, cut)
  }
  return text.slice(0, target)
}

const cases = []
for (const session of sessionsOf(ROOT)) {
  let messages = []
  try {
    messages = messagesOf(session.file)
  } catch (error) {
    continue
  }
  for (let index = 2; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const truth = message.text.trim()
    if (truth.length < 8 || truth.length > 140) continue
    if (truth.startsWith('/')) continue
    if (cases.length >= MAX_CASES) break
    const context = messages.slice(Math.max(0, index - 6), index)
    if (context.length === 0) continue
    const draft = draftOf(truth)
    cases.push({
      id: cases.length + 1,
      session: session.name.slice(0, 14),
      context,
      draft,
      truth,
      kind: 'draft',
    })
    cases.push({
      id: cases.length + 1,
      session: session.name.slice(0, 14),
      context,
      draft: '',
      truth,
      kind: 'empty',
    })
  }
  if (cases.length >= MAX_CASES) break
}

writeFileSync(OUT, JSON.stringify({ createdAt: new Date().toISOString(), cases }, null, 1), 'utf8')
console.log('cases', cases.length, 'sessions', MAX_SESSIONS, '->', OUT)
for (const sample of cases.slice(0, 3)) {
  console.log('---')
  console.log('context tail:', sample.context[sample.context.length - 1].text.slice(0, 60).replace(/\n/g, ' '))
  console.log('draft:', JSON.stringify(sample.draft), 'truth:', sample.truth.slice(0, 60).replace(/\n/g, ' '))
}
