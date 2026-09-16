/**
 * dsh-plugin-skills-management - Browser half.
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
let RDP = null
try { RDP = require('react-dom') } catch {}

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

// Composer services (inputTriggers + sessions) for the ＋ 技能 button plus
// the `connection` service for the picker's skill catalog: the button opens
// the plugin's own searchable picker popover (the host slash menu filters
// only by a typed query, which a button click cannot provide); the pick is
// written into the draft through the same scoped `slash/input-insert-text`
// event the host menu executes. Absence hides the button; nothing else
// depends on it.
let composerScope = null
let connectionApi = null

/**
 * Open one registered '/' source over a synthetic collapsed span appended at
 * the draft end (host toggleCommandMenu 同款调用形状；标准 kit 不暴露光标，
 * pick 依赖 span-CAS：点击后草稿若再变动则本次 pick 静默作废）。
 *
 * NOTE: the ＋ 技能 button no longer uses this — the host menu cannot offer
 * a search box, so the button opens SkillPicker instead. Kept for the
 * contract tests and as the documented toggleSource path.
 */
function openTriggerSource(scope, sessionId, input, sourceName) {
  const inputTriggers = scope && scope.inputTriggers
  const sessions = scope && scope.sessions
  if (!inputTriggers || !sessions) return false
  let actx
  try { actx = sessions.scope(sessionId) } catch { return false }
  if (actx === undefined || actx === null) return false
  let controller
  try { controller = inputTriggers.sessionOf(actx) } catch { return false }
  const draft = (input && input.draft) || ''
  const at = draft.length
  controller.toggleSource(sourceName, {
    trigger: '/',
    query: '',
    quoted: false,
    position: draft.trim() === '' ? 'leading' : 'inline',
    span: { start: at, end: at, draftRev: (input && input.draftRev) || 0 },
  })
  return true
}

/**
 * Insert `text` at the end of the session draft through the same scoped
 * event the host slash menu executes (`slash/input-insert-text`). The span
 * CAS uses the freshest input snapshot handed to the slot props — while the
 * picker popover is open the composer draft cannot move (focus is in the
 * picker), so the splice applies; a stale snapshot quietly no-ops, same as
 * the host menu's span-CAS.
 */
function insertComposerText(scope, sessionId, input, text) {
  const sessions = scope && scope.sessions
  if (!sessions) return false
  let actx
  try { actx = sessions.scope(sessionId) } catch { return false }
  if (actx === undefined || actx === null || typeof actx.bail !== 'function') return false
  const draft = (input && input.draft) || ''
  const at = draft.length
  try {
    return actx.bail(actx, 'slash/input-insert-text', {
      text,
      span: { start: at, end: at, draftRev: (input && input.draftRev) || 0 },
    }) === true
  } catch { return false }
}

/** Best-effort refocus of the composer textarea after the picker closes. */
function refocusComposer() {
  try {
    const card = document.querySelector('[data-composer-card]')
    const ta = card && card.querySelector('textarea')
    if (ta && typeof ta.focus === 'function') ta.focus()
  } catch {}
}

/** Picker popover list cap — beyond this the search input is the filter. */
const PICKER_ROW_CAP = 200

/** Skill catalog cache for the picker (ui-skill 同源：connection.api.skills). */
let skillCatalog = { sessionId: null, at: 0, rows: null }
const SKILL_CATALOG_TTL = 60_000

/**
 * Picker candidates from the host skill registry (the same list the `/`
 * skill source shows). Subagent sessions have no catalog (ui-skill 同款守卫);
 * a failed/absent connection rejects → the picker shows its empty state.
 */
async function fetchSkillCandidates(connection, sessions, sessionId) {
  try { if (sessions && typeof sessions.subagentAddress === 'function' && sessions.subagentAddress(sessionId) !== undefined) return [] } catch {}
  const now = Date.now()
  if (skillCatalog.rows !== null && skillCatalog.sessionId === sessionId && now - skillCatalog.at < SKILL_CATALOG_TTL) return skillCatalog.rows
  const skills = connection && connection.api && connection.api.skills
  if (!skills || typeof skills.list !== 'function') throw new Error('connection.api.skills unavailable')
  const res = await skills.list({ sessionId })
  const result = res && res.result
  if (!result || result.ok !== true) throw new Error('skill.list failed')
  const list = result.value && Array.isArray(result.value.skills) ? result.value.skills : []
  const rows = list.map((s) => ({ name: s.name, description: s.description || '', modelInvocable: s.modelInvocable !== false }))
  skillCatalog = { sessionId, at: now, rows }
  return rows
}

/**
 * ＋ 技能 picker：锚定在按钮上方、自带搜索框的候选浮层（portal 到 body）。
 * 宿主斜杠菜单靠「输入的 query」过滤，按钮打开的菜单没有输入载体——候选
 * 太多时无从筛选，所以浮层自带搜索框。键盘 ↑/↓/Enter/Esc，鼠标 hover+点击。
 */
function SkillPicker(props) {
  const t = props.t
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  useEffect(() => { try { if (inputRef.current) inputRef.current.focus() } catch {} }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !(e.isComposing === true)) props.onClose() }
    try { document.addEventListener('keydown', onKey) } catch {}
    return () => { try { document.removeEventListener('keydown', onKey) } catch {} }
  }, [])
  const lower = query.trim().toLowerCase()
  const all = props.rows || []
  const filtered = lower === '' ? all : all.filter((r) => matchSkill(r, lower))
  const shown = filtered.slice(0, PICKER_ROW_CAP)
  useEffect(() => { setActive(0) }, [lower, props.rows])
  useEffect(() => {
    const list = listRef.current
    const el = list && list.children[active]
    if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'nearest' }) } catch {} }
  }, [active])
  const onKeyDown = (e) => {
    // IME 组词中的按键不触发选择（回车是选定拼音候选，不是 pick）
    if (e.nativeEvent && e.nativeEvent.isComposing === true) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const row = shown[active]; if (row) props.onPick(row) }
  }
  const width = 400
  const winW = typeof window !== 'undefined' ? window.innerWidth : 800
  const winH = typeof window !== 'undefined' ? window.innerHeight : 600
  const left = Math.max(8, Math.min(props.anchor.left, winW - width - 8))
  const bottom = Math.max(8, winH - props.anchor.top + 6)
  return h('div', { className: 'sk-picker-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) props.onClose() } },
    h('div', { className: 'sk-picker', style: { left, bottom, width }, role: 'dialog', 'aria-label': t('pickSkillTitle') },
      h('input', {
        ref: inputRef, className: 'sk-input sk-picker-input', value: query,
        placeholder: t('pickerSearch'), onChange: (e) => setQuery(e.target.value), onKeyDown,
      }),
      h('div', { className: 'sk-picker-list', ref: listRef, role: 'listbox' },
        props.rows === null
          ? h('div', { className: 'sk-picker-empty' }, t('pickerLoading'))
          : shown.length === 0
            ? h('div', { className: 'sk-picker-empty' }, t('emptySearch'))
            : shown.map((row, i) => h('button', {
                key: row.name, type: 'button', role: 'option', 'aria-selected': i === active,
                className: 'sk-picker-row', 'data-active': i === active,
                onMouseEnter: () => setActive(i),
                onMouseDown: (e) => { e.preventDefault(); props.onPick(row) },
              },
                h('span', { className: 'sk-picker-name' }, row.name),
                h('span', { className: 'sk-picker-desc' },
                  row.modelInvocable ? row.description : `${t('pickerUserOnly')} · ${row.description}`))))))
}

// ── Locale ───────────────────────────────────────────────────────────────

const NS = 'skillsManagement'

const ZH = {
  title: '技能管理',
  close: '关闭',
  tabExecutors: '已安装',
  tabMcp: 'MCP 管理',
  mcpTitle: 'MCP 管理',
  mcpHint: '管理 dsh 的 MCP server：每条记录会被桥接成模型可调用的工具（mcp__服务名__工具名）。stdio 会在本机启动该程序，streamable-http 则连接远端地址。',
  mcpAdd: '新增 MCP server',
  mcpEdit: '编辑',
  mcpEditTitle: '编辑 MCP server',
  mcpAddTitle: '新增 MCP server',
  mcpEmpty: '还没有配置 MCP server，点「新增 MCP server」添加一条。',
  mcpLoading: '正在读取 profile 的 MCP 配置…',
  mcpProfile: 'Profile',
  mcpPatchFile: '配置文件',
  mcpPatchReload: '改动生效方式',
  mcpReloadLive: '热生效（无需重启）',
  mcpReloadStartup: '需重启 dsh',
  mcpNoProfile: '无法确定活动 profile：请在插件配置里指定 mcpProfile。',
  mcpServerName: '服务名',
  mcpServerNameHint: '成为工具名前缀：mcp__<服务名>__<工具名>；仅字母数字、下划线、连字符，≤32',
  mcpTransport: '传输方式',
  mcpStdio: 'stdio（本机启动程序）',
  mcpHttp: 'streamable-http（连接远端地址）',
  mcpCommand: '命令',
  mcpCommandHint: '例如 npx、node、python；相对路径会按宿主进程的工作目录解析',
  mcpArgs: '参数',
  mcpArgsHint: '一行一个参数（不解析引号，需要空格的整段写在一行）',
  mcpEnv: '环境变量',
  mcpEnvHint: '一行一个 KEY=值；需要读取宿主环境变量时写 KEY=${变量名}',
  mcpHeaders: '请求头',
  mcpCwd: '工作目录',
  mcpUrl: '地址',
  mcpTimeout: '工具调用超时',
  mcpTimeoutHint: '毫秒，留空用默认 60000',
  mcpFailOnStartup: '启动失败即中止',
  mcpFailOnStartupHint: '初始连接或工具同步失败时拒绝激活该条目（默认关闭：只记日志）',
  mcpReconnect: '重连',
  mcpReconnectEnabled: '断线自动重连',
  mcpReconnectAttempts: '最大连续失败次数',
  mcpSave: '保存',
  mcpCancel: '取消',
  mcpDelete: '删除',
  mcpDeleteTitle: '删除 MCP server',
  mcpDeleteConfirm: '即将删除「{name}」这条 MCP server 记录并写入 profile 配置，删除后该服务的工具不再可用。',
  mcpDisable: '停用',
  mcpEnable: '启用',
  mcpDisabledTag: '已停用',
  mcpReadOnlyTag: '本插件不管辖',
  mcpReadOnlyHint: '这条记录不是本页面创建的，为避免破坏你的配置，这里只展示、不修改。',
  mcpForeignJsTag: '含自定义表达式',
  mcpForeignJsHint: '该条目含 process.env 之外的 !!js 表达式，本页面不重写它。',
  mcpArgsCount: '{n} 个参数',
  mcpEnvCount: '{n} 个环境变量',
  mcpSaved: '已写入 profile 配置',
  mcpCreated: '已添加 MCP server',
  mcpDeleted: '已删除',
  mcpWarnBootstrap: '此 profile 的 patch 文件里已有你自己的条目，本插件不会自动改写它。',
  mcpWarnParse: '现有管理块无法解析，请手工修好后再用本页面。',
  mcpServerNameRequired: '服务名不能为空，且只能用字母数字、下划线、连字符（≤32）',
  mcpCommandRequired: 'stdio 传输必须填命令',
  mcpUrlRequired: 'streamable-http 传输必须填合法地址（http/https）',
  mcpEnvInvalid: '环境变量/请求头必须是 KEY=值，每行一条',
  cardsHint: '选择一个智能体工具浏览它的技能，或一次查看全部',
  executorSettings: '执行器目录',
  executorSettingsHint: '管理本机各执行器的技能目录：内置来源可改目录、可停用；也可新增自定义来源。保存后立即生效，无需重启。',
  execSourceBuiltin: '内置',
  execSourceCustom: '自定义',
  execDisabledTag: '已停用',
  execManagedTag: '由插件配置文件管理',
  execLockedTag: '锁定（本插件安装库）',
  execKeyLabel: '标识 (key)',
  execNameLabel: '显示名',
  execDirLabel: '技能目录',
  execEnabledLabel: '启用',
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
  backExecutors: '← 已安装',
  backAll: '← 全部技能',
  searchAll: '搜索全部技能…',
  filterWithin: '在 {label} 内筛选…',
  pickSource: '全部智能体工具',
  loadingCatalogs: '正在加载全部智能体工具目录…',
  scanning: '正在扫描 {label}…',
  skillsSuffix: '个技能',
  noExecutors: '本机未发现任何智能体工具目录',
  dirMissingTitle: '{label}：目录不存在',
  dirMissingHint: '预期位置 {dir}',
  notFoundGroup: '本机不存在的来源（{n}）',
  dirNotPresent: '目录不存在',
  emptySearch: '没有匹配的技能',
  emptySkillsIn: '{label} 中还没有技能',
  installedTag: '已装',
  readOnlyTag: '只读',
  toDsh: '安装',
  deleteBtn: '删除',
  detail: '详情',
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
  preview: '文件预览',
  content: '内容',
  activeInDsh: '已在 DSH 生效',
  invocationToggle: '模型可调用',
  hiddenTag: '已隐藏',
  hideAction: '隐藏',
  restoreAction: '恢复可见',
  modelVisibleTag: '模型可见',
  detailHideAction: '在模型目录隐藏',
  invocationOn: '模型可见',
  invocationOff: '已从模型目录隐藏',
  invocationHint: '关闭后技能保留在库里，但不再注入对话目录（skill 工具也调不到）',
  pathLabel: '路径',
  meTag: '本机',
  pickSkill: '＋ 技能',
  pickSkillTitle: '选择一个技能，其内容将注入本条消息',
  pickerSearch: '搜索技能名称或描述…',
  pickerLoading: '正在加载技能目录…',
  pickerUserOnly: '仅用户',
  usageStat: '≈{tokens} token · {chars} 字符',
  usageCharsOnly: '{chars} 字符',
  usageHint: '按「名称+描述」全文估算的注入开销（cl100k_base 词表，DeepSeek 实际分词略有差异，适合横向比较）',
  usageMetaLabel: '≈注入开销',
  sortLabel: '排序',
  sortDefault: '默认排序',
  sortTokensDesc: 'token 高→低',
  sortTokensAsc: 'token 低→高',
  sortCharsDesc: '字符 多→少',
}

const EN = {
  title: 'Skills',
  close: 'Close',
  tabExecutors: 'Installed',
  tabMcp: 'MCP',
  mcpTitle: 'MCP management',
  mcpHint: 'Manage dsh MCP servers. Each record is bridged into model-callable tools (mcp__<server>__<tool>). stdio launches a local program; streamable-http connects to a URL.',
  mcpAdd: 'Add MCP server',
  mcpEdit: 'Edit',
  mcpEditTitle: 'Edit MCP server',
  mcpAddTitle: 'Add MCP server',
  mcpEmpty: 'No MCP servers configured yet — use “Add MCP server”.',
  mcpLoading: 'Reading the profile MCP config…',
  mcpProfile: 'Profile',
  mcpPatchFile: 'Config file',
  mcpPatchReload: 'Applies',
  mcpReloadLive: 'live (no restart needed)',
  mcpReloadStartup: 'needs a dsh restart',
  mcpNoProfile: 'Cannot determine the active profile: set mcpProfile in the plugin config.',
  mcpServerName: 'Server name',
  mcpServerNameHint: 'Becomes the tool-name prefix: mcp__<server>__<tool>; letters, digits, underscore and hyphen only, ≤32',
  mcpTransport: 'Transport',
  mcpStdio: 'stdio (launch a local program)',
  mcpHttp: 'streamable-http (connect to a URL)',
  mcpCommand: 'Command',
  mcpCommandHint: 'e.g. npx, node, python; a relative path resolves against the host working directory',
  mcpArgs: 'Arguments',
  mcpArgsHint: 'One argument per line (quotes are not parsed — put a whole space-bearing argument on one line)',
  mcpEnv: 'Environment',
  mcpEnvHint: 'One KEY=value per line; use KEY=${VAR} to read a variable from the host environment',
  mcpHeaders: 'Headers',
  mcpCwd: 'Working directory',
  mcpUrl: 'URL',
  mcpTimeout: 'Tool call timeout',
  mcpTimeoutHint: 'milliseconds; leave empty for the default 60000',
  mcpFailOnStartup: 'Abort on startup failure',
  mcpFailOnStartupHint: 'Refuse to activate this entry when the initial connection or tool sync fails (off by default: log only)',
  mcpReconnect: 'Reconnect',
  mcpReconnectEnabled: 'Reconnect automatically',
  mcpReconnectAttempts: 'Max consecutive failures',
  mcpSave: 'Save',
  mcpCancel: 'Cancel',
  mcpDelete: 'Delete',
  mcpDeleteTitle: 'Delete MCP server',
  mcpDeleteConfirm: 'Delete the MCP server “{name}” and write the profile config? Its tools stop being available.',
  mcpDisable: 'Disable',
  mcpEnable: 'Enable',
  mcpDisabledTag: 'disabled',
  mcpReadOnlyTag: 'not managed here',
  mcpReadOnlyHint: 'This record was not created by this page; it is shown but never rewritten, so your config stays intact.',
  mcpForeignJsTag: 'custom expression',
  mcpForeignJsHint: 'This entry uses a !!js expression beyond process.env, so this page will not rewrite it.',
  mcpArgsCount: '{n} args',
  mcpEnvCount: '{n} env vars',
  mcpSaved: 'Written to the profile config',
  mcpCreated: 'MCP server added',
  mcpDeleted: 'Deleted',
  mcpWarnBootstrap: 'This profile patch file already has your own entries; the plugin will not rewrite it automatically.',
  mcpWarnParse: 'The existing managed block cannot be parsed — fix it by hand before using this page.',
  mcpServerNameRequired: 'Server name is required and must match [A-Za-z0-9_-]{1,32}',
  mcpCommandRequired: 'A stdio transport needs a command',
  mcpUrlRequired: 'A streamable-http transport needs a valid http(s) URL',
  mcpEnvInvalid: 'Environment/headers must be KEY=value, one per line',
  cardsHint: 'Pick an agent tool to browse its skills, or view everything at once',
  executorSettings: 'Executor dirs',
  executorSettingsHint: 'Manage the skill directories of on-machine executors: built-in sources can be redirected or disabled; custom sources can be added. Changes apply immediately, no restart.',
  execSourceBuiltin: 'built-in',
  execSourceCustom: 'custom',
  execDisabledTag: 'disabled',
  execManagedTag: 'managed by plugin config',
  execLockedTag: 'locked (this plugin\'s library)',
  execKeyLabel: 'Key',
  execNameLabel: 'Display name',
  execDirLabel: 'Skills dir',
  execEnabledLabel: 'Enabled',
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
  backExecutors: '← Installed',
  backAll: '← All skills',
  searchAll: 'Search all skills…',
  filterWithin: 'Filter within {label}…',
  pickSource: 'All agent tools',
  loadingCatalogs: 'Loading all agent tool catalogs…',
  scanning: 'Scanning {label}…',
  skillsSuffix: 'skills',
  noExecutors: 'No agent tool directories found on this machine',
  dirMissingTitle: '{label}: directory not found',
  dirMissingHint: 'Expected skills at {dir}',
  notFoundGroup: 'Not found on this machine ({n})',
  dirNotPresent: 'directory not present',
  emptySearch: 'No matching skills',
  emptySkillsIn: 'No skills in {label}',
  installedTag: 'Installed',
  readOnlyTag: 'read-only',
  toDsh: 'Install',
  deleteBtn: 'Delete',
  detail: 'Detail',
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
  preview: 'File preview',
  content: 'Content',
  activeInDsh: 'active in DSH',
  invocationToggle: 'Model-invocable',
  hiddenTag: 'hidden',
  hideAction: 'Hide',
  restoreAction: 'Restore',
  modelVisibleTag: 'model-visible',
  detailHideAction: 'Hide from model catalog',
  invocationOn: 'model-visible',
  invocationOff: 'hidden from model catalog',
  invocationHint: 'When off, the skill stays in the library but is not injected into conversation catalogs',
  pathLabel: 'Path',
  meTag: 'me',
  pickSkill: '+ Skill',
  pickSkillTitle: 'Pick a skill; its content is injected into this message',
  pickerSearch: 'Search skills by name or description…',
  pickerLoading: 'Loading skill catalog…',
  pickerUserOnly: 'user-only',
  usageStat: '≈{tokens} tokens · {chars} chars',
  usageCharsOnly: '{chars} chars',
  usageHint: 'Estimated injection cost of the full name+description (cl100k_base; DeepSeek tokenizes slightly differently — for comparison, not billing)',
  usageMetaLabel: '≈Injection cost',
  sortLabel: 'Sort',
  sortDefault: 'Default order',
  sortTokensDesc: 'tokens high→low',
  sortTokensAsc: 'tokens low→high',
  sortCharsDesc: 'chars high→low',
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

/** 注入开销一行文案：token 在（宿主装了词表）→「≈N token · M 字符」，
 *  降级时只剩字符数；两者都缺（旧响应）→ null 不渲染。 */
function usageText(s, t) {
  if (typeof s.tokens === 'number') return t('usageStat', { tokens: s.tokens, chars: s.chars ?? (s.description || '').length })
  if (typeof s.chars === 'number') return t('usageCharsOnly', { chars: s.chars })
  return null
}

/** 卡片排序：缺 token/chars 的行（预热未完成或降级模式）永远沉底，
 *  其余按所选指标升/降序。keyFn 供 {row, s} 包装数组取卡片行。 */
function sortSkills(rows, sortBy, keyFn = (s) => s) {
  if (!sortBy || sortBy === 'default') return rows
  const pick = sortBy === 'chars' ? (s) => keyFn(s).chars : (s) => keyFn(s).tokens
  const asc = sortBy === 'tokensAsc'
  return [...rows].sort((a, b) => {
    const va = pick(a), vb = pick(b)
    if (va === vb) return 0
    if (va === undefined || va === null) return 1
    if (vb === undefined || vb === null) return -1
    return asc ? va - vb : vb - va
  })
}

/** 排序下拉（原生 select：排序是低频操作，不值得自绘 popover）。 */
function SortSelect({ value, onChange, t }) {
  return h('select', { value, onChange: e => onChange(e.target.value), style: selectStyle(), title: t('sortLabel'), 'aria-label': t('sortLabel') },
    h('option', { value: 'default' }, t('sortDefault')),
    h('option', { value: 'tokens' }, t('sortTokensDesc')),
    h('option', { value: 'tokensAsc' }, t('sortTokensAsc')),
    h('option', { value: 'chars' }, t('sortCharsDesc')))
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
.sk-src{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.sk-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left}
.sk-card:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.sk-card.missing{opacity:.5;cursor:default}
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
.sk-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:12px;cursor:pointer;white-space:nowrap}
.sk-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sk-picker-backdrop{position:fixed;inset:0;z-index:2147483200}
.sk-picker{position:fixed;z-index:2147483201;width:400px;max-width:92vw;max-height:360px;display:flex;flex-direction:column;gap:4px;padding:6px;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;box-shadow:var(--dsw-shadow-lv3)}
.sk-picker-input{flex:none;box-sizing:border-box;width:100%}
.sk-picker-list{display:flex;flex-direction:column;min-height:40px;overflow-y:auto}
.sk-picker-row{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font-family:var(--dsw-font-family);font-size:13px}
.sk-picker-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.sk-picker-name{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.sk-picker-desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sk-picker-empty{padding:12px 10px;text-align:center;color:var(--dsw-alias-label-dimmed);font-size:13px}
</style>`

// ── Fetch layer ─────────────────────────────────────────────────────────

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
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
  const usage = usageText(s, t)
  return h('div', { className: 'sk-card', role: 'button', tabIndex: 0,
      onClick: () => onOpen(s),
      onKeyDown: e => e.key === 'Enter' && onOpen(s) },
    h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
      h(Avatar, { name }),
      h('div', { style: { minWidth: 0 } },
        h('div', { className: 'sk-title' }, name),
        (s.fileCount || s.totalSize) && h('div', { className: 'sk-dir' }, `${s.fileCount || 0} · ${formatSize(s.totalSize || 0)} · ${formatTime(s.modifiedAt)}`))),
    h('div', { className: 'sk-desc' }, s.description || ''),
    usage && h('div', { className: 'sk-stats', title: t('usageHint') }, usage),
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
              data && usageText(data, t) && h('div', null, h('div', { className: 'sk-dir' }, t('usageMetaLabel')), h('div', { className: 'sk-hint', title: t('usageHint') }, usageText(data, t))),
              meta.version && h('div', null, h('div', { className: 'sk-dir' }, 'Version'), h('div', { className: 'sk-hint' }, 'v' + meta.version)),
              meta.author && h('div', null, h('div', { className: 'sk-dir' }, 'Author'), h('div', { className: 'sk-hint' }, meta.author))),
            files.length
              ? h('div', { className: 'sk-filewrap' },
                  h('div', { className: 'sk-files' }, files.map(f =>
                    h('button', { key: f.path, className: 'sk-file' + ((file ? f.path === file.path : f.path === 'SKILL.md') ? ' on' : ''), onClick: () => openFile(f) },
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path),
                      h('span', { className: 'sk-dir' }, formatSize(f.size))))),
                  h('div', { className: 'sk-preview sk-md' },
                    isMd && prim('MarkdownText')
                      ? h(P.MarkdownText, { text: file ? fileText : (data?.content || '') })
                      : h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--dsw-font-family)' } }, file ? fileText : (data?.content || ''))))
              : h('div', { className: 'sk-preview sk-md' },
                  prim('MarkdownText')
                    ? h(P.MarkdownText, { text: data?.content || '' })
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
  const addRow = () => setRows(rs => [...rs, { __id: 'r' + (++rowSeq.current), key: '', label: '', dir: '', source: 'custom', locked: false, managedByConfig: false, disabled: false, overridden: false, defaultDir: '' }])

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

  const tag = (text, tone) => h('span', { className: 'sk-tag' + (tone ? ' ' + tone : '') }, text)
  const rowEl = (r, i) => {
    const editable = !r.locked && !r.managedByConfig
    return h('div', { key: r.__id, style: { display: 'flex', flexDirection: 'column', gap: 6,
        padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, opacity: r.disabled ? 0.55 : 1 } },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { className: 'sk-tag' }, r.source === 'builtin' ? t('execSourceBuiltin') : t('execSourceCustom')),
        r.source === 'custom' && editable
          ? h('input', { className: 'sk-input', value: r.key, placeholder: t('execKeyPlaceholder'), style: { width: 160 }, onChange: e => patchRow(i, { key: e.target.value }) })
          : h('span', { className: 'sk-title' }, r.label),
        r.source === 'custom' && editable
          ? h('input', { className: 'sk-input', value: r.label, placeholder: t('execNamePlaceholder'), style: { width: 140 }, onChange: e => patchRow(i, { label: e.target.value }) })
          : null,
        r.locked && tag(t('execLockedTag')),
        !r.locked && r.managedByConfig && tag(t('execManagedTag')),
        r.disabled && tag(t('execDisabledTag'), 'danger'),
        h('span', { style: { flex: 1 } }),
        r.source === 'builtin' && editable
          ? h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: !r.disabled, onChange: e => patchRow(i, { disabled: !e.target.checked }) }), t('execEnabledLabel'))
          : null,
        r.source === 'custom' && editable
          ? h(ButtonLite, { small: true, onClick: () => removeRow(i) }, t('execRemove'))
          : null),
      editable
        ? h('input', { className: 'sk-input', value: r.dir, placeholder: t('execDirPlaceholder'), style: { width: '100%' }, onChange: e => patchRow(i, { dir: e.target.value }) })
        : h('div', { className: 'sk-dir' }, r.dir))
  }

  return h(SkDialog, { title: t('executorSettings'), onClose, wide: true },
    rows === null
      ? h(Spinner, { label: '…' })
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { className: 'sk-hint' }, t('executorSettingsHint')),
          ...rows.map(rowEl),
          h('div', { style: { textAlign: 'center' } },
            h(ButtonLite, { small: true, onClick: addRow }, '+ ' + t('execAdd'))),
          restoreArmed && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-end' } }, t('execRestoreConfirm')),
          h('div', { className: 'sk-dlg-foot', style: { marginTop: 2 } },
            h(ButtonLite, { onClick: doRestore }, t('execRestore')),
            h('span', { style: { flex: 1 } }),
            h(ButtonLite, { primary: true, disabled: busy, onClick: doSave }, t('save'))),
        ]))
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

function CardsView({ executors, t, onEnter, onBrowseAll, onOpenSettings }) {
  if (!executors.length) return [
    // 空列表也要留设置入口：全部执行器被停用/目录为空时仍能进管理弹窗
    h('div', { className: 'sk-toolbar' },
      h('span', { className: 'sk-hint' }, t('cardsHint')),
      h('span', { className: 'spacer' }),
      h(ButtonLite, { onClick: onOpenSettings }, t('executorSettings'))),
    h(Empty, null, t('noExecutors')),
  ]
  const present = executors.filter(r => r.dirExists)
  const missing = executors.filter(r => !r.dirExists)
  return [
    h('div', { className: 'sk-toolbar' },
      h('span', { className: 'sk-hint' }, t('cardsHint')),
      h('span', { className: 'spacer' }),
      h(P.Button, { variant: 'primary', size: 'sm', onClick: onBrowseAll }, `${t('browseAll')} (${executors.reduce((a, r) => a + r.skillCount, 0)})`),
      h('span', { style: { width: 6 } }),
      h(ButtonLite, { onClick: onOpenSettings, title: t('executorSettings') }, t('executorSettings')),
      h('span', { style: { width: 6 } }),
      h('span', { className: 'sk-refresh-slot' })),
    h('div', { className: 'sk-src' },
      present.map(row => h(ExecutorCard, { key: row.key, row, t, onEnter }))),
    missing.length > 0 && [
      h('div', { className: 'sk-hint', style: { marginTop: 6 } }, t('notFoundGroup', { n: missing.length })),
      h('div', { className: 'sk-src' },
        missing.map(row => h(ExecutorCard, { key: row.key, row, t, onEnter }))),
    ],
  ]
}

function AllSkillsView({ executors, searchText, sourceFilter, sortBy, t, onSearch, onFilter, onSort, onBack, onOpen, onInstall, onDelete, onToggleVisible }) {
  const pending = executors.some(x => x.dirExists && !Array.isArray(x.skills))
  if (pending) return h(Spinner, { label: t('loadingCatalogs') })
  let items = []
  for (const row of executors) {
    if (!row.dirExists || !Array.isArray(row.skills)) continue
    if (sourceFilter !== 'all' && row.key !== sourceFilter) continue
    for (const s of row.skills) items.push({ row, s })
  }
  if (searchText) items = items.filter(it => matchSkill(it.s, searchText.toLowerCase()))
  items = sortSkills(items, sortBy, it => it.s)
  return [
    h('div', { className: 'sk-head' },
      h(P.Button, { variant: 'ghost', size: 'sm', onClick: onBack }, t('backCards')),
      h('span', { className: 'sk-title' }, t('title')),
      h(InputBox, { value: searchText, placeholder: t('searchAll'), onSearch }),
      SourceFilterEl({ rows: executors.filter(r => r.dirExists), value: sourceFilter, onChange: onFilter, t }),
      SortSelect({ value: sortBy, onChange: onSort, t }),
      h('span', { className: 'spacer' }),
      h(Tag, null, `${items.length} ${t('skillsSuffix')}`)),
    !items.length
      ? h(Empty, null, t('emptySearch'))
      : h('div', { className: 'sk-grid' }, items.map(({ row, s }) =>
          h(SkillCard, { key: row.key + '/' + s.name, row, s, t, onOpen, onInstall, onDelete, onToggleVisible })))]
}

function DrillInView({ row, searchText, sortBy, t, onSearch, onSort, onBack, onOpen, onInstall, onDelete, onToggleVisible }) {
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
  skills = sortSkills(skills, sortBy)
  return [
    h('div', { className: 'sk-head' },
      h(P.Button, { variant: 'ghost', size: 'sm', onClick: onBack }, t('backAll')),
      h('span', { className: 'sk-title' }, row.label),
      h('span', { className: 'sk-tag' }, `${skills.length} ${t('skillsSuffix')}`),
      row.readOnly && h(Tag, { tone: 'danger' }, t('readOnlyTag')),
      h(InputBox, { value: searchText, placeholder: t('filterWithin', { label: row.label }), onSearch }),
      SortSelect({ value: sortBy, onChange: onSort, t }),
      h('span', { className: 'spacer' }),
      h('span', { className: 'sk-dir' }, row.dir)),
    !skills.length
      ? h(Empty, null, searchText ? t('emptySearch') : t('emptySkillsIn', { label: row.label }))
      : h(PagedGrid, { key: 'ed' + row.key + searchText + sortBy, items: skills, t,
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
  const [pageToast, setPageToast] = useState(null)
  const [searchExec, setSearchExec] = useState('')
  const [searchDrill, setSearchDrill] = useState('')
  const [searchAll, setSearchAll] = useState('')
  const [sortBy, setSortBy] = useState('default')
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
      body = h(DrillInView, { row, searchText: searchDrill, sortBy, t,
        onSearch: setSearchDrill, onSort: setSortBy,
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
      body = h(AllSkillsView, { executors, searchText: searchAll, sourceFilter, sortBy, t,
        onSearch: setSearchAll, onSort: setSortBy,
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
        onOpenSettings: () => setExecutorSettingsOpen(true) })
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

function selectStyle() {
  return { minHeight: 30, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-specific-input-major, var(--dsw-alias-bg-layer-1))', color: 'var(--dsw-alias-label-primary)', padding: '4px 10px' }
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

// ── MCP 管理（profile cordis.patch.yml 里的 dsh-mcp-client 条目）──────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
/** `KEY=${VAR}` 读宿主环境变量；纯 `KEY=值` 按字面量写入配置。 */
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** 配置对象 → 文本域（`!!js process.env.X` 还原成 `${X}`）。 */
function mapToText(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return ''
  return Object.entries(map).map(([key, value]) => {
    const text = value !== null && typeof value === 'object' && typeof value.js === 'string' ? value.js : String(value)
    const ref = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text) || /^process\.env\['([^']+)'\]$/.exec(text)
    return `${key}=${ref ? '${' + ref[1] + '}' : text}`
  }).join('\n')
}

/** 文本域 → 配置对象 + 第一条错误。值里含 `=` 时按第一个 `=` 切分。 */
function textToMap(text, t) {
  const out = {}
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) return { error: t('mcpEnvInvalid') }
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1)
    if (!ENV_NAME_RE.test(key)) return { error: t('mcpEnvInvalid') }
    const ref = ENV_REF_RE.exec(value.trim())
    if (ref !== null) { out[key] = { js: `process.env.${ref[1]}` }; continue }
    out[key] = value
  }
  return { value: out }
}

/** 参数文本域 → 数组（一行一个，不解析引号）。 */
const textToArgs = (text) => String(text === undefined || text === null ? '' : text)
  .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')

function mcpRowToForm(row) {
  return {
    serverName: row.serverName || '',
    transport: row.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: row.command || '',
    argsText: (row.args || []).join('\n'),
    envText: mapToText(row.env),
    cwd: row.cwd || '',
    url: row.url || '',
    headersText: mapToText(row.headers),
    timeout: typeof row.toolCallTimeoutMs === 'number' ? String(row.toolCallTimeoutMs) : '',
    failOnStartup: row.failOnStartupError === true,
    reconnectEnabled: !(row.reconnect && row.reconnect.enabled === false),
    reconnectAttempts: row.reconnect && typeof row.reconnect.maxAttempts === 'number' ? String(row.reconnect.maxAttempts) : '',
  }
}

const emptyMcpForm = () => ({
  serverName: '', transport: 'stdio', command: '', argsText: '', envText: '', cwd: '',
  url: '', headersText: '', timeout: '', failOnStartup: false, reconnectEnabled: true, reconnectAttempts: '',
})

const labelStyle = () => ({ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 })
const fieldHintStyle = () => ({ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, lineHeight: 1.45 })
const textareaStyle = () => ({
  width: '100%', boxSizing: 'border-box', minHeight: 62, resize: 'vertical',
  fontFamily: 'var(--dsw-font-family)', fontSize: 13, padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)', outline: 'none',
})

/** 新增/编辑弹窗。表单 → API body 的转换与校验都在这里，服务端还会再校验一次。 */
function McpServerDialog({ t, row, profile, onClose, onSaved }) {
  const editing = row !== undefined && row !== null
  const [form, setForm] = useState(() => (editing ? mcpRowToForm(row) : emptyMcpForm()))
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const isStdio = form.transport === 'stdio'
  const patch = (values) => setForm((current) => ({ ...current, ...values }))
  const endpoint = `${API}/mcp?profile=${encodeURIComponent(profile)}`

  const submit = async () => {
    setError(null)
    const serverName = form.serverName.trim()
    if (!SERVER_NAME_RE.test(serverName)) { setError(t('mcpServerNameRequired')); return }
    const body = { serverName, transport: form.transport }
    if (isStdio) {
      if (form.command.trim() === '') { setError(t('mcpCommandRequired')); return }
      body.command = form.command.trim()
      body.args = textToArgs(form.argsText)
      const env = textToMap(form.envText, t)
      if (env.error !== undefined) { setError(env.error); return }
      body.env = env.value
      if (form.cwd.trim() !== '') body.cwd = form.cwd.trim()
    } else {
      const url = form.url.trim()
      if (url === '') { setError(t('mcpUrlRequired')); return }
      body.url = url
      const headers = textToMap(form.headersText, t)
      if (headers.error !== undefined) { setError(headers.error); return }
      body.headers = headers.value
    }
    if (form.timeout.trim() !== '') body.toolCallTimeoutMs = Number(form.timeout.trim())
    if (form.failOnStartup) body.failOnStartupError = true
    const reconnect = {}
    if (!form.reconnectEnabled) reconnect.enabled = false
    if (form.reconnectAttempts.trim() !== '') reconnect.maxAttempts = Number(form.reconnectAttempts.trim())
    if (Object.keys(reconnect).length > 0) body.reconnect = reconnect

    setBusy(true)
    try {
      // `enabled` rides along on edit so a disabled row stays disabled
      const payload = editing ? { ...body, id: row.id, enabled: row.enabled !== false } : body
      const response = await fetch(endpoint, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      onSaved(data)
    } catch (e) {
      setError(t('operationFailed') + ': ' + e.message)
    } finally { setBusy(false) }
  }

  const text = (label, value, onChange, hint, placeholder) => h('label', { style: labelStyle() },
    h('span', { className: 'sk-dir' }, label),
    h('input', { className: 'sk-input', value, placeholder, style: { width: '100%' }, onChange: (e) => onChange(e.target.value) }),
    hint !== undefined && h('span', { style: fieldHintStyle() }, hint))

  const area = (label, value, onChange, hint) => h('label', { style: labelStyle() },
    h('span', { className: 'sk-dir' }, label),
    h('textarea', { value, spellCheck: false, style: textareaStyle(), onChange: (e) => onChange(e.target.value) }),
    hint !== undefined && h('span', { style: fieldHintStyle() }, hint))

  return h(SkDialog, { title: editing ? t('mcpEditTitle') : t('mcpAddTitle'), onClose, wide: true },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h('div', { className: 'sk-hint' }, t('mcpHint')),
      text(t('mcpServerName'), form.serverName, (v) => patch({ serverName: v }), t('mcpServerNameHint'), 'github'),
      h('label', { style: labelStyle() },
        h('span', { className: 'sk-dir' }, t('mcpTransport')),
        h('select', { className: 'sk-input', style: { width: '100%' }, value: form.transport, onChange: (e) => patch({ transport: e.target.value }) },
          h('option', { value: 'stdio' }, t('mcpStdio')),
          h('option', { value: 'streamable-http' }, t('mcpHttp')))),
      isStdio
        ? [
            text(t('mcpCommand'), form.command, (v) => patch({ command: v }), t('mcpCommandHint'), 'npx'),
            area(t('mcpArgs'), form.argsText, (v) => patch({ argsText: v }), t('mcpArgsHint')),
            area(t('mcpEnv'), form.envText, (v) => patch({ envText: v }), t('mcpEnvHint')),
            text(t('mcpCwd'), form.cwd, (v) => patch({ cwd: v })),
          ]
        : [
            text(t('mcpUrl'), form.url, (v) => patch({ url: v }), undefined, 'http://localhost:3000/mcp'),
            area(t('mcpHeaders'), form.headersText, (v) => patch({ headersText: v }), t('mcpEnvHint')),
          ],
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { ...labelStyle(), flex: '0 0 200px' } },
          h('span', { className: 'sk-dir' }, t('mcpTimeout')),
          h('input', { className: 'sk-input', value: form.timeout, placeholder: '60000', onChange: (e) => patch({ timeout: e.target.value }) }),
          h('span', { style: fieldHintStyle() }, t('mcpTimeoutHint'))),
        h('div', { style: { ...labelStyle(), flex: '0 0 200px' } },
          h('span', { className: 'sk-dir' }, t('mcpReconnect')),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 } },
            h('input', { type: 'checkbox', checked: form.reconnectEnabled, onChange: (e) => patch({ reconnectEnabled: e.target.checked }) }),
            t('mcpReconnectEnabled')),
          h('input', { className: 'sk-input', value: form.reconnectAttempts, placeholder: '10', onChange: (e) => patch({ reconnectAttempts: e.target.value }) }))),
      h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 } },
        h('input', { type: 'checkbox', checked: form.failOnStartup, onChange: (e) => patch({ failOnStartup: e.target.checked }) }),
        h('span', null, t('mcpFailOnStartup'))),
      h('span', { style: fieldHintStyle() }, t('mcpFailOnStartupHint')),
      error !== null && h('div', { className: 'sk-tag danger', style: { alignSelf: 'flex-start', whiteSpace: 'pre-wrap' } }, error),
      h('div', { className: 'sk-dlg-foot' },
        h(ButtonLite, { onClick: onClose }, t('mcpCancel')),
        h(ButtonLite, { primary: true, disabled: busy, onClick: submit }, t('mcpSave')))))
}

/** MCP server 一行：服务名 + 传输摘要 + 操作按钮。 */
function McpServerCard({ t, row, onEdit, onToggle, onDelete, busy }) {
  const isStdio = row.transport === 'stdio'
  const envCount = Object.keys(row.env || {}).length
  const headerCount = Object.keys(row.headers || {}).length
  const summary = isStdio
    ? [row.command, ...(row.args || [])].join(' ')
    : row.url
  return h('div', { className: 'sk-card', style: { cursor: 'default' } },
    h('div', { className: 'sk-head' },
      h(Avatar, { name: row.serverName || row.id, square: true, size: 40 }),
      h('span', { className: 'sk-title' }, row.serverName || row.id),
      h(Tag, { tone: 'accent' }, row.transport),
      row.enabled === false && h(Tag, { tone: 'danger' }, t('mcpDisabledTag')),
      row.editable === false && h(Tag, null, t('mcpReadOnlyTag')),
      row.hasForeignJs === true && h(Tag, { tone: 'danger' }, t('mcpForeignJsTag'))),
    h('div', { className: 'sk-desc', style: { wordBreak: 'break-all' } }, summary),
    h('div', { className: 'sk-stats' },
      [
        isStdio && (row.args || []).length > 0 ? t('mcpArgsCount', { n: row.args.length }) : null,
        isStdio && envCount > 0 ? t('mcpEnvCount', { n: envCount }) : null,
        !isStdio && headerCount > 0 ? t('mcpEnvCount', { n: headerCount }) : null,
        isStdio && row.cwd ? row.cwd : null,
        typeof row.toolCallTimeoutMs === 'number' ? `${row.toolCallTimeoutMs} ms` : null,
        row.failOnStartupError === true ? t('mcpFailOnStartup') : null,
        row.reconnect && row.reconnect.enabled === false ? t('mcpReconnectEnabled') + ': off' : null,
      ].filter(Boolean).join(' · ')),
    row.editable === false && h('div', { style: fieldHintStyle() }, row.hasForeignJs ? t('mcpForeignJsHint') : t('mcpReadOnlyHint')),
    h('div', { className: 'sk-foot' },
      h('div', { className: 'sk-chips' },
        h('span', { className: 'sk-dir' }, row.id)),
      h('div', { className: 'sk-rowbtns' },
        row.editable !== false && h(ButtonLite, { small: true, disabled: busy,
          onClick: () => onToggle(row) }, row.enabled === false ? t('mcpEnable') : t('mcpDisable')),
        row.editable !== false && h(ButtonLite, { small: true, disabled: busy,
          onClick: () => onEdit(row) }, t('mcpEdit')),
        row.editable !== false && h(ButtonLite, { danger: true, small: true, disabled: busy,
          onClick: () => onDelete(row) }, t('mcpDelete')))))
}

/**
 * MCP 管理面板：一个 profile 的 dsh-mcp-client 条目。
 * 只有用户主动操作才发请求（打开页签 / 切换 profile / 增删改），没有轮询。
 */
function McpPane({ t, onToast }) {
  const [data, setData] = useState(null)
  const [profile, setProfile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(null)      // { row } | { row: null }
  const [pendingDelete, setPendingDelete] = useState(null)

  const load = (name) => {
    const query = name ? `?profile=${encodeURIComponent(name)}` : ''
    setData(null)
    getJson(API + '/mcp' + query)
      .then((payload) => { setData(payload); setProfile(payload.profile) })
      .catch((e) => {
        // 拿不到 profile（或请求失败）时也要把状态收尾，否则页面永远停在 loading
        setData({ servers: [], profiles: [], canWrite: false, error: String(e && e.message || e) })
      })
  }
  useEffect(() => { load(null) }, [])

  const act = async (request) => {
    setBusy(true)
    try {
      const response = await fetch(`${API}/mcp?profile=${encodeURIComponent(profile)}`, request)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'HTTP ' + response.status)
      if (Array.isArray(payload.servers)) { setData(payload); setProfile(payload.profile) }
      return payload
    } catch (e) {
      onToast(t('operationFailed') + ': ' + e.message)
      return null
    } finally { setBusy(false) }
  }

  if (data === null) return h(Spinner, { label: t('mcpLoading') })

  // 读取失败（例如无法判定 profile）：给确定性说明，不留白屏/无限转圈
  if (data.error !== undefined) {
    return [
      h(Empty, null, `${t('operationFailed')}: ${data.error}`),
      h('div', { className: 'sk-hint' }, t('mcpNoProfile')),
      (data.profiles || []).length > 0 && h('div', { className: 'sk-toolbar' },
        h('span', { className: 'sk-dir' }, t('mcpProfile')),
        (data.profiles || []).map((p) => h(ButtonLite, {
          key: p.name || p, onClick: () => load(p.name || p),
        }, p.name || p))),
      h('div', { className: 'sk-toolbar' }, h(ButtonLite, { onClick: () => load(null) }, t('refresh'))),
    ]
  }

  const servers = data.servers || []
  const writable = data.canWrite !== false
  const selectProfile = (name) => {
    if (name === profile) return
    setData(null)
    load(name)
  }
  const doToggle = async (row) => {
    const payload = await act({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: row.id, serverName: row.serverName, transport: row.transport,
        command: row.command, args: row.args, env: row.env, cwd: row.cwd,
        url: row.url, headers: row.headers,
        toolCallTimeoutMs: row.toolCallTimeoutMs, failOnStartupError: row.failOnStartupError,
        reconnect: row.reconnect, enabled: row.enabled === false,
      }),
    })
    if (payload !== null) onToast(t('mcpSaved'))
  }
  const doDelete = async () => {
    const row = pendingDelete
    setPendingDelete(null)
    const payload = await act({
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [row.id] }),
    })
    if (payload !== null) onToast(t('mcpDeleted'))
  }

  return [
    h('div', { className: 'sk-toolbar' },
      h('span', { className: 'sk-hint' }, t('mcpHint')),
      h('span', { className: 'spacer' }),
      h('span', { className: 'sk-dir' }, t('mcpProfile')),
      (data.profiles || []).length > 0
        ? h('select', { className: 'sk-input', value: profile || '', onChange: (e) => selectProfile(e.target.value), style: selectStyle() },
            (data.profiles || []).map((p) => h('option', { key: p.name, value: p.name },
              p.name + (p.name === data.activeProfile ? ' *' : ''))))
        : h('span', { className: 'sk-hint' }, profile || '-'),
      h(ButtonLite, { onClick: () => load(profile), disabled: busy }, t('refresh')),
      h(ButtonLite, { primary: true, disabled: busy || !writable, onClick: () => setDialog({ row: null }) }, t('mcpAdd'))),
    h('div', { className: 'sk-hint' },
      `${t('mcpPatchFile')}: ${data.patchFile} · ${t('mcpPatchReload')}: ${data.patchReload === 'startup' ? t('mcpReloadStartup') : t('mcpReloadLive')}`),
    ...(data.warnings || []).map((warning) => h('div', { key: warning, className: 'sk-tag danger', style: { alignSelf: 'flex-start' } }, warning)),
    servers.length === 0
      ? h(Empty, null, t('mcpEmpty'))
      : h('div', { className: 'sk-src' }, servers.map((row) =>
          h(McpServerCard, { key: row.id, t, row, busy, onEdit: (r) => setDialog({ row: r }), onToggle: doToggle, onDelete: setPendingDelete }))),
    dialog !== null && h(McpServerDialog, {
      t, profile, row: dialog.row, onClose: () => setDialog(null),
      onSaved: (payload) => {
        setDialog(null)
        setData(payload)
        setProfile(payload.profile)
        onToast(t('mcpCreated'))
      },
    }),
    pendingDelete !== null && h(SkDialog, {
      title: t('mcpDeleteTitle'),
      onClose: () => setPendingDelete(null),
      footer: [
        h(ButtonLite, { onClick: () => setPendingDelete(null) }, t('mcpCancel')),
        h(ButtonLite, { primary: true, danger: true, onClick: doDelete }, t('mcpDelete')),
      ],
    }, h('div', { className: 'sk-hint' }, t('mcpDeleteConfirm', { name: pendingDelete.serverName || pendingDelete.id }))),
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

const CLIENT_NAME = '@weibaohui/skills-management'

module.exports = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: { NS, ZH, EN, matchSkill, formatSize, formatTime, usageText, sortSkills, openTriggerSource, insertComposerText, fetchSkillCandidates, mapToText, textToMap, textToArgs, mcpRowToForm, emptyMcpForm },
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
    // Composer services (inputTriggers + sessions) for the ＋ 技能 button;
    // absence hides the button only.
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['inputTriggers', 'sessions'], (scope) => { composerScope = scope })
      }
    } catch {}
    // connection service for the picker skill catalog (host skill registry,
    // ui-skill 同源); absence keeps the button hidden.
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['connection'], (scope) => { connectionApi = scope && scope.connection })
      }
    } catch {}
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
    ctx.effect(() => {
      try {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: CLIENT_NAME,
        order: 60,
        locale: NS,
        label: () => t('pickSkill'),
        inject: () => ({ t }),
      }, function SkillButtonSlot(apiProps) {
        return h(ComposerButtonSlot, {
          __t: t, label: t('pickSkill'), title: t('pickSkillTitle'),
          source: 'skill', sessionId: apiProps && apiProps.sessionId, input: apiProps && apiProps.input,
        })
      }))
      } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('input.left:' + (e && e.message)); throw e }
    }, 'skills-management: input left button')
  },
}

/** Composer tool-row button: 加号+文字 chip，点击在按钮上方打开自带搜索的
 *  技能 picker 浮层（候选 = 宿主技能注册表，ui-skill 同源）；pick 经
 *  slash/input-insert-text 写入 `/<name> `。浮层背板盖住按钮以外的区域，
 *  再点一次按钮会先落在背板上——天然形成开关切换。
 *  connection 缺席（picker 无目录来源）时回退旧的 toggleSource 宿主菜单；
 *  inputTriggers/sessions 缺席时按钮隐藏（与旧行为一致）。 */
function ComposerButtonSlot(props) {
  useEffect(ensureStyles, [])
  const [picker, setPicker] = useState(null) // {left, top} 锚点快照；null = 关闭
  const [rows, setRows] = useState(null)     // null = 加载中
  const btnRef = useRef(null)
  const liveInput = useRef(props.input)
  liveInput.current = props.input
  const ready = !!(composerScope && composerScope.inputTriggers && composerScope.sessions && props.sessionId)
  if (!ready) return null
  const close = () => setPicker(null)
  const open = () => {
    // 目录来源缺席 → 退回宿主斜杠菜单（无搜索，但按钮不消失）
    if (!connectionApi) { openTriggerSource(composerScope, props.sessionId, liveInput.current, props.source); return }
    let anchor = { left: 16, top: 160 }
    try { if (btnRef.current) anchor = btnRef.current.getBoundingClientRect() } catch {}
    setPicker({ left: anchor.left, top: anchor.top })
    setRows(null)
    fetchSkillCandidates(connectionApi, composerScope.sessions, props.sessionId)
      .then((list) => setRows(Array.isArray(list) ? list : []))
      .catch(() => setRows([]))
  }
  const pick = (row) => {
    insertComposerText(composerScope, props.sessionId, liveInput.current, `/${row.name} `)
    close()
    refocusComposer()
  }
  const popover = picker !== null && RDP && typeof RDP.createPortal === 'function'
    ? RDP.createPortal(h(SkillPicker, { t: props.__t, anchor: picker, rows, onClose: close, onPick: pick }), document.body)
    : null
  return h('button', {
    className: 'sk-chip',
    ref: btnRef,
    title: props.title || props.label,
    'aria-haspopup': 'dialog',
    'aria-expanded': picker !== null,
    onClick: open,
  }, props.label, popover)
}
