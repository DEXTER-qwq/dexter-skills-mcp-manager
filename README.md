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

以上第 1、2 点已在本次改造中**整体删除**（而非加开关），第 3 点的第三方 kit 依赖也已移除。

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
npm install                # yaml + js-tiktoken（devDeps: @deepseek-ai/schemastery）
npm run check              # 语法检查
npm test                   # node --test（宿主面 28 + 客户端面 12）
npm run build:client       # 由 client/index.js 生成 client/bundle.js
```

`client/bundle.js` 是构建产物，改完 `client/index.js` 必须重新 `build:client`。

当前依赖已按 `package-lock.json` 锁定；卸载/重装请使用 `npm ci`。

## 许可

MIT（沿用上游许可）。上游仓库：<https://github.com/weibaohui/skills-management>
