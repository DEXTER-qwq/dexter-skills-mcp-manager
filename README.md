# dexter-skills-mcp-manager

DSH（DeepSeek Harness）的本地插件：在设置页里加两个同级入口 —— **技能管理** 和 **MCP 管理**。

- **技能管理**：把本机十几个 coding agent 的技能目录扫到一处，预览、收编进 DSH 用户库（这样模型的 `skill` 工具才调得到），也能删除、能把某个技能从模型目录里隐藏。
- **MCP 管理**：把你手写的 MCP server 挂进 dsh 的 loader，并且在页面里改条目、重启进程、顺手编辑 server 自己读的配置文件。

插件只做两件事：读写本机文件、调用 dsh 的 `loader` / `skills` / `settings` / `webServer` 服务。它不发起对外网络请求，也不自己 spawn 进程（MCP server 进程由 `@deepseek-ai/dsh-mcp-client` 启动）。

## 目录

- [快速开始](#快速开始)
- [技能管理](#技能管理)
- [MCP 管理](#mcp-管理)
- [手写 MCP 配置](#手写-mcp-配置)
- [写了哪些文件](#写了哪些文件)
- [工作方式](#工作方式)
- [开发](#开发)
- [已知限制](#已知限制)

## 快速开始

```bash
dsh plugin add "<本仓库目录>"
```

`dsh plugin add` 会在该 dsh profile 里跑 `pnpm add`，本地目录记成 `link:` 符号链接（不是拷贝），所以之后改源码不必重装。装完**重启 DSH**，设置页左侧就会多出「技能管理」和「MCP 管理」两个入口。

卸载：

```bash
dsh plugin remove dexter-skills-mcp-manager
```

要求：Node ≥ 22.5、dsh ≥ 0.1.2-rc.1。

## 技能管理

把散落在各处的技能目录当成本机来源统一浏览：卡片视图按来源分组，点进去看该来源的全部技能；「浏览全部技能」是跨来源的平铺列表。两个视图都支持按名称 / 描述 / 关键词筛选。

- **收编**：把任意来源的技能复制进 DSH 用户库（`$DSH_HOME/skills`），复制时把符号链接实体化，新副本自包含。同名技能会被拒绝，不会静默覆盖。
- **详情**：SKILL.md 的 frontmatter 与正文分开显示；列表出技能目录里的全部文件并按类型预览（路径必须落在该技能目录内，有穿越防护）。
- **删除**：按来源删除，删前弹确认。
- **模型可见性**：切换 dsh 原生 frontmatter 键 `disable-model-invocation`，覆盖用户库与 `~/.agents/skills`，其余字段与正文原样保留，原子写回。隐藏后技能还在库里，只是不再注入对话目录，`skill` 工具也调不到。
- **执行器目录**：一行一个来源 —— `[内置] 名称  路径  [改目录] [✓ 启用]`。路径平时是等宽文本，点「改目录」才变输入框；内置来源可以改目录、可以停用，也能新增自定义来源、一键恢复默认。保存后立即生效，走宿主 settings 服务持久化。
- **不存在的来源**：收在「本机不存在的来源（n）」一行里，默认折叠，点开才展开。
- **说明在「? 提示」里**：页面上不摆说明段落，来源含义、视图、可见性治理都收在工具栏的这一个按钮后面。

内置来源与默认目录：

| 来源 | 目录 |
| --- | --- |
| DSH（本插件的安装库，锁定） | `$DSH_HOME/skills` |
| Claude Code | `~/.claude/skills` |
| ZCode | `~/.zcode/skills` |
| Codex | `~/.codex/skills` |
| OpenCode | `~/.opencode/skills` |
| CodeBuddy | `~/.codebuddy/skills` |
| AtomCode | `~/.atomcode/skills` |
| Hermes | `~/.hermes/skills` |
| Kimi | `~/.kimi/skills` |
| MobileCoder | `~/.mobile-coder/skills` |
| Codewhale | `~/.codewhale/skills` |
| Kilo | `~/.kilo/skills` |
| Pi | `~/.pi/skills` |
| Mimo | `~/.local/share/mimocode/skills` |
| ZhanLu | `~/.local/share/zhanlu/skills` |
| WorkBuddy | `~/.workbuddy/skills` |
| Agents | `~/.agents/skills` |

扫描会跟随符号链接并做环检测，跳过 `.git` 与 `node_modules`。

## MCP 管理

dsh 里一条 MCP server 就是组合里的一条 `@deepseek-ai/dsh-mcp-client` 记录，它的工具以 `mcp__<服务名>__<工具名>` 出现在模型工具表里。这个页面的数据来自两处：dsh loader 里已经存在的条目，以及你手写的 `mcp.local.jsonc`；一个 `serverName` 只出一行，并标出归谁管。

- **点卡片就编辑**：和技能卡片一样，点 server 卡片直接打开这条的配置表单，不用先点一个「编辑」按钮。工具栏的「+ 新增 server」进来就已经摆好一条空白条目。
- **保存是就地的**：只重写被改动的那一条，其它行（注释、空行、尾随逗号、你原来的排版）一个字节都不动；写之前把旧版本留成 `mcp.local.jsonc.bak`；配置真正变了的 server 自动重启（重建 loader 条目），新配置立刻生效。
- **拒绝而不是猜**：文件里有读不懂的条目时拒绝保存（否则它们会被静默丢弃）；要占用的名字已经被 dsh 组合配置或别的插件声明过时也拒绝（写进来只会被忽略）。
- **关联配置文件**：一个 server 常常还会读自己的配置文件（典型是 `--config-file` 指向的一个 json）。页面从 `command` / `args` 里认出真实存在、且看起来是配置的文件，在卡片上显示成 `关联文件` 标签，点开就进「配置文件」编辑器 —— 加一条 SSH 连接、保存，读它的 server 会自动重启，新连接立刻可用。认不出来的可以在条目里写 `relatedFiles` 补充。
- **配置文件**：`$DSH_HOME/skills-management` 下的文本文件，左列表右编辑器。只允许这个目录内的文件；`.json` 保存前必须仍是严格 JSON（`.jsonc` 才容忍注释）；写前留 `<文件名>.bak`；保存后重启用到这个文件的 server。
- **重载 / 全部重载 / 刷新**：不做后台轮询。强制重建某个进程点行内「重载」，重新读一遍列表点「刷新」。页面上的写操作之后会自动补读一次工具列表（挂载刚重建，工具要等握手完）。
- **开关只覆盖一种情况**：把手写配置里写着 `"enabled": false` 的条目强制打开（并真的挂上 loader 条目）。覆盖只记在插件自己的状态文件里；条目本身写着开、或来自组合层的行不给开关 —— 要关它必须在声明它的地方关（手写条目点卡片取消勾选「启用」）。
- **只读的行**：dsh 组合配置（bundle / profile patch）和其他插件挂载的条目只展示、不响应点击，原因写在「? 提示」里。
- **同名声明会标出来**：一个名字被多处声明时只挂优先级最高的那条（组合层 > 手写配置），行上标「有同名声明」。
- **说明在「? 提示」里**：两个配置文件的位置、每条来源的含义、开关与覆盖、关联文件与重载、同名声明，全在这一个按钮后面；卡片上只留状态标签（`手写配置` / `dsh 组合配置` / `其他插件挂载` / `已强制开启` / `已连接` / `未启用` / `有同名声明`）。

## 手写 MCP 配置

文件放 `$DSH_HOME/skills-management/mcp.local.jsonc`（默认 `~/.dsh/skills-management/mcp.local.jsonc`）。是 JSONC：`//`、`/* */`、尾随逗号都安全；顶层可以是数组，也可以是 `{"servers": [...]}`。页面编辑与手写可以混用，页面只重写你改过的那一条。完整模板见 [`docs/mcp.local.example.jsonc`](docs/mcp.local.example.jsonc)。

```jsonc
{
  "servers": [
    // 本机程序（stdio）
    {
      "serverName": "my-stdio-server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "SOME_TOKEN": "${SOME_TOKEN}" },
      "toolCallTimeoutMs": 60000
    },

    // 远端地址（streamable-http）
    {
      "serverName": "my-http-server",
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `serverName` | 必填。成为工具名前缀 `mcp__<这个名字>__<工具名>`；只允许字母数字、下划线、连字符，≤32 字符 |
| `transport` | 必填，`stdio` 或 `streamable-http` |
| `command` / `args` / `cwd` | `stdio` 用；`args` 一行一个参数 |
| `url` / `headers` | `streamable-http` 用；必须 http(s) |
| `env` / `headers` | 值写 `KEY=${VAR}` 表示**挂载时读宿主环境变量**，不把明文写进这个文件 |
| `toolCallTimeoutMs` | 可选，工具调用超时（毫秒，默认 60000） |
| `relatedFiles` | 可选，这个 server 自己读的配置文件（自动识别不到的再手写） |
| `enabled` | 可选，写 `false` 表示停用（页面上的开关能把它打开） |

停用一条有三种写法，挑一种即可：条目里写 `"enabled": false`（页面开关能把它打开）、把条目整块注释掉、或放进顶层的 `"disabled": ["名字"]` 列表。

## 写了哪些文件

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `$DSH_HOME/skills-management/mcp.local.jsonc` | 你写，页面也会写（只重写被改动的那一条） | 你的 MCP 配置（JSONC） |
| `$DSH_HOME/skills-management/mcp.local.jsonc.bak` | 页面，每次保存前 | 上一版内容，出问题可以拿回来 |
| `$DSH_HOME/skills-management/mcp.json` | 只有插件写 | 唯一字段 `forcedOn`：记录页面强制打开过哪些手写条目 |
| `$DSH_HOME/skills-management/<其他配置文件>` | 你写，页面「配置文件」面板也会写（留 `.bak`） | server 自己读的配置；保存后用到它的 server 自动重启 |

除此之外不写任何文件：不碰 dsh 的 `cordis.yml` / `cordis.patch.yml`，也不动上面这个目录以外的路径（「配置文件」面板对目录外的路径只展示、不可写）。旧版本状态文件里的 `version` / `disabled` / `servers` 读取时被忽略，里面有内容时页面会给一条提示。

## 工作方式

- **技能**：插件向 dsh 的 `skills` 注册表注册一个 provider，模型看到的技能目录来自它。列表是扫描出来的；「安装」是把技能目录复制进 `$DSH_HOME/skills`；「隐藏」是改写 SKILL.md 的 frontmatter。
- **MCP**：页面读 `mcp.local.jsonc`，对每条启用的 server 用 `loader.create` 挂一条 `@deepseek-ai/dsh-mcp-client` 条目（id 前缀 `sm-mcp-`）。每个挂载记一个指纹 —— 客户端配置加关联文件的 size/mtime —— 保存时指纹变了就重挂，也就是重启进程。
- **HTTP**：所有接口挂在 `webServer` 的 `/skills-management/api` 前缀下，只服务本机页面。

## 开发

```
src/index.js              宿主半：skills provider、执行器目录、HTTP 路由
src/mcp-manager.js        MCP 纯逻辑：状态文件、JSONC 解析与就地改写、关联文件、指纹
src/mcp-files.js          配置文件编辑器后端：目录限制、JSON 校验、.bak、原子写
client/index.js           浏览器半：两个设置页（React + 宿主 primitives）
client/bundle.js          由 client/index.js 生成，不要手改
scripts/build-client.mjs  生成 bundle
test/*.test.mjs           契约测试
```

```bash
npm run check          # node --check 四个源文件
npm run test           # node --test test/*.test.mjs
npm run build:client   # 重新生成 client/bundle.js
```

几个约定：

- 改完 `client/index.js` 必须 `npm run build:client` —— 有测试比对 `client/bundle.js` 是不是最新的。
- 改宿主侧代码要**重启 DSH** 才加载；只改客户端也要刷新页面（宿主不一定会重新读 bundle，必要时同样重启）。
- 测试里 `node --test` 会为每个文件 spawn 子进程，在受限环境（例如某些沙箱）里可能报 `spawn EPERM`，这时逐个跑 `node test/mcp-ui.test.mjs` 即可。
- 文案全部走 locale（zh / en），不写死在组件里；颜色只用 ui-theme 的 `--dsw-*` 令牌。

## 已知限制

- **不做后台文件监听**：用外部编辑器改完文件后，点「刷新」或那一行的「重载」；页面上的保存是即时生效的。
- **组合层的 MCP 条目只读**：要改，去声明它的 bundle / profile patch / 那个插件。
- **关联文件靠识别**：路径不在 `command` / `args` 里、又不像配置文件的，需要手写 `relatedFiles`。
- **配置文件编辑器只覆盖一个目录**：`$DSH_HOME/skills-management`，别处的路径只展示不可写。

## License

MIT，见 [LICENSE](LICENSE)。这个 fork 基于 [@weibaohui/skills-management](https://github.com/weibaohui/skills-management)。
