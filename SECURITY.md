# 安全模型 / Security model

这份文档说明 **dsh-tab-complete** 信任什么、接受什么输入、**会把你的对话送到哪里去**。
它从实现里读出来：`src/host.js`（宿主半边与 7 个端点）、`src/core.js`（提示词与清洗）、
`src/client.cjs`（插槽组件与 Tab 采纳）、`scripts/build.mjs`（`src/ → lib/` 的构建）。
**如果文档和代码不一致，以代码为准。**

> 一句话：每次补全都是**一次真实的小模型调用**——它会把你最近几条对话、当前草稿、
> 以及当前工作目录的顶层文件名发给配置的那个模型服务商。它不是本地推断。

## 信任边界

| 表面 | 谁碰得到 | 鉴权 |
| --- | --- | --- |
| `GET /dsh-tab-complete/state` | 能连上 DSH web server 的人 | **没有**（这是唯一一条没走 loopback 检查的端点，见下） |
| `POST /suggest`、`POST /replay` | 本机进程（`127.0.0.1` / `::1`） | 只有回环判断 |
| `POST /enabled`、`GET /prompt`、`GET|POST /style`、`GET /transcript` | 本机进程 | 只有回环判断 |
| 客户端半边（`conversation.input.overlay` 插槽） | 你打开的 DSH Web 页面 | 无（页面本身无认证） |

**视为不可信输入的：**

- **模型返回的文本**：先经 `sanitizeCompletion` / `sanitizePartial`（单行、去包裹标点、
  去回显草稿、`maxCompletionChars` 截断、不切半个代理对），再作为**文本**进幽灵层；
- **请求体**：`readBody` 上限 **64 KiB**，解析失败当 `{}`，不抛栈；
- **草稿**：`asText` 只收字符串，`draft.length > 4000` 直接返回 `draft-too-long`，不调模型；
- **会话对象**：`deriveMessages()` / `session.log` 都当只读数据用，`transcriptOf` 有
  `maxMessages` / `maxChars` 双重预算（默认 6 条 / 2200 字符）；
- **工作目录**：`readdirSync(cwd)` 的**文件名**（不含内容），跳过 `.` 开头与 `node_modules`，
  超过 30 个子项的目录整条丢掉——只为了避免把模型锚在错误的项目名上。

## 鉴权与权限现状（照实写）

- **没有令牌，没有账号**。唯一的门是 `isLoopback(req)`：比对 `req.socket.remoteAddress`
  是否 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`。
- **`GET /dsh-tab-complete/state` 没有这道门**。其余全部端点都有。也就是说：DSH 的 web server
  一旦被绑到内网地址（或经隧道暴露），`/state` 会对外给出配置项、计数器、`lastSession`
  （会话 id）、`lastWorkspace`、`lastError`。这些是它**正在处理**的东西，不是你的对话正文，
  但仍是不该公开的运维信息。README 里「只接受来自 loopback 的请求」这句对 `/state` 不成立。
- **loopback 判断的是地址，不是身份**：任何以你的用户身份运行的本机程序都能调这些端点，
  包括 `/replay`——它接受调用方自己给的 `messages` / `system` / `user` / `maxTokens` /
  `raw`，等价于「用你配置的模型额度发任意提示词」。它被设计成本机离线评测入口（README「它是怎么被调的」），
  不是给不受信任的一方用的 API。
- **它花钱**：`/suggest` 与 `/replay` 都真实调用 `llm.stream`。没有全局预算、没有每日配额，
  只有「同一会话一个在飞请求 + 最短间隔 120 ms + 2 分钟缓存」这层节流。

## 数据与副作用

- **写**：只有 `<家目录>/.dsh/tab-complete-style.json`——你**采纳过的句子**（最多 40 条，
  `normalizeExample` 去重后追加，1.5 秒防抖落盘）。`POST /style {clear:true}` 写回 `[]`。
  文件是明文、不设权限位；它留在本机、不进 git、不上传（除非你自己把它贴出去）。
- **读**：内存里的会话对象（`sessions.get(id)` 的 `log` / `deriveMessages()`）、
  当前工作目录的**文件名列表**、上面那个 style 文件。
- **网络出口（重要）**：插件自身不发任何 HTTP 请求，但它**驱动宿主去调模型**——
  每次补全把下面这些交给配置的 `provider`/`model`：系统提示词、最近 N 条对话的裁剪版、
  当前草稿、工作目录顶层文件名、最近 6 条采纳过的句子。**目标端点由你的模型路由决定**，
  可能不是官方 API；插件不知道也不控制那一跳的隐私策略。
- **遥测**：无。计数器只在内存里，供面板与 `/state` 读。
- **模型上下文**：补全不走会话、不写会话记录、不占 Harness 的上下文预算（README 的口径）。

## 已知限制（真实取舍，不是 bug）

1. **`/state` 比其它端点松**：唯一的无 loopback 检查入口（见上）。要改就是加一行判断的事，
   但那是行为改动，本版没动。
2. **回环 = 同用户边界**：同一账户下的任何进程都能触发模型调用与读 style 文件。
3. **`/replay` 是任意提示词出口**：设计给离线评测；本机任何进程都能用你的额度。
4. **对话内容会离开本机**：这是补全的前提。不想让某个会话的上下文出去，就把 `enabled` 关掉，
   或把 `provider`/`model` 指到一个你信任的端点。
5. **依赖宿主输入框的 DOM 标记**（`data-composer-card` / `data-composer-input`）与
   `inputActions.captureInsertion/insertText/setDraft`；宿主大改输入框结构时这里会失效。
6. **落字是 CAS，不是事务**：`insertText(text, span)` 带 `draftRev` 校验，失败退回 `setDraft`；
   极端并发下仍可能出现「采纳的文本贴到末尾而不是光标处」。
7. **补全质量是概率**：真实会话上的评测分在 4/10 上下（README 自己写着），不对就 <kbd>Esc</kbd>。
8. **style 文件是明文的**，没有 0600；同机其他用户若可读你的家目录，也能读到这些句子。
9. **超时 9 秒**；超时/中断只是「没有建议」，不会重试烧钱。

## 明确不算漏洞的

- 正常使用会把对话尾部发给模型服务商（这是功能本身，见限制第 4 条）；
- 本机其他进程调用 `/suggest` 花钱（回环即同用户，见限制第 2、3 条）；
- 幽灵文本内容不合你意、误伤「接着写测试」这类句子（质量取舍，`suppressSteps: false` 可关）；
- 你自己打开 `/state` 或 devtools 看到会话 id；
- 补全没有写进会话记录（设计如此）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-tab-complete/security/advisories/new>

个人项目，**不承诺响应时限**；会读、会修，修完写进 [CHANGELOG](CHANGELOG.md)。
请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护最新版 `0.3.x`（`package.json` 为 `0.3.0`）。注意 **npm 上的 `dsh-tab-complete` 停在
`0.1.1`（2026-08-15）**，不代表本仓库的当前状态；以仓库默认分支与本地构建为准。
