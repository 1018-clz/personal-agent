# Personal Agent

一个专精 Ansys HFSS 的桌面 agent：用户填写自己的模型 API（DeepSeek、通义千问、Kimi、智谱、OpenAI 或任何 OpenAI 兼容接口）就能用。长期记忆用 [Hindsight](https://github.com/vectorize-io/hindsight)，桌面端用 Electron + React，命令在 Windows 沙箱里运行。

架构借鉴 [grok-build](https://github.com/xai-org/grok-build) 和 [rongke](https://github.com/Yrzsh/rongke)，但不依赖它们。HFSS 部分的路线见[HFSS 路线图](#hfss-路线图)。

## 安装（给用户）

运行 `Personal Agent Setup <版本>.exe`。按用户安装，不需要管理员权限，可以改安装位置。装好后：

1. **模型设置**：第一次打开会自动弹出，填厂商、Key 和模型名，见[连接模型](#连接模型)。
2. **环境检查**：点顶栏的「环境检查」，在「HFSS 环境」那一项点「安装 HFSS 环境」。应用会用本机 AEDT 自带的 Python 建环境并装 PyAEDT，要几分钟，需要联网。装好后不用重启，HFSS 直接连上。
3. **记忆（可选）**：同一个窗口里点「安装记忆服务」。要先装 Python 3（带 `py` 启动器），体积较大。不装也能用，只是记不住以前的对话。

安装包里没有 AEDT，需要用户自己装好 Ansys Electronics Desktop 和 HFSS 许可证。Python 环境装在 `%LOCALAPPDATA%\personal-agent\runtime`；卸载应用不会删掉设置、Key、会话和仿真结果。

打包：

```powershell
npm.cmd run dist        # release\Personal Agent Setup <版本>.exe
npm.cmd run dist:dir    # 只生成 release\win-unpacked，不打安装包，调试用
```

还没有代码签名，Windows 第一次运行时可能提示“未知发布者”。

## 快速开始（开发）

如果 PowerShell 提示“禁止运行脚本”，把下面命令里的 `npm` 换成 `npm.cmd`，`npx` 换成 `npx.cmd`，不需要修改系统的执行策略。

不需要 API Key 也能跑，这时用内置的模拟模型，agent 循环、工具、权限和沙箱都是真实的：

```powershell
npm install
npx install-electron
npm run dev:fake
```

发送包含 `tool` 的消息测试写文件和权限弹窗，`edit` 测试修改文件和改动预览（先发一次 `tool` 创建文件），`search` 测试搜索，`command` 测试沙箱命令，`slow` 测试停止，`fail` 测试失败恢复。

## 连接模型

```powershell
npm run dev
```

第一次启动会自动打开「模型设置」，以后点右上角的按钮也能打开：

1. **选厂商：** 自动填好接口地址和上下文窗口。列表里没有的选「其他（OpenAI 兼容）」，自己填地址，本机的 Ollama、LM Studio 也行。
2. **填 API Key：** 「获取 Key」按钮会打开厂商的 Key 页面。
3. **选模型：** 点「获取模型列表」从厂商那里取，或者直接填写模型名。
4. **测试连接：** 发一个带工具的极短请求，模型开始回复就停，几乎不花钱。agent 需要模型支持工具调用，不支持的会在这一步报错。
5. **保存：** 立即生效，不用重启，当前对话也会保留。

Key 怎么保存：

- **加密：** 用 Windows DPAPI 加密，存在 `%APPDATA%\personal-agent\secrets.json`，换一个 Windows 账号或拷到别的电脑都解不开。沙箱里的命令读不到 `%APPDATA%`。
- **只发给原来的地址：** Key 和保存时的接口地址绑定。改了接口地址，要重新填 Key，所以就算界面被动了手脚，也不能把保存的 Key 发到别的服务器。
- **界面拿不到 Key：** 设置页只显示 Key 的最后 4 位。
- **旧的配置：** 以前用 `npm run set-key` 或环境变量 `DEEPSEEK_API_KEY` 设置的 DeepSeek Key 继续有效，第一次在设置页保存时会移进加密文件，`config.json` 里的明文会被删掉。

**不要用 `setx` 保存 Key。** `setx` 把它写进 `HKCU\Environment`，Windows 默认允许沙箱读取这个位置。

## 启用 HFSS

HFSS 工具是 `hfss/hfss_agent`，一个 Python 写的 MCP 服务，应用启动时自动拉起。它要用 PyAEDT，所以要先装一次环境。环境放在项目的 `.hfss` 目录，用 AEDT 自带的 Python 建，不影响系统里的 Python：

```powershell
npm.cmd run install-hfss
```

也可以在应用里点顶栏的「环境检查」，再点「安装 HFSS 环境」，效果一样。

- **需要：** 本机装了 Ansys Electronics Desktop（按安装程序设的 `ANSYSEM_ROOTxxx` 环境变量找，默认用最新版），还要有 HFSS 许可证。
- **顶栏：** 显示“HFSS：已连接”，悬停可以看到工具数。没装环境时显示“不可用”，并说明怎么装。
- **能做什么：** 看任意 `.aedt` 工程里有什么、改变量后求解（S 参数、远场、本征模），以及用 `dr_filter` 配方从零建一个介质谐振器滤波器。详见 [hfss/hfss_agent/README.md](hfss/hfss_agent/README.md)。
- **不碰你的工程：** 只读取 `.aedt` 的副本，原文件不会被 AEDT 打开。
- **仿真结果：** 放在 `%LOCALAPPDATA%\personal-agent\hfss`，可能有几十 GB，可以用 `hfss.dataDir` 换个盘。
- **关掉应用不会中断仿真：** 任务由独立的后台进程执行，下次打开应用还能查到结果。
- **核数和并行数：** 按本机的物理核数和内存自动定。不合适时在数据目录写 `settings.json` 覆盖，见 hfss_agent 的 README。

### 任务面板

窗口右边是「仿真任务」面板，由应用自己每几秒查一次任务队列，不经过模型：

- **进度：** 每个任务显示排第几、在做什么（启动 AEDT、求解、提取结果）、跑了多久、用几核。
- **结果：** 做完的显示是否收敛、要点数字（通带中心、插损、带宽，或模式频率和 Q），以及「需要注意的问题」（见下面的踩坑检查）。
- **取消：** 排队和运行中的任务可以直接取消，不用告诉模型。
- **详情和曲线：** S 参数曲线、每次加密的收敛过程（对数坐标，虚线是收敛目标）、本征模表。
- **对比：** 勾选几个任务点「对比」，或者在一组扫参上点「对比这组」，把同一条曲线（默认 S21）叠在一张图上，下面是要点对比表。网格档位不同时会提醒。

**模型不再自己等仿真。** 提交以后，模型告诉你任务号就结束这一轮。等这一轮提交的任务全部结束，应用自动发一条「自动消息」把结果交给模型分析（对话里显示为虚线框，可以展开看内容）。这样：

- 仿真跑几个小时也没关系，不受一轮最多 25 次模型调用的限制，等待期间也不花钱；
- 只报回提交它的那个会话：你切到别的会话，等切回来再报；
- 面板顶上的「任务结束后自动分析」可以关掉，关掉后任务照样跑，结果你自己问。

### 扫参

想看一个尺寸的影响，模型会一次提交一组（`sweep_project` 扫任意工程的变量，`sweep_recipe` 扫配方参数，一次最多 12 个点），算完用 `compare_jobs` 读成一张表。和以前算过的点一模一样的直接复用。有一个点不合法（比如几何撞车）时一个都不提交，免得算了一半才发现。

### 踩坑检查

每个做完的任务都会自动查一遍"数字看着正常、其实不能信"的情况，结果放在 `pitfalls` 里，模型和面板都看得到，每条都写了怎么改：

- 网格是在离谐振超过 1% 的频率上加密的（要把 `f0_ghz` 设到谐振点重跑）；
- 谐振点贴着扫频边界；
- 只加密 3 次以内就判了收敛，或者最后一次加密时 Δ 反而变大；
- 网格只有几千个四面体；
- 加密到次数上限还没收敛；
- 只求了一两个本征模，却要判断模式间隔。

### 证据检查

模型回复里引用了仿真数字时，回复下面会多一个「证据检查」：

- **来源：** 引用的任务是什么网格、是否收敛（细网格且收敛的才能下结论）。
- **对不上的数字：** 带 GHz、MHz、dB 单位的数字，在这一轮的工具结果、工具参数和你的消息里都找不到的，会列出来。换算单位、四舍五入、两个结果的差值都算对得上。
- **没说明只能看趋势：** 用了粗网格或未收敛的结果，回复里却没有"趋势""粗网格""未收敛"之类的说明。
- **假装提交了：** 回复说"已提交""排上队了"，这一轮却没有调用提交工具。真实模型出现过这种情况，所以专门查。

它只提醒，不拦截、不改写回复。

### 环境检查

顶栏的「环境检查」逐项查：模型、HFSS 环境和工具服务、记忆、AEDT 版本和路径、许可证服务器能不能连上、PyAEDT、数据目录剩余空间、后台 runner、本机核数和内存。没过的项写了怎么修，HFSS 环境和记忆服务能在这里直接安装。模型也可以调用同样的检查（`check_setup`），用户问"为什么跑不了"时用。许可证只能查到服务器连不连得上，有没有空闲的 HFSS 许可要真正求解时才知道。

## 启用记忆

长期记忆由本地的 Hindsight 服务提供，已针对中文配置。没有它也能聊天，只是没有记忆，顶栏会显示“记忆：离线”。

第一次需要安装，它放在项目的 `.hindsight` 目录里，自带 Python，不影响系统环境。检测到 NVIDIA 显卡时会安装 GPU 版：

```powershell
npm.cmd run install-hindsight
```

安装好以后，应用会自动启动它，不用另开终端：

- **启动：** 窗口先就绪，可以直接聊天；顶栏显示“记忆：启动中”，本机约 13 到 18 秒后变成“在线”。这段时间里发的消息没有记忆召回，但会话一旦在线，就会补上记忆规则和用户画像。
- **退出：** 关闭应用时会正常关闭 Hindsight 和它的内嵌数据库。应用崩溃或被强制结束时，Hindsight 会发现自己被丢下，自己关掉数据库再退出。
- **残留的数据库：** 在任务管理器里“结束进程树”，或者关掉运行 `npm.cmd run hindsight` 的终端，Hindsight 来不及关数据库。Hindsight 自己不会关闭别人启动的数据库，所以下次启动时会先把残留的停掉，再自己启动一个。
- **崩溃：** Hindsight 运行中意外退出会自动重启，最多 3 次。启动就失败（比如端口被占用）不会重试，顶栏悬停可以看到原因。
- **日志：** `%APPDATA%personal-agentlogshindsight.log`，保留上一次的 `hindsight.previous.log`。
- **已经在运行：** 如果 8888 端口上已经有 Hindsight（比如你用 `npm.cmd run hindsight` 手动启动的），应用直接用它，退出时也不会关闭它。
- **关闭自动启动：** 把 `hindsight.autoStart` 设为 `false`。`baseUrl` 指向别的机器时也不会自动启动。

第一次启动要下载约 6 GB 的模型，加上运行环境共占用约 12 GB 磁盘。之后模型都在本地，启动时不再联网检查更新。

记忆保存在 `%USERPROFILE%.pg0instanceshindsight`，备份这个目录即可。

## AGENTS.md：agent 的个性和习惯

用 Markdown 写下你希望 agent 怎么做事，每个新会话开始时它都会读到：

| 文件 | 用途 | agent 能否修改 |
|---|---|---|
| `%APPDATA%\personal-agent\AGENTS.md` | 全局：称呼、语气、你的习惯 | 不能，在工作目录之外 |
| `<工作目录>\AGENTS.md` | 工作区：这里的项目和约定 | 能，但每次都要你批准 |

```markdown
# 关于我
- 叫我老板，回答尽量简短，先给结论。
- 我用 Windows 和 PowerShell。

# 做事习惯
- 改文件前先说要改什么。
- 代码注释用中文。
```

- **生效时间：** 新建或打开会话时读取。修改后要新建会话才生效，因为一个会话内系统提示固定不变，这样才能命中 DeepSeek 的上下文缓存。
- **冲突时：** 两个文件说法不一致时以工作区的为准，对话里你当场说的又优先于两个文件。
- **不能放宽权限：** 写在里面的“可以随便删文件”不会跳过批准，权限只由[权限规则](#权限规则)决定。
- **修改工作区的 AGENTS.md 总是询问：** 即使有 `edit_file` 或 `write_file(**)` 这样的允许规则，也不能记住授权，弹窗会注明这是规则文件。否则一段被动过手脚的网页或文件就能让 agent 改写自己以后的行为。拒绝规则仍然有效。这只保护 `write_file` 和 `edit_file`，你批准的命令也可能改到这个文件。
- **大小：** 每个文件最多用前 2 万字符，超出时界面会提示。文件读不了时也会提示，不影响聊天。
- **请 agent 改：** 说“以后都用中文写注释，记到 AGENTS.md 里”，它会修改工作区的文件，你在弹窗里看到 diff 再决定。关于你的事实（住哪、喜欢什么）由记忆保存，不需要写进去。

## 配置

配置文件是 `%APPDATA%\personal-agent\config.json`，所有字段都可省略，示例见 [config.example.json](config.example.json)。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `workspaceDir` | `~/PersonalAgent/workspace` | agent 的工作目录 |
| `model.provider` | `deepseek` | 厂商，用设置页修改 |
| `model.baseUrl` | 厂商的默认地址 | OpenAI 兼容接口的地址 |
| `model.model` | `deepseek-flash` | 模型名 |
| `model.contextWindow` | DeepSeek 100 万，其他 12.8 万 | 模型一次能接收的 token 数，压缩阈值不会超过它的一半 |
| `model.compactAtTokens` | `200000` | 上下文达到这个 token 数时压缩较早的对话 |

旧版本的 `deepseek` 一节仍能读取，在设置页保存后会换成 `model` 一节。API Key 不在 `config.json` 里，见[连接模型](#连接模型)。
| `sandbox.enabled` | `true` | 是否启用命令沙箱 |
| `sandbox.network` | `false` | 沙箱内的命令能否访问互联网 |
| `hindsight.enabled` | `true` | 是否启用记忆 |
| `hindsight.baseUrl` | `http://localhost:8888` | Hindsight API 地址 |
| `hindsight.bankId` | `personal` | 记忆库 ID |
| `hindsight.apiKey` | 无 | 本地默认不需要 |
| `hindsight.autoStart` | `true` | 随应用启动本地安装的 Hindsight，只对本机地址生效 |
| `hfss.enabled` | `true` | 是否随应用启动 HFSS 工具 |
| `hfss.python` | 开发时 `.hfss\env\Scripts\python.exe`；安装版 `%LOCALAPPDATA%\personal-agent\runtime\.hfss\env\Scripts\python.exe` | 装了 PyAEDT 的 Python |
| `hfss.dataDir` | `%LOCALAPPDATA%\personal-agent\hfss` | 仿真任务、结果和工程快照 |
| `mcp.servers` | `{}` | 其他 MCP 服务，见下 |
| `permissions.allow` | `[]` | 不用询问就运行的规则，见[权限规则](#权限规则) |
| `permissions.deny` | `[]` | 直接拒绝的规则，优先于 `allow` |
| `permissions.autoAllowReadOnly` | `true` | 只读命令不用询问，只在沙箱开启时生效 |

其他 MCP 服务的写法和 Claude Desktop 的 `mcpServers` 类似，只支持 stdio：

```json
{
  "mcp": {
    "servers": {
      "origin": { "command": "C:\\Python312\\python.exe", "args": ["origin_mcp_server.py"], "readOnlyTools": ["list_graphs"] }
    }
  }
}
```

工具在 agent 里叫 `服务名__工具名`，例如 `origin__plot_xy`。`readOnlyTools` 里的工具和声明了 `readOnlyHint` 的工具不询问，其他每次都要批准，可以用权限规则放行，例如 `"allow": ["hfss__submit_simulation"]`。

## 架构

```text
渲染进程（React）        聊天界面，只通过 preload 暴露的 window.desktop 与主进程通信
  │ IPC
主进程
  ├─ AppController       装配各服务，处理启动和页面重载
  ├─ TurnOrchestrator    每一轮的 recall → agent → retain
  ├─ Agent               agent 循环：调模型、执行工具、把结果交回模型，直到回复完成
  │   ├─ OpenAICompatibleClient  流式调用任何 OpenAI 兼容的 Chat Completions
  │   ├─ SwitchableModel 设置页保存后换模型，不用重启
  │   └─ tools           文件读写和修改、搜索文件、运行命令、搜索记忆
  ├─ SandboxedShell      在 AppContainer 和 Job Object 里运行命令
  ├─ MemoryService       调用 Hindsight，失败时降级为“没有记忆”
  ├─ HindsightServer     随应用启动、重启和关闭 Hindsight 进程
  ├─ SessionRecorder     监听事件，在每轮结束时保存
  ├─ SessionStore        读写磁盘上的会话
  ├─ PermissionGate      按规则决定每次工具调用：拒绝、直接运行或询问
  ├─ PermissionBroker    挂起需要批准的工具调用，等待用户回答
  └─ McpHub              启动 MCP 服务（HFSS 等），把它们的工具交给 agent
      └─ McpClient       stdio 上的 JSON-RPC，自己实现，不依赖 SDK
```

### 会话存储

会话保存在 `%APPDATA%\personal-agent\sessions\<会话 ID>\`，目录结构借鉴 grok-build：

| 文件 | 内容 |
|---|---|
| `summary.json` | 标题、时间、回合数，用于历史列表 |
| `turns.jsonl` | 界面看到的回合，包括被取消和失败的 |
| `chat_history.jsonl` | 发给模型的消息，包括 `reasoning_content` |

- **按回合原子写入：** `chat_history.jsonl` 一行存一整轮。崩溃时最多丢失还没完成的这一轮，不会留下没有结果的工具调用。
- **系统提示不保存：** 打开旧会话时重新生成，日期和用户画像都是最新的。
- **保存时机：** 每轮结束时写入，第一轮之前不创建任何文件，所以历史列表里没有空会话。启动应用时总是一个新会话。
- **隐私：** 会话文件是明文，可能包含你读过的文件内容。它们和 `config.json` 一样在 `%APPDATA%` 下，沙箱内的命令读不到。
- **删除：** 只删除这个会话的文件。已经提取到 Hindsight 的长期记忆不会一起删除。

### 上下文压缩

每次请求都会重发整个上下文，所以长对话越来越贵。上下文达到阈值时，较早的对话会被 DeepSeek 总结成摘要，放进系统提示，只保留最近约 2 万 token 的原文。界面上的对话不受影响，所有回合都还在，只是模型看到的内容变少了。

- **阈值：** 默认 20 万 token（`model.compactAtTokens`），远低于 DeepSeek 的 1M 窗口，因为没命中缓存时，85 万 token 的上下文一次调用要 0.13 到 0.25 美元。
- **窗口较小的模型：** 回合之间的阈值不超过上下文窗口的一半，回合内不超过 80%。12.8 万窗口的模型在 6.4 万时压缩。
- **回合内更保守：** 一轮进行中，阈值是 3 倍，每轮最多压缩 2 次。回合内压缩会丢掉当前任务要用的工具结果，模型只好重读：实测读 3 个文件，从 12 次模型调用降到 4 次。
- **切分规则：** 不会把工具调用和结果分开，当前这轮的用户消息始终保留。
- **失败时：** 摘要失败不影响对话，这一轮继续用完整上下文，下一轮再试。回合被取消或失败时，压缩也一起撤销。
- **存储：** 压缩是往 `chat_history.jsonl` 追加一个检查点，不改写文件，完整历史一直在磁盘上。
- **摘要是有损的：** 模型可能漏掉细节，也可能加上你没说过的引申。重要的事实由 Hindsight 单独保存，不依赖摘要。

### 回复显示

回复按 Markdown 渲染，支持标题、列表、表格、任务列表、引用和代码块（带语言标签和复制按钮），回复还在生成时也能正常显示。你自己发的消息保持原样，不渲染。

模型的输出不可信（它可能读过被人动过手脚的文件），所以渲染有这些限制：

- **不渲染 HTML：** 回复里的 HTML 标签按原文显示，不会变成元素。
- **不加载图片：** 图片显示成“[图片：说明]”链接。加载远程图片会把 URL 里的内容发出去，这是常见的数据泄露手段。
- **链接：** 只有 http 和 https 链接能点，点击后用系统浏览器打开，窗口本身不会跳转。主进程会再检查一次协议，`file:`、`javascript:` 这类链接会被拒绝。

### 记忆流程

- **新建会话：** 召回用户画像，写入系统提示。
- **每轮发送前：** 用用户消息 recall，取排名前 5 条，包在 `<memory_context>` 里拼到用户消息前面。
- **每轮结束后：** 异步 retain 原始对话。只存用户原话，不存注入后的内容，否则召回的记忆会被当成新事实再存一遍。被取消或失败的回合不写入。
- **任务进行中：** 模型可以调用 `memory_search` 主动查询，这里不做过滤。

### 中文记忆

Hindsight 的默认配置只适合英文，[scripts/hindsight-launcher.py](scripts/hindsight-launcher.py) 做了这些调整（应用和 `npm.cmd run hindsight` 都通过它启动）：

| 层 | 配置 | 原因 |
|---|---|---|
| 向量 | `BAAI/bge-m3` | 默认模型只支持英文。换模型要重新生成全部向量，建库前就要定好 |
| 重排序 | `BAAI/bge-reranker-v2-m3` | 同上 |
| 提取事实 | 设置页选的模型，固定输出中文 | 文档建议查询语言和存储语言一致 |
| 关键词检索 | `native` + `simple` | 官方推荐的 `pgroonga` 需要外部 PostgreSQL，这里没有用 |
| 监听地址 | `127.0.0.1` | 默认的 `0.0.0.0` 没有鉴权，局域网内都能读到记忆 |

几个实测结论：

- **不需要 pgroonga：** 内嵌数据库不能切分中文，但在 49 条相似记忆中，精确词和编号查询都排在第一。这是几十条规模的结论，上万条时可能要重新评估。
- **必须用 GPU：** recall 在 RTX 4070 Ti SUPER 上约 55 毫秒，在 CPU 上约 6 秒，超过了应用 4 秒的超时。没有 NVIDIA 显卡时，记忆会频繁超时。
- **不能只靠分数过滤：** 相关的换说法查询可能只有 0.008 分，而“1+1 等于几？”能到 0.05，所以按排名取前 5 条，只用很低的底线 0.001 去掉明显无关的结果。

记忆也用设置页选的模型提取事实：DeepSeek 用 Hindsight 自带的 DeepSeek 接入，其他厂商按 OpenAI 兼容接入。换了模型或 Key 后，应用会用新设置重启它启动的 Hindsight；你手动启动的那个不会被重启。没设置模型时 Hindsight 不会启动，顶栏会说明原因。

### 模型接口的几个约定

- **思考内容要回传：** DeepSeek 带工具的请求必须附上之前各轮的 `reasoning_content`，否则返回 400，所以历史消息会保留它。只有模型返回过思考内容时才会回传，不返回的厂商（如 OpenAI）收不到这个字段。
- **关闭思考只对 DeepSeek 发：** 压缩摘要时会关闭思考，这个开关是 DeepSeek 特有的字段，其他厂商收到不认识的字段可能报错，所以只发给 DeepSeek。
- **系统提示固定：** 上下文缓存按前缀匹配，一个会话内系统提示不变，日期只在新建会话时写入。
- **取消或失败时回滚：** 没有响应的工具调用会让后续请求被拒绝，所以这一轮会整体从历史中移除。

## 沙箱

grok-build 的沙箱只支持 Linux 和 macOS，所以这部分是针对 Windows 自己实现的，策略借鉴它的 `strict` 配置。`run_command` 通过 [native/sandbox-runner.cs](native/sandbox-runner.cs) 运行，这个小程序在第一次运行命令时由系统自带的 `csc.exe` 编译。

| 项目 | 沙箱内 |
|---|---|
| 工作目录 | 可读写 |
| 用户文件、`%APPDATA%`、其他盘 | 不可访问 |
| 系统目录 | 只读 |
| 互联网 | 默认禁止，`sandbox.network` 可打开 |
| 本机服务（包括 Hindsight） | 禁止，打开网络后也一样 |
| 环境变量 | 只保留系统必需的白名单，API Key 不会传入 |
| 管理员权限 | 没有，以 Low 完整性级别运行 |
| 进程 | 最多 64 个，内存上限 4 GB；命令结束或被取消时整棵进程树一起终止 |
| 超时 | 120 秒 |

- **失败时拒绝运行：** 沙箱起不来时命令不会执行，不会退回无沙箱模式。
- **仍需批准：** 沙箱是第二道防线，每条命令依然要你批准，弹窗会写明运行方式。
- **关闭沙箱：** `sandbox.enabled` 设为 `false` 后，命令以你的用户权限运行，弹窗会给出警告。环境变量白名单仍然生效。
- **系统改动：** 第一次运行时会创建名为 `PersonalAgent.Sandbox` 的 AppContainer 配置，并给工作目录加一条该容器的访问权限，不修改其他 ACL。

### 已知限制

- **`HKCU\Environment` 可读：** 这是 Windows 对所有应用包的默认授权。更严格的 LPAC 能挡住它，但 Windows PowerShell 5.1 无法在 LPAC 中启动。所以密钥不要用 `setx` 保存，已有的用户环境变量也可能被命令读到。
- **只有 ACL 开放给应用包的程序可用：** `git` 可用；Node.js 的安装目录没有开放，`node` 不可用；`python` 的 WindowsApps 别名也不可用。
- **部分 `cmd` 内建命令不可用：** 比如 `cmd /c dir` 需要读取父目录，请用 `Get-ChildItem`。PowerShell 中工作目录显示为 `Work:\`。
- **网络隔离依赖 Windows 防火墙服务：** 如果该服务被停用，网络隔离可能失效。

## 文件工具

| 工具 | 作用 | 需要批准 |
|---|---|---|
| `list_directory` | 列出目录 | 否 |
| `read_file` | 读取文本文件，最大 200 KB | 否 |
| `search_files` | 按内容或文件名搜索 | 否 |
| `write_file` | 创建或覆盖整个文件 | 是 |
| `edit_file` | 把一段原文精确替换成新内容 | 是，弹窗显示改动的 diff |

**`edit_file`：**

- **必须唯一：** 原文找不到或出现多次时直接报错给模型，不会弹窗打扰你；多处都要改时模型可以设置 `replace_all`。
- **写入的就是你看到的：** 批准后如果文件被改动过，不会写入，模型需要重新读取。
- **换行符：** 文件用 `
` 时，模型写的 `
` 会自动对应，修改后仍是 `
`。
- **只改 UTF-8 文件：** GBK 等编码的文件会被拒绝，因为按 UTF-8 写回会把中文变成乱码。

**`search_files`：**

- **两种用法：** 给 `query` 按内容搜索，返回“路径:行号: 内容”；只给 `file_pattern`（如 `*.md`、`src/**/*.ts`）按文件名查找。
- **默认按原文匹配：** 设置 `regex` 后才当正则表达式，`ignore_case` 忽略大小写。
- **跳过：** `.git`、`node_modules`、二进制文件、超过 1 MB 的文件，以及符号链接和目录联接，所以链接不能把搜索带出工作目录。
- **结果上限：** 最多 200 条匹配或 500 个文件，超出时会提示缩小范围。
- **正则超时：** 模型写的正则可能回溯爆炸，让主进程卡死。匹配在 `vm` 里运行，整次搜索最多 10 秒，超时报错给模型。

## 权限规则

每次工具调用按这个顺序决定：

1. **拒绝规则**匹配就直接拒绝，告诉模型不要换写法重试。只读工具也受它限制。
2. **只读工具**（`read_file`、`list_directory`、`search_files`、`memory_search`）直接运行。
3. **允许规则**匹配就直接运行，依次检查 `config.json`、`permissions.json` 和本会话记住的规则。
4. **只读命令**直接运行，比如 `Get-ChildItem`、`Get-Content x | Select-String y`。
5. 其他情况弹窗询问。

对话里每次工具调用都会显示它操作的内容：命令、文件路径或搜索词。没有询问就运行的调用会注明原因，比如“未询问：只读命令，自动运行”或“未询问：规则 run_command(git status *) 允许”，所以免询问的命令也看得到。

### 规则写法

规则是工具名，或者工具名加括号里的模式：

| 规则 | 含义 |
|---|---|
| `run_command` | 所有命令 |
| `run_command(git status *)` | `git status` 和 `git status -s` 等，结尾的 ` *` 表示后面可以没有参数 |
| `run_command(npm test)` | 只有 `npm test` 这条命令 |
| `edit_file(notes/**)` | 修改 `notes` 下的任何文件，路径相对于工作目录 |
| `write_file(*.md)` | 写入工作目录根下的 `.md` 文件 |
| `memory_search` | 拒绝时使用，禁止搜索记忆 |

只有 `run_command`、`write_file` 和 `edit_file` 可以带模式。规则写错（比如工具名拼错）时应用不会启动，并提示是哪一条，因为悄悄忽略一条拒绝规则比启动失败更危险。

```json
{
  "permissions": {
    "allow": ["run_command(git status *)", "run_command(git log *)", "edit_file(notes/**)"],
    "deny": ["run_command(Remove-Item *)"]
  }
}
```

### 记住授权

弹窗里有“本会话内都允许”和“始终允许”，并显示会记住哪条规则：

- **命令：** 记住前两个词，比如 `git commit -m x` 记成 `run_command(git commit *)`。`python`、`powershell`、`cmd`、`node` 这类能运行任意代码的程序只记住完整命令。
- **文件：** 记住这个文件，比如 `edit_file(notes/a.md)`。
- **本会话：** 新建或打开其他会话时失效。
- **始终：** 保存在 `%APPDATA%\personal-agent\permissions.json`，删除其中的规则即可撤销。这个文件不在工作目录里，agent 改不了它。文件损坏时应用不会覆盖它，规则只在本次运行中生效。
- 多条语句或管道组成的命令没有可记住的规则，每次都会询问。

### 安全边界

- **带 `*` 的允许规则只匹配单条命令：** `run_command(git status *)` 不会放行 `git status; Remove-Item x`，也不会放行带 `|`、`>`、`$(…)`、`&` 的命令。
- **只读命令判断很保守：** 每条语句和每个管道阶段都必须是只读的 cmdlet（`Get-ChildItem`、`Get-Content`、`Select-String`、`Measure-Object` 等），不能有变量、子表达式、脚本块、重定向、驱动器路径（`HKCU:`、`C:\`）、`~` 和网络路径。不确定的都会询问。
- **只读命令只在沙箱里免询问：** 关掉沙箱后命令能读到你的所有文件，内容会发给 DeepSeek，所以每条都要询问。
- **拒绝规则是尽力而为：** PowerShell 有别名（`ri` 就是 `Remove-Item`）和很多绕过写法，拒绝规则只能挡住常见写法。真正的边界是沙箱。

## MCP 工具

MCP 客户端是自己写的（[src/main/mcp/client.ts](src/main/mcp/client.ts)），借鉴了 rongke 踩过的坑：

- **失败就是失败：** 服务端标了 `isError`，或者返回的 JSON 里 `"ok": false`，这次调用都算失败。否则模型会把一次失败当成结果用。
- **服务端崩溃：** 所有等待中的调用立刻失败，错误里带上它最后的输出，不会一直等到超时。下次调用时自动重启一次，再崩就不重启了，免得掩盖一个反复崩溃的服务。
- **超时和停止：** 每次调用有超时，停止回合时会通知服务端取消。
- **不给密钥：** 服务端拿到的环境变量里去掉了名字带 `API_KEY`、`SECRET`、`TOKEN`、`PASSWORD` 的。

**MCP 服务不在沙箱里：** 它们以你的用户权限运行，能读你的文件（HFSS 工具要读你指定的 `.aedt`）。所以会改变东西的工具（提交仿真、取消任务）每次都要批准；只读的工具（查看工程、查进度）直接运行。HFSS 工具只读取工程的副本，结果写在它自己的数据目录。

## 其他安全措施

- 窗口开启 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`，并禁止页面跳转和打开新窗口，因为聊天记录是不可信的模型输出。
- `write_file`、`edit_file` 和 `run_command` 默认每次都要用户批准，弹窗会显示具体内容。规则可以放宽或收紧，见[权限规则](#权限规则)。
- 文件工具在主进程里运行，不经过沙箱，靠路径检查限制在工作目录内，并解析符号链接防止越界。
- 记忆内容可能来自外部来源。系统提示声明它只是数据，代码也会转义 `<memory_context>` 标签，防止提前闭合。

## 开发

```powershell
npm run typecheck
npm test
npm run build
```

`tests/sandbox.test.ts` 会从真实沙箱内部尝试逃逸，每项拒绝都有对照，证明拦截来自隔离本身。

用真实 DeepSeek 和 Hindsight 验证完整流程（会产生少量费用；测试不经过应用，需要先用 `npm.cmd run hindsight` 启动 Hindsight）：

```powershell
npm run test:live
```

## 借鉴 grok-build 的路线图

这里借鉴的是设计，没有复制它的代码。如果以后要搬代码，它是 Apache-2.0 许可，需要保留版权和许可声明。

| grok-build 模块 | 本项目 | 状态 |
|---|---|---|
| `xai-grok-agent`、`xai-grok-shell`（agent 运行时） | `Agent` | 已完成 |
| `xai-grok-sampler`（模型调用） | `OpenAICompatibleClient` | 已完成：任何 OpenAI 兼容接口，设置页切换 |
| `xai-grok-sandbox`（沙箱） | `SandboxedShell` | 已完成，Windows 版自行实现 |
| `xai-grok-tools`（工具） | `tools.ts` | 已完成：读写、局部修改、搜索 |
| `xai-grok-memory` | Hindsight | 已替换，已针对中文配置 |
| `sessions/`（`chat_history.jsonl`、`summary.json`） | `SessionStore` | 已完成 |
| `xai-compaction-transcript`（上下文压缩） | `compaction.ts` | 已完成：自动压缩，暂无手动 `/compact` |
| `xai-grok-permission-rules`（允许/拒绝规则分层） | `PermissionGate` | 已完成：允许/拒绝规则、记住授权、只读命令免询问 |
| `AGENTS.md` 项目规则 | `instructions.ts` | 已完成：全局和工作区两个文件，修改工作区文件总是询问 |
| Skills（`SKILL.md`） | 无 | 计划 |
| `xai-grok-mcp`（MCP） | `McpHub` / `McpClient` | 已完成：stdio，内置 HFSS，可配置其他服务 |
| 子 agent、Hooks | 无 | 以后再说 |

## HFSS 路线图

HFSS 能力来自作者此前已经验证过的工作：`hfss_agent` 是一个 Python MCP 服务（任务队列、网格档位和收敛判定、快照副本保护原工程、`dr_filter` 配方和任意工程的变量扫描），`pyaedt-hfss-antenna` 是 PyAEDT 参考资料（MIT 许可，作者 WishingCat）。另外借鉴 [rongke](https://github.com/Yrzsh/rongke)（Apache-2.0）的设计，不复制代码。

| 步骤 | 内容 | 借鉴 | 状态 |
|---|---|---|---|
| 1 | 模型 API 设置：多厂商、加密保存 Key、测试连接 | rongke `config.py` / `llm.py`（BYOK、各家网关差异） | 已完成 |
| 2 | 把 `hfss_agent` 复制进本项目 `hfss/`，本机参数改成自动探测（AEDT 版本和路径、核数、内存阈值） | | 已完成 |
| 3 | MCP 客户端：stdio JSON-RPC，服务端报错要变成失败，不能当成功 | rongke `mcp_client.py` | 已完成 |
| 4 | HFSS 规则进系统提示：先本征模再驱动模、只用 fine 且收敛的数字下结论、并行提交扫参 | hfss_agent 的 INSTRUCTIONS，rongke `pitfalls.py` | 已完成：规则加上结果出来后的自动踩坑检查 |
| 5 | 长任务：等待不靠模型反复查询；任务面板；任务结束后自动交给模型分析 | | 已完成 |
| 6 | 结果可追溯：回复里的仿真数字要能对上任务结果，粗网格和未收敛要说明 | rongke `gate.py`（证据门） | 已完成：只提醒，不拦截 |
| 7 | 环境自检：AEDT、Python、pyaedt、许可证，缺什么、怎么补，能装的直接装 | rongke `setupdoctor.py` | 已完成 |
| 8 | 安装包 | | 已完成：NSIS，按用户安装，环境在首次使用时装 |
| 9 | 曲线和对比：S 参数、收敛过程、本征模表，多个任务叠图 | | 已完成 |
| 10 | 扫参：一次提交一组，算完一张表比较 | | 已完成；自动优化（给目标让它自己迭代）还没做 |

## 目前的限制

- 会话标题取自第一条消息，不能重命名，也不支持搜索。
- 删除会话不会删除已提取的长期记忆，目前也没有浏览和删除记忆的界面。
- Hindsight 启动要十几秒，这段时间发的消息没有记忆召回。
- 压缩只能在回合之间和回合内自动触发，没有手动命令，也看不到摘要内容。
- 单轮工具结果过大、压缩 2 次后仍超过上下文窗口时，模型厂商会拒绝请求。
- 网络中断、429 限流和 5xx 服务端错误会自动重试 3 次（等 1、3、8 秒，服务端给了 `Retry-After` 就照它等，最多 20 秒）。但只在还没显示任何文字时重试：回复写到一半断了，这一轮就结束，需要手动重发。
- 代码块没有语法高亮。
- 记住的规则没有管理界面，需要手动编辑 `permissions.json`。
- 界面上看不到当前会话用了哪些 AGENTS.md。
- 安装包没有代码签名，也没有自动更新。
- 证据检查是启发式的：差值也算"对得上"，所以它能发现编出来的数字，但发现不了算错的差值；百分比和不带单位的数字不查。
- 自动分析在一轮提交的任务全部结束后才报：同时提交了很快的粗网格和很慢的细网格时，要等慢的那个。
- 扫参一次只扫一个变量；还没有"给目标让它自己迭代"的自动优化。

## 验证状态

- **已验证：** 真实 DeepSeek（`deepseek-flash`）的流式回复、多轮工具调用、`reasoning_content` 回传、沙箱命令、中途停止后继续对话；真实 Hindsight 的中文写入和召回；记忆跨会话、跨应用重启保留；会话在正常退出、中途停止和进程被强制结束后都能恢复并继续对话；压缩后早期事实保留，压缩过的会话重启后可继续；Hindsight 随应用自动启动，正常退出和应用崩溃后都不残留进程，已在运行的 Hindsight 会被复用；真实回复的 Markdown（标题、表格、代码块、列表、链接）在浅色和深色主题下渲染正确，复制按钮可用。这些都在真实窗口里走过，压缩用的是小阈值。
- **模型设置：** 设置页在浏览器里用模拟的主进程走过一遍（选厂商、获取模型列表、测试连接、保存、重新打开只显示 Key 末 4 位）。真实的 AppController 在测试里（不是 Electron 窗口）对着本地假服务器验证过：没设置模型时会提示，保存后不重启就换上新模型并回复。
- **HFSS 工具服务：** 通过应用自己的 MCP 客户端调用复制进来的 hfss_agent，用 AEDT 2025 R2 真实求解了 `dr6g` 滤波器（粗网格），结果和原项目的记录完全一致：f0 7862.5 MHz、插损 0.56 dB、带宽 14.6 MHz、14578 个网格（`npm run test:live`）。数据目录经命令行传到了 WMI 启动的 runner，AEDT 版本是自动找到的。离线测试 20 项全部通过（`npm run test:hfss`），包括新加的曲线、踩坑检查、环境检查和扫参。作者自己的设计和测量数据（`hfss/hfss_agent/tests/fixtures`）不随公开仓库发布，没有它时对照历史数据的 4 项和真实求解测试会跳过，其余照常跑。
- **任务面板、自动分析、曲线、证据检查、扫参（真实窗口）：** 用真实 DeepSeek 和 AEDT 走过两次完整流程。一次是 `dr_filter` 本征模扫 Lx 三个点，一次是驱动模扫 Lx 三个点：模型提交后不等就结束这一轮，面板实时显示排队、阶段和用时，三个任务全部结束后应用自动发消息，模型用 `compare_jobs` 读表并分析，回复下有证据检查。驱动模的结果：带宽随 Lx 从 8.1 增到 11.4 MHz，叠图和表格一致。踩坑检查在真实结果上正确标出了"只加密 3 次""网格只有 711/1839 个四面体""只求了 2 个模式"。真实模型说过一次"另外提交了两件事"却没调用工具，因此加了"假装提交"检查和对应的规则；加规则后再跑一次，模型就说明了"都还没提交，等你决定"。
- **安装包：** `npm.cmd run dist:dir` 生成的程序在本机运行过：设置和 Key 和开发版共用；没有 HFSS 环境时顶栏提示，环境检查里点「安装 HFSS 环境」约一分钟装好（pip 有缓存），不重启就连上，模型随即能调用 `check_setup`。`npm.cmd run dist` 生成的安装包（约 117 MB）没有在本机实际安装过。
- **尚未验证：** 在别的电脑上从安装包装起；从安装包装记忆服务；终端解、多模端口和三端口以上的工程（原项目就没验证过）；只装了 AEDT 旧版本或没有 HPC 许可证的机器；DeepSeek 以外的真实厂商（通义、Kimi、智谱、OpenAI 等都没有用真 Key 测过）；Electron 窗口里的设置页和 DPAPI 加密；换模型后 Hindsight 用新模型提取事实；`deepseek-v4-pro`；几千条以上记忆时的检索质量和延迟；默认 20 万 token 阈值下的真实长对话；没有 GPU 的机器；安装脚本的完整重装（本机是分步安装的）。
