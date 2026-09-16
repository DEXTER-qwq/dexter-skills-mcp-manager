# @weibaohui/skills-management（本地版 / local-only fork）

DSH 插件 · **技能管理 + MCP 管理**：一个页面管理**本机**所有 coding agent 的技能目录（Claude Code、ZCode、Codex、WorkBuddy 等十余个执行器），可预览、一键收编进 DSH 用户库供 `skill` 工具调用；同级还有「MCP 管理」，用来查看、开关、增删 dsh 的 MCP server。

> 这是上游 `@weibaohui/skills-management@0.6.1` 的**本地化改造版**：已移除「ntd 技能市场（git 仓库同步）」与「分享到 GitCode 官方仓库」两条**联网 / 起子进程**的功能链。运行期第三方依赖为 0、不发任何网络请求、不 spawn 任何子进程。

📄 **可交互说明页**：浏览器打开 [`docs/overview.html`](docs/overview.html) —— 改造全过程、功能清单（可筛选）、工作原理、HTTP 接口（可逐条展开）、安全审计结论、验证方式与安装步骤。纯静态、离线、无外链。

## 功能

### 技能管理

- **全来源扫描**：本机各执行器的技能目录（`~/.claude/skills`、`~/.zcode/skills`、…），统一浏览、详情、单文件预览
- **一键收编**：任意来源的技能复制进 DSH 用户库（`$DSH_HOME/skills`），供模型 `skill` 工具调用
- **模型可见性治理**：切换 dsh 原生 frontmatter 键 `disable-model-invocation`（覆盖用户库与 `~/.agents/skills`）
- **删除技能**：按来源删除（显式标记 `readOnly` 的来源拒绝删除）
- **执行器目录管理**：内置来源可改目录 / 停用，可新增自定义来源，改完即生效
- **注入开销统计**：卡片与详情显示字符数，可按字符排序
- **输入框 ＋ 技能**：composer 工具行的技能候选浮层（候选来自宿主技能注册表）

### MCP 管理

设置页里**与「技能管理」同级**的区块（侧栏独立入口），管理 dsh 的 MCP server。

背景：dsh 里一条 MCP server 就是组合里的一条 `@deepseek-ai/dsh-mcp-client` 记录，它的工具以 `mcp__<服务名>__<工具名>` 出现在模型工具表里。

**以手写配置为主**：server 由你自己写在 `mcp.local.jsonc` 里，这个页面负责把它们挂进 dsh、并告诉你每条现在是什么状态。

- **列表**：服务名、传输方式、命令行/地址、工具数量、是否连接、来源（`手写配置` / `dsh 组合配置` / `其他插件挂载`）
- **唯一的写操作**：把手写配置里 `"enabled": false` 的条目**强制打开**（记在本插件状态文件里，你的文件一个字节都不会被改）
- **没有的按钮**：新增、编辑、删除、从其他插件导入、清掉重复声明、刷新——都不在页面上了（见下节「为什么只剩开关」）

#### 它怎么工作

早先的实现去解析并改写 profile 的 `cordis.patch.yml`，于是需要猜活动 profile、手写 YAML 进 dsh 拥有的文件、而且只能看到那一个文件里的 server。现在**完全不碰任何 dsh 配置文件，也不改写你的手写配置**：

| 能力 | 实现 |
| --- | --- |
| 列表 | 读 `ctx.loader.entries()`（运行期的真源，bundle / patch / preset / 任何层声明的都看得见）**并**读手写配置，一个 `serverName` 只出一行 |
| 挂载 | `ctx.loader.create()` 挂真实的 `dsh-mcp-client` loader 条目（id 前缀 `sm-mcp-`），启动时和每次开关后都同步一次；手写配置里写着开的就挂，被停用的不挂 |
| 持久化 | 只有本插件自己的文件：`$DSH_HOME/skills-management/mcp.json`，唯一字段 `forcedOn`（本页强制开过的手写条目） |

`apply()` 保持**同步**（Cordis 把带 prototype 的函数当构造函数、会忽略返回的 promise，async apply 里 await 之后抛错会变成 unhandled rejection 并可能拖垮进程），异步的挂载都在请求里或 effect 的 fire-and-forget 里做。

#### 为什么只剩开关

「关掉一条 server」需要写「谁说的开」——而它只能写在**声明它的那个文件**里。本插件能写的只有自己的状态文件，而状态文件里一个名字的缺席只能表示「没被覆盖」，不能表示「关」。所以：

- 手写条目自己写 `"enabled": false`（或注释掉、或放进文件的 `disabled` 列表）= 停用；本页可以覆盖成开。
- 手写条目写着开、或者 dsh 组合层声明着 = 本页**不画开关**（画一个点了没反应的按钮更糟），行内说明让你去改那一边。
- 曾经用 `tools.restrict({ deny })` 做「不卸载、只把工具从模型目录摘掉」的遮蔽层：那是给「配置里的 server 只能开关」准备的，现在配置里的 server 不提供开关，整个遮蔽机制（连同它那个防无限递归的守卫）一起删掉了。

#### 两个文件，各归其主

| 文件 | 谁写 | 格式 |
| --- | --- | --- |
| `~/.dsh/skills-management/mcp.json` | **只有插件写**（只写 `forcedOn`） | 严格 JSON。读取时容忍注释，但**绝不把容忍结果写回** |
| `~/.dsh/skills-management/mcp.local.jsonc` | **只有你写**，插件只读、从不改写 | JSONC：`//`、`/* */`、尾随逗号都可以 |

想给 MCP 配置写注释、把不用的条目注释掉留档,就写进 `mcp.local.jsonc`——UI 里的开关不会碰这个文件。模板见 [`docs/mcp.local.example.jsonc`](docs/mcp.local.example.jsonc);改完**重启 dsh** 生效（本插件不做文件监听；页面在打开时读一次）。

同名冲突规则:**dsh 组合 > 手写文件**,只挂载优先级最高的那条(`dsh-mcp-client` 会拒绝重复的 `serverName`),一个名字在列表里只出现一行并标出「有同名声明」;要消除就删掉配置里多余的那份。

旧版本的状态文件（`version` / `disabled` / `servers`）读取时被忽略：里面还有内容的话页面会给一条提示，不会闷声丢掉。

> 要是宿主缺少 `loader` 服务（最小组合），页面会显示「能力不可用」而不是报错，并照常列出当前状态。


## 改造说明（相对上游 0.6.1 删掉了什么）

| 已删除 | 涉及面 | 为什么删 |
| --- | --- | --- |
| **ntd 技能市场** | `src/index.js` 的 git 克隆/`fetch`+`reset --hard` 同步、`authedUrl()` token 拼 URL、稀疏检出、启动/每 24h 自动同步、`/api/market/*` 路由、市场设置命名空间；客户端的「市场」Tab、来源卡片、`MarketSettingsDialog`、市场 locale 文案 | 会向外部 GitCode 仓库发起网络请求并把访问令牌拼进 git 远端 URL；对不信任的仓库而言没有保留价值 |
| **分享到官方仓库** | `SHARE_PROMPT_ZH` 提示词、`ShareSkillDialog`、`/api/share/run` 两个路由；依赖 `@weibaohui/dsh-plugin-kit` 的 `createShareRunJob` | 该提示词会指示模型**读取本机 settings.yaml 里的 GitCode PAT** 并 `POST` 到 `api.gitcode.com`（fork/建分支/写文件/开 PR）；`/api/share/run` 还以任意 `dir` 为 cwd **spawn 一个 headless `dsh` 进程**执行任意 prompt |
| `@weibaohui/dsh-plugin-kit` / `yaml` / `js-tiktoken` | 依赖树 | 见下节：前两个随功能删除，第三个换成了自写实现，现在运行期依赖为 0 |
| 市场专属注入开销预热 | 启动后台扫描，仅为市场 6600 条描述预热 token memo | 市场没了，预热无意义 |
| `.github/workflows/publish.yml` | npm Trusted Publishing CI | 本地私有分支，不再发布到 npm |
| `docs/demo*.gif`、`client/hooks/*.ts`、`client/components/*.ts` | 旧市场 UI 截图；上一版 koa 架构遗留的 TS hook，运行时从未被加载 | 与现界面不符 / 死代码 |
| **MCP 的面板式管理** | 新增/编辑/删除 server 的弹窗与 `POST`/`DELETE /api/mcp`、从其他插件导入的 `/api/mcp/import`、清重复声明的 `/api/mcp/prune`、页面「刷新」按钮、状态文件里的 `disabled`/`servers`/`version`、per-agent 的 `tools.restrict({ deny })` 遮蔽层、客户端表单与 env/headers 文本互转 helper | MCP 改成以手写配置为主之后这些都没有对象了：server 由你写文件，本页只做「把手写里停用的条目打开」这一件事。少一层遮蔽机制也顺手删掉了它那个「deny 集合没变就不重复 restrict」的防递归守卫 |

## MCP 管理不写 dsh 配置

详见上文「它怎么工作」。一句话：只读 `ctx.loader.entries()` 和你的 `mcp.local.jsonc`，只写 `$DSH_HOME/skills-management/mcp.json` 里的 `forcedOn`。

## API 面（本地唯一）

```
GET    /skills-management/api                       # 用户库技能列表
GET    /skills-management/api/executors[?mode=summary|?executor=<key>]
GET    /skills-management/api/executor-settings
PUT    /skills-management/api/executor-settings      # {dirs, disabled, extra}
GET    /skills-management/api/detail?name=&executor=
GET    /skills-management/api/file?name=&path=&executor=
POST   /skills-management/api/install               # {name, from:<executor>, overwrite?}
DELETE /skills-management/api                       # {name, executor?}
PUT    /skills-management/api/invocation            # {name, modelInvocable}
GET    /skills-management/api/mcp                   # MCP server 列表（loader + 手写配置）
PUT    /skills-management/api/mcp                   # {serverName, enabled}  把手写里停用的条目打开/关回去
```

对 `/api/mcp` 来说 PUT 是唯一写方法：`enabled: true` 只对手写配置里写着 `"enabled": false` 的条目有效（否则 409 并说明该去哪里改），`enabled: false` 撤回这条覆盖。其他方法返回 405；被删掉的 `/api/mcp/import`、`/api/mcp/prune` 返回 404（有回归测试守着）。

MCP 路由没有任何 profile 参数：作用对象就是运行中的这个 dsh 实例（loader 里有什么就管什么）。

原 `POST /api/install` 的 `from` 现在是**必填**（原来 `from` 缺省/`'market'` 表示从市场装），`/api/market/*` 与 `/api/share/run` 已移除并返回 404（有回归测试守着）。

## 安全审计结论（改造前快照）

对上游 0.6.1 全量源码（`src/index.js`、`client/index.js`、`client/bundle.js`、`scripts/build-client.mjs`、测试、`package.json` / lock、GitHub workflow）逐文件读过后的结论：

**未发现「藏起来的」恶意载荷** —— 没有 `eval` / `new Function` / 混淆代码 / 硬编码外发地址 / 后门凭据 / 读取 SSH 私钥或环境变量批量外传的行为。CI workflow 是正常的 npm Trusted Publishing（OIDC，无 `NPM_TOKEN`）。

但**存在三处真实风险面**（都属于「功能本身危险」，而非隐藏后门）：

1. **`/api/share/run` 任意 prompt 执行**（最严重）
   本地 HTTP 路由，无鉴权。`createShareRunJob` 会 `spawn(dsh, ['--profile','headless', prompt], {cwd: 用户传入的 dir})`，或走同进程 agent。配合仓库自带的 `SHARE_PROMPT_ZH`（指引模型读取 `settings.yaml` 里的 GitCode PAT 并 POST 到 `api.gitcode.com`），等于把「读凭据 + 外发」做成了一条现成链路。任何本机进程或浏览器页面都能 POST 触发它。
2. **访问令牌写进 git 远端 URL**
   `authedUrl()` 把 token 以 `https://oauth2:<token>@host` 形式拼进 URL 交给 `git clone/fetch`。虽不落 `.git/config`，但会短暂出现在进程命令行 / 进程列表里；token 本身存在 `settings.yaml`（`update` 通道，文件权限由宿主决定），且随「启动时同步 / 每 24h 同步」自动使用，用户很难有感知。
3. **供应链面**
   `yaml` + `js-tiktoken` 是常规 npm 包；`@weibaohui/dsh-plugin-kit` 同样是作者自有包，代码已读（101 行，就是 spawn / 会话执行器）。风险点是「插件通过 `dsh plugin add` 直接取得与本机同等权限」，而非包内藏毒。

以上第 1、2 点已在本次改造中**整体删除**（而非加开关）。第 3 点的三个第三方包**全部移除**：

- `@weibaohui/dsh-plugin-kit` → 随分享功能删除；
- `yaml` → 换成自写的 frontmatter 读取器（见下），**不再把不受信任技能目录里的内容交给通用 YAML 解析器**；
- `js-tiktoken` → 注入开销统计只保留精确字符数（token 数本来就是近似值）。

**现在运行期第三方依赖为 0**：宿主端只 `require('node:…')`，加上一个可选的 `@deepseek-ai/schemastery`（dsh 官方包，仅供 settings schema 注册，缺失时自动跳过注册）。`test/skills.test.mjs` 有断言守着这一点。

## 自写 frontmatter 读取器

`src/index.js` 里的 `parseFrontmatterMeta()` **不是** YAML 实现，只认 SKILL.md frontmatter 实际出现的形状：扁平标量、单/双引号标量、内联数组 `[a, b]`、块序列 `- item`、一层嵌套映射（Codex 的 `metadata: / short-description:`）、块标量 `|` / `>`。锚点别名、流式映射 `{a: b}`、复杂键等构造**直接跳过**，绝不影响 `name` / `description`。

行为要点（都有测试）：

- 只对**未加引号**的标量做类型推断：`disable-model-invocation: true` → 布尔 `true`；而 `user-invocable: "false"` 保持字符串 `'false'`（`flagValue` 读的就是字符串形式）。
- 数字保持字符串，`version: 1.0` 按作者写的样子渲染。
- `#` 只有「前面是空白、后面也是空白或行尾」才算注释，所以 `description: issue #123 fix` 与 `https://x/y#frag` 都完整保留。
- 嵌套叶子会被扁平化：`metadata.short-description` 同时可按 `short-description` 读到（对未用此字段的旧读取面是纯增量）。
- 畸形输入不抛错：无法解析的行跳过，文件正文（frontmatter 之后的内容）始终原样返回。

验收方式：拿本机 10 个真实 SKILL.md（claude / agents / codex / dsh preset）与 `yaml.parse` 做差分，`name` / `description` / `version` / `author` / `license` / `whenToUse` / 正文**逐字节一致**；另有 25 条构造用例（引号、冒号、注释、块标量、CRLF、unicode、畸形数组…）。

## 自写 MCP 状态存储

`src/mcp-manager.js` 只写一个文件：`$DSH_HOME/skills-management/mcp.json`（原子写 + 串行化，损坏或缺席都当空状态）。它存三件事：被停用的 `serverName` 列表（`disabled`）、被本页强制开启的手写条目（`forcedOn`），以及本页新增的 server（含 `enabled`）。读取侧对结构不符的条目一律丢弃而不是修补，因为半个理解的条目比缺一条更糟。19 条测试覆盖存储往返、原子性、损坏降级、校验、`!!js` 解析，以及用假 loader/tools/agents 跑完整的增删改流程——包括「deny 集合没变就不重复 restrict」这条防止无限递归的守卫。

## 安装 / 使用

`dsh plugin add <路径>` 本质是「在 profile 目录里跑 `pnpm add`」，然后把声明了 `dsh.bundle` 的依赖并进该 profile 的 `dsh.profile.bundles`。本地目录会被 pnpm 记成 **`link:` 符号链接**（不是拷贝），所以改完源码不必重装。

DSH Desktop 的 PATH shim 已经预设 `DSH_DESKTOP_DEFAULT_PROFILE=desktop`，直接：

```bash
dsh plugin add "D:\11dsh\skills-management"
```

若是命令行 dsh（非 Desktop）或想显式指定 profile：

```bash
dsh plugin --profile desktop add "D:\11dsh\skills-management"
```

相对路径会被 `dsh` 按**你当前所在目录**展开（pnpm 的 cwd 是 profile 目录），所以用绝对路径最省事。

> 必须用 `add <路径>`，不能用 `npm i`：宿主编译/加载插件时**不执行任何 install 脚本**（正常的工作流就是「装依赖 → 再实例化」，`prepare` 不会跑），所以依赖要在安装前就位。
> 本 fork 的运行期依赖为 0，`dsh plugin add` 已足够；开发用的 `npm install`（只装 devDeps）是可选步骤。

安装完**重启 DSH**（Desktop 应用重启；CLI 则重启 `dsh web`）。profile 里 `patchReload: live`，之后改 `cordis.patch.yml` 可热生效；而宿主 `src/index.js` 与客户端 `client/bundle.js` 的改动需要**重启 + 刷新页面**。

验证装上了：

```bash
dsh plugin why @weibaohui/skills-management      # 应显示 link:D:\11dsh\skills-management
```

然后打开 Web UI → **设置** → 左侧「技能管理」。卸载：`dsh plugin remove @weibaohui/skills-management`。

设置页侧栏里会出现**两个**同级条目：

- **技能管理**：执行器卡片 → 钻入看该来源技能 → 安装 / 删除 / 隐藏；⚙ 执行器目录：改目录、停用、新增自定义来源、恢复默认；详情页可预览 SKILL.md 全文与附属文件、切换模型可调用
- **MCP 管理**：列出 loader 与手写配置里的 MCP server，代码来源一栏说清每条归谁管；唯一按钮是「打开手写里停用的条目」（见上文「MCP 管理」）

## 开发

```bash
npm install                # 只装 devDeps（@deepseek-ai/schemastery）；运行期依赖为空
npm run check              # 语法检查（src/index.js、src/mcp-manager.js、client/index.js）
npm test                   # node --test（宿主面 32 + MCP 35 + 客户端面 18）
npm run build:client       # 由 client/index.js 生成 client/bundle.js
```

> `npm test`（即 `node --test`）通过子进程跑测试文件；在受限沙箱里子进程 `stdio` 管道会被拒（`spawn EPERM`）。此时改为直接执行测试文件即可：
> `node test/skills.test.mjs && node test/mcp-manager.test.mjs && node test/ui.test.mjs`。

`client/bundle.js` 是构建产物，改完 `client/index.js` 必须重新 `build:client`（`test/ui.test.mjs` 有一条「bundle 是否为最新构建」的断言守着）。

MCP 相关的测试全部用临时 `DSH_HOME` 和假 loader/tools，不会碰你真实的 `~/.dsh`。

依赖已按 `package-lock.json` 锁定；卸载/重装请使用 `npm ci`。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | 宿主端：执行器扫描、本地 API、skill provider、frontmatter 读取器、MCP 运行时与路由 |
| `src/mcp-manager.js` | 手写配置读取（JSONC）、状态存储、输入校验、loader 的纯逻辑 |
| `client/index.js` | 客户端 React 源码：设置区两个区块（技能 / MCP）+ composer「＋技能」按钮 |
| `client/bundle.js` | 构建产物（`npm run build:client` 生成，勿手改） |
| `cordis.patch.yml` | 插件接入宿主 composition 的 insert 行 |
| `test/skills.test.mjs` | 宿主面测试（含「无子进程/无网络/无第三方 require」守卫） |
| `test/mcp-manager.test.mjs` | MCP 存储、JSONC、校验、loader 与路由测试 |
| `test/ui.test.mjs` | 客户端面测试（含「无市场/分享残留 + 无已删功能文案 + bundle 新鲜度」守卫） |
| `docs/overview.html` | 可交互说明页（静态、离线；浏览器直接打开） |

## 许可

MIT（沿用上游许可）。上游仓库：<https://github.com/weibaohui/skills-management>
