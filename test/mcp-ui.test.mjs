// Render contract for the MCP surfaces.
//
// The settings page has no DOM under `node --test`, and a broken render there is
// invisible until a user opens the page and sees nothing — which is exactly how
// the markdown-labels bug reached production. So the components are rendered
// here against the client module's own plain-Node fallbacks (its React shim and
// the absence of the host primitives), from fixture snapshots shaped like what
// `GET /skills-management/api/mcp` really returns.
//
// What this catches: a reference error, a missing import, a helper that returns
// undefined, a locale key that does not exist, and a card that silently drops
// the related config file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Module = require('node:module')

/**
 * Stand-in for `@deepseek-ai/dsh-client-ui-primitives`: the real package only
 * resolves inside the dsh client loader, so the test supplies components that
 * produce the same element shape the client's own fallback createElement does.
 * Without it any `P.Button` reference would throw before anything renders.
 */
const shimPath = join(mkdtempSync(join(tmpdir(), 'dsh-mcp-ui-')), 'primitives.cjs')
writeFileSync(shimPath, [
  "'use strict'",
  'function make(tag) {',
  '  return function Prim(props) {',
  '    const children = props && props.children',
  '    return { type: tag, props: {}, kids: children === undefined ? [] : [children] }',
  '  }',
  '}',
  "module.exports = { Button: make('button'), Input: make('input'), MarkdownText: make('div'), IconChevronDownOutline14: make('svg') }",
  '',
].join('\n'))

// Force the client's own React fallback, while the primitives resolve to the
// shim above: that is the plain-Node surface these components must survive.
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'react') throw new Error('not available under node: react')
  if (request === '@deepseek-ai/dsh-client-ui-primitives') return shimPath
  return originalResolve.call(this, request, ...rest)
}
let client
try {
  client = require('../client/index.js')
} finally {
  Module._resolveFilename = originalResolve
}

const { EN, ZH, McpView, McpPane, McpServerCard, McpEditorDialog, McpFilesDialog, McpHelpDialog, SkillsHelpDialog, CardsView, ExecutorList } = client.__internals

/** The host's own `t()` shape: EN copy with `{name}` interpolation. */
const t = (key, vars) => {
  let out = EN[key] ?? key
  if (vars) for (const [name, value] of Object.entries(vars)) out = out.split('{' + name + '}').join(String(value))
  return out
}

/**
 * Minimal renderer: calls function components, passes `children` the way React
 * would (the shim keeps kids beside props), and collects the text a user would
 * read. Hooks work because the shim's implementations are plain functions.
 */
function render(node, text = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return text
  if (Array.isArray(node)) {
    for (const item of node) render(item, text)
    return text
  }
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node))
    return text
  }
  const { type, props, kids } = node
  const children = props !== undefined && props !== null && Object.hasOwn(props, 'children')
    ? props.children
    : (kids === undefined || kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids)
  if (typeof type === 'function') {
    render(type({ ...(props || {}), children }), text)
    return text
  }
  render(children, text)
  return text
}

const rendered = (element) => render(element).join(' ')

/**
 * Same walk, but keeping the elements so props can be inspected — the card's
 * "click me" is an `onClick`, which no amount of text would reveal.
 */
function nodes(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const item of node) nodes(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  const { type, props, kids } = node
  const children = props !== undefined && props !== null && Object.hasOwn(props, 'children')
    ? props.children
    : (kids === undefined || kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids)
  const withChildren = { ...(props || {}), children }
  out.push({ type, props: withChildren })
  if (typeof type === 'function') nodes(type(withChildren), out)
  else nodes(children, out)
  return out
}

const cardOf = (element) => nodes(element).find((node) => node.type === 'div' && /sk-card/.test(String(node.props.className || '')))

const sshRow = {
  serverName: 'ssh-mcp-server',
  source: 'local',
  entryId: 'sm-mcp-ssh-mcp-server',
  transport: 'stdio',
  enabled: true,
  enabledInFile: false,
  enabledForced: true,
  switchable: true,
  live: true,
  editable: true,
  restartable: true,
  alsoDeclared: false,
  toolCount: 4,
  command: 'npx',
  args: ['-y', '@fangjunjie/ssh-mcp-server', '--config-file', 'C:\\Users\\a\\.dsh\\skills-management\\ssh-config.json'],
  env: {},
  toolCallTimeoutMs: 30000,
  relatedFiles: [{
    path: 'C:\\Users\\a\\.dsh\\skills-management\\ssh-config.json',
    display: '~/.dsh/skills-management/ssh-config.json',
    origin: 'detected',
    exists: true,
    size: 894,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    editable: true,
  }],
}

const composedRow = {
  serverName: 'github',
  source: 'configured',
  entryId: 'mcp-github',
  transport: 'stdio',
  enabled: true,
  switchable: false,
  live: true,
  editable: false,
  restartable: false,
  toolCount: 2,
  command: 'npx',
  args: [],
  env: {},
  relatedFiles: [],
}

const snapshot = {
  servers: [composedRow, sshRow],
  stateFile: '~/.dsh/skills-management/mcp.json',
  localFile: '~/.dsh/skills-management/mcp.local.jsonc',
  localStatus: 'ok',
  localInvalid: [],
  stateStatus: 'ok',
  loaderAvailable: true,
  mountAvailable: true,
}

const noop = () => {}

const sshFileRow = {
  ...sshRow,
  // what the real snapshot carries for an entry whose args name a tool script:
  // `python.exe` is a file, but not a config, so it is not shown
  relatedFiles: [
    ...sshRow.relatedFiles,
    {
      path: 'C:\\tools\\python.exe',
      display: 'C:\\tools\\python.exe',
      origin: 'detected',
      exists: true,
      size: 100,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      editable: false,
      shown: false,
    },
  ],
}

test('McpView renders the toolbar, every row, and each row’s related file', () => {
  const text = rendered(McpView({
    t, data: { ...snapshot, servers: [composedRow, sshFileRow] }, busy: false,
    onRefresh: noop, onReloadAll: noop, onToggle: noop, onReload: noop,
    onEdit: noop, onOpenFile: noop, onNewServer: noop, onOpenFiles: noop, onHelp: noop,
  }))
  for (const needle of [EN.mcpNewServer, 'Config files', 'Reload all', EN.help, 'ssh-mcp-server', 'github', 'connected']) {
    assert.ok(text.includes(needle), `expected the pane to render ${JSON.stringify(needle)}`)
  }
  assert.ok(text.includes('ssh-config.json'), 'the related config file is visible on the row')
  assert.ok(!text.includes('python.exe'), 'a detected executable is not shown as a config file')
  assert.ok(text.includes('4 tools'), 'the tool count comes from the snapshot')
  // the hint copy lives behind the「? Help」button now: nothing of it outside
  assert.ok(!text.includes(EN.mcpLocalFile), 'the hand-written path is no longer printed on the page')
  assert.ok(!text.includes(EN.mcpLocalHint), 'the hint paragraph is no longer printed on the page')
  for (const key of ['mcpEditConfig', 'mcpReloadAll', 'mcpLocalHint', 'mcpToolsCount']) {
    assert.ok(!text.includes(key), `the raw locale key ${key} must not reach the page`)
  }
})

test('the help dialog carries the paths and every explanation', () => {
  const text = rendered(McpHelpDialog({ t, snapshot, onClose: noop }))
  for (const needle of [
    EN.mcpHelpTitle, EN.mcpLocalFile, EN.mcpStateFile, EN.mcpLocalHint,
    EN.mcpLocalRowHint, EN.mcpConfiguredHint, EN.mcpForeignHint,
    EN.mcpLocalParkedHint, EN.mcpLocalForcedHint, EN.mcpShadowedHint,
    EN.mcpEditHint, EN.mcpReloadHint,
  ]) {
    assert.ok(text.includes(needle), `expected the help dialog to show ${JSON.stringify(needle.slice(0, 40))}`)
  }
  assert.ok(text.includes('mcp.local.jsonc') && text.includes('mcp.json'), 'both file paths are there')
})

test('McpView shows the loader-missing notice instead of promising a mount', () => {
  const text = rendered(McpView({
    t, data: { ...snapshot, loaderAvailable: false, mountAvailable: false, servers: [] }, busy: false,
    onRefresh: noop, onReloadAll: noop, onToggle: noop, onReload: noop,
    onEdit: noop, onOpenFile: noop, onNewServer: noop, onOpenFiles: noop, onHelp: noop,
  }))
  assert.ok(text.includes(EN.mcpUnavailableTag))
  assert.ok(text.includes(EN.mcpEmpty))
})

test('clicking a hand-written card opens its editor — no separate edit button', () => {
  const card = cardOf(McpServerCard({
    t, row: sshRow, busy: false, onToggle: noop, onReload: noop, onEdit: noop, onOpenFile: noop,
  }))
  assert.equal(typeof card.props.onClick, 'function', 'the card itself opens the config')
  assert.equal(card.props.role, 'button')
  const text = rendered(McpServerCard({
    t, row: sshRow, busy: false, onToggle: noop, onReload: noop, onEdit: noop, onOpenFile: noop,
  }))
  assert.ok(text.includes(EN.mcpReload), 'reload stays on the row')
  assert.ok(!text.includes(EN.mcpEdit), 'the extra edit button is gone: the card itself is the entry point')
  assert.ok(text.includes('ssh-config.json'))
})

test('a composed row is not clickable and offers no reload', () => {
  const card = cardOf(McpServerCard({
    t, row: composedRow, busy: false, onToggle: noop, onReload: noop, onEdit: noop, onOpenFile: noop,
  }))
  assert.equal(card.props.onClick, undefined, 'a composed row cannot be edited here')
  assert.equal(card.props.role, undefined)
  const text = rendered(McpServerCard({
    t, row: composedRow, busy: false, onToggle: noop, onReload: noop, onEdit: noop, onOpenFile: noop,
  }))
  assert.ok(text.includes('dsh composition'))
  assert.ok(!text.includes(EN.mcpReload), 'and it cannot be restarted here either')
})

test('the editor opens on the clicked server, and「new server」opens a blank row', () => {
  const opened = rendered(McpEditorDialog({
    t, snapshot, initialName: 'ssh-mcp-server', onClose: noop, onToast: noop, onSaved: noop, onOpenFile: noop,
  }))
  assert.ok(opened.includes('ssh-mcp-server'), 'the clicked server is selected')
  assert.ok(opened.includes(EN.mcpFormCommand), 'its form is rendered')

  const fresh = rendered(McpEditorDialog({
    t, snapshot, initialNew: true, onClose: noop, onToast: noop, onSaved: noop, onOpenFile: noop,
  }))
  assert.ok(fresh.includes(EN.mcpUnnamed), 'a blank row is selected and listed')
  assert.ok(fresh.includes(EN.mcpFormName))
})

test('the editor dialog renders a form for the selected hand-written server', () => {
  const text = rendered(McpEditorDialog({
    t, snapshot, initialName: 'ssh-mcp-server', onClose: noop, onToast: noop, onSaved: noop, onOpenFile: noop,
  }))
  for (const needle of [
    EN.mcpEditConfig, EN.mcpFormName, EN.mcpFormTransport, EN.mcpFormCommand, EN.mcpFormArgs,
    EN.mcpFormEnv, EN.mcpFormTimeout, EN.mcpFormRelated, EN.mcpFormRelatedDetected, EN.mcpNewServer, EN.save,
  ]) {
    assert.ok(text.includes(needle), `expected the editor to render ${JSON.stringify(needle)}`)
  }
  assert.ok(text.includes('ssh-mcp-server'), 'the left list shows the server names')
  assert.ok(!text.includes('github'), 'a composed server is not part of the hand-written file')
})

test('the editor dialog refuses to save when the file has entries it cannot read', () => {
  const text = rendered(McpEditorDialog({
    t,
    snapshot: { ...snapshot, localInvalid: [{ serverName: 'bad name', reason: 'serverName must match' }] },
    onClose: noop, onToast: noop, onSaved: noop, onOpenFile: noop,
  }))
  assert.ok(text.includes(EN.mcpEditInvalid.replace('{n}', '1')), 'the reason is stated')
})

test('the config-file dialog renders its picker and editor frame', () => {
  const text = rendered(McpFilesDialog({ t, initialPath: null, onClose: noop, onToast: noop, onSnapshot: noop }))
  assert.ok(text.includes(EN.mcpConfigFiles))
  assert.ok(text.includes(EN.mcpFilePanelHint))
  assert.ok(text.includes(EN.mcpFileSave))
  assert.ok(text.includes(EN.mcpFileReload))
})

test('the skills page keeps its explanations behind the same help button', () => {
  const page = rendered(CardsView({
    t,
    executors: [{ key: 'dsh', label: 'DSH', dir: '~/.dsh/skills', dirExists: true, skillCount: 3, readOnly: false, source: 'builtin', locked: true }],
    onEnter: noop, onBrowseAll: noop, onOpenSettings: noop, onHelp: noop,
  }))
  assert.ok(page.includes(`? ${EN.help}`), 'the toolbar carries the help button')
  assert.ok(!page.includes(EN.cardsHint), 'the hint paragraph is no longer printed above the cards')
  const help = rendered(SkillsHelpDialog({ t, onClose: noop }))
  for (const needle of [EN.skillsHelpTitle, EN.cardsHint, EN.executorSettingsHint, EN.invocationHint]) {
    assert.ok(help.includes(needle), `expected the skills help to show ${JSON.stringify(needle.slice(0, 40))}`)
  }
})

test('the missing sources are folded on the skill page', () => {
  const text = rendered(CardsView({
    t,
    executors: [
      { key: 'dsh', label: 'DSH', dir: '~/.dsh/skills', dirExists: true, skillCount: 3 },
      { key: 'zcode', label: 'ZCode', dir: '~/.zcode/skills', dirExists: false, skillCount: 0 },
    ],
    onEnter: noop, onBrowseAll: noop, onOpenSettings: noop, onHelp: noop,
  }))
  assert.ok(text.includes(EN.notFoundGroup.replace('{n}', '1')), 'the fold label counts them')
  assert.ok(!text.includes('ZCode'), 'and the missing sources stay folded until asked for')
  assert.ok(text.includes('DSH'), 'the sources that do exist are still cards')
})

test('an executor row is one compact line: the path is text until asked for', () => {
  const rows = [
    { __id: 'r1', key: 'codex', label: 'Codex', dir: '~/.codex/skills', defaultDir: '~/.codex/skills',
      source: 'builtin', locked: false, managedByConfig: false, disabled: false, overridden: false },
    { __id: 'r2', key: 'my-cli', label: 'My CLI', dir: '~/.my-cli/skills',
      source: 'custom', locked: false, managedByConfig: false, disabled: false, overridden: false, editing: true },
  ]
  const element = ExecutorList({ t, rows, onPatch: noop, onRemove: noop })
  const text = rendered(element)
  assert.ok(text.includes('~/.codex/skills'), 'the default path is plain text')
  assert.ok(text.includes(EN.execEditDir), 'a collapsed row offers「Change」')
  assert.ok(text.includes(EN.execDone), 'the row being edited offers「Done」')

  // only the row under edit mounts a directory input — that is what used to
  // make the dialog 17 two-line boxes tall
  const values = nodes(element).filter((node) => node.type === 'input').map((node) => node.props.value)
  assert.ok(!values.includes('~/.codex/skills'), 'a collapsed row mounts no text input for its path')
  assert.ok(values.includes('~/.my-cli/skills'), 'the editing row does')
  assert.ok(String(text).includes(EN.execEnabledLabel), 'the enable checkbox label is on the row')
})

test('the pane itself renders its loading state without throwing', () => {
  // useEffect is a no-op under the fallback shim, so the pane stays on its
  // first render — the state that used to blank the whole settings section.
  const text = rendered(McpPane({ t, onToast: noop }))
  assert.ok(text.includes(EN.mcpLoading))
})

test('every MCP locale key the pane reaches for exists in both dictionaries', () => {
  const keys = new Set()
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    const { type, props, kids } = node
    const children = props && Object.hasOwn(props, 'children') ? props.children : kids
    if (typeof type === 'function') collect(type({ ...(props || {}), children }))
    else collect(children)
  }
  // a spy `t` records every key the tree asks for
  const spy = (key, vars) => {
    keys.add(key)
    return t(key, vars)
  }
  collect(McpView({
    t: spy, data: snapshot, busy: false,
    onRefresh: noop, onReloadAll: noop, onToggle: noop, onReload: noop,
    onEdit: noop, onOpenFile: noop, onNewServer: noop, onOpenFiles: noop, onHelp: noop,
  }))
  collect(McpEditorDialog({ t: spy, snapshot, onClose: noop, onToast: noop, onSaved: noop, onOpenFile: noop }))
  collect(McpFilesDialog({ t: spy, initialPath: null, onClose: noop, onToast: noop, onSnapshot: noop }))
  collect(McpHelpDialog({ t: spy, snapshot, onClose: noop }))
  assert.ok(keys.size > 10, `expected the surfaces to use their copy, saw ${keys.size} keys`)
  for (const key of keys) {
    assert.equal(typeof ZH[key], 'string', `t('${key}') has no zh copy`)
    assert.equal(typeof EN[key], 'string', `t('${key}') has no en copy`)
  }
})
