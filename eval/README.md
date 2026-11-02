# 评测：让「准不准」变成数字

这个目录存在的理由只有一个：改提示词、改守卫规则时，不要靠感觉。

做法是把你自己最近的真实会话变成考卷，再把考卷重放进**真实补全链路**，最后让另一个模型当评审打分。

```
你的会话记录 ──extract──> eval/cases.json ──replay──> 插件 ──judge──> 0-10 分
```

## 1. 抽考卷

```bash
node eval/extract.mjs                       # 默认读 ~/.dsh/sessions，写 eval/cases.json
node eval/extract.mjs --sessions /path/to/sessions --cases 80
```

每条样本是「对话尾部 + 用户真实发出的下一句」。会话是 zstd 多帧存储的，脚本按 magic 拆帧解压；技能目录、运行时上下文这类框架注入会被丢掉（否则模型会对着技能列表瞎猜，这也是 0.2.0 翻车的原因）。

`eval/cases.json` 含**你的真实对话内容**，已 gitignore，不要提交、不要外传。

## 2. 起一个可回放的实例

`/replay` 只在 loopback 上开放，需要一个跑着的实例（用独立 profile，别拿你正在用的那个）：

```bash
node <dsh>/lib/bin.js --profile tabdev --port 3080 --no-open
```

## 3. 打分

```bash
node eval/judge.mjs --port 3080 --limit 20                  # 全部样本
node eval/judge.mjs --port 3080 --limit 15 --kind empty      # 只看空输入框
node eval/judge.mjs --port 3080 --limit 15 --kind draft      # 只看打了字的
node eval/judge.mjs --port 3080 --extra "再加一条规则……"      # 试新提示词
```

输出：

```
## run  shown-mean 4.05/10  shown 20/20 (hidden 0, 0%)  good(>=7) 2  bad(<=4) 13  raw-mean 4.05  p50 2670ms
```

- `shown-mean` 只算**真的会显示给你**的预测——这是产品的实际体验。
- `hidden` 是被守卫/净化吃掉的（你根本看不到），单独看，别混进平均分。
- 每条的明细落在 `eval/last-<label>.json`，也 gitignored。

## 判分标准（`judge.mjs` 里的 `JUDGE_SYSTEM`）

10 = 几乎就是他会说的；7 = 方向对、措辞不同；5 = 沾边但不在点子上，或明显是助手口吻；3 = 跑到别的话题，或像助手的执行步骤；0 = 完全无关。

评审模型默认 `chenyuzhiyun/deepseek-flash`，可以 `--judge` 换。注意**别用推理型模型当评审或当补全模型**：`maxTokens` 会被思考吃光，返回空。

## 已知的坑

- 样本量小（20 条），单次抽样噪声约 ±0.5 分，别把 0.1 的差距当结论；要看趋势就把 `--limit` 调大。
- 考卷里「下一句」有时真的是换话题（尤其空输入框场景），这类天然猜不中，会拉低整体分——所以按 `--kind` 分开看。
- `/replay` 会用你的模型额度，`limit` 别设太大。
