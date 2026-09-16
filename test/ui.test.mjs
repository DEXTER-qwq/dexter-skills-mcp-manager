// Client-plane contract tests for the React/primitives rewrite.
// The primitives package only resolves inside the dsh module loader, so the
// client source is loaded under plain Node with that require shimmed away —
// which is also the assertion surface: interactions must degrade gracefully
// without primitives present (jsdom shim), and never depend on its internals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../client/index.js')
const { NS, ZH, EN, matchSkill, formatSize, insertComposerText, fetchSkillCandidates,
  mapToText, textToMap, textToArgs, mcpRowToForm, emptyMcpForm } = plugin.__internals

test('client module declares slots + locale injects', () => {
  assert.equal(plugin.name, '@weibaohui/skills-management') // must equal the boot manifest id
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
  // 注意：/share/i 不能裸用——sortCharsDesc 之外无影响，但 /token/i 会误伤 sortTokens*
  const bannedKeys = Object.keys(ZH).filter(k => /(market|share|sync|repo|branch|prompt|secret)/i.test(k))
  assert.deepEqual(bannedKeys, [], 'market/share locale keys must not come back')
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

// ── MCP pane helpers ────────────────────────────────────────────────────

const enT = (key, vars) => {
  let out = EN[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
  return out
}

test('mapToText / textToMap round-trip env and headers', () => {
  assert.equal(mapToText({ A: 'v', B: { js: 'process.env.HOME' } }), 'A=v\nB=${HOME}')
  assert.equal(mapToText({}), '')
  assert.equal(mapToText(undefined), '')
  const parsed = textToMap('A=v\nB=${HOME}\n# comment\n\nC=has=equals', enT)
  assert.deepEqual(parsed.value, { A: 'v', B: { js: 'process.env.HOME' }, C: 'has=equals' })
  assert.equal(textToMap('A=v', enT).error, undefined)
})

test('textToMap rejects malformed lines instead of guessing', () => {
  for (const bad of ['novalue', '=v', '1BAD=v', 'A v']) {
    assert.ok(textToMap(bad, enT).error !== undefined, `expected an error for ${JSON.stringify(bad)}`)
  }
})

test('textToArgs is one argument per line, blanks dropped', () => {
  assert.deepEqual(textToArgs('-y\n@scope/pkg\n\n  spaced arg  '), ['-y', '@scope/pkg', 'spaced arg'])
  assert.deepEqual(textToArgs(''), [])
  assert.deepEqual(textToArgs(undefined), [])
})

test('mcpRowToForm / emptyMcpForm keep the dialog fields consistent', () => {
  const form = mcpRowToForm({
    serverName: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'],
    env: { T: { js: 'process.env.T' } }, cwd: 'C:/x', url: '', headers: {},
    toolCallTimeoutMs: 1234, failOnStartupError: true, reconnect: { enabled: false, maxAttempts: 4 },
  })
  assert.equal(form.serverName, 'gh')
  assert.equal(form.argsText, '-y\npkg')
  assert.equal(form.envText, 'T=${T}')
  assert.equal(form.timeout, '1234')
  assert.equal(form.failOnStartup, true)
  assert.equal(form.reconnectEnabled, false)
  assert.equal(form.reconnectAttempts, '4')
  assert.deepEqual(emptyMcpForm(), {
    serverName: '', transport: 'stdio', command: '', argsText: '', envText: '', cwd: '',
    url: '', headersText: '', timeout: '', failOnStartup: false, reconnectEnabled: true, reconnectAttempts: '',
  })
})

test('mcpRowToForm tolerates a row with missing or foreign fields', () => {
  const form = mcpRowToForm({ id: 'x', transport: 'weird', env: null, headers: undefined, args: undefined, reconnect: 'nope' })
  assert.equal(form.transport, 'stdio')
  assert.equal(form.envText, '')
  assert.equal(form.headersText, '')
  assert.equal(form.argsText, '')
  assert.equal(form.reconnectEnabled, true)
})

test('the MCP pane ships its own copy in both locales', () => {
  const mcpKeys = Object.keys(ZH).filter((key) => key.startsWith('mcp'))
  assert.ok(mcpKeys.length >= 40, `expected a full MCP copy set, saw ${mcpKeys.length}`)
  for (const key of mcpKeys) {
    assert.equal(typeof ZH[key], 'string', `zh.${key}`)
    assert.equal(typeof EN[key], 'string', `en.${key}`)
    assert.ok(ZH[key].trim() !== '' && EN[key].trim() !== '', `${key} must not be empty`)
  }
  assert.equal(ZH.tabMcp, 'MCP 管理')
  assert.equal(ZH.mcpTitle, 'MCP 管理')
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
  // three entries: two settings sections (skills + MCP, siblings) + the composer button
  assert.equal(registered.length, 3)
  const names = registered.map(r => r.name).sort()
  assert.deepEqual(names, ['conversation.input.left', 'settings.section', 'settings.section'])
  for (const spec of registered) {
    assert.equal(typeof spec.inject, 'function')
    if (spec.name === 'settings.section') assert.equal(typeof spec.label, 'function')
    else assert.equal(spec.id, plugin.name)
  }
  // the two settings sections are distinct entries with distinct ids
  const sections = registered.filter(r => r.name === 'settings.section')
  assert.deepEqual(sections.map(s => s.id), [plugin.name, plugin.name + ':mcp'])
  assert.deepEqual(sections.map(s => typeof s.label()), ['string', 'string'])
  assert.notEqual(sections[0].label(), sections[1].label(), 'the two sidebar entries must not share a label')
  assert.ok(sections[1].order > sections[0].order, 'MCP sits right after skills')
  // ＋技能按钮槽位：打开自带搜索的 picker 浮层
  const composer = registered.find(r => r.name === 'conversation.input.left')
  assert.equal(typeof composer, 'object')
  assert.equal(composer.id, plugin.name)
})

test('insertComposerText bails slash/input-insert-text with an end-of-draft span', () => {
  const calls = []
  const scope = { sessions: { scope: (id) => ({ id, bail(...args) { calls.push(args); return true } }) } }
  const ok = insertComposerText(scope, 's1', { draft: 'ab', draftRev: 5 }, '/lint ')
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'slash/input-insert-text')
  assert.deepEqual(calls[0][2], { text: '/lint ', span: { start: 2, end: 2, draftRev: 5 } })
  // bail 未被认领 / 服务缺席 / scope 抛错 → false，无副作用
  assert.equal(insertComposerText({ sessions: { scope: () => ({ bail: () => undefined }) } }, 's', {}, '/x '), false)
  assert.equal(insertComposerText(null, 's', {}, '/x '), false)
  assert.equal(insertComposerText({ sessions: { scope: () => { throw new Error('x') } } }, 's', {}, '/x '), false)
  assert.equal(insertComposerText({ sessions: { scope: () => null } }, 's', {}, '/x '), false)
})

test('fetchSkillCandidates maps the host registry and guards absent services', async () => {
  // 子代理会话：ui-skill 同款守卫，直接空目录
  const subagentSessions = { subagentAddress: () => 'subagent://x' }
  assert.deepEqual(await fetchSkillCandidates(null, subagentSessions, 's-sub'), [])
  // connection 缺席 / api 缺失 → reject（picker 落入空态）
  await assert.rejects(() => fetchSkillCandidates(null, {}, 's-1'))
  await assert.rejects(() => fetchSkillCandidates({ api: {} }, {}, 's-1'))
  // result.ok=false → reject
  const badConn = { api: { skills: { list: async () => ({ result: { ok: false } }) } } }
  await assert.rejects(() => fetchSkillCandidates(badConn, {}, 's-bad'))
  // 正常映射 + 60s 内同会话走缓存（list 只调一次）
  let calls = 0
  const conn = { api: { skills: { list: async ({ sessionId }) => { calls += 1; return { result: { ok: true, value: { skills: [
    { name: 'lint', description: '检查', modelInvocable: true },
    { name: 'deploy', description: '', modelInvocable: false },
  ] } } } } } } }
  const sid = `s-${Date.now()}`
  const rows = await fetchSkillCandidates(conn, {}, sid)
  assert.deepEqual(rows, [
    { name: 'lint', description: '检查', modelInvocable: true },
    { name: 'deploy', description: '', modelInvocable: false },
  ])
  const again = await fetchSkillCandidates(conn, {}, sid)
  assert.equal(again, rows)
  assert.equal(calls, 1)
})

test('openTriggerSource toggles via sessionOf with a synthetic end-of-draft span', () => {
  const { openTriggerSource } = plugin.__internals
  const calls = []
  const scope = {
    sessions: { scope: (id) => ({ id }) },
    inputTriggers: {
      sessionOf: (actx) => ({
        toggleSource: (name, hit) => calls.push({ name, hit, actx }),
      }),
    },
  }
  const ok = openTriggerSource(scope, 'session-9', { draft: '', draftRev: 3 }, 'skill')
  assert.equal(ok, true)
  assert.equal(calls[0].name, 'skill')
  assert.equal(calls[0].hit.position, 'leading')
  assert.deepEqual(calls[0].hit.span, { start: 0, end: 0, draftRev: 3 })
  // 服务缺席 / scope 不可解析 → false（按钮点击无副作用）
  assert.equal(openTriggerSource(null, 's', {}, 'skill'), false)
  assert.equal(openTriggerSource({ sessions: { scope: () => undefined }, inputTriggers: { sessionOf: () => ({}) } }, 's', {}, 'skill'), false)
})

// ── 注入开销文案与排序（纯 helper）────────────────────────────────────────

test('usageText renders tokens first, degrades to chars, hides on legacy rows', () => {
  const { usageText, EN } = plugin.__internals
  const t = (key, vars) => {
    let out = EN[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
    return out
  }
  const full = usageText({ tokens: 4, chars: 17 }, t)
  assert.equal(full, '≈4 tokens · 17 chars')
  const charsOnly = usageText({ chars: 9 }, t)
  assert.equal(charsOnly, '9 chars')
  assert.equal(usageText({}, t), null)
})

test('sortSkills orders by the picked metric with missing values sinking', () => {
  const { sortSkills } = plugin.__internals
  const rows = [
    { name: 'no-usage' },
    { name: 'a', tokens: 3, chars: 30 },
    { name: 'b', tokens: 9, chars: 10 },
    { name: 'c', tokens: 3, chars: 20 },
  ]
  assert.deepEqual(sortSkills(rows, 'tokens').map(r => r.name), ['b', 'a', 'c', 'no-usage'])
  assert.deepEqual(sortSkills(rows, 'tokensAsc').map(r => r.name), ['a', 'c', 'b', 'no-usage'])
  assert.deepEqual(sortSkills(rows, 'chars').map(r => r.name), ['a', 'c', 'b', 'no-usage'])
  assert.deepEqual(sortSkills(rows, 'default').map(r => r.name), ['no-usage', 'a', 'b', 'c']) // 原序
  // keyFn：{row, s} 包装数组按内层卡片行排序
  const wrapped = rows.map(s => ({ row: {}, s }))
  assert.deepEqual(sortSkills(wrapped, 'tokens', it => it.s).map(it => it.s.name), ['b', 'a', 'c', 'no-usage'])
  // 不改变原数组
  assert.deepEqual(rows.map(r => r.name), ['no-usage', 'a', 'b', 'c'])
})
