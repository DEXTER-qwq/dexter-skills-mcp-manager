// Client-plane contract tests for the React/primitives rewrite.
// The primitives package only resolves inside the dsh module loader, so the
// client source is loaded under plain Node with that require shimmed away —
// which is also the assertion surface: interactions must degrade gracefully
// without primitives present (jsdom shim), and never depend on its internals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../client/index.js')
const { NS, ZH, EN, matchSkill, formatSize, markdownLabels } = plugin.__internals

test('client module declares slots + locale injects', () => {
  assert.equal(plugin.name, 'dexter-skills-mcp-manager') // must equal the boot manifest id
  assert.deepEqual(plugin.inject.sort(), ['locale', 'slots'])
})

test('locale dictionaries are zh/en with identical key sets', () => {
  const zhKeys = Object.keys(ZH).sort()
  const enKeys = Object.keys(EN).sort()
  assert.deepEqual(enKeys, zhKeys)
  for (const key of zhKeys) {
    assert.equal(typeof ZH[key], 'string', `zh.${key}`)
    assert.equal(typeof EN[key], 'string', `en.${key}`)
  }
})

test('no hardcoded colors in the client source — ui-theme tokens only', () => {
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  // gradient() legitimately uses hsl(); inverted-label fallback may pin #fff
  const hex = (src.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
    .filter(h => !src.includes('label-primary-inverted,#fff') && !src.includes('label-primary-inverted, #fff'))
  assert.deepEqual(hex, [], 'hex colors are banned; use var(--dsw-alias-*)')
  assert.ok(src.includes('var(--dsw-alias-label-primary)'), 'label token consumed')
  assert.ok(src.includes('var(--dsw-alias-bg-layer-1'), 'surface token consumed')
})

test('the remote surfaces stay deleted — no market/share client code or copy', () => {
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  for (const banned of ['PluginKit', 'SHARE_PROMPT_ZH', 'api/market/', 'api/share/', 'gitcode.com', 'api.gitcode', 'ActionShareDialog']) {
    assert.ok(!src.includes(banned), `client source must not reference ${banned}`)
  }
  // 注意：/share/i 也不能裸用（会误伤 shareable 之类的正常词），所以这里列的是具体的键名片段
  const bannedKeys = Object.keys(ZH).filter(k => /(market|share|sync|repo|branch|prompt|secret)/i.test(k))
  assert.deepEqual(bannedKeys, [], 'market/share locale keys must not come back')
})

test('every text file in the repo is valid UTF-8', () => {
  // Editing a UTF-8 file with a tool that assumes the console code page silently
  // doubles-encodes every non-ASCII character; this caught exactly that, so the
  // guard stays. Directories that are never source: .git, node_modules, backups.
  const root = new URL('..', import.meta.url)
  const skip = new Set(['.git', 'node_modules'])
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const bad = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
      if (entry.isDirectory()) { walk(path); continue }
      if (!/\.(mjs|js|cjs|json|jsonc|md|html|ya?ml)$/.test(entry.name)) continue
      try { decoder.decode(readFileSync(path)) } catch { bad.push(entry.name) }
    }
  }
  walk(root)
  assert.deepEqual(bad, [], `not valid UTF-8: ${bad.join(', ')}`)
})

test('client/bundle.js is a fresh build of client/index.js', () => {
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../client/bundle.js', import.meta.url), 'utf8')
  // build-client.mjs wraps the source verbatim under a uniform 4-space indent
  const wrapped = src.split('\n').map(line => (line.length === 0 ? line : '    ' + line)).join('\n')
  assert.ok(bundle.includes(wrapped), 'client/bundle.js is stale — run `npm run build:client`')
})

test('matchSkill covers name/description/keywords case-insensitively', () => {
  const skill = { name: 'Lark-Base', description: '多维表格', keywords: ['Feishu'] }
  assert.ok(matchSkill(skill, 'lark'))
  assert.ok(matchSkill(skill, '表格'))
  assert.ok(matchSkill(skill, 'feishu'))
  assert.equal(matchSkill(skill, 'codex'), false)
})

// ── MarkdownText labels contract ────────────────────────────────────────
//
// Regression guard for the white-screen bug: the host's MarkdownText reads
// `context.labels.code.copyLabel` (and `labels.footnotes`) with no default, so
// rendering any skill whose SKILL.md has one non-empty fenced code block threw
// inside the primitive, escaped every try/catch of ours, and got the settings
// slot entry abdicated (blank page, unrecoverable until restart).

test('markdownLabels carries every field the host renderer dereferences', () => {
  const labels = markdownLabels((key) => `T:${key}`)
  // renderCode(): context.labels.code.copyLabel / .copiedLabel / .toolbarLabels
  assert.equal(labels.code.copyLabel, 'T:codeCopy')
  assert.equal(labels.code.copiedLabel, 'T:codeCopied')
  // CodeToolbar (labels.toolbarLabels): codeLabel / wrapLabel / unwrapLabel
  assert.equal(labels.code.toolbarLabels.codeLabel, 'T:codeLabel')
  assert.equal(labels.code.toolbarLabels.wrapLabel, 'T:codeWrap')
  assert.equal(labels.code.toolbarLabels.unwrapLabel, 'T:codeUnwrap')
  // renderFootnoteSection(): context.labels.footnotes
  assert.equal(labels.footnotes, 'T:footnotes')
})

test('every MarkdownText call site passes labels', () => {
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const calls = [...src.matchAll(/h\(\s*MarkdownText\s*,\s*\{([\s\S]{0,200}?)\}\s*\)/g)]
  assert.ok(calls.length >= 2, `expected the detail preview to render markdown, saw ${calls.length} call sites`)
  for (const [, props] of calls) {
    assert.match(props, /\blabels\s*:/, `MarkdownText call without labels: {${props.trim()}}`)
  }
  // and the host primitive is resolved through the null-able constant, never
  // through prim() (whose shim is always truthy and would defeat the <pre> arm)
  assert.ok(!src.includes("prim('MarkdownText')"), 'prim() must not gate the markdown preview')
})

// ── MCP pane copy ───────────────────────────────────────────────────────

test('the MCP pane keeps no copy for the features that were removed', () => {
  // The pane edits the hand-written file and its related config files; the
  // remote-era surfaces (import from the loader, prune, the old server dialog)
  // are still gone, so no copy may survive to promise them.
  const removed = [
    'mcpImport', 'mcpImportTitle', 'mcpImportHint', 'mcpImportNone', 'mcpImportDo',
    'mcpImportDone', 'mcpImportSkipped', 'mcpImportOnlyTaken', 'mcpImportReasonNotInstalled',
    'mcpImportReasonAlreadyManaged', 'mcpImportReasonNameTaken', 'mcpImportReasonInvalid',
    'mcpPrune', 'mcpPruneDone', 'mcpDuplicateNotice', 'mcpStateRepaired', 'mcpSourceUser',
    'mcpAdd', 'mcpAddTitle', 'mcpAddHint', 'mcpEditTitle', 'mcpDeleteTitle', 'mcpDeleteConfirm',
    'mcpDeleted', 'mcpCreated', 'mcpCancel', 'mcpSave', 'mcpServerName', 'mcpServerNameHint',
    'mcpTransport', 'mcpStdio', 'mcpHttp', 'mcpCommand', 'mcpCommandHint', 'mcpArgs', 'mcpArgsHint',
    'mcpEnv', 'mcpEnvHint', 'mcpHeaders', 'mcpCwd', 'mcpUrl', 'mcpTimeout', 'mcpTimeoutHint',
  ]
  const stale = removed.filter((key) => ZH[key] !== undefined || EN[key] !== undefined)
  assert.deepEqual(stale, [], `stale MCP locale keys: ${stale.join(', ')}`)
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  for (const bannedRef of ['mcp/import', 'mcp/prune', 'McpServerDialog', 'McpImportDialog']) {
    assert.ok(!src.includes(bannedRef), `client source must not reference ${bannedRef}`)
  }
  // …and the editing surface it was replaced with is present in both locales
  for (const key of ['mcpEditConfig', 'mcpConfigFiles', 'mcpReload', 'mcpNewServer', 'mcpFormName', 'mcpFormRelated']) {
    assert.equal(typeof ZH[key], 'string', `zh.${key}`)
    assert.equal(typeof EN[key], 'string', `en.${key}`)
  }
})

test('every locale key is actually consumed by the client source', () => {
  // Two keys are read through a computed name (the skills page tab labels are
  // `t('tab' + Capitalised(view))`), so they cannot be found by matching t('…').
  const DYNAMIC = new Set(['tabExecutors', 'tabMcp'])
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const referenced = new Set([...src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
  const orphans = Object.keys(ZH).filter((key) => !referenced.has(key) && !DYNAMIC.has(key))
  assert.deepEqual(orphans, [], `unused locale keys: ${orphans.join(', ')}`)
})

test('every t() key the client asks for actually exists in both dictionaries', () => {
  // The counterpart of the check above: a missing entry does not throw, it
  // renders the raw key ("browseAll (24)" in a screenshot, which is how this
  // was found), so the dictionaries are checked in this direction too.
  const DYNAMIC = new Set(['tabExecutors', 'tabMcp'])
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const referenced = new Set([...src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
  const missingZh = [...referenced].filter((key) => !DYNAMIC.has(key) && ZH[key] === undefined)
  const missingEn = [...referenced].filter((key) => !DYNAMIC.has(key) && EN[key] === undefined)
  assert.deepEqual(missingZh, [], `t() keys with no zh copy: ${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `t() keys with no en copy: ${missingEn.join(', ')}`)
  // and the placeholders a key promises must be the ones the caller passes
  for (const key of ['showMore']) {
    assert.match(ZH[key], /\{n\}/, `${key} must accept {n}`)
    assert.match(EN[key], /\{n\}/, `${key} must accept {n}`)
  }
})

test('the MCP pane ships its own copy in both locales', () => {
  const mcpKeys = Object.keys(ZH).filter((key) => key.startsWith('mcp'))
  assert.ok(mcpKeys.length >= 25, `expected a full MCP copy set, saw ${mcpKeys.length}`)
  for (const key of mcpKeys) {
    assert.equal(typeof ZH[key], 'string', `zh.${key}`)
    assert.equal(typeof EN[key], 'string', `en.${key}`)
    assert.ok(ZH[key].trim() !== '' && EN[key].trim() !== '', `${key} must not be empty`)
  }
  assert.equal(ZH.tabMcp, 'MCP 管理')
  assert.equal(ZH.mcpTitle, 'MCP 管理')
})

test('the MCP copy no longer sends the user to a config file', () => {
  // The pane stopped editing cordis.patch.yml, so no MCP copy may name that
  // file or talk about a profile. ("bundle / patch / preset" is fine — those
  // are composition layers, and the pane legitimately tells the user where a
  // row came from.)
  const stale = Object.keys(ZH).filter((key) => key.startsWith('mcp'))
    .filter((key) => /profile/i.test(key)
      || /cordis|\.yml|\.yaml/i.test(ZH[key]) || /cordis|\.yml|\.yaml/i.test(EN[key]))
  assert.deepEqual(stale, [], 'no MCP copy may reference a config file or profile')
})

test('formatSize humanizes bytes like the list views expect', () => {
  assert.equal(formatSize(NaN), '-')
  assert.equal(formatSize(-1), '-')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
})

test('apply registers dictionaries and both slot entries', async () => {
  const calls = []
  const registered = []
  const ctx = {
    locale: {
      register: (...args) => calls.push(args),
      bind: (ns) => (key) => `${ns}:${key}`,
      subscribe: () => () => {},
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (spec) => registered.push(spec),
    },
    effect: (fn) => fn(),
  }
  plugin.apply(ctx)
  assert.deepEqual(calls.map(c => [c[0], c[1]]).sort(), [[NS, 'en'], [NS, 'zh']])
  // two entries: the two settings sections (skills + MCP, siblings). The composer
  // 「＋技能」 button was removed, so nothing registers in the conversation slot.
  assert.equal(registered.length, 2)
  const names = registered.map(r => r.name).sort()
  assert.deepEqual(names, ['settings.section', 'settings.section'])
  for (const spec of registered) {
    assert.equal(typeof spec.inject, 'function')
    assert.equal(spec.name, 'settings.section')
    assert.equal(typeof spec.label, 'function')
  }
  // the two settings sections are distinct entries with distinct ids
  const sections = registered.filter(r => r.name === 'settings.section')
  assert.deepEqual(sections.map(s => s.id), [plugin.name, plugin.name + ':mcp'])
  assert.deepEqual(sections.map(s => typeof s.label()), ['string', 'string'])
  assert.notEqual(sections[0].label(), sections[1].label(), 'the two sidebar entries must not share a label')
  assert.ok(sections[1].order > sections[0].order, 'MCP sits right after skills')
})

test('the composer button stays removed — no picker surface or conversation slot', () => {
  const src = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const banned = ['conversation.input.left', 'SkillPicker', 'ComposerButtonSlot', 'inputTriggers', 'sk-picker', 'insertComposerText', 'fetchSkillCandidates', 'openTriggerSource']
  const found = banned.filter((needle) => src.includes(needle))
  assert.deepEqual(found, [], `client source must not reference ${found.join(', ')}`)
  // and no locale copy survives for it (`pickSource` is the skills page's own
  // source filter, so the check names the removed keys instead of a prefix)
  const removedKeys = ['pickSkill', 'pickSkillTitle', 'pickerSearch', 'pickerLoading', 'pickerUserOnly']
  const leftovers = removedKeys.filter((key) => ZH[key] !== undefined || EN[key] !== undefined)
  assert.deepEqual(leftovers, [], `stale picker locale keys: ${leftovers.join(', ')}`)
})

