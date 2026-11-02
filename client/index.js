/**
 * dexter-skills-mcp-manager - Browser half.
 *
 * One React app for every surface (settings section; the former sidebar
 *  full-page entry was retired — pair with dsh-settings-ui for room).
 * All interactive controls are host primitives (@deepseek-ai/dsh-client-ui-
 * primitives); all colors come from the ui-theme `--dsw-*` token layers so
 * light/dark follows the shell; all copy comes from the locale registry
 * (`zh`/`en`) so switches render live. No hardcoded colors, no ad-hoc copy.
 */

// React is a loader platform module. Under plain Node (contract tests) a
// minimal createElement/hook shim keeps the source loadable for assertions.
let __React = null
try { __React = require('react') } catch {}
if (!__React || typeof __React.createElement !== 'function') {
  __React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true && typeof k !== 'string' || true) }
    },
    useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
    useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
  }
}
const { createElement: h, useState, useEffect, useMemo, useRef } = __React

// Platform module — always present in the loader's seeded require table.
// Under plain Node (tests) it is absent; a tagged-element shim keeps the
// tree structurally testable while every real surface ships primitives.
let P = null
try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

// NOTE: no class components in this module. A `class X extends
// React.Component` error boundary defined here silently killed rendering in
// the plugin loader (components before it rendered, it never instantiated,
// zero errors) — render-time crashes are handled by the try/catch inside
// SkillsPage and recorded into globalThis.__skErrors instead.

/** Idempotent stylesheet injection — the overlay/tab/card classes are
 *  position-critical (.sk-overlay is position:fixed) so mounting without
 *  them renders the panel invisibly at the end of <body>. */
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('sk-styles')) return
  const holder = document.createElement('div')
  holder.id = 'sk-styles'
  holder.style.display = 'none'
  holder.innerHTML = STYLE
  document.head.appendChild(holder)
}

const prim = (name) => P && P[name]
  ? P[name]
  : function Shim(props) {
      const { children, text, ...rest } = props
      const tag = props.href ? 'a' : ['item', 'entry'].includes(props.__kind) ? 'div' : 'button'
      const el = document.createElement(tag === 'function' || typeof props.as === 'string' ? props.as : tag)
      return h(tag, { ...rest, 'data-p-shim': name }, children)
    }


// ── Locale ───────────────────────────────────────────────────────────────

const NS = 'skillsManagement'

const ZH = {
  title: '技能管理',
  close: '关闭',
  tabExecutors: '已安装',
  tabMcp: 'MCP 管理',
  mcpTitle: 'MCP 管理',
  mcpEmpty: '还没有 MCP server，点「+ 新增 server」开始。',
  mcpLoading: '正在读取 MCP 状态…',
  mcpStateFile: '状态文件',
  mcpLocalFile: '手写配置',
  mcpLocalHint: '点卡片就直接编辑这条配置；保存后立即生效，不必重启 dsh。用编辑器手改文件后点「刷新」或这一行的「重载」即可。',
  mcpLocalMissing: '手写配置还不存在 —— 用「+ 新增 server」新建它。',
  mcpLocalCorrupt: '手写配置无法解析：{error}',
  mcpLocalInvalid: '手写配置里有 {n} 条不合法，已被跳过',
  mcpSourceLocal: '手写配置',
  mcpLocalRowHint: '这条来自手写配置文件，文件里是开着的。本页只能把手写配置里停用的条目打开；要关它请点这条卡片、把「启用」取消勾选。',
  mcpLocalParkedHint: '这条在手写配置里是 "enabled": false（停用状态）。本页可以把它打开 —— 覆盖只记在本插件状态里，你的文件不会被改写。',
  mcpLocalForcedHint: '手写配置里这条是 "enabled": false，现在被本页开关强制开着（覆盖记在本插件状态里，文件没动）。',
  mcpShadowedTag: '有同名声明',
  mcpShadowedHint: '这个名字在别处也声明了（dsh 组合配置里，或者你的手写配置重复了一遍）。为保证不冲突只挂载优先级最高的那条，另一份被忽略；要消除请在对应文件里删掉多余的那份。',
  mcpStateCorrupt: '状态文件无法解析：{error} —— 下面的列表不完整。修好或删掉该文件，再重启 dsh。',
  mcpLegacyNotice: '这个状态文件是旧格式：{disabled} 条停用记录、{servers} 条本页新增的 server 已不再使用。',
  mcpSourceConfigured: 'dsh 组合配置',
  mcpSourceForeign: '其他插件挂载',
  mcpForeignHint: '这条由其他插件动态挂载，本页不动它，也不显示开关。那个插件一旦被停用，它会移除自己的条目、server 也随之消失。',
  mcpLiveTag: '已连接',
  mcpOfflineTag: '未连接',
  mcpToolsCount: '{n} 个工具',
  mcpDisable: '停用',
  mcpEnable: '启用',
  mcpDisabledTag: '未启用',
  mcpConfiguredHint: '这条来自 dsh 组合配置（bundle / profile patch），始终按配置生效；本页不提供开关，要关请改你自己的 dsh 配置。',
  mcpSaved: '已更新',
  mcpUnavailableTag: '能力不可用',
  mcpUnavailableHint: '宿主缺少 loader 服务，MCP server 无法挂载；列表仍会显示当前状态。',
  mcpEditConfig: '编辑配置',
  mcpConfigFiles: '配置文件',
  mcpReload: '重载',
  mcpReloadAll: '全部重载',
  mcpReloadHint: '重建这个 server 的进程：它自己读的配置文件（如 ssh-config.json）改了之后，只有重启进程才会重新加载。',
  mcpReloadedOne: '已重启 {name}，工具列表重新读取中',
  mcpReloadedMany: '已重启 {n} 个 server',
  mcpReloadedNone: '没有变化',
  mcpEdit: '编辑',
  mcpOpenHint: '点开编辑这条的配置',
  help: '提示',
  skillsHelpTitle: '技能管理说明',
  mcpHelpTitle: 'MCP 管理说明',
  mcpHelpSwitch: '开关与覆盖',
  mcpForcedTag: '已强制开启',
  mcpEditHint: '保存只会就地重写改动的那一条，其它注释与格式原样保留；写之前会把旧版本留成 .bak。配置有变化的 server 会被自动重启。',
  mcpEditCorrupt: '手写配置当前无法解析，先修好文件再从这里编辑。',
  mcpEditInvalid: '手写配置里有 {n} 条不合法，页面编辑会丢掉它们 —— 先在文件里修好或删掉再保存。',
  mcpNewServer: '+ 新增 server',
  mcpNoServers: '手写配置里还没有 server，点「+ 新增 server」开始。',
  mcpSelectServer: '左边选一条 server 编辑，或者新增一条。',
  mcpFormName: '服务名',
  mcpFormNameHint: '成为工具名前缀 mcp__<名字>__<工具名>；字母数字、下划线、连字符，≤32 字符',
  mcpFormTransport: '传输方式',
  mcpFormStdio: 'stdio（本机程序）',
  mcpFormHttp: 'streamable-http（远端地址）',
  mcpFormCommand: '命令',
  mcpFormArgs: '参数（一行一个）',
  mcpFormEnv: '环境变量（一行一个 KEY=value；值写 ${VAR} 表示读宿主环境变量）',
  mcpFormCwd: '工作目录（可选）',
  mcpFormUrl: '地址（http/https）',
  mcpFormHeaders: '请求头（一行一个 KEY=value）',
  mcpFormTimeout: '工具调用超时（毫秒，留空用 60000）',
  mcpFormEnabled: '启用',
  mcpFormRelated: '关联配置文件',
  mcpFormRelatedHint: '这个 server 自己还会读的文件（如 ssh-mcp-server 的 ssh-config.json）。改完保存会自动重启它。',
  mcpFormRelatedDetected: '自动识别',
  mcpFormRelatedDeclared: '手动添加',
  mcpFormRelatedNone: '没有检测到关联配置文件',
  mcpFormRelatedAdd: '添加文件路径（如 ~/.dsh/skills-management/ssh-config.json）',
  mcpFormRelatedAddBtn: '添加',
  mcpFormRelatedOutside: '不在本插件目录内，只能看路径',
  mcpUnnamed: '（未命名）',
  mcpRelatedTag: '关联文件',
  mcpEditSaved: '已保存到 mcp.local.jsonc',
  mcpEditSavedBackup: '已保存（旧版本留在 {name}）',
  mcpEditUnchanged: '没有改动',
  mcpFileSaved: '已保存 {name}',
  mcpFileSavedBackup: '已保存 {name}（旧版本留在 {backup}）',
  mcpFilePanelHint: 'mcp.local.jsonc 决定启动哪些 server；ssh-config.json 这类是 server 自己读的文件。在这里保存后，用到它的 server 会被自动重启。',
  mcpFileSave: '保存文件',
  mcpFileReload: '重新读取',
  mcpFileEmpty: '这里还没有可编辑的配置文件',
  mcpFileMissing: '未创建',
  mcpFileUnsaved: '有未保存的改动',
  mcpFileReadOnly: '只读预览',
  mcpFileExists: '{n} 字节',
  cardsHint: '选择一个智能体工具浏览它的技能，或一次查看全部',
  executorSettings: '执行器目录',
  executorSettingsHint: '管理本机各执行器的技能目录：内置来源可改目录、可停用；也可新增自定义来源。保存后立即生效，无需重启。',
  execSourceBuiltin: '内置',
  execSourceCustom: '自定义',
  execDisabledTag: '已停用',
  execManagedTag: '由插件配置文件管理',
  execLockedTag: '锁定（本插件安装库）',
  execEnabledLabel: '启用',
  execEditDir: '改目录',
  execDone: '完成',
  execAdd: '新增执行器',
  execRemove: '删除',
  execRestore: '恢复默认',
  execRestoreConfirm: '确认恢复默认？将清空全部目录修改、停用状态与自定义执行器。',
  execKeyPlaceholder: '如 my-cli（小写字母、数字、连字符）',
  execNamePlaceholder: '显示名（可留空，默认同 key）',
  execDirPlaceholder: '如 ~/.my-cli/skills',
  execKeyInvalid: 'key 必须是小写字母/数字/连字符（kebab-case）',
  execKeyDup: 'key 与现有执行器重复',
  execDirRequired: '目录不能为空',
  save: '保存',
  saved: '设置已保存',
  refresh: '刷新',
  backCards: '← 智能体工具卡片',
  backAll: '← 全部技能',
  browseAll: '浏览全部技能',
  showMore: '显示更多（还有 {n} 个）',
  searchAll: '搜索全部技能…',
  filterWithin: '在 {label} 内筛选…',
  pickSource: '全部智能体工具',
  loadingCatalogs: '正在加载全部智能体工具目录…',
  scanning: '正在扫描 {label}…',
  skillsSuffix: '个技能',
  noExecutors: '本机未发现任何智能体工具目录',
  notFoundGroup: '本机不存在的来源（{n}）',
  dirNotPresent: '目录不存在',
  emptySearch: '没有匹配的技能',
  emptySkillsIn: '{label} 中还没有技能',
  readOnlyTag: '只读',
  toDsh: '安装',
  deleteBtn: '删除',
  filesCount: '{n} 个文件',
  totalSize: '共 {size}',
  copy: '复制内容',
  copied: '已复制到剪贴板',
  installFrom: '从 {label} 安装',
  installTitle: '安装',
  installOk: '确认安装',
  cancel: '取消',
  installedToast: '已装入 DSH 技能库',
  installConfirm: '即将把「{name}」从「{label}」安装到 DSH 技能库，安装后可通过 DSH 的 skill 工具调用。',
  deleteTitle: '删除技能',
  deleteConfirm: '即将从「{where}」删除技能「{name}」，删除后不可恢复。',
  whereDsh: 'DSH 技能库',
  operationFailed: '操作失败',
  activeInDsh: '已在 DSH 生效',
  invocationToggle: '模型可调用',
  hiddenTag: '已隐藏',
  hideAction: '隐藏',
  restoreAction: '恢复可见',
  modelVisibleTag: '模型可见',
  detailHideAction: '在模型目录隐藏',
  invocationHint: '关闭后技能保留在库里，但不再注入对话目录（skill 工具也调不到）',
  pathLabel: '路径',
  meTag: '本机',
  codeCopy: '复制',
  codeCopied: '已复制',
  codeLabel: '代码',
  codeWrap: '自动换行',
  codeUnwrap: '取消自动换行',
  footnotes: '脚注',
}

const EN = {
  title: 'Skills',
  close: 'Close',
  tabExecutors: 'Installed',
  tabMcp: 'MCP',
  mcpTitle: 'MCP management',
  mcpEmpty: 'No MCP servers yet. Write yours into the hand-written config below.',
  mcpLoading: 'Reading MCP state…',
  mcpStateFile: 'State file',
  mcpStateCorrupt: 'The state file cannot be parsed: {error} — the list below is incomplete. Fix or delete it, then restart dsh.',
  mcpLegacyNotice: 'This state file is an older format: {disabled} disabled entries and {servers} servers added from the page are no longer used.',
  mcpSourceConfigured: 'dsh composition',
  mcpSourceForeign: 'mounted by another plugin',
  mcpSourceLocal: 'hand-written',
  mcpLocalFile: 'Hand-written config',
  mcpLocalHint: 'Click a card to edit that entry; saving applies immediately, no dsh restart. After editing the file by hand, press 「Refresh」 or the row’s 「Reload」.',
  mcpLocalMissing: 'The hand-written config does not exist yet — create it with 「+ New server」.',
  mcpLocalCorrupt: 'The hand-written config cannot be parsed: {error}',
  mcpLocalInvalid: '{n} entries in the hand-written config are invalid and were skipped',
  mcpLocalRowHint: 'This row comes from the hand-written config, which says it is on. This page can only switch on an entry the file parks — to switch this one off, click the card and clear “Enabled”.',
  mcpLocalParkedHint: 'This entry is parked with "enabled": false in the hand-written config. This page can switch it on — the override is recorded in this plugin’s state, and your file is never rewritten.',
  mcpLocalForcedHint: 'The hand-written config parks this entry with "enabled": false; it is on because this page switched it on. The override lives in this plugin’s state — your file was not touched.',
  mcpShadowedTag: 'duplicate name',
  mcpShadowedHint: 'This name is declared somewhere else too (the dsh composition, or twice in your hand-written config). Only the highest-precedence row is mounted, because a duplicate serverName would break the MCP client; the other declaration is ignored. Delete the extra one in its own file to clear this.',
  mcpForeignHint: 'Another plugin mounted this row at runtime, so this page leaves it alone and offers no switch. When that plugin is disabled it removes its own entry and the server disappears with it.',
  mcpLiveTag: 'connected',
  mcpOfflineTag: 'not connected',
  mcpToolsCount: '{n} tools',
  mcpDisable: 'Disable',
  mcpEnable: 'Enable',
  mcpDisabledTag: 'not enabled',
  mcpConfiguredHint: 'This row comes from the dsh composition (bundle / profile patch) and is always on as configured; this page offers no switch — change your own dsh config to switch it off.',
  mcpSaved: 'Updated',
  mcpUnavailableTag: 'capability unavailable',
  mcpUnavailableHint: 'The host lacks the loader service, so MCP servers cannot be mounted; the list still shows current state.',
  mcpEditConfig: 'Edit config',
  mcpConfigFiles: 'Config files',
  mcpReload: 'Reload',
  mcpReloadAll: 'Reload all',
  mcpReloadHint: 'Rebuild this server’s process. A config file it reads itself (ssh-config.json, …) is only re-read by a new process.',
  mcpReloadedOne: 'Restarted {name}; the tool list is being re-read',
  mcpReloadedMany: 'Restarted {n} servers',
  mcpReloadedNone: 'Nothing changed',
  mcpEdit: 'Edit',
  mcpOpenHint: 'Click to edit this entry',
  help: 'Help',
  skillsHelpTitle: 'About skill management',
  mcpHelpTitle: 'About MCP management',
  mcpHelpSwitch: 'Switches and overrides',
  mcpForcedTag: 'forced on',
  mcpEditHint: 'Saving rewrites only the entries that changed, in place — every other line, comments included, stays as written, and the previous version is kept as .bak. Servers whose config changed are restarted.',
  mcpEditCorrupt: 'The hand-written config cannot be parsed right now; fix the file before editing here.',
  mcpEditInvalid: '{n} entries in the hand-written config are invalid and saving from this page would drop them — fix or delete them in the file first.',
  mcpNewServer: '+ New server',
  mcpNoServers: 'No servers in the hand-written config yet — start with 「+ New server」.',
  mcpSelectServer: 'Pick a server on the left, or add one.',
  mcpFormName: 'Server name',
  mcpFormNameHint: 'Becomes the tool prefix mcp__<name>__<tool>; letters, digits, underscore, hyphen, ≤32 chars',
  mcpFormTransport: 'Transport',
  mcpFormStdio: 'stdio (local process)',
  mcpFormHttp: 'streamable-http (remote URL)',
  mcpFormCommand: 'Command',
  mcpFormArgs: 'Arguments (one per line)',
  mcpFormEnv: 'Environment (one KEY=value per line; ${VAR} reads the host environment)',
  mcpFormCwd: 'Working directory (optional)',
  mcpFormUrl: 'URL (http/https)',
  mcpFormHeaders: 'Headers (one KEY=value per line)',
  mcpFormTimeout: 'Tool-call timeout (ms; empty uses 60000)',
  mcpFormEnabled: 'Enabled',
  mcpFormRelated: 'Related config files',
  mcpFormRelatedHint: 'Files this server reads itself (e.g. ssh-config.json for ssh-mcp-server). Saving restarts it.',
  mcpFormRelatedDetected: 'detected',
  mcpFormRelatedDeclared: 'added',
  mcpFormRelatedNone: 'No related config file detected',
  mcpFormRelatedAdd: 'Add a file path (e.g. ~/.dsh/skills-management/ssh-config.json)',
  mcpFormRelatedAddBtn: 'Add',
  mcpFormRelatedOutside: 'outside this plugin’s directory — path only',
  mcpUnnamed: '(unnamed)',
  mcpRelatedTag: 'related files',
  mcpEditSaved: 'Saved to mcp.local.jsonc',
  mcpEditSavedBackup: 'Saved (previous version kept as {name})',
  mcpEditUnchanged: 'Nothing changed',
  mcpFileSaved: 'Saved {name}',
  mcpFileSavedBackup: 'Saved {name} (previous version kept as {backup})',
  mcpFilePanelHint: 'mcp.local.jsonc decides which servers start; ssh-config.json and friends are read by the servers themselves. Saving here restarts the servers that use the file.',
  mcpFileSave: 'Save file',
  mcpFileReload: 'Reload',
  mcpFileEmpty: 'No editable config file here yet',
  mcpFileMissing: 'not created',
  mcpFileUnsaved: 'unsaved changes',
  mcpFileReadOnly: 'read-only preview',
  mcpFileExists: '{n} bytes',
  cardsHint: 'Pick an agent tool to browse its skills, or view everything at once',
  executorSettings: 'Executor dirs',
  executorSettingsHint: 'Manage the skill directories of on-machine executors: built-in sources can be redirected or disabled; custom sources can be added. Changes apply immediately, no restart.',
  execSourceBuiltin: 'built-in',
  execSourceCustom: 'custom',
  execDisabledTag: 'disabled',
  execManagedTag: 'managed by plugin config',
  execLockedTag: 'locked (this plugin\'s library)',
  execEnabledLabel: 'Enabled',
  execEditDir: 'Change',
  execDone: 'Done',
  execAdd: 'Add executor',
  execRemove: 'Remove',
  execRestore: 'Restore defaults',
  execRestoreConfirm: 'Restore defaults? This clears all dir overrides, disabled flags and custom executors.',
  execKeyPlaceholder: 'e.g. my-cli (lowercase letters, digits, hyphens)',
  execNamePlaceholder: 'Display name (optional, defaults to key)',
  execDirPlaceholder: 'e.g. ~/.my-cli/skills',
  execKeyInvalid: 'key must be kebab-case (a-z 0-9 -)',
  execKeyDup: 'key conflicts with an existing executor',
  execDirRequired: 'directory is required',
  save: 'Save',
  saved: 'Settings saved',
  refresh: 'Refresh',
  backCards: '← Agent tool cards',
  backAll: '← All skills',
  browseAll: 'Browse all skills',
  showMore: 'Show more ({n} left)',
  searchAll: 'Search all skills…',
  filterWithin: 'Filter within {label}…',
  pickSource: 'All agent tools',
  loadingCatalogs: 'Loading all agent tool catalogs…',
  scanning: 'Scanning {label}…',
  skillsSuffix: 'skills',
  noExecutors: 'No agent tool directories found on this machine',
  notFoundGroup: 'Not found on this machine ({n})',
  dirNotPresent: 'directory not present',
  emptySearch: 'No matching skills',
  emptySkillsIn: 'No skills in {label}',
  readOnlyTag: 'read-only',
  toDsh: 'Install',
  deleteBtn: 'Delete',
  filesCount: '{n} files',
  totalSize: '{size}',
  copy: 'Copy content',
  copied: 'Copied to clipboard',
  installFrom: 'Install from {label}',
  installTitle: 'Install',
  installOk: 'Install',
  cancel: 'Cancel',
  installedToast: 'Installed into the DSH library',
  installConfirm: 'Install "{name}" from {label} into the DSH skills library. It becomes callable through the DSH skill tool.',
  deleteTitle: 'Delete skill',
  deleteConfirm: 'You are about to delete "{name}" from {where}. This cannot be undone.',
  whereDsh: 'the DSH library',
  operationFailed: 'Operation failed',
  activeInDsh: 'active in DSH',
  invocationToggle: 'Model-invocable',
  hiddenTag: 'hidden',
  hideAction: 'Hide',
  restoreAction: 'Restore',
  modelVisibleTag: 'model-visible',
  detailHideAction: 'Hide from model catalog',
  invocationHint: 'When off, the skill stays in the library but is not injected into conversation catalogs',
  pathLabel: 'Path',
  meTag: 'me',
  codeCopy: 'Copy',
  codeCopied: 'Copied',
  codeLabel: 'Code',
  codeWrap: 'Wrap lines',
  codeUnwrap: 'No wrap',
  footnotes: 'Footnotes',
}

// ── Pure helpers ────────────────────────────────────────────────────────

const API = '/skills-management/api'

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatTime(iso) {
  if (!iso) return '-'
  try {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
    if (days > 30) return new Date(iso).toLocaleDateString()
    if (days > 0) return days + 'd'
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
    if (hours > 0) return hours + 'h'
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (minutes > 0) return minutes + 'm'
    return 'now'
  } catch { return '-' }
}

function gradient(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  const h1 = Math.abs(hash) % 360
  return `linear-gradient(135deg, hsl(${h1},55%,55%), hsl(${(h1 + 40) % 360},45%,45%))`
}

const shortName = (name) => name.includes('/') ? name.split('/').slice(1).join('/') : name

/** Shared predicate for skill filtering (name / description / keywords). */
function matchSkill(s, lower) {
  return (s.name || '').toLowerCase().includes(lower) ||
    (s.description || '').toLowerCase().includes(lower) ||
    (s.keywords || []).some(k => String(k).toLowerCase().includes(lower))
}

// ── Token-based stylesheet (light/dark adaptive by construction) ────────

const STYLE = `<style>
.sk-page{position:relative;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}
.sk-overlay{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base);overflow:auto;padding:20px 26px}
.sk-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sk-body{display:flex;flex-direction:column;gap:14px}
.sk-inv-toggle{display:inline-flex;gap:8px;align-items:center}
.spacer{flex:1}
.sk-hint{color:var(--dsw-alias-label-secondary)}
.sk-dir{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13,12px)}
.sk-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.sk-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.sk-tag.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sk-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.sk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.sk-src{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;align-items:start}
.sk-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left}
.sk-card:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.sk-card.missing{opacity:.5;cursor:default}
/* a row this page cannot act on must not offer the hover affordance of a card that opens */
.sk-card.static:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.sk-avatar.sq{border-radius:12px}
.sk-avatar{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--dsw-alias-label-primary-inverted,#fff);font-size:17px;flex:none}
.sk-title{font-weight:600;word-break:break-all}
.sk-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sk-stats{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.sk-chips{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.sk-rowbtns{display:flex;gap:6px;flex-wrap:wrap}
.sk-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sk-countline{display:flex;align-items:baseline;gap:2px;color:var(--dsw-alias-label-secondary);font-size:13px}
.sk-count{font-size:26px;font-weight:700;color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary))}
.sk-count.none{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.sk-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:44px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}
.sk-loading{padding:48px;text-align:center;color:var(--dsw-alias-label-secondary)}
.sk-spin{width:30px;height:30px;margin:0 auto 10px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));animation:skspin .7s linear infinite}
@keyframes skspin{to{transform:rotate(360deg)}}
.sk-list{display:flex;flex-direction:column;gap:8px}
.sk-list .sk-card{flex-direction:row;align-items:center;padding:12px 14px}
.sk-filewrap{display:flex;gap:14px;min-height:300px}
.sk-files{flex:0 0 230px;max-height:430px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.sk-file{display:flex;align-items:center;gap:8px;width:100%;padding:7px 11px;font-size:12.5px;border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.sk-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sk-file.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
.sk-preview{flex:1;max-height:430px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px}
.sk-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.sk-meta div{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;min-width:0}
.sk-dlg-backdrop{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
.sk-dlg{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;min-width:340px;max-width:640px;max-height:82vh;overflow:auto;padding:18px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.sk-dlg h3{margin:0 0 12px;font-size:15px}
.sk-dlg-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.sk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}
.sk-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.sk-btn:disabled{opacity:.5;cursor:not-allowed}
.sk-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.sk-btn-primary:hover{filter:brightness(1.08);background:var(--dsw-alias-state-business-primary)}
.sk-btn-sm{min-height:28px;padding:4px 12px;font-size:12.5px;min-width:64px}
.sk-input{min-height:32px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none}
.sk-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.sk-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sk-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}
.sk-menu{position:absolute;top:100%;left:0;margin-top:4px;min-width:220px;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv2,var(--dsw-shadow-lv1));z-index:2147483600;padding:4px}
.sk-menu-item{padding:8px 12px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;white-space:nowrap}
.sk-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sk-menu-item.on{color:var(--dsw-alias-state-business-primary);font-weight:500}
.sk-split{display:flex;gap:14px;align-items:stretch;min-height:300px}
.sk-split-left{flex:0 0 218px;max-height:440px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:4px}
.sk-split-right{flex:1;min-width:0;max-height:440px;overflow:auto}
.sk-pick{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer;font-family:var(--dsw-font-family)}
.sk-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sk-pick.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);font-weight:500}
.sk-textarea{width:100%;min-height:280px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.55;outline:none;box-sizing:border-box}
.sk-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.sk-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.sk-field > label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sk-filerow{display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;margin-bottom:6px;flex-wrap:wrap}
.sk-erow{display:flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;flex-wrap:wrap}
.sk-erow-path{flex:1;min-width:120px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk-fold{align-self:flex-start;background:none;border:none;padding:4px 2px;color:var(--dsw-alias-label-secondary);font-size:13px;font-family:var(--dsw-font-family);cursor:pointer}
.sk-fold:hover{color:var(--dsw-alias-label-primary)}
</style>`

// ── Fetch layer ─────────────────────────────────────────────────────────

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

// ── Host MarkdownText contract ───────────────────────────────────────────
//
// `MarkdownText` has NO default for `labels`: in the host's markdown renderer
// `renderCode()` reads `context.labels.code.copyLabel` unconditionally, so the
// moment the text carries one non-empty fenced code block (and no labels were
// passed) the primitive throws `TypeError: Cannot read properties of undefined
// (reading 'code')` INSIDE ITS OWN RENDER. That throw escapes our component
// (it happens after `h()` returns, so no try/catch of ours can see it), reaches
// the slot renderer's error boundary, and a non-chain slot entry is then
// *abdicated* — the settings section renders an empty div for the rest of the
// session. Symptom: the page goes blank the first time a skill preview with a
// code fence loads, and it never comes back. So: every call site must pass the
// full labels object, shape copied from the host's own `markdownLabels()`.

/** The host primitive, or null when it is absent (plain-Node tests): the
 *  `prim()` shim is NOT usable here — it always returns a function, so the
 *  `? MarkdownText : <pre>` fallbacks below would never take the `<pre>` arm. */
const MarkdownText = P && typeof P.MarkdownText === 'function' ? P.MarkdownText : null

/** Localized chrome the host markdown renderer reads off `labels`. */
function markdownLabels(t) {
  return {
    code: {
      copyLabel: t('codeCopy'),
      copiedLabel: t('codeCopied'),
      toolbarLabels: {
        codeLabel: t('codeLabel'),
        wrapLabel: t('codeWrap'),
        unwrapLabel: t('codeUnwrap'),
      },
    },
    footnotes: t('footnotes'),
  }
}

// ── Small building blocks ────────────────────────────────────────────────

const Tag = ({ tone, children }) =>
  h('span', { className: 'sk-tag' + (tone ? ' ' + tone : '') }, children)

const Spinner = ({ label }) =>
  h('div', { className: 'sk-loading' },
    h('div', { className: 'sk-spin' }),
    h('div', null, label))

const Empty = ({ children }) => h('div', { className: 'sk-empty' }, children)

function Avatar({ name, square, size }) {
  const sizing = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : {}
  return h('div', { className: 'sk-avatar' + (square ? ' sq' : ''),
      style: { background: gradient(name), ...sizing } },
    (name[0] || '?').toUpperCase())
}

/** Executor dropdown: self-contained popover (host primitives expose no Menu). */
function SourceFilter({ rows, value, onChange, t }) {
  const [open, setOpen] = useState(false)
  const items = [
    { id: 'all', label: `${t('pickSource')} (${rows.reduce((a, r) => a + r.skillCount, 0)})` },
    ...rows.map(x => ({ id: x.key, label: `${x.label} (${x.skillCount})` })),
  ]
  const current = value === 'all' ? null : rows.find(r => r.key === value)
  const label = value === 'all'
    ? `${t('pickSource')} (${rows.reduce((a, r) => a + r.skillCount, 0)})`
    : `${current ? current.label : value} (${current ? current.skillCount : 0})`
  return h('span', { style: { position: 'relative', display: 'inline-flex' } },
    h(P.Button, { variant: 'outline', size: 'sm',
        onClick: () => setOpen(o => !o), title: label },
      label,
      P.IconChevronDownOutline14 ? h(P.IconChevronDownOutline14, { size: 12 }) : ' ▾'),
    open && h('div', { className: 'sk-menu' },
      items.map(item => h('div', {
        key: item.id,
        className: 'sk-menu-item' + (item.id === value ? ' on' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => { onChange(item.id); setOpen(false) },
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { onChange(item.id); setOpen(false) } },
      }, item.label))))
}

// ── Skill / executor cards ───────────────────────────────────────────────

function SkillCard({ row, s, t, onOpen, onInstall, onDelete, onToggleVisible }) {
  const name = shortName(s.name)
  return h('div', { className: 'sk-card', role: 'button', tabIndex: 0,
      onClick: () => onOpen(s),
      onKeyDown: e => e.key === 'Enter' && onOpen(s) },
    h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
      h(Avatar, { name }),
      h('div', { style: { minWidth: 0 } },
        h('div', { className: 'sk-title' }, name),
        (s.fileCount || s.totalSize) && h('div', { className: 'sk-dir' }, `${s.fileCount || 0} · ${formatSize(s.totalSize || 0)} · ${formatTime(s.modifiedAt)}`))),
    h('div', { className: 'sk-desc' }, s.description || ''),
    h('div', { className: 'sk-foot' },
      h('div', { className: 'sk-chips' },
        h(Tag, null, row.label),
        row.readOnly && h(Tag, { tone: 'danger' }, t('readOnlyTag')),
        s.version && h(Tag, { tone: 'accent' }, 'v' + s.version),
        (row.key === 'dsh' || row.key === 'agents') && s.modelInvocable === false && h(Tag, { tone: 'danger' }, t('hiddenTag'))),
      h('div', { className: 'sk-rowbtns' },
        row.key !== 'dsh' && h(ButtonLite, { primary: true, small: true,
          onClick: e => { e.stopPropagation(); onInstall(row, s.installName || s.name) } }, t('toDsh')),
        (row.key === 'dsh' || row.key === 'agents') && h(ButtonLite, { small: true,
          title: s.modelInvocable === false ? t('restoreAction') : t('hideAction'),
          onClick: e => { e.stopPropagation(); onToggleVisible(row, s.name, s.modelInvocable === false) } },
          s.modelInvocable === false ? t('restoreAction') : t('hideAction')),
        (row.deletable !== false && !row.readOnly) && h(ButtonLite, { danger: true, small: true,
          onClick: e => { e.stopPropagation(); onDelete(row, s.name) } }, t('deleteBtn')))))
}

/** Tiny variant buttons before P.Button availability resolution settles —
 *  unified through primitives in the browser via data-p-* swap below. */
function ButtonLite({ primary, danger, small, children, ...rest }) {
  const cls = 'sk-btn' + (primary ? ' sk-btn-primary' : '') + (small ? ' sk-btn-sm' : '')
  if (prim('Button')) {
    return h(P.Button, {
      variant: primary ? 'primary' : 'outline',
      size: small ? 'sm' : 'md',
      className: cls,
      ...rest,
    }, children)
  }
  return h('button', {
    className: cls,
    ...rest,
  }, children)
}

function ExecutorCard({ row, t, onEnter }) {
  const count = Array.isArray(row.skills) ? row.skills.length : (row.skillCount || 0)
  const sizeTotal = Array.isArray(row.skills) ? row.skills.reduce((a, s) => a + (s.totalSize || 0), 0) : null
  return h('div', { className: 'sk-card', role: 'button', tabIndex: 0, style: !row.dirExists ? { opacity: 0.5, cursor: 'default' } : undefined,
      onClick: () => row.dirExists && onEnter(row.key),
      onKeyDown: e => e.key === 'Enter' && row.dirExists && onEnter(row.key) },
    h('div', { className: 'sk-head' },
      h(Avatar, { name: row.label, square: true, size: 40 }),
      h('span', { className: 'sk-title' }, row.label),
      row.readOnly && h(Tag, { tone: 'danger' }, t('readOnlyTag')),
      row.key === 'dsh' && h(Tag, { tone: 'accent' }, t('meTag'))),
    h('div', { className: 'sk-countline' },
      row.dirExists
        ? [h('span', { key: 'n', className: 'sk-count' + (count ? '' : ' none') }, String(count)),
           ' ' + t('skillsSuffix') + (sizeTotal != null ? ' · ' + t('totalSize', { size: formatSize(sizeTotal) }) : '')]
        : t('dirNotPresent')),
    h('div', { className: 'sk-dir' }, row.dir))
}

// ── Detail modal ─────────────────────────────────────────────────────────

function DetailModal({ sel, executors, t, onClose, onInstalled, onDeleted }) {
  const [data, setData] = useState(null)
  const [file, setFile] = useState(null)
  const [fileText, setFileText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [toast, setToast] = useState(false)
  const meta = data?.meta || {}
  const row = sel.executorKey ? executors.find(x => x.key === sel.executorKey) : null

  useEffect(() => {
    let alive = true
    setData(null)
    const q = `?name=${encodeURIComponent(sel.name)}${sel.executorKey ? '&executor=' + encodeURIComponent(sel.executorKey) : ''}`
    getJson(API + '/detail' + q).then(d => { if (alive) setData(d) }).catch(() => {})
    return () => { alive = false }
  }, [sel])

  const openFile = (f) => {
    setFile(f)
    const q = `?name=${encodeURIComponent(sel.name)}&path=${encodeURIComponent(f.path)}${sel.executorKey ? '&executor=' + encodeURIComponent(sel.executorKey) : ''}`
    fetch(API + '/file' + q).then(r => { if (!r.ok) throw 0; return r.text() }).then(setFileText).catch(() => setFileText(''))
  }

  const doDelete = async () => {
    try {
      const body = { name: sel.name }
      if (sel.executorKey) body.executor = sel.executorKey
      const r = await fetch(API, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
      setConfirming(false)
      onDeleted()
    } catch (e) { setConfirming(false); alert(t('operationFailed') + ': ' + e.message) }
  }

  const doInstall = async () => {
    try {
      const body = { name: sel.name }
      if (sel.executorKey && sel.executorKey !== 'dsh') body.from = sel.executorKey
      const r = await fetch(API + '/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
      onInstalled()
    } catch (e) { alert(t('operationFailed') + ': ' + e.message) }
  }

  const copyContent = () => {
    navigator.clipboard.writeText(data?.content || '').then(() => {
      setToast(true)
      setTimeout(() => setToast(false), 2200)
    }).catch(() => {})
  }

  // 治理键开关（dsh 原生 disable-model-invocation）：对用户库（dsh 行）和
  // user-agents 根（agents 行——dsh 内置扫描 ~/.agents/skills）的技能开放
  const [invBusy, setInvBusy] = useState(false)
  const modelVisible = meta['disable-model-invocation'] !== true
  const toggleInvocation = async () => {
    setInvBusy(true)
    try {
      const r = await fetch(API + '/invocation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sel.name, modelInvocable: !modelVisible }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
      const q = `?name=${encodeURIComponent(sel.name)}${sel.executorKey ? '&executor=' + encodeURIComponent(sel.executorKey) : ''}`
      getJson(API + '/detail' + q).then(d => { setData(d) }).catch(() => {})
    } catch (e) { alert(t('operationFailed') + ': ' + e.message) } finally { setInvBusy(false) }
  }

  const files = data?.files || []
  const isMd = file ? file.path.endsWith('.md') : true
  // Stable identity per locale revision: MarkdownText memoizes on `labels`,
  // and a new object every render would re-parse the whole document.
  const mdLabels = useMemo(() => markdownLabels(t), [t])

  return h('div', null,
    h(SkDialog, { title: shortName(sel.name), onClose, wide: true },
          h('div', { className: 'sk-page' },
            h('div', { className: 'sk-hint' }, meta.description || meta.whenToUse || ''),
            h('div', { className: 'sk-toolbar' },
              row && row.key !== 'dsh' && h(P.Button, { variant: 'primary', size: 'sm', onClick: doInstall }, `${t('installFrom', { label: row.label })}`),
              row && row.key === 'dsh' && h(Tag, { tone: 'ok' }, t('activeInDsh')),
              row && (row.key === 'dsh' || row.key === 'agents') && h('span', { className: 'sk-inv-toggle', title: t('invocationHint') },
                h('span', { className: 'sk-dir' }, t('invocationToggle')),
                modelVisible ? h(Tag, { tone: 'ok' }, t('modelVisibleTag')) : h(Tag, { tone: 'danger' }, t('hiddenTag')),
                h(P.Button, { size: 'sm', variant: 'outline', disabled: invBusy, onClick: toggleInvocation },
                  modelVisible ? t('detailHideAction') : t('restoreAction'))),
              row && row.readOnly && h(Tag, { tone: 'danger' }, t('readOnlyTag')),
              h(P.Button, { variant: 'outline', size: 'sm', onClick: copyContent }, t('copy')),
              h('span', { className: 'spacer' }),
              row && !row.readOnly && h(P.Button, { variant: 'outline', size: 'sm', onClick: () => setConfirming(true) }, t('deleteBtn'))),
            h('div', { className: 'sk-meta' },
              h('div', null, h('div', { className: 'sk-dir' }, t('pathLabel')), h('div', { className: 'sk-hint' }, data?.dir || '-')),
              h('div', null, h('div', { className: 'sk-dir' }, t('filesCount', { n: data?.fileCount ?? 0 })), h('div', { className: 'sk-hint' }, formatSize(data?.totalSize || 0))),
              meta.version && h('div', null, h('div', { className: 'sk-dir' }, 'Version'), h('div', { className: 'sk-hint' }, 'v' + meta.version)),
              meta.author && h('div', null, h('div', { className: 'sk-dir' }, 'Author'), h('div', { className: 'sk-hint' }, meta.author))),
            files.length
              ? h('div', { className: 'sk-filewrap' },
                  h('div', { className: 'sk-files' }, files.map(f =>
                    h('button', { key: f.path, className: 'sk-file' + ((file ? f.path === file.path : f.path === 'SKILL.md') ? ' on' : ''), onClick: () => openFile(f) },
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path),
                      h('span', { className: 'sk-dir' }, formatSize(f.size))))),
                  h('div', { className: 'sk-preview sk-md' },
                    isMd && MarkdownText
                      ? h(MarkdownText, { text: file ? fileText : (data?.content || ''), labels: mdLabels })
                      : h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--dsw-font-family)' } }, file ? fileText : (data?.content || ''))))
              : h('div', { className: 'sk-preview sk-md' },
                  MarkdownText
                    ? h(MarkdownText, { text: data?.content || '', labels: mdLabels })
                    : h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, data?.content || '')))),
    confirming && h(SkDialog, {
      title: t('deleteTitle'),
      onClose: () => setConfirming(false),
      footer: [
        h(ButtonLite, { onClick: () => setConfirming(false) }, t('cancel')),
        h(ButtonLite, { danger: true, primary: true, onClick: doDelete }, t('deleteBtn')),
      ],
    }, h('div', { className: 'sk-hint' }, t('deleteConfirm', { name: sel.name, where: row ? row.label : t('whereDsh') }))),
    toast && h(InToast, { text: t('copied') }))
}

/** In-page dialog: rendered INSIDE the fullscreen overlay's stacking context
 *  so it can never fall behind it (host Modal portals to <body> with a lower
 *  z-index than the fullscreen page and would be invisible). */
function SkDialog({ title, onClose, footer, children, wide }) {
  return h('div', { className: 'sk-dlg-backdrop', onClick: onClose },
    h('div', { className: 'sk-dlg', style: wide ? { maxWidth: 920, width: '92vw' } : undefined,
        onClick: e => e.stopPropagation() },
      title && h('h3', null, title),
      children,
      footer && h('div', { className: 'sk-dlg-foot' }, footer)))
}

function InToast({ text }) {
  return h('div', { className: 'sk-toast' }, text)
}

/** 执行器目录管理：内置行可改目录/停用（dsh 锁定；cordis 配置管理的行只展示），
 *  自定义行可增删改。保存 = 整表 PUT executor-settings（replace 语义），服务端
 *  逐行校验（key kebab、重复、dsh 锁定），改完即时生效无需重启。 */
function ExecutorSettingsDialog({ t, onClose, onToast, onChanged }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [restoreArmed, setRestoreArmed] = useState(false)
  // 行的 React key 必须稳定：不能用 r.key——它是可编辑字段，逐字输入会整行
  // 重挂载、输入框丢焦点（每个字符后）。__id 在行创建/载入时分配。
  const rowSeq = useRef(0)
  const withIds = (list) => (Array.isArray(list) ? list : []).map((r) => ({ ...r, __id: 'r' + (++rowSeq.current) }))

  const applySheet = (d) => setRows(withIds(d && d.executors))
  const refresh = () => getJson(API + '/executor-settings')
    .then(applySheet)
    .catch(e => onToast(t('operationFailed') + ': ' + e.message))
  useEffect(() => { refresh() }, [])

  const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const patchRow = (index, patch) => setRows(rs => rs.map((r, i) => i === index ? { ...r, ...patch } : r))
  const removeRow = (index) => setRows(rs => rs.filter((_, i) => i !== index))
  const addRow = () => setRows(rs => [...rs, { __id: 'r' + (++rowSeq.current), key: '', label: '', dir: '', source: 'custom', locked: false, managedByConfig: false, disabled: false, overridden: false, defaultDir: '', editing: true }])

  const validate = () => {
    const customs = rows.filter(r => r.source === 'custom' && !r.managedByConfig)
    for (const r of customs) {
      if (!KEBAB.test(String(r.key || '').trim())) return t('execKeyInvalid')
      if (!String(r.dir || '').trim()) return t('execDirRequired')
    }
    const keys = customs.map(r => String(r.key || '').trim())
    if (keys.some((k, i) => keys.indexOf(k) !== i)) return t('execKeyDup')
    return undefined
  }

  const saveSheet = async (sheet) => {
    const r = await fetch(API + '/executor-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sheet) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
    applySheet(d)
    setRestoreArmed(false)
    onToast(t('saved'))
    onChanged && onChanged()
  }
  const doSave = async () => {
    if (!rows) return
    const err = validate()
    if (err) { onToast(t('operationFailed') + ': ' + err); return }
    setBusy(true)
    try {
      const dirs = {}
      const disabled = []
      for (const r of rows) {
        if (r.source !== 'builtin' || r.locked || r.managedByConfig) continue
        if (r.disabled) disabled.push(r.key)
        const dir = String(r.dir || '').trim()
        // 等于默认值的覆盖不落盘（保持 sheet 干净）；已在 sheet 里的条目原样带回
        if (dir !== '' && (r.overridden || dir !== r.defaultDir)) dirs[r.key] = dir
      }
      const extra = rows
        .filter(r => r.source === 'custom' && !r.managedByConfig)
        .map(r => ({ key: String(r.key || '').trim(), label: String(r.label || '').trim() || String(r.key || '').trim(), dir: String(r.dir || '').trim() }))
      await saveSheet({ dirs, disabled, extra })
    } catch (e) { onToast(t('operationFailed') + ': ' + e.message) } finally { setBusy(false) }
  }
  const doRestore = async () => {
    if (!restoreArmed) { setRestoreArmed(true); return }
    setBusy(true)
    try { await saveSheet({ dirs: {}, disabled: [], extra: [] }) }
    catch (e) { onToast(t('operationFailed') + ': ' + e.message) } finally { setBusy(false) }
  }


  return h(SkDialog, { title: t('executorSettings'), onClose, wide: true },
    rows === null
      ? h(Spinner, { label: '…' })
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { className: 'sk-hint' }, t('executorSettingsHint')),
          h(ExecutorList, { t, rows, onPatch: patchRow, onRemove: removeRow }),
          h('div', { style: { textAlign: 'center' } },
            h(ButtonLite, { small: true, onClick: addRow }, '+ ' + t('execAdd'))),
          restoreArmed && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-end' } }, t('execRestoreConfirm')),
          h('div', { className: 'sk-dlg-foot', style: { marginTop: 2 } },
            h(ButtonLite, { onClick: doRestore }, t('execRestore')),
            h('span', { style: { flex: 1 } }),
            h(ButtonLite, { primary: true, disabled: busy, onClick: doSave }, t('save'))),
        ]))
}

/**
 * The executor rows themselves — presentational, so the compact one-line layout
 * can be rendered from a fixture in the contract tests.
 *
 * One row per source: `[内置] Name  <path>  [改目录] [☑ 启用]`. The directory is
 * plain text until「改目录」is pressed; that is the whole point — the editor used
 * to put a full-width input under all 17 rows and the dialog became a wall of
 * boxes for a setting most users never touch.
 */
function ExecutorList({ t, rows, onPatch, onRemove }) {
  const tag = (text, tone) => h('span', { className: 'sk-tag' + (tone ? ' ' + tone : '') }, text)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    rows.map((r, i) => {
      const editable = !r.locked && !r.managedByConfig
      const isCustom = r.source === 'custom'
      const editing = editable && r.editing === true
      return h('div', { key: r.__id, className: 'sk-erow', style: { opacity: r.disabled ? 0.55 : 1 } },
        h('span', { className: 'sk-tag' }, isCustom ? t('execSourceCustom') : t('execSourceBuiltin')),
        isCustom && editable
          ? [
              h('input', { key: 'k', className: 'sk-input', value: r.key, placeholder: t('execKeyPlaceholder'),
                style: { width: 132 }, onChange: e => onPatch(i, { key: e.target.value }) }),
              h('input', { key: 'l', className: 'sk-input', value: r.label, placeholder: t('execNamePlaceholder'),
                style: { width: 120 }, onChange: e => onPatch(i, { label: e.target.value }) }),
            ]
          : h('span', { className: 'sk-title' }, r.label),
        r.locked && tag(t('execLockedTag')),
        !r.locked && r.managedByConfig && tag(t('execManagedTag')),
        r.disabled && tag(t('execDisabledTag'), 'danger'),
        editing
          ? h('input', { className: 'sk-input', autoFocus: true, value: r.dir, placeholder: t('execDirPlaceholder'),
              style: { flex: 1, minWidth: 150 }, onChange: e => onPatch(i, { dir: e.target.value }) })
          : h('span', { className: 'sk-erow-path', title: r.dir || r.defaultDir }, r.dir || '-'),
        editable && h(ButtonLite, { small: true, onClick: () => onPatch(i, { editing: !editing }) },
          editing ? t('execDone') : t('execEditDir')),
        r.source === 'builtin' && editable
          ? h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: !r.disabled, onChange: e => onPatch(i, { disabled: !e.target.checked }) }), t('execEnabledLabel'))
          : null,
        isCustom && editable
          ? h(ButtonLite, { small: true, danger: true, onClick: () => onRemove(i) }, t('execRemove'))
          : null)
    }))
}

/** Incremental grid: renders the first pageSize cards and grows on demand —
 *  a source with hundreds of skills must not mount at once.
 *  Key the element by the active filter so filtering resets the window. */
function PagedGrid({ items, render, t, pageSize = 120, grow = 240, keyPrefix = '' }) {
  const [shown, setShown] = useState(pageSize)
  return [
    h('div', { className: 'sk-grid' }, items.slice(0, shown).map(render)),
    items.length > shown && h('div', { style: { textAlign: 'center', margin: '14px 0' } },
      h(ButtonLite, { onClick: () => setShown(n => n + grow) }, t('showMore', { n: items.length - shown }))),
  ]
}

// ── Views ────────────────────────────────────────────────────────────────

/**
 * 「提示」弹窗（技能管理侧）：页面说明集中在这里，工具栏不再摆一整行提示文字。
 */
function SkillsHelpDialog({ t, onClose }) {
  const bullet = (text) => h('div', { className: 'sk-hint', style: { paddingLeft: 12, marginBottom: 6, lineHeight: 1.6 } }, `· ${text}`)
  return h(SkDialog, { title: t('skillsHelpTitle'), onClose },
    bullet(t('cardsHint')),
    bullet(t('executorSettingsHint')),
    bullet(t('invocationHint')))
}

function CardsView({ executors, t, onEnter, onBrowseAll, onOpenSettings, onHelp }) {
  // The sources whose directory does not exist are noise on every visit: they
  // stay folded until asked for.
  const [showMissing, setShowMissing] = useState(false)
  if (!executors.length) return [
    // 空列表也要留设置入口：全部执行器被停用/目录为空时仍能进管理弹窗
    h('div', { className: 'sk-toolbar' },
      h(ButtonLite, { onClick: onHelp }, `? ${t('help')}`),
      h('span', { className: 'spacer' }),
      h(ButtonLite, { onClick: onOpenSettings }, t('executorSettings'))),
    h(Empty, null, t('noExecutors')),
  ]
  const present = executors.filter(r => r.dirExists)
  const missing = executors.filter(r => !r.dirExists)
  return [
    // one row, no wrapping: the two buttons stay together even in a narrow pane
    h('div', { className: 'sk-toolbar', style: { flexWrap: 'nowrap' } },
      h(ButtonLite, { onClick: onHelp, title: t('cardsHint') }, `? ${t('help')}`),
      h('span', { className: 'spacer' }),
      h(P.Button, { variant: 'primary', size: 'sm', onClick: onBrowseAll },
        `${t('browseAll')} (${executors.reduce((a, r) => a + r.skillCount, 0)})`),
      h(ButtonLite, { onClick: onOpenSettings, title: t('executorSettings') }, t('executorSettings'))),
    h('div', { className: 'sk-src' },
      present.map(row => h(ExecutorCard, { key: row.key, row, t, onEnter }))),
    missing.length > 0 && [
      h('button', { key: 'fold', className: 'sk-fold', style: { marginTop: 6 },
          onClick: () => setShowMissing(v => !v) },
        `${t('notFoundGroup', { n: missing.length })} ${showMissing ? '▾' : '▸'}`),
      showMissing && h('div', { key: 'missing', className: 'sk-src' },
        missing.map(row => h(ExecutorCard, { key: row.key, row, t, onEnter }))),
    ],
  ]
}

function AllSkillsView({ executors, searchText, sourceFilter, t, onSearch, onFilter, onBack, onOpen, onInstall, onDelete, onToggleVisible }) {
  const pending = executors.some(x => x.dirExists && !Array.isArray(x.skills))
  if (pending) return h(Spinner, { label: t('loadingCatalogs') })
  let items = []
  for (const row of executors) {
    if (!row.dirExists || !Array.isArray(row.skills)) continue
    if (sourceFilter !== 'all' && row.key !== sourceFilter) continue
    for (const s of row.skills) items.push({ row, s })
  }
  if (searchText) items = items.filter(it => matchSkill(it.s, searchText.toLowerCase()))
  return [
    h('div', { className: 'sk-head' },
      h(P.Button, { variant: 'ghost', size: 'sm', onClick: onBack }, t('backCards')),
      h('span', { className: 'sk-title' }, t('title')),
      h(InputBox, { value: searchText, placeholder: t('searchAll'), onSearch }),
      SourceFilterEl({ rows: executors.filter(r => r.dirExists), value: sourceFilter, onChange: onFilter, t }),
      h('span', { className: 'spacer' }),
      h(Tag, null, `${items.length} ${t('skillsSuffix')}`)),
    !items.length
      ? h(Empty, null, t('emptySearch'))
      : h('div', { className: 'sk-grid' }, items.map(({ row, s }) =>
          h(SkillCard, { key: row.key + '/' + s.name, row, s, t, onOpen, onInstall, onDelete, onToggleVisible })))]
}

function DrillInView({ row, searchText, t, onSearch, onBack, onOpen, onInstall, onDelete, onToggleVisible }) {
  if (!row) return null
  if (!row.dirExists) {
    return [
      h('div', { className: 'sk-head' },
        h(P.Button, { variant: 'ghost', size: 'sm', onClick: onBack }, t('backAll'))),
      h(Empty, null, `${row.label} — ${row.dir}`)]
  }
  if (!Array.isArray(row.skills)) {
    return h(Spinner, { label: t('scanning', { label: row.label }) })
  }
  let skills = row.skills
  if (searchText) skills = skills.filter(s => matchSkill(s, searchText.toLowerCase()))
  return [
    h('div', { className: 'sk-head' },
      h(P.Button, { variant: 'ghost', size: 'sm', onClick: onBack }, t('backAll')),
      h('span', { className: 'sk-title' }, row.label),
      h('span', { className: 'sk-tag' }, `${skills.length} ${t('skillsSuffix')}`),
      row.readOnly && h(Tag, { tone: 'danger' }, t('readOnlyTag')),
      h(InputBox, { value: searchText, placeholder: t('filterWithin', { label: row.label }), onSearch }),
      h('span', { className: 'spacer' }),
      h('span', { className: 'sk-dir' }, row.dir)),
    !skills.length
      ? h(Empty, null, searchText ? t('emptySearch') : t('emptySkillsIn', { label: row.label }))
      : h(PagedGrid, { key: 'ed' + row.key + searchText, items: skills, t,
          render: s => h(SkillCard, { key: s.name, row, s, t, onOpen, onInstall, onDelete, onToggleVisible }) }),
  ]
}

function InputBox({ value, placeholder, onSearch }) {
  if (prim('Input')) {
    return h(P.Input, { value, placeholder, className: 'sk-input', onChange: e => onSearch(e.target.value),
      style: { minWidth: 220 } })
  }
  return h('input', { value, placeholder, onChange: e => onSearch(e.target.value),
    style: { minWidth: 220, minHeight: 32, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '6px 12px' } })
}
function SourceFilterEl(args) { return SourceFilter(args) }

// ── App root ─────────────────────────────────────────────────────────────

function SkillsPage({ t, onClose, embedded }) {
  const [executors, setExecutors] = useState([])
  const [executorView, setExecutorView] = useState('cards')
  const [filterExecutor, setFilterExecutor] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [executorSettingsOpen, setExecutorSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [pageToast, setPageToast] = useState(null)
  const [searchExec, setSearchExec] = useState('')
  const [searchDrill, setSearchDrill] = useState('')
  const [searchAll, setSearchAll] = useState('')
  const [sel, setSel] = useState(null)
  const rootRef = useRef(null)

  const reloadExecutors = () => {
    getJson(API + '/executors?mode=summary').then(d => setExecutors(d.executors || [])).catch(() => {})
  }
  useEffect(reloadExecutors, [])

  // Load full lists for one executor on demand
  useEffect(() => {
    if (filterExecutor === 'all') return
    const row = executors.find(x => x.key === filterExecutor)
    if (!row || Array.isArray(row.skills)) return
    let alive = true
    getJson(API + '/executors?executor=' + encodeURIComponent(filterExecutor))
      .then(d => { if (alive) setExecutors(rows => rows.map(r => r.key === d.executor.key ? d.executor : r)) })
      .catch(() => {})
    return () => { alive = false }
  }, [filterExecutor, executors])

  // Load all catalogs when entering the flat all-skills view
  useEffect(() => {
    if (executorView !== 'all') return
    const targets = executors.filter(x => x.dirExists && !Array.isArray(x.skills))
    targets.forEach(row => {
      getJson(API + '/executors?executor=' + encodeURIComponent(row.key))
        .then(d => setExecutors(rows => rows.map(r => r.key === d.executor.key ? d.executor : r)))
        .catch(() => {})
    })
  }, [executorView, executors])

  const row = filterExecutor !== 'all' ? executors.find(x => x.key === filterExecutor) : null

  const openDetail = (s, executorKey) => setSel({ name: s.name, executorKey })
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingInstall, setPendingInstall] = useState(null)
  const [toastText, setToastText] = useState(null)
  const doPendingInstall = async () => {
    if (!pendingInstall) return
    const { row, name } = pendingInstall
    setPendingInstall(null)
    try {
      const body = { name, from: row.key }
      const r = await fetch(API + '/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
      setToastText(t('installedToast'))
      setTimeout(() => setToastText(null), 2600)
      reloadExecutors()
    } catch (e) { alert(t('operationFailed') + ': ' + e.message) }
  }
  const doPendingDelete = async () => {
    if (!pendingDelete) return
    await quickDelete(t, pendingDelete.executor, pendingDelete.name)
    setPendingDelete(null)
    reloadExecutors()
  }

  let body = null
  try {
    if (filterExecutor !== 'all') {
      body = h(DrillInView, { row, searchText: searchDrill, t,
        onSearch: setSearchDrill,
        onBack: () => { setFilterExecutor('all'); setSearchDrill('') },
        onOpen: s => openDetail(s, row?.key),
        onInstall: (r, name) => setPendingInstall({ row: r, name }),
        onDelete: (r, name) => setPendingDelete({ executor: r.key, name }),
        onToggleVisible: (r, name, modelInvocable) => {
          fetch(API + '/invocation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, modelInvocable }) })
            .then(() => getJson(API + '/executors?executor=' + encodeURIComponent(r.key))
              .then(d => setExecutors(rows => rows.map(x => x.key === d.executor.key ? d.executor : x))))
            .catch(() => {})
        } })
    } else if (executorView === 'all') {
      body = h(AllSkillsView, { executors, searchText: searchAll, sourceFilter, t,
        onSearch: setSearchAll,
        onFilter: v => { setSourceFilter(v); if (v !== 'all') { setFilterExecutor(v); setSearchAll(''); setSearchExec('') } },
        onBack: () => setExecutorView('cards'),
        onOpen: s => { const owner = executors.find(x => x.dirExists && Array.isArray(x.skills) && x.skills.some(k => k.name === s.name)); openDetail(s, owner ? owner.key : sourceFilter !== 'all' ? sourceFilter : 'dsh') },
        onInstall: (r, name) => setPendingInstall({ row: r, name }),
        onDelete: (r, name) => setPendingDelete({ executor: r.key, name }),
        onToggleVisible: (r, name, modelInvocable) => {
          fetch(API + '/invocation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, modelInvocable }) })
            .then(() => getJson(API + '/executors?executor=' + encodeURIComponent(r.key))
              .then(d => setExecutors(rows => rows.map(x => x.key === d.executor.key ? d.executor : x))))
            .catch(() => {})
        } })
    } else {
      body = h(CardsView, { executors, t,
        onEnter: key => { setFilterExecutor(key); setSearchDrill('') },
        onBrowseAll: () => setExecutorView('all'),
        onOpenSettings: () => setExecutorSettingsOpen(true),
        onHelp: () => setHelpOpen(true) })
    }
  } catch (renderErr) {
    ;(globalThis.__skErrors = globalThis.__skErrors || []).push('body: ' + (renderErr && renderErr.message))
    body = h('div', { className: 'sk-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      '\u26A0\uFE0F ' + String((renderErr && renderErr.message) || renderErr))
  }

  return h('div', { className: 'sk-page' + (embedded ? '' : ' sk-overlay'), ref: rootRef },
    !embedded && h('div', { className: 'sk-head' },
      h('span', { className: 'sk-title', style: { fontSize: 16 } }, t('title')),
      h('span', { className: 'spacer' }),
      h(ButtonLite, { onClick: () => onClose && onClose() }, t('close'))),
    h('div', { className: 'sk-body' }, body),
    sel && h(DetailModal, { sel, executors, t,
      onClose: () => setSel(null),
      onInstalled: () => { setSel(null); reloadExecutors() },
      onDeleted: () => { setSel(null); reloadExecutors() } }),
    executorSettingsOpen && h(ExecutorSettingsDialog, {
      t,
      onClose: () => setExecutorSettingsOpen(false),
      onToast: (text) => { setPageToast(text); setTimeout(() => setPageToast(null), 3000) },
      onChanged: () => reloadExecutors(),
    }),
    helpOpen && h(SkillsHelpDialog, { t, onClose: () => setHelpOpen(false) }),
    pageToast && h(InToast, { text: pageToast }),
    pendingInstall && h(SkDialog, {
      title: t('installTitle'),
      onClose: () => setPendingInstall(null),
      footer: [
        h(ButtonLite, { onClick: () => setPendingInstall(null) }, t('cancel')),
        h(ButtonLite, { primary: true, onClick: doPendingInstall }, t('installOk')),
      ],
    }, h('div', { className: 'sk-hint' },
        t('installConfirm', { name: pendingInstall.name, label: pendingInstall.row.label }))),
    toastText && h(InToast, { text: toastText }),
    pendingDelete && h(SkDialog, {
      title: t('deleteTitle'),
      onClose: () => setPendingDelete(null),
      footer: [
        h(ButtonLite, { onClick: () => setPendingDelete(null) }, t('cancel')),
        h(ButtonLite, { primary: true, danger: true, onClick: doPendingDelete }, t('deleteBtn')),
      ],
    }, h('div', { className: 'sk-hint' }, t('deleteConfirm', {
      name: pendingDelete.name,
      where: pendingDelete.executor === 'dsh' || !pendingDelete.executor ? t('whereDsh') : ((executors.find(x => x.key === pendingDelete.executor) || {}).label || pendingDelete.executor),
    }))))
  }

async function quickDelete(t, executor, name, done) {
  try {
    const body = { name }
    if (executor) body.executor = executor
    const r = await fetch(API, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)
    if (typeof done === 'function') done()
  } catch (e) { alert(t('operationFailed') + ': ' + e.message) }
}

// ── MCP 管理（手写配置 mcp.local.jsonc + loader 里的 dsh-mcp-client 条目）──
//
// 这一页做三件事：
//  1. 列出所有 server（手写配置 + dsh 组合配置 + 别的插件挂的），只放状态标签；
//  2. 点卡片 = 编辑那一条（工具栏「+ 新增 server」是加新的）。保存时就地重写
//     mcp.local.jsonc：只重写改动的那一条，其它注释/格式原样保留，写前留 .bak；
//     配置变了的 server 自动重启；
//  3. 「配置文件」—— 本插件目录下的文件编辑器。ssh-config.json 这种「server 自己
//     读的配置」就在这里改：保存后读它的 server 会被重启，新加的 ssh 连接立刻可用。
// 页面上的说明文字一律收在工具栏「? 提示」里，卡片不再带说明段落。

const fieldHintStyle = () => ({ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, lineHeight: 1.45 })

const baseName = (p) => {
  const text = String(p === undefined || p === null ? '' : p)
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

const splitLines = (text) => String(text === undefined || text === null ? '' : text)
  .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')

/** Extensions a human edits; a tool's `.exe`/`.py` is not a config file. */
const CONFIG_FILE_RE = /\.(jsonc?|ya?ml|toml|ini|conf|cfg|env|properties|txt)$/i

/**
 * Which related files a row should list.
 *
 * The server marks them (`shown`); the extension check repeats the rule here so
 * the page stays quiet even when the host half predates that field.
 */
const shownRelatedFiles = (row) => (Array.isArray(row.relatedFiles) ? row.relatedFiles : [])
  .filter((file) => file.shown !== false && (file.origin === 'declared' || CONFIG_FILE_RE.test(String(file.path))))

/** env/headers 对象 → `KEY=value` 行；`{ js: 'process.env.X' }` 还原成 `${X}`。 */
function mapText(map) {
  const lines = []
  for (const [key, value] of Object.entries(map || {})) {
    if (value !== null && typeof value === 'object' && typeof value.js === 'string') {
      const match = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.js.trim())
      lines.push(`${key}=${match === null ? value.js : '${' + match[1] + '}'}`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.join('\n')
}

/** `KEY=value` 行 → 对象；坏行报错，不静默丢弃。 */
function parseMapText(text) {
  const out = {}
  for (const line of splitLines(text)) {
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(`"${line}" must look like KEY=value`)
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** 一行 snapshot 行 → 编辑表单的草稿。 */
function draftFromRow(row, id) {
  return {
    __id: id,
    serverName: row.serverName || '',
    transport: row.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: row.command || '',
    // 一条参数一行。`row.args` 已经是数组：直接 String() 会得到逗号拼接的一行。
    argsText: Array.isArray(row.args) ? row.args.join('\n') : splitLines(row.args).join('\n'),
    envText: mapText(row.env),
    cwd: row.cwd || '',
    url: row.url || '',
    headersText: mapText(row.headers),
    timeoutText: typeof row.toolCallTimeoutMs === 'number' ? String(row.toolCallTimeoutMs) : '',
    // the form edits the FILE, so it shows what the file says — the pane's
    // switch is the one that overrides a parked entry, not this checkbox
    enabled: row.enabledInFile !== false,
    relatedFiles: (row.relatedFiles || []).filter((f) => f.origin === 'declared').map((f) => f.path),
    detected: shownRelatedFiles(row).filter((f) => f.origin === 'detected'),
  }
}

const emptyDraft = (id) => ({
  __id: id, serverName: '', transport: 'stdio', command: '', argsText: '', envText: '',
  cwd: '', url: '', headersText: '', timeoutText: '', enabled: true, relatedFiles: [], detected: [],
})

/** 表单草稿 → API body 里的一条 server。 */
function serverFromDraft(draft) {
  const server = { serverName: String(draft.serverName || '').trim(), transport: draft.transport }
  if (draft.transport === 'stdio') {
    server.command = String(draft.command || '').trim()
    server.args = splitLines(draft.argsText)
    const env = parseMapText(draft.envText)
    if (Object.keys(env).length > 0) server.env = env
    if (String(draft.cwd || '').trim() !== '') server.cwd = String(draft.cwd).trim()
  } else {
    server.url = String(draft.url || '').trim()
    const headers = parseMapText(draft.headersText)
    if (Object.keys(headers).length > 0) server.headers = headers
  }
  const timeout = String(draft.timeoutText || '').trim()
  if (timeout !== '') server.toolCallTimeoutMs = Number(timeout)
  if (draft.relatedFiles.length > 0) server.relatedFiles = [...draft.relatedFiles]
  server.enabled = draft.enabled !== false
  return server
}

/**
 * MCP server 一行 —— 和技能卡片一样，**点卡片就打开它的配置**，不再需要先点
 * 「编辑」。行上只留状态标签和真正会改变状态的动作：「重载」（重建进程）和开关
 * （仅在手写配置把它停用时才有意义）。
 *
 * 说明文字一律不进卡片：它们都在工具栏的「提示」里（一处解释，页面干净）。
 * 卡片只保留一眼能看懂的状态标签。
 */
function McpServerCard({ t, row, busy, onToggle, onReload, onEdit, onOpenFile }) {
  const isStdio = row.transport === 'stdio'
  const envCount = Object.keys(row.env || {}).length
  const headerCount = Object.keys(row.headers || {}).length
  const summary = isStdio ? [row.command, ...(row.args || [])].join(' ') : row.url
  const sourceLabel = row.source === 'foreign' ? t('mcpSourceForeign')
    : row.source === 'local' ? t('mcpSourceLocal') : t('mcpSourceConfigured')
  // `shown === false`: a detected executable/script still restarts the server when
  // it changes, but it is not a config a human edits, so the row stays quiet.
  const related = shownRelatedFiles(row)
  const clickable = row.editable === true
  const open = clickable ? () => onEdit(row) : undefined
  const stop = (fn) => (event) => { event.stopPropagation(); fn() }
  return h('div', {
      className: 'sk-card' + (clickable ? ' clickable' : ' static'),
      style: { cursor: clickable ? 'pointer' : 'default' },
      role: clickable ? 'button' : undefined,
      tabIndex: clickable ? 0 : undefined,
      title: clickable ? t('mcpOpenHint') : undefined,
      onClick: open,
      onKeyDown: clickable ? (event) => { if (event.key === 'Enter' || event.key === ' ') open() } : undefined,
    },
    h('div', { className: 'sk-head' },
      h(Avatar, { name: row.serverName || row.entryId, square: true, size: 40 }),
      h('span', { className: 'sk-title' }, row.serverName || row.entryId),
      h(Tag, { tone: row.source === 'foreign' ? 'danger' : 'accent' }, sourceLabel),
      row.alsoDeclared === true && h(Tag, { tone: 'danger' }, t('mcpShadowedTag')),
      row.owner && h(Tag, null, row.owner),
      h(Tag, { tone: 'accent' }, row.transport),
      row.enabledForced === true && h(Tag, { tone: 'accent' }, t('mcpForcedTag')),
      row.enabled === false && h(Tag, { tone: 'danger' }, t('mcpDisabledTag')),
      row.enabled !== false && h(Tag, { tone: row.live === false ? 'danger' : 'ok' },
        row.live === false ? t('mcpOfflineTag') : t('mcpLiveTag'))),
    h('div', { className: 'sk-desc', style: { wordBreak: 'break-all' } }, summary),
    h('div', { className: 'sk-stats' },
      [
        t('mcpToolsCount', { n: row.toolCount ?? 0 }),
        isStdio && (row.args || []).length > 0 ? `${row.args.length} args` : null,
        isStdio && envCount > 0 ? `${envCount} env` : null,
        !isStdio && headerCount > 0 ? `${headerCount} headers` : null,
        isStdio && row.cwd ? row.cwd : null,
        typeof row.toolCallTimeoutMs === 'number' ? `${row.toolCallTimeoutMs} ms` : null,
      ].filter(Boolean).join(' · ')),
    related.length > 0 && h('div', { className: 'sk-chips' },
      h('span', { className: 'sk-dir' }, t('mcpRelatedTag') + ':'),
      related.map((file) => h('span', {
        key: file.path,
        className: 'sk-tag' + (file.editable ? ' accent' : ''),
        title: file.editable ? file.path : `${file.path} — ${t('mcpFormRelatedOutside')}`,
        style: { cursor: file.editable ? 'pointer' : 'default' },
        onClick: file.editable ? stop(() => onOpenFile(file)) : undefined,
      }, baseName(file.path)))),
    h('div', { className: 'sk-foot' },
      h('div', { className: 'sk-chips' }, h('span', { className: 'sk-dir' }, row.entryId)),
      h('div', { className: 'sk-rowbtns' },
        row.restartable === true && h(ButtonLite, { small: true, disabled: busy, title: t('mcpReloadHint'),
          onClick: stop(() => onReload(row)) }, t('mcpReload')),
        row.switchable === true && h(ButtonLite, { small: true, disabled: busy,
          onClick: stop(() => onToggle(row)) }, row.enabled === false ? t('mcpEnable') : t('mcpDisable')))))
}

/**
 * 编辑弹窗：手写配置里每一条 server 一个表单（点卡片进来，焦点在这条上）。
 *
 * 保存走 PUT /mcp/servers（整表）—— 服务端负责「只重写改动的那一条」和
 * 「配置变了的条目重挂」，客户端只描述想要的结果。
 */
function McpEditorDialog({ t, snapshot, onClose, onToast, onSaved, onOpenFile, initialName, initialNew }) {
  const rowSeq = useRef(0)
  const nextId = () => 'm' + (++rowSeq.current)
  const initial = useMemo(() => {
    const list = (snapshot.servers || [])
      .filter((row) => row.source === 'local')
      .map((row) => draftFromRow(row, 'm' + (++rowSeq.current)))
    // 「新增 server」进来时先摆一条空白的并选中它，省掉再点一次「+ 新增」
    if (initialNew === true) list.push(emptyDraft('m' + (++rowSeq.current)))
    return list
  }, [])
  const [rows, setRows] = useState(initial)
  const [selectedId, setSelectedId] = useState(() => {
    if (initialNew === true) return initial[initial.length - 1].__id
    const pick = initial.find((row) => row.serverName === initialName) || initial[0]
    return pick === undefined ? null : pick.__id
  })
  const [addText, setAddText] = useState('')
  const [busy, setBusy] = useState(false)
  const localStatus = snapshot.localStatus
  const invalid = (snapshot.localInvalid || []).length
  const blocked = localStatus === 'corrupt' || invalid > 0
  const selected = rows.find((row) => row.__id === selectedId)

  const patch = (id, next) => setRows((list) => list.map((row) => (row.__id === id ? { ...row, ...next } : row)))
  const addRow = () => {
    const draft = emptyDraft(nextId())
    setRows((list) => [...list, draft])
    setSelectedId(draft.__id)
  }
  const removeRow = (id) => {
    setRows((list) => list.filter((row) => row.__id !== id))
    setSelectedId((current) => (current === id ? null : current))
  }

  const save = async () => {
    let servers
    try {
      servers = rows.map(serverFromDraft)
    } catch (error) {
      onToast(t('operationFailed') + ': ' + error.message)
      return
    }
    setBusy(true)
    try {
      const response = await fetch(API + '/mcp/servers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
      onSaved(payload)
      const saved = payload.saved || {}
      onToast(saved.changed
        ? (saved.backup ? t('mcpEditSavedBackup', { name: saved.backup }) : t('mcpEditSaved'))
        : t('mcpEditUnchanged'))
      onClose()
    } catch (error) {
      onToast(t('operationFailed') + ': ' + error.message)
    } finally { setBusy(false) }
  }

  const field = (label, control, hint) => h('div', { className: 'sk-field' },
    h('label', null, label),
    control,
    hint !== undefined && h('div', { style: fieldHintStyle() }, hint))

  const form = (row) => {
    const isStdio = row.transport === 'stdio'
    return h('div', null,
      field(t('mcpFormName'),
        h('input', { className: 'sk-input', value: row.serverName, placeholder: 'my-server',
          onChange: (e) => patch(row.__id, { serverName: e.target.value }) }),
        t('mcpFormNameHint')),
      field(t('mcpFormTransport'),
        h('select', { className: 'sk-input', value: row.transport,
            onChange: (e) => patch(row.__id, { transport: e.target.value }) },
          h('option', { value: 'stdio' }, t('mcpFormStdio')),
          h('option', { value: 'streamable-http' }, t('mcpFormHttp')))),
      isStdio
        ? [
            field(t('mcpFormCommand'),
              h('input', { className: 'sk-input', value: row.command, placeholder: 'npx',
                onChange: (e) => patch(row.__id, { command: e.target.value }) })),
            field(t('mcpFormArgs'),
              h('textarea', { className: 'sk-textarea', style: { minHeight: 110 }, value: row.argsText, spellCheck: false,
                placeholder: '-y\nsome-mcp-server',
                onChange: (e) => patch(row.__id, { argsText: e.target.value }) })),
            field(t('mcpFormEnv'),
              h('textarea', { className: 'sk-textarea', style: { minHeight: 80 }, value: row.envText, spellCheck: false,
                placeholder: 'SOME_TOKEN=${SOME_TOKEN}',
                onChange: (e) => patch(row.__id, { envText: e.target.value }) })),
            field(t('mcpFormCwd'),
              h('input', { className: 'sk-input', value: row.cwd, placeholder: 'D:\\work',
                onChange: (e) => patch(row.__id, { cwd: e.target.value }) })),
          ]
        : [
            field(t('mcpFormUrl'),
              h('input', { className: 'sk-input', value: row.url, placeholder: 'http://127.0.0.1:13337/mcp',
                onChange: (e) => patch(row.__id, { url: e.target.value }) })),
            field(t('mcpFormHeaders'),
              h('textarea', { className: 'sk-textarea', style: { minHeight: 80 }, value: row.headersText, spellCheck: false,
                placeholder: 'Authorization=Bearer ${MCP_TOKEN}',
                onChange: (e) => patch(row.__id, { headersText: e.target.value }) })),
          ],
      field(t('mcpFormTimeout'),
        h('input', { className: 'sk-input', value: row.timeoutText, placeholder: '60000',
          onChange: (e) => patch(row.__id, { timeoutText: e.target.value }) })),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 10, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: row.enabled,
          onChange: (e) => patch(row.__id, { enabled: e.target.checked }) }),
        t('mcpFormEnabled')),
      h('div', { className: 'sk-field' },
        h('label', null, t('mcpFormRelated')),
        row.detected.length === 0 && row.relatedFiles.length === 0
          ? h('div', { className: 'sk-dir' }, t('mcpFormRelatedNone'))
          : null,
        row.detected.map((file) => h('div', { key: 'd' + file.path, className: 'sk-filerow' },
          h(Tag, null, t('mcpFormRelatedDetected')),
          h('span', { className: 'sk-dir', style: { flex: 1, wordBreak: 'break-all' } }, file.path),
          file.editable === true && h(ButtonLite, { small: true,
            onClick: () => onOpenFile(file) }, t('mcpEdit')))),
        row.relatedFiles.map((path) => h('div', { key: 'r' + path, className: 'sk-filerow' },
          h(Tag, { tone: 'accent' }, t('mcpFormRelatedDeclared')),
          h('span', { className: 'sk-dir', style: { flex: 1, wordBreak: 'break-all' } }, path),
          h(ButtonLite, { small: true, danger: true,
            onClick: () => patch(row.__id, { relatedFiles: row.relatedFiles.filter((item) => item !== path) }) },
            t('deleteBtn')))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', { className: 'sk-input', style: { flex: 1 }, value: addText,
            placeholder: t('mcpFormRelatedAdd'),
            onChange: (e) => setAddText(e.target.value),
            onKeyDown: (e) => {
              if (e.key !== 'Enter') return
              const value = addText.trim()
              if (value === '') return
              patch(row.__id, { relatedFiles: row.relatedFiles.includes(value) ? row.relatedFiles : [...row.relatedFiles, value] })
              setAddText('')
            } }),
          h(ButtonLite, { small: true, onClick: () => {
            const value = addText.trim()
            if (value === '') return
            patch(row.__id, { relatedFiles: row.relatedFiles.includes(value) ? row.relatedFiles : [...row.relatedFiles, value] })
            setAddText('')
          } }, t('mcpFormRelatedAddBtn'))),
        h('div', { style: fieldHintStyle() }, t('mcpFormRelatedHint'))),
      h('div', { className: 'sk-dlg-foot', style: { marginTop: 2 } },
        h(ButtonLite, { small: true, onClick: () => removeRow(row.__id) }, t('deleteBtn'))))
  }

  return h(SkDialog, { title: t('mcpEditConfig'), onClose, wide: true },
    localStatus === 'corrupt' && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start', whiteSpace: 'pre-wrap' } },
      t('mcpEditCorrupt')),
    invalid > 0 && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start' } },
      t('mcpEditInvalid', { n: invalid })),
    h('div', { style: fieldHintStyle() }, t('mcpEditHint')),
    h('div', { className: 'sk-split' },
      h('div', { className: 'sk-split-left' },
        rows.map((row) => h('button', { key: row.__id,
            className: 'sk-pick' + (row.__id === selectedId ? ' on' : ''),
            onClick: () => setSelectedId(row.__id) },
          h('span', null, String(row.serverName || t('mcpUnnamed'))),
          h('span', { className: 'sk-dir' }, row.transport))),
        rows.length === 0 && h('div', { className: 'sk-hint', style: { padding: 8 } }, t('mcpNoServers')),
        h('div', { style: { padding: 6 } },
          h(ButtonLite, { small: true, onClick: addRow }, t('mcpNewServer')))),
      h('div', { className: 'sk-split-right' },
        selected === undefined
          ? h('div', { className: 'sk-hint' }, t('mcpSelectServer'))
          : form(selected))),
    h('div', { className: 'sk-dlg-foot' },
      h(ButtonLite, { onClick: onClose }, t('cancel')),
      h(ButtonLite, { primary: true, disabled: busy || blocked || rows.length === 0, onClick: save }, t('save'))))
}

/**
 * 「配置文件」弹窗：左列表 + 右编辑器（技能详情页那套布局）。
 *
 * 只在 $DSH_HOME/skills-management 下工作（服务端强制）；.json 保存前必须仍是
 * 严格 JSON，写前留 .bak，写完同步挂载 —— 于是「改 ssh-config.json」会重启
 * 读它的 ssh-mcp-server。
 */
function McpFilesDialog({ t, onClose, onToast, onSnapshot, initialPath }) {
  const [files, setFiles] = useState(null)
  const [selected, setSelected] = useState(initialPath || null)
  const [file, setFile] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const loadList = () => getJson(API + '/mcp/files')
    .then((payload) => {
      const list = payload.files || []
      setFiles(list)
      setSelected((current) => {
        if (current !== null) return current
        const first = list.find((entry) => entry.exists && entry.editable)
        return first === undefined ? null : first.rawPath
      })
      return list
    })
    .catch((error) => {
      setFiles([])
      onToast(t('operationFailed') + ': ' + error.message)
    })
  useEffect(() => { loadList() }, [])

  const open = (path) => {
    setBusy(true)
    fetch(API + '/mcp/file?path=' + encodeURIComponent(path))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
        return payload
      })
      .then((payload) => { setFile(payload.file); setText(payload.file.text) })
      .catch((error) => {
        setFile(null)
        setText('')
        onToast(t('operationFailed') + ': ' + error.message)
      })
      .finally(() => setBusy(false))
  }
  useEffect(() => { if (selected !== null && (file === null || file.rawPath !== selected)) open(selected) }, [selected])

  const save = async () => {
    if (selected === null) return
    setBusy(true)
    try {
      const response = await fetch(API + '/mcp/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected, text }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
      if (payload.file !== undefined) { setFile(payload.file); setText(payload.file.text) }
      if (Array.isArray(payload.servers)) onSnapshot(payload)
      onToast(payload.backup
        ? t('mcpFileSavedBackup', { name: baseName(selected), backup: baseName(payload.backup) })
        : t('mcpFileSaved', { name: baseName(selected) }))
      loadList()
    } catch (error) {
      onToast(t('operationFailed') + ': ' + error.message)
    } finally { setBusy(false) }
  }

  const current = files === null ? undefined : files.find((entry) => entry.rawPath === selected)
  return h(SkDialog, { title: t('mcpConfigFiles'), onClose, wide: true },
    h('div', { style: fieldHintStyle(), marginBottom: 8 }, t('mcpFilePanelHint')),
    h('div', { className: 'sk-split' },
      h('div', { className: 'sk-split-left' },
        files === null && h('div', { className: 'sk-hint', style: { padding: 8 } }, '…'),
        files !== null && files.length === 0 && h('div', { className: 'sk-hint', style: { padding: 8 } }, t('mcpFileEmpty')),
        (files || []).map((entry) => h('button', { key: entry.rawPath,
            className: 'sk-pick' + (entry.rawPath === selected ? ' on' : ''),
            title: entry.path,
            onClick: () => { setFile(null); setSelected(entry.rawPath) } },
          h('span', null, entry.name),
          h('span', { className: 'sk-dir' },
            entry.exists ? t('mcpFileExists', { n: entry.size }) : t('mcpFileMissing'))))),
      h('div', { className: 'sk-split-right' },
        textareaBlock())),
    h('div', { className: 'sk-dlg-foot' },
      h(ButtonLite, { onClick: onClose }, t('cancel')),
      h(ButtonLite, { disabled: busy || selected === null, onClick: () => open(selected) }, t('mcpFileReload')),
      h(ButtonLite, { primary: true, disabled: busy || file === null, onClick: save }, t('mcpFileSave'))))

  function textareaBlock() {
    if (selected === null) return h('div', { className: 'sk-hint' }, t('mcpFileEmpty'))
    if (file === null) return h(Spinner, { label: '…' })
    return [
      h('div', { className: 'sk-head', style: { marginBottom: 6 } },
        h('span', { className: 'sk-dir', style: { wordBreak: 'break-all' } }, file.path),
        h('span', { className: 'spacer' }),
        text !== file.text && h(Tag, { tone: 'danger' }, t('mcpFileUnsaved')),
        current !== undefined && current.editable !== true && h(Tag, null, t('mcpFileReadOnly'))),
      h('textarea', { className: 'sk-textarea', value: text, spellCheck: false,
        onChange: (e) => setText(e.target.value) }),
    ]
  }
}

/**
 * 「提示」弹窗：整页的说明只在这里出现一次。
 *
 * 页面本体不放说明段落 —— 每条 server 的来源、开关语义、关联文件与重载、
 * 同名声明，全都收在这一个按钮后面，卡片只留状态标签。
 */
function McpHelpDialog({ t, snapshot, onClose }) {
  const line = (label, text) => h('div', { style: { marginBottom: 10, wordBreak: 'break-all' } },
    h('span', { className: 'sk-dir' }, `${label}: `),
    h('span', { className: 'sk-hint' }, text))
  const bullet = (text) => h('div', { className: 'sk-hint', style: { paddingLeft: 12, marginBottom: 6, lineHeight: 1.6 } }, `· ${text}`)
  const heading = (text) => h('div', { className: 'sk-title', style: { margin: '14px 0 6px', fontSize: 13 } }, text)
  return h(SkDialog, { title: t('mcpHelpTitle'), onClose },
    line(t('mcpLocalFile'), snapshot.localFile || '-'),
    line(t('mcpStateFile'), snapshot.stateFile || '-'),
    snapshot.localStatus === 'missing' && bullet(t('mcpLocalMissing')),
    bullet(t('mcpLocalHint')),
    heading(`${t('mcpSourceLocal')} / ${t('mcpSourceConfigured')} / ${t('mcpSourceForeign')}`),
    bullet(t('mcpLocalRowHint')),
    bullet(t('mcpConfiguredHint')),
    bullet(t('mcpForeignHint')),
    heading(t('mcpHelpSwitch')),
    bullet(t('mcpLocalParkedHint')),
    bullet(t('mcpLocalForcedHint')),
    bullet(t('mcpShadowedHint')),
    heading(t('mcpRelatedTag')),
    bullet(t('mcpFormRelatedHint')),
    bullet(t('mcpEditHint')),
    bullet(t('mcpReloadHint')))
}

/**
 * The pane's presentation half: a plain function of the snapshot.
 *
 * Kept separate from the fetching/actions in {@link McpPane} so it can be
 * rendered from a fixture (the settings surface has no DOM in the contract
 * tests, and a blank MCP page is exactly the failure this split exists to
 * catch).
 */
function McpView({ t, data, busy, onRefresh, onReloadAll, onToggle, onReload, onEdit, onOpenFile, onNewServer, onOpenFiles, onHelp }) {
  const servers = data.servers || []
  const canMount = data.loaderAvailable !== false && data.mountAvailable !== false
  const legacy = data.legacyIgnored
  return [
    h('div', { className: 'sk-toolbar' },
      h(ButtonLite, { onClick: onRefresh }, t('refresh')),
      h(ButtonLite, { disabled: busy || !canMount, onClick: onReloadAll }, t('mcpReloadAll')),
      h('span', { className: 'spacer' }),
      h(ButtonLite, { onClick: onHelp }, `? ${t('help')}`),
      h(ButtonLite, { disabled: busy, onClick: onOpenFiles }, t('mcpConfigFiles')),
      h(P.Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: onNewServer }, t('mcpNewServer'))),
    data.localStatus === 'corrupt' && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start', whiteSpace: 'pre-wrap' } },
      t('mcpLocalCorrupt', { error: data.localError || '?' })),
    (data.localInvalid || []).length > 0 && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start' } },
      t('mcpLocalInvalid', { n: data.localInvalid.length })),
    legacy !== undefined && h('div', { className: 'sk-tag', style: { alignSelf: 'flex-start' } },
      t('mcpLegacyNotice', { disabled: legacy.disabled || 0, servers: legacy.servers || 0 })),
    data.stateStatus === 'corrupt' && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start', whiteSpace: 'pre-wrap' } },
      t('mcpStateCorrupt', { error: data.stateError || '?' })),
    !canMount && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start' } }, t('mcpUnavailableTag')),
    !canMount && h('div', { className: 'sk-hint' }, t('mcpUnavailableHint')),
    servers.length === 0
      ? h(Empty, null, t('mcpEmpty'))
      : h('div', { className: 'sk-src' }, servers.map((row) =>
          h(McpServerCard, { key: row.serverName, t, row, busy, onToggle, onReload, onEdit, onOpenFile }))),
  ]
}

/**
 * MCP 管理面板（取数 + 动作）。
 *
 * 数据只在打开页面时读一次和手动「刷新」时重读 —— 没有后台轮询：文件改完点
 * 「重载」/「刷新」就行，不必重启 dsh。每次写操作（保存配置、保存文件、开关、
 * 重载）服务端都会回一份新的 snapshot，页面直接换上去。
 */
function McpPane({ t, onToast }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorFocus, setEditorFocus] = useState(undefined)
  const [editorNew, setEditorNew] = useState(false)
  const [fileOpen, setFileOpen] = useState(false)
  const [fileFocus, setFileFocus] = useState(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const load = () => {
    getJson(API + '/mcp')
      .then(setData)
      .catch((e) => {
        // 请求失败也要收尾，否则页面永远停在 loading
        setData({ servers: [], loaderAvailable: false, mountAvailable: false, error: String(e && e.message || e) })
      })
  }
  useEffect(load, [])

  const send = async (method, path, body) => {
    const response = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
    if (Array.isArray(payload.servers)) {
      setData(payload)
      // 挂载刚重建，MCP 客户端还在握手：过一会儿再读一次，让工具数量和
      // 连接状态落到页面上。一次性补读，不是轮询。
      setTimeout(load, 2500)
    }
    return payload
  }

  const doToggle = async (row) => {
    setBusy(true)
    try {
      await send('PUT', '/mcp', { serverName: row.serverName, enabled: row.enabled === false })
      onToast(t('mcpSaved'))
    } catch (e) {
      onToast(t('operationFailed') + ': ' + e.message)
    } finally { setBusy(false) }
  }
  const doReload = async (row) => {
    setBusy(true)
    try {
      const payload = await send('POST', '/mcp/reload', row === undefined ? {} : { serverName: row.serverName })
      const restarted = row === undefined
        ? (payload.sync?.remounted?.length ?? 0) + (payload.sync?.created?.length ?? 0)
        : 1
      onToast(row === undefined
        ? (restarted === 0 ? t('mcpReloadedNone') : t('mcpReloadedMany', { n: restarted }))
        : t('mcpReloadedOne', { name: row.serverName }))
    } catch (e) {
      onToast(t('operationFailed') + ': ' + e.message)
    } finally { setBusy(false) }
  }

  if (data === null) return h(Spinner, { label: t('mcpLoading') })

  // 读取失败：给确定性说明，不留白屏/无限转圈；也只在这里保留重试
  if (data.error !== undefined) {
    return [
      h(Empty, null, `${t('operationFailed')}: ${data.error}`),
      h('div', { className: 'sk-toolbar' }, h(ButtonLite, { onClick: load }, t('refresh'))),
    ]
  }

  return [
    h(McpView, {
      t,
      data,
      busy,
      onRefresh: load,
      onReloadAll: () => doReload(undefined),
      onToggle: doToggle,
      onReload: doReload,
      // 点卡片 = 打开这条的配置（和技能卡片一样），工具栏那个按钮只管「新增」
      onEdit: (target) => { setEditorFocus(target.serverName); setEditorNew(false); setEditorOpen(true) },
      onOpenFile: (file) => { setFileFocus(file.path); setFileOpen(true) },
      onNewServer: () => { setEditorFocus(undefined); setEditorNew(true); setEditorOpen(true) },
      onOpenFiles: () => { setFileFocus(null); setFileOpen(true) },
      onHelp: () => setHelpOpen(true),
    }),
    editorOpen && h(McpEditorDialog, {
      t,
      snapshot: data,
      initialName: editorFocus,
      initialNew: editorNew,
      onClose: () => setEditorOpen(false),
      onToast,
      onSaved: (payload) => {
        if (!Array.isArray(payload.servers)) return
        setData(payload)
        setTimeout(load, 2500)
      },
      onOpenFile: (file) => { setEditorOpen(false); setFileFocus(file.path); setFileOpen(true) },
    }),
    fileOpen && h(McpFilesDialog, {
      t,
      initialPath: fileFocus,
      onClose: () => setFileOpen(false),
      onToast,
      onSnapshot: (payload) => {
        if (!Array.isArray(payload.servers)) return
        setData(payload)
        setTimeout(load, 2500) // the restarted server needs a moment to hand over its tools
      },
    }),
    helpOpen && h(McpHelpDialog, { t, snapshot: data, onClose: () => setHelpOpen(false) }),
  ]
}


// ── Slot entries ─────────────────────────────────────────────────────────

/** Settings section slot entry: render the page directly in the host tree. */
function SettingsSlotComponent(props) {
  useEffect(ensureStyles, [])
  return h(SkillsPage, { t: props.__t, embedded: true })
}

/** MCP 管理 section：与技能管理同级，自己一个页面。 */
function McpSectionComponent(props) {
  useEffect(ensureStyles, [])
  const t = props.__t
  const [toast, setToast] = useState(null)
  return h('div', { className: 'sk-page' },
    h('div', { className: 'sk-body' }, h(McpPane, {
      t,
      onToast: (text) => { setToast(text); setTimeout(() => setToast(null), 3000) },
    })),
    toast && h(InToast, { text: toast }))
}

// ── Plugin plane contract ────────────────────────────────────────────────

const CLIENT_NAME = 'dexter-skills-mcp-manager'

module.exports = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: {
    NS, ZH, EN, matchSkill, formatSize, formatTime, markdownLabels,
    // renderable from a fixture by the contract tests (no DOM needed)
    McpView, McpPane, McpServerCard, McpEditorDialog, McpFilesDialog, McpHelpDialog, SkillsHelpDialog, CardsView, ExecutorList,
    baseName, mapText, parseMapText, draftFromRow, serverFromDraft,
  },
  /** Test/host helper: mount a standalone page into any container. */
  __boot(container, opts = {}) {
    ensureStyles()
    let t = opts.t || ((key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    })
    try {
      if (!opts.t && globalThis.document && !(container.ownerDocument !== document)) { /* noop */ }
    } catch {}
    const root = require('react-dom/client').createRoot(container)
    root.render(h(SkillsPage, { t, embedded: !!opts.embedded }))
    return root
  },
  apply(ctx) {
    // Locale service is optional at boot order — degrade to EN until present
    let t = (key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) {
          t = (key, vars) => {
            let out = bound(key) || key
            if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
            return out
          }
          globalThis.__skillsLocaleLive = true
        }
      }
    } catch (e) { try { console.error('[skills-management] locale init:', e) } catch {} }
    ctx.effect(() => {
      try {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: CLIENT_NAME,
        order: 90,
        locale: NS,
        // resolveSlotLabel 调用 label() 不传参;官方模式是自带绑定翻译的闭包
        label: () => t('title'),
        inject: () => ({}),
      }, function SettingsSectionSlot() {
        return h(SettingsSlotComponent, { __t: t })
      }))
      } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('settings:' + (e && e.message)); throw e }
    }, 'skills-management: settings section')
    // 「MCP 管理」是**同级**的 settings section（不是技能页里的页签）：侧栏里与
    // 「技能管理」并列，各自独立打开。
    ctx.effect(() => {
      try {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: CLIENT_NAME + ':mcp',
        order: 91,
        locale: NS,
        label: () => t('mcpTitle'),
        inject: () => ({}),
      }, function McpSectionSlot() {
        return h(McpSectionComponent, { __t: t })
      }))
      } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('settings:mcp:' + (e && e.message)); throw e }
    }, 'skills-management: mcp settings section')
  },
}

