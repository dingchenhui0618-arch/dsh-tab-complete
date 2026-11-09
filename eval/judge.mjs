// Score predictions of the real code path with a model judge (0-10), instead of
// n-gram overlap. A bigram F1 punishes a short prediction for not repeating a
// long truth; the question that actually matters is "could this person have
// sent this next?".
//
// Replays every case through POST /dsh-tab-complete/replay on a running
// instance, so what gets scored is exactly what the plugin would have shown
// (sanitiser, suppression guard, step filter included).
//
// Usage:
//   node eval/judge.mjs --port 3080 [--limit 20] [--kind empty|draft]
//                        [--model <provider>/<model>] [--judge <provider>/<model>]
//                        [--extra "额外的一段系统提示"] [--maxtokens 64]
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SYSTEM_PROMPT } from '../lib/core.js'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const at = args.indexOf('--' + name)
  return at === -1 ? fallback : args[at + 1]
}

const port = flag('port', '3080')
const label = flag('label', 'run')
const modelArg = flag('model', '')
const limit = Number(flag('limit', '20'))
const maxTokens = Number(flag('maxtokens', '0'))
const judgeModel = flag('judge', 'chenyuzhiyun/deepseek-flash')
const kind = flag('kind', '')
const extraFile = flag('extra-file', '')
const extra = extraFile.length > 0 ? readFileSync(extraFile, 'utf8') : flag('extra', '')
const base = SYSTEM_PROMPT
const system = extra.length > 0 ? base + '\n\n' + extra : base
const provider = modelArg.includes('/') ? modelArg.split('/')[0] : ''
const model = modelArg.includes('/') ? modelArg.split('/').slice(1).join('/') : ''

const casesPath = flag('cases', fileURLToPath(new URL('./cases.json', import.meta.url)))
const data = JSON.parse(readFileSync(casesPath, 'utf8'))
const all = kind.length > 0 ? data.cases.filter((one) => one.kind === kind) : data.cases
const cases = all.slice(0, limit)

async function post(body) {
  const response = await fetch('http://127.0.0.1:' + port + '/dsh-tab-complete/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

const JUDGE_SYSTEM = [
  '你是对话质量评审。给你一段人机对话的记录、用户的真实下一句、以及一个预测。',
  '判断这个预测有多像「这个用户自己会紧接着发出去的那句话」。',
  '评分标准（0-10）：',
  '10 = 几乎就是他会说的，方向和粒度都对',
  '7 = 方向对，措辞不同',
  '5 = 沾边但不在点子上，或者明显是助手口吻',
  '3 = 跑到别的话题，或者像助手的执行步骤',
  '0 = 完全无关',
  '只看预测本身，不要因为真实句子更长就扣分。',
  '输出格式：第一行只写分数（阿拉伯数字），第二行写不超过 20 字的理由。',
].join('\n')

const results = []
for (const one of cases) {
  const prediction = await post({
    messages: one.context,
    draft: one.draft,
    provider: provider,
    model: model,
    system: system,
    maxTokens: maxTokens > 0 ? maxTokens : undefined,
  })
  const text = prediction.completion || ''
  const history = one.context.map((m) => (m.role === 'user' ? '用户：' : '助手：') + m.text.slice(0, 400)).join('\n')
  const judgment = await post({
    raw: true,
    provider: judgeModel.split('/')[0],
    model: judgeModel.split('/').slice(1).join('/'),
    maxTokens: 800,
    system: JUDGE_SYSTEM,
    user: [
      '<对话>',
      history,
      '</对话>',
      '',
      '用户当前输入：' + (one.draft.length === 0 ? '<空>' : JSON.stringify(one.draft)),
      '用户真实下一句：' + one.truth,
      '候选预测：' + (text.length === 0 ? '<空>' : JSON.stringify(text)),
    ].join('\n'),
  })
  const verdict = (judgment.completion || '').trim()
  const score = Number((verdict.match(/^(\d+(?:\.\d+)?)/) || [])[1] || 0)
  results.push({ id: one.id, kind: one.kind, draft: one.draft, truth: one.truth, text, score, verdict: verdict.replace(/\n/g, ' | ').slice(0, 90), ms: prediction.ms })
}

const mean = results.reduce((sum, row) => sum + row.score, 0) / results.length
const shown = results.filter((row) => row.text.trim().length > 0)
const hidden = results.length - shown.length
const shownMean = shown.length > 0 ? shown.reduce((sum, row) => sum + row.score, 0) / shown.length : 0
const good = shown.filter((row) => row.score >= 7).length
const bad = shown.filter((row) => row.score <= 4).length
const times = results.map((row) => row.ms).sort((a, b) => a - b)
console.log('## ' + label + '  shown-mean ' + shownMean.toFixed(2) + '/10  shown ' + shown.length + '/' + results.length + ' (hidden ' + hidden + ', ' + Math.round((hidden * 100) / results.length) + '%)  good(>=7) ' + good + '  bad(<=4) ' + bad + '  raw-mean ' + mean.toFixed(2) + '  p50 ' + times[Math.floor(times.length / 2)] + 'ms')
for (const row of results.sort((a, b) => a.score - b.score).slice(0, 5)) {
  console.log('  ' + row.score + ' [' + row.kind + '] pred=' + JSON.stringify(row.text.slice(0, 50)) + ' | truth=' + JSON.stringify(row.truth.slice(0, 40)))
}
writeFileSync(
  fileURLToPath(new URL('./last-' + label.replace(/[^\w-]/g, '_') + '.json', import.meta.url)),
  JSON.stringify(results, null, 1),
  'utf8',
)
