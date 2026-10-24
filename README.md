# dsh-hot-restart

**一句话：在设置里点一下，重启 DeepSeek​ Harness，回来之后每个被打断的对话都接着自己那件事继续干。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **来源说明**
>
> 本项目基于 [Minester9421/dsh-hot-restart](https://github.com/Minester9421/dsh-hot-restart)
> （MIT）修改而来，保留了原作者的重启通道设计与「只唤醒目标会话」的安全边界。
>
> 在此基础上做了较大幅度的重写与扩展，主要改动见下方「相对上游的改动」。
> 原作者的 `scripts/install-desktop-generation.mjs` 与 `.d.ts` 类型声明在本仓库中未包含。

---

## 相对上游的改动

| 方向 | 改动 |
|---|---|
| **多对话唤醒** | 一次重启唤醒**所有**被打断的对话，不再只唤醒发起者。账本由单条 `pending` 改为 `pendingWakes` 列表，旧格式自动升级 |
| **每对话独立续接消息** | 每个对话收到的续接指令由**它自己的日志尾部**生成（最后一条真实人类请求 + 中断时在做什么），调用方的 prompt 只发给调用方自己 |
| **macOS 支持** | 新增 `lib/channel.js`：macOS 的 `app.asar` 里没有任何重启 IPC，改由一次性 launchd 助手在进程组之外重开应用 |
| **零依赖** | 移除了对 `schemastery` / `@deepseek-ai/*` 的 import。这些包在 `app.asar` 内，profile 插件解析不到，import 会让整个 Host 起不来。Config 改为自行实现 Standard Schema |
| **防绕过** | 新增 `tools/pre-execute` 硬拦截：bash 里直接调 `scheduleRestart` / `RestartChannel` / `launchctl` / `pkill` 会被拒绝，强制走 `hot_restart` 工具 |
| **测试** | 62 → 109 个测试，新增 bypass 拦截、多对话唤醒、续接消息隔离等回归测试 |

---

## 这是什么

这是一个 **DeepSeek​ Harness 的插件**（不是独立软件，装进 DSH 里用）。

它解决一个具体问题：**改完插件 / 配置之后必须重启 Harness 才生效，而重启会把当前对话打断。**

装上它之后：

1. 打开「设置 → 热重启」；
2. 选一个要接着聊的对话；
3. 点「安排重启」；
4. 应用重启，**被选中的对话 + 所有正在执行任务 / 上次被打断的对话**都会收到一条「继续未完成的工作」。

### 多对话同时继续

重启替换的是**整个进程**，所以不是「只该恢复一个对话」——所有被打断的工作都需要在新进程里继续。默认行为因此是**唤醒全部**：

- 设置面板里「同时唤醒所有正在执行任务的对话」默认勾选，面板会列出这次会一起唤醒的对话；
- 模型调用 `hot_restart` 时默认也唤醒全部（`allConversations` 默认 `true`），可用 `sessionIds` 追加，或设 `allConversations: false` 只唤醒自己；
- 判定「需要继续」的依据是硬事实，不靠猜：该对话的 agent 仍在运行，或者它的日志停在一个没有 `turn/end` 的 turn 里（进程正好死在工作中间）。

每个对话独立唤醒：某个对话找不到 / 被归档 / attach 失败，**不会**挡住其它对话，失败原因会记进面板和历史。

---

## 为什么 Mac 和 Windows 不一样

这是本项目存在的根本原因，也是它和你可能见过的其它热重启插件最大的区别。

| | Windows | macOS |
|---|---|---|
| 官方重启入口 | `window.dshDesktop.restartHarness()` | **不存在** |
| IPC 通道 `harness:restart` | 有 | **不存在** |
| 主进程里的重启 `ipcMain.handle` | 有 | **没有** |
| 插件能用的重启方式 | 调官方入口 | **launchd 助手脚本** |

macOS 版 `0.2.0-rc.2` 的 `app.asar` 里，`restartHarness` 和 `harness:restart` 都是 **0 处**；30 个 `ipcMain.handle` 里没有任何一个跟 restart / relaunch / quit 有关。唯一的重启是主进程自己调 `app.relaunch()`，而那两处调用分别是「崩溃恢复对话框」和「开发模式菜单」——插件都够不着。

所以 Mac 上只能绕：**写一个 launchd 任务，让它在应用进程组之外把应用杀掉再拉起来。**

### 为什么必须走 launchd

直接从应用内部（或应用派生的 shell）执行 `pkill` + `open` **不行**：应用退出时会清理自己的整个进程组，脚本会在「已经关掉、还没重开」的半路被连带杀死，结果就是**应用关了再也起不来**。

launchd 托管的进程不在那个进程组里，能活到执行 `open` 的那一步。

### 一次性助手（重要）

早期版本在这个问题上踩过坑：留下的 `RunAtLoad=true` 任务会在之后每次 `launchctl bootstrap` 同一个 label 时**再次执行**，表现为「应用莫名其妙自己重启」。所以本插件的助手是严格一次性的：

1. label 每次请求都不同：`com.dsh.hotrestart.<随机 token>`，绝不复用；
2. 脚本**先**删掉自己的 plist 和脚本文件，**再**去动应用；
3. 加 `LaunchOnlyOnce`，即使 plist 还在也不会二次触发；
4. 跑完磁盘上什么都不剩。

> 注意：脚本里**不能**写 `launchctl bootout`。bootout 会杀掉正在执行这个脚本的那个 job，脚本会在重开应用之前就死掉。删 plist 才是「一次性」的正确做法。

---

## 安全边界：绝不唤醒错的对话

唤醒这件事一旦出错，代价是**在别人的对话里凭空冒出一句「继续」**。所以每次安排重启时，都会把目标对话的指纹一起记下来：

```js
{ sessionId, cwd, createdAt, origin, parentSession, delegationDepth, agentPreset }
```

重启回来后逐项比对，**任何一项对不上就拒绝唤醒**，并在面板里说明原因：

- `session-not-found` — 对话已经不在了
- `session-id-mismatch` / `cwd-mismatch` / `created-at-mismatch` — 不是同一个对话
- `subagent-session` — 是子代理的会话，不该被当成主对话唤醒
- `session-archived` — 对话已归档

另外还有一条同样重要的规则：**只有「下一次启动」才允许唤醒。**

写入重启请求的那个进程，如果在自己还活着的时候就把唤醒投递了，看起来像成功、实际上根本没重启。所以账本里记了 `bootId`，唤醒只欠给下一个 boot。

投递本身也是可重放的：唤醒消息里带标记 `[[dsh-hot-restart wake=<id>]]`，重试前先查会话日志，已经投递过就不再投第二次。

---

## 安装

```bash
# 1. 放进 profile 的 node_modules
cp -R dsh-hot-restart ~/.dsh/profiles/desktop/node_modules/

# 2. 加进 profile 的 package.json
#    dsh.profile.bundles 里追加 "dsh-hot-restart"
#    dependencies 里追加 "dsh-hot-restart": "file:/path/to/dsh-hot-restart"

# 3. 重启应用
```

装好后「设置」里会出现 **热重启** 一栏。

---

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `autoWake` | `true` | 重启后自动唤醒；关掉则留待手动处理 |
| `graceMs` | `1500` | 安排到真正重启之间的等待 |
| `restartTtlMs` | `60000` | 重启请求的有效期 |
| `maxRestartAttempts` | `3` | 单次请求最多派发几次重启 |
| `maxWakeAttempts` | `5` | 唤醒最多重试几次 |
| `ui` | `true` | 是否在设置里显示这一栏 |
| `tools` | `true` | 是否给 Agent 提供 `hot_restart` 工具 |

---

## 面板会告诉你走的是哪条路

「重启通道」一栏会明确显示：

- **桌面外壳官方入口（Windows）** — 由当前窗口调 `restartHarness()`
- **launchd 助手（macOS）** — 由宿主生成一次性助手，经 launchd 重开应用
- **不可用** — 两条路都没有，面板会说明原因

这一点很关键：Mac 上官方入口本来就不存在，如果面板不说明，看起来就像「坏了」。

---

## 开发

```bash
npm test          # 62 个测试
```

测试**不会**真的重启你的应用：引擎的 channel 在测试里一律换成记录用的替身。这一条是硬要求——真实 channel 会往 `~/Library/LaunchAgents` 写文件并杀掉应用。

---

## License

MIT
