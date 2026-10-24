# dsh-window-size-keeper

[English](README.md) | 中文

DSH 桌面端窗口大小保持插件（host 侧 + 设置页分区，零外部依赖）。

> 更新记录：英文 [CHANGELOG.md](CHANGELOG.md) / 中文 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（两份一起维护）。
> 发布台账 `RELEASES.txt`、建仓与投稿说明 `PUBLISHING.md`、市场投稿条目 `submission/` 只在这份 checkout 里（它们不在发布出去的包中，见文末「本机上的东西各放在哪」）。

## 解决的问题

DSH 桌面端（Electron）每次启动都以固定默认尺寸（1280×820）重建主窗口，用户上次调整的窗口大小会丢失。本插件记录主窗口最后的外框尺寸（含标题栏与边框，物理像素），在下次启动时自动恢复并居中；并在 DSH 设置页提供「窗口大小」分区，可直接选 1920×1080、1280×720 等常用分辨率或任意自定义宽高。

## 设置页「窗口大小」分区（2026-10-11 新增）

DSH 桌面端 → 设置 → **窗口大小**（与「插件」「桌宠」同一层，`order: 65`）。分区里可以：

| 控件 | 作用 |
| --- | --- |
| 恢复尺寸单选 | 「上次尺寸」（默认）／12 个常用分辨率／「自定义…」 |
| 自定义宽高输入 | 任意宽高（外框物理像素），点「应用自定义尺寸」 |
| 恢复时居中 开关 | 居中到主屏工作区；关掉则只改大小、不动位置 |
| 立即应用当前选择 | 不改设置，只按当前选择重新 resize 一次 |
| 当前外框尺寸 / 下次启动将用 / 文件路径 | 状态展示 |

**生效时机**：选中即生效——马上把主窗口改成该尺寸（并按设置居中），同时写入设置文件，下次启动沿用同一尺寸。

尺寸口径：都是**窗口外框**（含标题栏与边框）的**物理像素**，与 `GetWindowRect` 原值一致。DPI 缩放 >100% 时，同一数值在屏幕上看起来比字面更小（例如 1920×1080 在 125% 缩放的 1920 宽屏上放不下，会被夹到工作区大小）；清单里专门给了 `1536×864`（= 1920×1080 在 125% 缩放下的等效尺寸）。

## 显示语言（2026-10-19 新增）

分区里的文案全部翻译过，语言按这个顺序定：

| # | 判据 | 行为 |
| --- | --- | --- |
| 1 | patch config 的 `language`（经 `GET /state` 下发给页面） | 写 `"zh"` / `"en"` 就钉死；认不出的值（**含 `zh-TW`**）不算"钉死中文"，继续往下判 |
| 2 | DSH 客户端的当前语言（`ctx.locale`，即「设置 → 通用 → 语言」） | DSH 里选了什么就是什么。**切语言立刻生效**：不刷新页面、不重启，也不重建这页 DOM（你正在自定义宽高里输入的内容不会被冲掉） |
| 3 | 插件自带判定 `detectLanguage()`（`navigator` / `Intl`） | 只在客户端运行时不提供语言服务时用到（DSH 0.1 系客户端）。**只有简体中文算中文**：`zh`、`zh-Hans*`、`zh-CN`、`zh-SG`、`zh-MY`；`zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` 以及任何其它语言一律英文 |

宿主侧不做界面翻译：它只发数据 + 机器读的原因码（失败 `code`、校验 `noteCodes`，由客户端按当前语言渲染）和中英两份预选项别名（`label` / `labelEn`）。你在 patch config 里自定义的预选项若没写 `labelEn`，就原样显示你写的名字——**绝不机器翻译用户自己起的名字**。

两个刻意的选择：

- **客户端模块的 `inject` 里故意不写 `"locale"`**：声明了某个服务而运行时没有它，这半个插件会**整块起不来**（设置页里这个分区直接消失，而且不报错）。语言服务只有 DSH 0.2 客户端才有，所以 `ctx.locale` 走可选访问 + try/catch，拿不到就退回第 3 条判定，别的功能一点不降级。
- **认不出的错误码不许甩给用户**：认得出的码走词典；认不出的退回宿主给的原文；连原文都没有才给一条通用失败文案。

## 工作原理

- 宿主进程（DSH host，Electron 主进程的子进程）**在 `apply` 那一刻就开始盯主窗口**：起一个常驻 Win32 代理（首选本机现编的小助手 exe，起不来才退 `powershell.exe`），进程内每 40ms 枚举一次，主窗口一被创建就动手。识别规则：宿主父进程 PID + `Chrome_WidgetWin_1` 窗口类 + 外框面积 ≥ `earlyMinArea`。盯窗口阶段窗口**还是隐藏的**、标题也还没变成产品名，所以这一段按面积认窗（把欢迎窗 600×700、登录窗 720×760 挡掉）；两个候选面积接近时判为"分不清"，下一轮再看，绝不猜。
- **为什么这样就能"打开就是上次的尺寸"**：桌面端的主窗口是**先隐藏创建 → `loadURL` → 才 `show()`**（`lib/main.js` 里 `createWindow(appPreload, false, true)` 与 `enterWorkspace`），而 Electron 要等宿主报 `ready` 之后才创建它。于是"窗口已存在但还看不见"这段时间是空的，代理在这里把尺寸改完 —— 窗口第一次露面就已经是目标尺寸，启动动画不会播在错误尺寸上。盯不到（或 `restoreEarly: false`）才退回 `restoreDelayMs` 的旧轮询路径。
- 恢复目标尺寸优先级：**设置页选择（`settings.json`）> patch config 的 `preset` > "上次尺寸"（`state.json`）**。用 Win32 `SetWindowPos` 恢复尺寸并**居中到主屏工作区**（`centerOnRestore`，默认开启；关闭时只改大小、不动位置），并夹取到 `[minW,minH]` 与当前主屏工作区范围内（窗口比工作区大时贴左上角）；`SetWindowPos`/Win32 调用偶发失败时最多重试 3 次（间隔 1s），全部失败则落盘实际尺寸、下次启动再试（自愈）。
- 之后按**自适应节奏**采样窗口外框：窗口没变时每 `saveIntervalMs`（15 秒）读一次；一旦这一轮采到与上一轮不同（尺寸或位置），下一次立刻改用 `activeSampleMs`（1 秒），并保持到距最后一次变化满 `activeTailMs`（10 秒）为止。而且**下一轮只在上一轮跑完之后才排**，Win32 读取慢的时候只会排队，不会叠出一串并发读取。
- 进程退出（`beforeExit`/`exit`）时用内存缓存同步落盘，兜底捕获"最后一次"尺寸；自适应之后这份缓存最多旧 1 秒，不再是过去的最多 15 秒。
- 生命周期清理经 `ctx.fiber.effect` 正规注册：fiber 卸载（热重载/移除）时清定时器、**杀掉常驻代理**、移除 process 钩子并同步落盘。
- **热重载僵尸防护**：每次 `apply` 递增代数文件 `state.json.gen`；盯窗循环、cycle 与「立即应用」写入前发现代数已变（属于热重载前的旧 fiber）即放弃一切写入，防止陈旧尺寸覆盖状态文件。
- **并发串行化**：启动恢复 cycle 与设置页的「立即应用」都走同一条 `serialize()` 队列，不会有两股 Win32 调用并发改同一窗口互相覆盖。提前恢复不占这条队列（它只有一个代理进程、且动手前会重读一次设置），所以设置页改选择不会被它盖回旧尺寸。
- 判断与数学（挑窗口、夹取、居中）**全部留在 Node 侧的纯函数里**，代理只做 Win32；`scripts/selftest.mjs` 因此能离线验到它们，并对**两层代理**（真 `powershell.exe`、本机现编的助手 exe）各跑一遍协议，`SET` 一律打在一个不存在的句柄上（必然失败 → 正好验证"失败如实回报"）。
- **Win32 这只机械臂有两层。** 首选一个**在使用者本机现场编译**出来的小助手 exe：源码就写在 `lib/index.js` 的 `buildAgentCSharp()` 里，用**系统自带**的 `csc.exe` 编一次约 110ms，产物与同一份 `.cs` 落在 `~/.dsh/storages/window-size-keeper/`，文件名带源码摘要（源码一改，旧缓存自动作废，不需要谁去清）；之后起进程约 **90ms**，进程内再问一次只要几毫秒。编译不成、exe 起不来、或握手答不上来（杀软拦下刚写的文件）→ 整套退回原来的临时 `powershell.exe`（Add-Type P/Invoke）：起进程约 0.8s、`Add-Type` 现场编译约 0.45s，**首轮动手合计约 1.3s**。当前走的是哪一层，`GET /state` 里的 `win32Backend` 字段直接写着。
- **为什么要省掉这 1.2 秒**（0.1.3）：桌面端从 Electron 主进程起来到 `window.show()` 实测只有 2~3s，而插件的 `apply` 落在约 +1.7s —— 兜底那条路要到约 +3.1s 才改得完，刚好被 `show()` 抢先，于是看到"打开后一会才把窗口改成设置的大小"。助手这条路把动手时间压到约 +1.9s，赶在窗口露面之前。顺带，快轮询（1 秒一次）也不再"那一秒一跳"；而下一轮仍要等上一轮跑完才排，所以慢读取只会排队、不会叠加。
- 非 Windows 平台：设置页分区仍会出现（能看到状态），但 payload 里 `supported:false`，不启动窗口轮询/恢复。
- 注意：应用自身对活动主窗口有 960 DIP 最小宽度策略（`setMinimumSize`/resize 处理器）；恢复尺寸低于该值时由应用钳制，状态文件会在下一轮轮询自动校正为实际尺寸。

## 采样节奏与跟随手动改尺寸（2026-10-20 新增）

- **节奏是自适应的，不是固定 15 秒。** 待机：每 `saveIntervalMs`（默认 15 秒）读一次外框。一旦这一轮采到与上一轮不同（尺寸或位置），下一次立刻改用 `activeSampleMs`（默认 1 秒），并一直保持到距最后一次变化满 `activeTailMs`（默认 10 秒）。这三个键只认正数：写 0、写负数、写垃圾一律退回默认，并各自夹下限（待机不低于 1 秒、快轮询不低于 250 ms），手滑写错也不会变成 0 毫秒狂采样。
- **为什么要紧：** 状态文件与设置页那行"当前主窗口外框"的新鲜度**取决于上一次采样**，退出兜底写的也是同一份缓存。过去固定 15 秒轮询时，"拖完马上重启"会把这次拖动整个丢掉 —— 下次启动回到再上一个尺寸。自适应把这段延迟压到 1 秒左右，而安静时的开销一分不减。
- **`followManualResize`（默认开）：手动改尺寸会连选择一起改。** 采到**宽高**变了，插件就自己写一次 `settings.json`，把「恢复尺寸」选择变成 `自定义` = 你刚拖出来的宽高；于是下次启动用的就是这个尺寸，设置页里也显示成选中了「自定义」。只有宽高算数：**只挪位置不动大小不改选择**（`custom` 存的本就是宽高，不是位置）。
- **插件自己改的那一次不算手动。** 启动恢复与"立即应用"会记下自己改成的矩形，随后确认它的那一次采样把这条记录用掉。没有这条规矩，恢复你选的 `1920×1080（Full HD）` 会被插件自己改成 `自定义 1920×1080`，设置页看起来就像"忘了我选过什么"。
- 最大化会被当成一次手动改尺寸：记的是最大化那个矩形（作为自定义尺寸），下次启动**把尺寸改到这个值**，而不是还原"最大化"这个状态。
- 写 `followManualResize: false` 就退回"只记状态"：设置页的选择完全由你自己定，此时拖动只在选择是「上次尺寸」时才影响下次启动。

## 状态文件与设置文件

目录：`~/.dsh/storages/window-size-keeper/`

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `state.json` | 插件轮询/退出兜底 | `{ "version": 1, "width": 1894, "height": 1171, "x": 18, "y": 17, "savedAt": "..." }`（外框尺寸，物理像素） |
| `settings.json` | 设置页；插件自己在采纳一次手动改尺寸时也会写（`followManualResize`） | `{ "version": 1, "preset": "1920x1080", "centerOnRestore": true, "custom": { "width": 1600, "height": 1000 }, "updatedAt": "..." }`；`preset` 空串 = 用"上次尺寸"，`"custom"` = 用 `custom` 宽高 |
| `state.json.gen` | 插件 | 代数（每次 apply 递增，热重载僵尸防护用），无需手动维护 |
| `wsk-agent-<源码摘要16位>.exe` + 同名 `.cs` | 插件（第一次要用 Win32 时现编，之后复用） | 只干 Win32 的小助手：C# 源码随包可见、编译只发生在你自己机器上，`.cs` 就在 exe 旁边供你核对；源码一改就换个文件名，旧缓存自动作废。不想在本机落 exe 就配 `win32Backend: "powershell"`；删掉这两个文件唯一的后果是下次重新编一遍 |

两个 JSON 都是**原子写**（临时文件 + rename），避免并发读到半写文件。

手动删除 `state.json` 即可重置"上次尺寸"；删除 `settings.json` 即让设置页回到默认（用"上次尺寸"）。

## HTTP 路由（设置页与宿主之间的通道）

前缀 `/window-size-keeper/api`（经宿主 `webServer.register({ kind: "prefix" })` 注册；`webServer` 不写进 `inject`，headless 场景不会硬依赖，注册失败会有限重试）。

| 路由 | 作用 |
| --- | --- |
| `GET /state` | 可用分辨率清单、当前选择、最近一次窗口矩形、上下限、两个文件路径，以及现在实际走的是哪层 Win32（`win32Backend`、`win32HelperExe`） |
| `POST /select` | `{ preset, custom:{width,height}, centerOnRestore }` → 校验 + 落盘 + 立即应用 |
| `POST /apply` | 按当前选择立即应用一次（改尺寸 + 居中） |
| `POST /reset` | 选择退回"上次尺寸"（`preset: ""`）并立即应用 |

非法输入（未知 `preset` id、自定义宽高不是正整数、选了「自定义」却没填过宽高）会被拒绝并回报原因，不会静默改设置。回报的是稳定原因码，界面按当前语言渲染（见「显示语言」）。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关掉时连设置页路由也不注册） |
| `saveIntervalMs` | `15000` | 待机采样间隔：窗口一直没变时多久读一次外框 |
| `activeSampleMs` | `1000` | 采到变化时的快轮询间隔（下限 250 ms） |
| `activeTailMs` | `10000` | 距最后一次采到变化多久之内保持快轮询 |
| `followManualResize` | `true` | 采到手动改宽高时，把「恢复尺寸」选择改成 `自定义` = 那个尺寸（见上一节） |
| `restoreDelayMs` | `3000` | 兜底路径的首次恢复延迟（`restoreEarly` 关掉或盯不到时才用到） |
| `restoreEarly` | `true` | 提前恢复：`apply` 起就盯窗口，赶在 `show()` 之前把尺寸改对。关掉即退回纯轮询旧行为 |
| `earlyPollMs` | `40` | 提前恢复时代理进程内两次枚举之间的间隔 |
| `earlyBudgetMs` | `10000` | 提前恢复总预算；到点没等到窗口就交给 `restoreDelayMs` |
| `earlyMinArea` | `900000` | 提前恢复认"主窗口"的外框面积下限（物理像素²，主窗创建时恒为 1280×820 = 1,049,600） |
| `win32Backend` | `auto` | Win32 走哪一层：`auto` = 先试本机现编的助手 exe，不行退 `powershell.exe`；`powershell` = 只用老路子（不在本机编译、不落 exe）；`helper` = 只用助手，起不来就当没有提前恢复（排障用） |
| `minW` / `minH` | `520` / `600` | 恢复尺寸下限（对齐 Electron 主窗口最小值） |
| `maxW` / `maxH` | `7680` / `4320` | 恢复尺寸上限（防异常值） |
| `stateFile` | 空 | 自定义状态文件路径（设置文件取同目录的 `settings.json`） |
| `centerOnRestore` | `true` | 恢复时是否居中（设置页开关会覆盖它） |
| `preset` | 空 | 选中的预选项 id（空 = 用"上次尺寸"；设置页选择会覆盖它） |
| `presets` | 内置 12 项 | 预选项列表，整体覆盖内置列表（见下） |
| `language` | `auto` | 设置页分区文案语言：`auto` 跟随 DSH 当前语言，`zh` / `en` 钉死（见「显示语言」） |

> 注意：`preset`/`presets` 属于 Cordis patch 配置，改动后需**重启 DSH**（或触发 profile 重组）才生效；`dev_reload_package` 热重载不会重读 patch 配置。设置页的选择走 `settings.json`，**不需要**重启。

### 预选项（presets）

内置 12 个常用分辨率（设置页按此顺序显示）：

`1024×768`、`1280×720`、`1366×768`、`1440×900`、`1536×864`（1920 在 125% 缩放下等效）、`1600×900`、`1920×1080`、`1920×1200`、`2560×1080`、`2560×1440`、`3440×1440`、`3840×2160`

要增删就在 `cordis.patch.yml` 的 `config` 里加 `presets:` 列表（每项 `{ id, label, labelEn?, width, height }`）**整体覆盖**内置列表（示例见 `cordis.patch.yml` 末尾注释）；设置页的清单会跟着变。`labelEn` 可省略——省略时这条在两种语言下都显示你写的那一份。

## 安装 / 重载

```bash
# 普通用户：装发布产物 —— 从 GitHub Release 下载附件、先核摘要、再安装
curl -L -o ~/.dsh/.plugin-sources/dsh-window-size-keeper-<版本>.tgz \
  https://github.com/ecbob/dsh-window-size-keeper/releases/download/v<版本>/dsh-window-size-keeper-<版本>.tgz
sha256sum ~/.dsh/.plugin-sources/dsh-window-size-keeper-<版本>.tgz   # 必须等于 RELEASES.txt 里那次发布的 SHA-256
dsh plugin --profile desktop add "<这个 .tgz 的绝对路径>"             # spec 必须给绝对路径

# 开发期：热装配（免重启）
dev_install_package  dir=<本仓库绝对路径>  profile=desktop
dev_reload_package   dsh-window-size-keeper   # 只换宿主那一半；设置页还得刷新一次
```

卸载：`dsh plugin --profile desktop remove dsh-window-size-keeper`，或 `dev_uninject_plugin dsh-window-size-keeper`。

> `<profile>` 填什么？桌面端常见 `desktop`、Web 端常见 `web`，但名字由本机决定：`dir %USERPROFILE%\.dsh\profiles`（Linux/macOS：`ls ~/.dsh/profiles`）。填错不会报错，只是装到另一个 profile 去了，当前会话看不见这个插件。

**新增/改动 `lib/client.js`（设置页分区）后**：客户端半个插件由页面加载，需要 profile 重组（重启 DSH 桌面端）+ 刷新页面才会出现新分区；只改宿主侧 `lib/index.js` 可用 `dev_reload_package` 热重载。

## 离线自检

```bash
node scripts/selftest.mjs                                    # 或 npm test
node --check lib/index.js && node --check lib/client.js      # or npm run check
```

`scripts/selftest.mjs` 零依赖，99 项分十三个编号组（`[5c]` 组是 0.1.1 加的：采样节奏与"这次算不算用户手动"的判定，都是纯函数；`[7b]` 组是 0.1.3 加的：Win32 助手的选路纯函数、真机现编与三条契约、以及"助手起不来必须退回 powershell、绝不整个放弃"；`[9]` 组另钉了那一行必须显示真实尺寸）：纯函数（居中/夹取/优先级/输入校验/主窗口识别/状态与设置读写）、HTTP 路由（假 ctx + 真 http server + 真 fetch）、真 `powershell.exe` 的 Win32 代理协议、现编助手 exe 的握手/`--get`/`--set` 契约与常驻协议、文案 i18n（中英词典逐 key 对齐、`{占位符}` 一致、英文表里不许残留中文、语言判定优先级），以及**用假 DOM 真渲染这个分区**——中英两种语言各渲染一遍，并验"切语言不重建 DOM、正在输入的自定义宽高不丢、提示也跟着换语言、词典没注册成功时绝不把 page.title 这类内部 key 甩到界面上、卸载时刷新定时器与语言订阅都释放"。

第 [10] 组是**脱敏扫描**（`scripts/check-sensitive.mjs`，也能单独跑：`npm run scan:sensitive`）：发布文件与仓库文档里都不许出现账号家目录绝对路径（`C:\Users\<某人>`、`/home/<某人>`）、个人工作区绝对路径、写死的本机回环端口、凭据样式（`api_key: …`、`ghp_…`、`sk-…`、`AKIA…`）、真实邮箱、机器指纹（SID、机器 GUID、主机名）。扫描器自带「必须判红」与「必须判绿」两组对照（条数由扫描器运行时自报，并被自检第 [10] 组盯住），所以它不会悄悄退化成盖章机器；`~/.dsh`、`%USERPROFILE%`、`<工作区>`、`<HOME>` 这类通用占位写法和 SHA-256 摘要是**故意放行**的——一份连校验和都写不进去的仓库，也算不上发布台账。

它把状态与设置文件指到临时目录，现编的 Win32 助手也只落在自检自己的临时目录，**都不碰**真实的 `~/.dsh/storages/window-size-keeper`；脚本的父进程不是 DSH 宿主，所以路由里的 `applyNow` 定位不到主窗口——正好验证"失败如实回报、不谎报已改窗口"，也不会真去 resize 任何真实窗口。真机生效验证：重启桌面端后看「设置 → 窗口大小」。

## 零依赖红线

仅使用 node 内置模块 + 系统自带的 `csc.exe`（现编 Win32 助手）与 `powershell.exe`（兜底），不声明任何运行时依赖，**包里也不带任何二进制**——那个助手 exe 是在使用者本机从随包可见的 C# 源码现编出来的，不在 tarball 里。两种装配方式下这条红线都成立：profile 装打包产物时，声明了的运行时依赖就得在安装那一刻从 registry 解析；profile 用 pnpm `link:` 直接链接本目录调试时，pnpm 根本不会去装被链接包自己的依赖 —— 两种情况下只要运行时依赖解析失败会让 Cordis 插件树整体抛错、DSH 无法启动（2026-09 事故，见 `@dsh-pet/bridge` 同款注释）。客户端半个插件同理：只用客户端模块加载器已注入的 `react`，不引任何第三方包。

## 本机上的东西各放在哪

`<工作区>\dsh-window-size-keeper` 就是唯一那一份 checkout：代码、两份 README、两份更新记录、发布台账、`PUBLISHING.md`、市场投稿条目、CI 与 `.git` 都在它里面。版本身份是注解 tag `v<版本>` —— 以前那种再开一个 `<名字>-<版本>` 目录当发布快照的做法已在 2026-10-20 退役，没有任何东西依赖它。`<工作区>` 的意思就是"这份 checkout 在你机器上的位置"——仓库里**故意不记录任何人本机的绝对路径**，而且自检里有一组专门盯着这件事。DSH 真正跑的是**打包产物**而不是这个目录：`npm pack` 打出 `dist/<名字>-<版本>.tgz`，profile 从 `~/.dsh/.plugin-sources/<名字>-<版本>.tgz` 装它 —— 所以在这里改 `lib/*.js` 不会直接影响运行时，要走 pack + `dsh plugin … add` + 完全重启桌面端（调试期可以临时换回 `link:`）。运行时自己写出来的东西都在 `~/.dsh/storages/window-size-keeper/`：`state.json`、`settings.json`、`state.json.gen`，外加现编的 `wsk-agent-*.exe` 与它的 `.cs`（删掉这几个的唯一后果是下次重新编一遍、以及"上次尺寸"从头积累）。

## 许可

MIT，见 LICENSE。
