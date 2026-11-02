# dexter-skills-mcp-manager

DSH（DeepSeek Harness）插件：给 Web 设置页加两个同级入口 —— **技能管理** 和 **MCP 管理**。

> dsh 插件 · 技能管理 + MCP 管理（本地版）：skill管理页面管理本机skills, 支持导入十余个 coding agent 的技能目录（Claude Code、ZCode、Codex、WorkBuddy 等），可预览、收编进 DSH 用户库供 skill 工具调用；mcp管理页面列出 loader 与手写配置 mcp.local.jsonc 里的 MCP server，可直接增删改条目（就地重写、留 .bak）、重载进程，并编辑 server 自己读的配置文件（如 ssh-config.json）。

## 技能管理

把本机各 coding agent 的技能目录集中到一个页面里管理。



![image-20260916205152566](./README.assets/image-20260916205152566.png)

执行器目录

![image-20260916205232507](./README.assets/image-20260916205232507.png)

- **全来源扫描**：内置 17 个来源 —— DSH 用户库，以及 Claude Code、ZCode、Codex、OpenCode、CodeBuddy、AtomCode、Hermes、Kimi、MobileCoder、Codewhale、Kilo、Pi、Mimo、ZhanLu、WorkBuddy、Agents 的技能目录。跟随符号链接并做环检测，跳过 `.git` 与 `node_modules`。
- **两种视图**：按来源的卡片视图（点进去看该来源的全部技能）与跨来源的「全部技能」列表；支持按名称 / 描述 / 关键词搜索、按来源筛选、按注入开销排序。本机不存在的来源收在「本机不存在的来源（n）」一行里，默认折叠，点一下才展开。
- **详情与文件预览**：SKILL.md 的 frontmatter 与正文分开显示，列出技能目录里的全部文件，按类型预览（路径必须落在该技能目录内，有穿越防护）。
- **一键收编**：把任意来源的技能复制进 DSH 用户库（`$DSH_HOME/skills`），这样模型的 `skill` 工具才调得到。符号链接会被实体化成真实文件，新副本自包含；同名时可选覆盖。
- **删除技能**：按来源删除；显式标记为只读的来源会拒绝删除。
- **模型可见性治理**：切换 dsh 原生 frontmatter 键 `disable-model-invocation`，覆盖用户库与 `~/.agents/skills`。原样保留其余字段与正文，原子写回。
- **执行器目录管理**：一行一个来源 —— `[内置] 名称  路径  [改目录] [✓ 启用]`；路径平时是等宽文本，点「改目录」才变成输入框（17 个内置来源不再是一墙输入框）。内置来源可改目录、可停用，也能新增自定义来源、一键恢复默认；走宿主 settings 服务持久化，保存即生效。
- **说明只在「? 提示」里**：页面上不摆说明段落，来源/视图/可见性治理的说明集中在工具栏的「? 提示」里（MCP 页同样）。

## MCP 管理

![image-20260916205320564](./README.assets/image-20260916205320564.png)

列出 dsh loader 里已有的 MCP server 与你自己手写的配置，一个 `serverName` 只出一行，并说明每条归谁管。

dsh 里一条 MCP server 就是组合里的一条 `@deepseek-ai/dsh-mcp-client` 记录，它的工具以 `mcp__<服务名>__<工具名>` 出现在模型工具表里。

- **以手写配置为主**：server 由你写在 `mcp.local.jsonc` 里，这个页面负责把它们挂进 dsh、告诉你每条现在是什么状态，并且**可以直接编辑**。
- **列表**：服务名、传输方式、命令行 / 地址、工具数量、是否连接、来源（`手写配置` / `dsh 组合配置` / `其他插件挂载`）、关联配置文件。
- **点卡片就编辑**：和技能管理一样 —— 点 server 卡片直接打开这条的配置表单，不用先点一个「编辑」按钮；工具栏的「+ 新增 server」进来就已经摆好一条空白条目。表单内容：服务名、传输方式、命令 / 参数（一行一个）/ 环境变量（`KEY=value`，值写 `${VAR}` 读宿主环境变量）/ 工作目录，或 url / 请求头；超时、启用开关、关联配置文件。保存时：
  - **只就地重写被改动的那一条**，其它行（注释、空行、尾随逗号、你原来的排版）一个字节都不动；
  - 写前把旧版本留成 `mcp.local.jsonc.bak`，写入是原子替换；
  - 配置真正变了的 server **自动重启**（loader 条目重建），新配置立刻生效；
  - 文件里有读不懂的条目时**拒绝保存**（否则它们会被静默丢弃），并说明是哪一条；
  - 不允许占用 dsh 组合配置 / 其他插件已经声明过的名字（写进来也只会被忽略）。
- **关联配置文件**：一个 server 经常还会读自己的配置文件，典型就是 `ssh-mcp-server --config-file …\ssh-config.json`。页面从 `command` / `args` 里认出真实存在的文件（也可以在条目里写 `relatedFiles` 补充），卡片上显示成 `关联文件` 标签，点开就进「配置文件」编辑器 —— 加一条 SSH 连接、保存，读它的 ssh server 自动重启，新连接立刻可用。
- **配置文件**：`$DSH_HOME/skills-management` 下的文本文件，左列表右编辑器（和技能详情页一个样式）。只允许这个目录内的文件；`.json` 保存前必须仍是严格 JSON（`.jsonc` 才容忍注释）；写前留 `<文件名>.bak`；保存后重启用到这个文件的 server。
- **重载 / 全部重载 / 刷新**：不做后台轮询（不需要为了生效去重启 dsh）。改了参数引用的外部文件、或者你希望强制重建进程时，点这一行的「重载」；改完文件想重新读一遍列表就点「刷新」。页面上的写操作之后会自动补读一次工具列表。
- **说明只在一个地方**：页面本体不摆说明段落 —— 两个配置文件的位置、每条来源的含义、开关与覆盖、关联文件与重载、同名声明，全都收在工具栏的「? 提示」里。卡片上只留状态标签（`手写配置` / `dsh 组合配置` / `其他插件挂载` / `已强制开启` / `已连接` / `未启用` / `有同名声明`）。
- **唯一的「覆盖」——开关**：把手写配置里写着 `"enabled": false` 的条目**强制打开**（并真的挂上 loader 条目）。这条覆盖只记在插件自己的状态文件 `~/.dsh/skills-management/mcp.json` 里，内容只有一个字段：

  ```json
  { "forcedOn": ["ssh-mcp-server"] }
  ```

  再点一下「停用」就把名字从 `forcedOn` 里删掉、卸载该条目。不点开关就不会生成这个文件；点卡片把条目保存成启用后，这条覆盖会被清掉（文件本身已经说了「开」）。
- **不画开关的情况**：条目本身写着开（或来自 dsh 组合层、其他插件）时页面不给开关 —— 「关掉」要写在声明它的那个文件里（手写条目点卡片取消勾选「启用」）。组合层的行不响应点击（它本来就不归这一页管），原因写在「? 提示」里。
- **启动时挂载**：按手写配置挂载真实的 `dsh-mcp-client` loader 条目（id 前缀 `sm-mcp-`），每次开关 / 保存 / 重载后同步一次。同名冲突时 dsh 组合优先，一个名字只挂一条。
- **同名声明会标出来**：一个名字被多处声明时只挂优先级最高的那条，行上标「有同名声明」并说明去删哪一份。

### 手写配置怎么写

模板见 [`docs/mcp.local.example.jsonc`](docs/mcp.local.example.jsonc)。文件放 `~/.dsh/skills-management/mcp.local.jsonc`，是 JSONC：`//`、`/* */`、尾随逗号都安全。顶层可以是数组，也可以是 `{"servers": [...]}`。页面编辑与手写可以混用：页面只重写你改过的那一条。

一条 server 的字段：

| 字段 | 说明 |
| --- | --- |
| `serverName` | 必填。成为工具名前缀 `mcp__<这个名字>__<工具名>`；只允许字母数字、下划线、连字符，≤32 字符 |
| `transport` | 必填，`stdio` 或 `streamable-http` |
| `command` / `args` / `cwd` | `stdio` 用；`args` 是一行一个参数 |
| `url` / `headers` | `streamable-http` 用；必须是 http(s) |
| `env` / `headers` | 值写 `KEY=${VAR}` 表示**挂载时读宿主环境变量**，不落盘明文 |
| `toolCallTimeoutMs` | 可选，工具调用超时（毫秒，默认 60000） |
| `relatedFiles` | 可选，这个 server 自己读的配置文件（页面自动识别不到的再手写） |
| `enabled` | 可选，写 `false` 表示停用（页面上的开关能把它打开） |

停用一条有三种写法，随便挑一种：条目里写 `"enabled": false`（页面上的开关能把它打开）、把条目整块注释掉、或放进顶层的 `"disabled": ["名字"]` 列表。

页面里的开关 / 保存 / 重载都是即时生效的；用外部编辑器改文件后点「刷新」或「重载」即可，不必重启 dsh（本插件仍然不做文件监听）。

## 配置文件

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `~/.dsh/skills-management/mcp.local.jsonc` | **你写，页面也会写**（只重写被改动的那一条） | 你的 MCP 配置（JSONC） |
| `~/.dsh/skills-management/mcp.local.jsonc.bak` | 页面（每次保存前） | 上一版内容，出问题可以拿回来 |
| `~/.dsh/skills-management/mcp.json` | **只有插件写** | 唯一字段 `forcedOn`：记录页面强制打开过哪些手写条目。原子写、串行化、损坏或缺席都当空状态 |
| `~/.dsh/skills-management/ssh-config.json` 等 | 你写 / 页面「配置文件」面板写（留 `.bak`） | server 自己读的配置；保存后用到它的 server 自动重启 |

除此之外不写任何文件：不碰 dsh 的 `cordis.yml` / `cordis.patch.yml`，也不动这个目录以外的任何文件（「配置文件」面板对目录外的路径只展示、不可写）。旧版本状态文件里的 `version` / `disabled` / `servers` 读取时被忽略，里面有内容时页面会给一条提示。

## 安装

`dsh plugin add <路径>` 会在 profile 目录里跑 `pnpm add`，并把声明了 `dsh.bundle` 的依赖并进该 profile 的 bundles。本地目录会被记成 `link:` 符号链接（不是拷贝），所以改完源码不必重装。

```bash
dsh plugin add "<本仓库目录>"
```

安装完**重启 DSH**。设置页左侧会出现两个同级入口：「技能管理」和「MCP 管理」。

卸载：

```bash
dsh plugin remove dexter-skills-mcp-manager
```
