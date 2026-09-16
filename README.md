# @weibaohui/skills-management（本地版 / local-only fork）

DSH 插件 · **技能管理**：一个页面管理**本机**所有 coding agent 的技能目录（Claude Code、ZCode、Codex、WorkBuddy 等十余个执行器），可预览、一键收编进 DSH 用户库供 `skill` 工具调用。

> 这是上游 `@weibaohui/skills-management@0.6.1` 的**本地化改造版**：已移除「ntd 技能市场（git 仓库同步）」与「分享到 GitCode 官方仓库」两条**联网 / 起子进程**的功能链。运行期**不发任何网络请求、不 spawn 任何子进程**。

## 改造说明（与原版的差异）

### 已删除

| 原功能 | 涉及面 | 为什么删 |
| --- | --- | --- |
| **ntd 技能市场** | `src/index.js` 的 git 克隆/`fetch`+`reset --hard` 同步、`authedUrl()` token 拼 URL、稀疏检出、启动/每 24h 自动同步、`/api/market/*` 路由、市场设置命名空间；客户端的「市场」Tab、来源卡片、`MarketSettingsDialog`、市场 locale 文案 | 会向外部 GitCode 仓库发起网络请求并把访问令牌拼进 git 远端 URL；对不信任的仓库而言没有保留价值 |
| **分享到官方仓库** | `SHARE_PROMPT_ZH` 提示词、`ShareSkillDialog`、`/api/share/run` 两个路由；依赖 `@weibaohui/dsh-plugin-kit` 的 `createShareRunJob` | 该提示词会指示模型**读取本机 settings.yaml 里的 GitCode PAT** 并 `POST` 到 `api.gitcode.com`（fork/建分支/写文件/开 PR）；`/api/share/run` 还以任意 `dir` 为 cwd **spawn 一个 headless `dsh` 进程**执行任意 prompt |
| `@weibaohui/dsh-plugin-kit` 依赖 | `package.json`、客户端 bundle 内联段 | 仅被分享功能使用（host 端 `createShareRunJob` 就是 spawn / 会话执行器） |
| 市场专属注入开销预热 | 启动后台扫描，仅为市场 6600 条描述预热 token memo | 市场没了，预热无意义 |
| `.github/workflows/publish.yml` | npm Trusted Publishing CI | 本地私有分支，不再发布到 npm |
| `docs/demo*.gif`、`client/hooks/*.ts`、`client/components/*.ts` | 旧市场 UI 截图；上一版 koa 架构遗留的 TS hook，运行时从未被加载 | 与现界面不符 / 死代码 |

### 保留（纯本地能力）

- **全来源扫描**：本机各执行器的技能目录（`~/.claude/skills`、`~/.zcode/skills`、…），统一浏览、详情、单文件预览
- **一键收编**：任意来源的技能复制进 DSH 用户库（`$DSH_HOME/skills`），供模型 `skill` 工具调用
- **模型可见性治理**：切换 dsh 原生 frontmatter 键 `disable-model-invocation`（覆盖用户库与 `~/.agents/skills`）
- **删除技能**：按来源删除（显式标记 `readOnly` 的来源拒绝删除）
- **执行器目录管理**：内置来源可改目录 / 停用，可新增自定义来源，改完即生效
- **注入开销统计**：卡片与详情显示「≈N token · M 字符」，支持按 token / 字符排序
- **输入框 ＋ 技能**：composer 工具行的技能候选浮层（候选来自宿主技能注册表）

### API 面（本地唯一）

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
```

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

## 安装 / 使用

```bash
# 在本目录（或在 dsh 的插件目录）以本地路径方式接入：
dsh plugin --profile web add <本目录绝对路径> -w
```

装完重启 `dsh web`：**设置** → 左侧「技能管理」即完整管理页。

- 「已安装」视图：执行器卡片 → 钻入看该来源技能 → 安装 / 删除 / 隐藏
- ⚙ 执行器目录：改目录、停用、新增自定义来源、恢复默认
- 详情页：预览 SKILL.md 全文与附属文件、安装到用户库、切换模型可调用

## 开发

```bash
npm install                # 只装 devDeps（@deepseek-ai/schemastery）；运行期依赖为空
npm run check              # 语法检查
npm test                   # node --test（宿主面 32 + 客户端面 13）
npm run build:client       # 由 client/index.js 生成 client/bundle.js
```

> `npm test`（即 `node --test`）通过子进程跑测试文件；在受限沙箱里子进程 `stdio` 管道会被拒（`spawn EPERM`）。此时改为直接执行测试文件即可：
> `node test/skills.test.mjs && node test/ui.test.mjs`。

`client/bundle.js` 是构建产物，改完 `client/index.js` 必须重新 `build:client`（`test/ui.test.mjs` 有一条「bundle 是否为最新构建」的断言守着）。

依赖已按 `package-lock.json` 锁定；卸载/重装请使用 `npm ci`。

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | 宿主端：执行器扫描、本地 API、skill provider、frontmatter 读取器 |
| `client/index.js` | 客户端 React 源码：设置区页面 + composer「＋技能」按钮 |
| `client/bundle.js` | 构建产物（`npm run build:client` 生成，勿手改） |
| `cordis.patch.yml` | 插件接入宿主 composition 的 insert 行 |
| `test/skills.test.mjs` | 宿主面测试（含「无子进程/无网络/无第三方 require」守卫） |
| `test/ui.test.mjs` | 客户端面测试（含「无市场/分享残留 + bundle 新鲜度」守卫） |

## 许可

MIT（沿用上游许可）。上游仓库：<https://github.com/weibaohui/skills-management>
