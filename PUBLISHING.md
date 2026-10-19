# 发布现状与投稿清单

**一句话：代码、自检与门禁都已就绪；没做的只有"在 GitHub 建仓 + push"和"往市场数据源仓库提投稿 PR"。**

## 零、本机状态（重要）

本目录是**发布用归档副本**。桌面端 profile 现在 link 的是**开发目录**
`<工作区>\dsh-window-size-keeper`：

```
%USERPROFILE%\.dsh\profiles\desktop\package.json
  "dsh-window-size-keeper": "link:<工作区>\\dsh-window-size-keeper"
```

归档时**没有**改动这一条，也没有重启 profile。后来按用户要求「两边都改」（i18n 那一轮），
两边现在是**同内容的两份**：10 个共有文件逐字节相同（`RELEASES.txt` 里有逐条摘要，也写清了
哪些文件只在归档目录里）。开发目录那份改完要生效，仍然需要 profile 重组（重启桌面端）——
客户端半个插件是页面加载的，热重载只换宿主侧那一半。

## 一、四道自动闸门逐条核对

市场数据源仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `scripts/check-submission.mjs`：

| # | 要求 | 本仓库状态 |
| --- | --- | --- |
| 1 | 仓库内**任意** `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 会被直接拒） | ✅ `dsh.bundle.patch = ./cordis.patch.yml`，另含 `dsh.client`（CI 里有一条 job 专门钉这个） |
| 2 | 仓库存在满 1 天（≥24 h） | ⏳ 建仓当天会红一次，之后自动转绿；不需要重提、重推或关掉重开 |
| 3 | 仓库存在、未归档、非 fork | ✅ 要新建的独立仓库 |
| 4 | 不是 DSH 本体 | ✅ |

投稿文件已按市场数据格式备好，原样复制即可：

```
submission/data/plugins/ecbob__dsh-window-size-keeper.yml
```

文件名规则：`owner/repo` → `owner__repo.yml`。名字冲突已核过：`plugins.json`（2026-10-19 拉取，
5945 条）里没有 `dsh-window-size-keeper` 这个条目，也没有描述相近的窗口尺寸类插件。`category`
取自市场在用的 23 个分类之一（`ui`）。

## 二、建仓与 push（本机走 SSH）

```bash
cd <工作区>/dsh-window-size-keeper-0.1.0
# 空仓库已在 GitHub 建好：ecbob/dsh-window-size-keeper（建仓时不要勾自动生成 README，否则首推会撞）
git remote add origin git@github.com:ecbob/dsh-window-size-keeper.git
git push -u origin main
```

> **本机走 SSH 的前提**：GitHub 账号里必须加着本机的公钥（内容见 `~/.ssh/id_ed25519.pub`
> → Settings → SSH and GPG keys → New SSH key）。没加时 22 端口与 443 端口都会回
> `Permission denied (publickey)`（本机实测过，两种都一样）。22 端口被网络拦时改用 ssh over 443：
> 在 `~/.ssh/config` 里给 `github.com` 写 `Hostname ssh.github.com` 与 `Port 443`。
>
> 备用路线是 HTTPS + 个人访问令牌（GitHub 从 2021 年起不接受账号密码推 HTTPS）：
> `git remote add origin https://github.com/ecbob/dsh-window-size-keeper.git` 然后
> `git -c http.proxy="$GIT_PROXY" push -u origin main`——这台机器 `github.com:443` 被 SNI 级阻断，
> HTTPS 必须带本地代理：`export GIT_PROXY="http://127.0.0.1:<端口>"`（端口自己填，仓库里刻意不写死）。
>
> 首次建仓时的提交身份写法：`git -c user.name=ecbob -c user.email=ecbob@users.noreply.github.com …`
> ——GitHub 的 noreply 地址让你 commit 挂在你的账号下，又不把个人邮箱暴露在公开历史里。

## 三、装到 profile（两种）

```bash
# A. 装产物（发布口径）
dsh plugin --profile desktop add "<本目录>/dist/dsh-window-size-keeper-0.1.0.tgz"

# B. 开发期热装配（改代码调试）——注意这会 link 到本目录而不是开发目录
dev_install_package  dir=<本目录绝对路径>  profile=desktop
dev_reload_package   dsh-window-size-keeper
```

> **改了 `lib/client.js`（设置页分区）必须重启桌面端 + 刷新页面**：客户端半个插件由页面加载，
> 热重载不会补上新分区。只改 `lib/index.js` 可以 `dev_reload_package`。

## 四、发布前自检清单

- [x] `npm run check` — `lib/index.js` / `lib/client.js` / `scripts/selftest.mjs` 语法过
- [x] `node scripts/selftest.mjs` — **81 项**离线自检全绿：第 [7] 组真 powershell 代理协议、
      第 [8] 组文案 i18n（中英词典各 60 条 key 对齐、`{占位符}` 一致、英文表无中日韩残留、
      语言判定优先级全分支、两份 README 章节结构一一对应）、
      第 [9] 组假 DOM 真渲染（英文一遍、中文一遍、无语言服务两遍、词典注册失败也不甩 key、切语言不重建 DOM）
- [x] `npm pack --pack-destination dist` → 11 个文件、74,868 B、
      SHA-256 `f88f27e7f5dac892d1a06d8055e2ce0a2d59bf2a73908789a720dd8cc37c77b9`；
      产物逐文件摘要 == 工作副本摘要（11/11），逐条记在 `RELEASES.txt`
- [x] 开发目录与本归档目录的 11 个共有文件逐字节相同（这几轮都是「两边都改」）
- [x] 脱敏：仓库里不再写死任何人本机的账号家目录、工作区绝对路径与本机代理端口（占位写法见下）
- [x] owner 与署名统一为 `ecbob`（包、LICENSE、投稿条目文件名与字段、文档一致）；仓库已在 GitHub 建好，待推送
- [x] `npm run scan:sensitive` — 脱敏扫描通过（9 条规则；扫描器自身的「必须判红 / 必须判绿」两组对照全通过（条数运行时自报）；递归覆盖，归档目录实扫 17 个文件）
- [x] CI：Windows × Node 20/22 跑 check + selftest；Ubuntu 跑 check；一条 job 钉 `dsh.bundle` 与零依赖；一条 job 专跑脱敏扫描
- [ ] 建仓 push 后看 Actions 首跑
- [ ] 浏览器里的真机视觉确认：本机 Edge / Chrome 的 headless 被活动会话挡住（stdout 空、
      `--screenshot` 不落盘），所以第 [9] 组只能走假 DOM；要看真的得开桌面端

自检**能证明**：判断与数学（挑窗口、夹取、居中、优先级、输入校验、状态/设置文件读写）正确、
HTTP 路由对非法输入如实拒绝、代理协议失败如实回报、双语词典完整且对齐、语言判定按
"配置 > DSH 当前语言 > 浏览器（只有简体中文算中文）"落地、切语言不丢掉用户正在输入的内容。
自检**不能证明**：真机窗口真的被改成目标尺寸（要重启桌面端看「设置 → 窗口大小」的
"当前外框尺寸 / 下次启动将用"）；以及 DSH 自己的语言开关在这台机器上是否已经把界面切成英文
（那是宿主的事，本插件只是跟随）。

> 一个容易混的点：**新代码**要生效得 profile 重组（重启桌面端）+ 刷新页面——客户端半个插件是页面
> 加载的，`dev_reload_package` 只换宿主侧那一半。但**代码进去之后**，切语言是立即生效的，
> 不需要再重启：那是 DSH 的 locale 服务在推（第 [9] 组里那条订阅就是验这个）。

## 五、逐项回滚

| 改动 | 回滚办法 |
| --- | --- |
| 插件安装 | `dsh plugin --profile desktop remove dsh-window-size-keeper`，或把 profile 的 link 指回开发目录 |
| 恢复的尺寸 | 删 `~/.dsh/storages/window-size-keeper/state.json`（重置"上次尺寸"） |
| 设置页选择 | 删 `~/.dsh/storages/window-size-keeper/settings.json`（回到"用上次尺寸"） |
| 本归档目录 | 直接删：它是复制出来的副本，开发目录与 profile 的 link 都没被改动 |
