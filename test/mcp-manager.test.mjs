// Tests for src/mcp-manager.js and the host's MCP surface.
//
// Design under test: the servers live in the hand-written `mcp.local.jsonc`,
// which this plugin reads on every request and never writes. Listing joins that
// file with the loader (so a server the dsh composition declares is visible and
// wins a name collision), mounting is a real `@deepseek-ai/dsh-mcp-client`
// loader entry under `sm-mcp-`, and the ONLY file written is this plugin's own
// state, `mcp.json`, whose single field (`forcedOn`) records the hand-written
// entries this page switched on although the file parks them.
//
// The tests therefore have to prove: (a) state round-trips and degrades safely,
// (b) reading a hand-written file never rewrites it, (c) the switch can only do
// what the state file can express, and (d) nothing else on disk is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mcpManager = require('../src/mcp-manager.js')
const plugin = require('../src/index.js')

const MCP_PLUGIN_NAME = mcpManager.MCP_PLUGIN_NAME

/** Point DSH_HOME at a temp dir so nothing touches the real ~/.dsh. */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-mgr-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    await rm(home, { recursive: true, force: true })
  }
}

/** Write the hand-written config; returns its exact text so tests can compare bytes. */
async function writeLocal(home, text) {
  const dir = join(home, 'skills-management')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mcp.local.jsonc'), text)
  return text
}

/** Let the fire-and-forget startup mount pass finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

// ── state store ─────────────────────────────────────────────────────────

test('the store round-trips the forcedOn list through mcp.json', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    assert.deepEqual(store.get(), { forcedOn: [] })
    assert.equal(store.file, join(home, 'skills-management', 'mcp.json'))

    await store.replace({ forcedOn: ['github', 'github', 'bad name', 42, 'a'.repeat(33)] })

    // a fresh store (another process / next boot) reads the same thing back
    const reopened = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    reopened.loadSync()
    assert.deepEqual(reopened.get().forcedOn, ['github'], 'deduplicated, and only valid server names kept')

    const raw = JSON.parse(await readFile(store.file, 'utf8'))
    assert.deepEqual(Object.keys(raw), ['forcedOn'], 'the state file holds that one field and nothing else')
    assert.deepEqual(raw.forcedOn, ['github'])
  })
})

test('a corrupt or missing state file degrades to empty instead of throwing', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })

    const missing = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(missing.loadSync(), { forcedOn: [] })

    await writeFile(join(dir, 'mcp.json'), '{ not json')
    const broken = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(broken.loadSync(), { forcedOn: [] })
    assert.equal(broken.status().status, 'corrupt')

    // structurally wrong entries are dropped, not repaired
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ forcedOn: ['ok', 'ok', 7, null] }))
    const partial = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(partial.loadSync().forcedOn, ['ok'])
  })
})

test('writes are atomic: no temp file is left behind', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    await store.replace({ forcedOn: [] })
    await store.replace({ forcedOn: ['a'] })
    const entries = await readdir(join(home, 'skills-management'))
    assert.deepEqual(entries, ['mcp.json'], `expected only the state file, saw ${entries.join(', ')}`)
  })
})

test('two writes in the same millisecond must not share a temp path', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    // no await between them: both land in the same tick, where Date.now() alone
    // would hand them the same temp filename
    const first = store.replace({ forcedOn: ['one'] })
    const second = store.replace({ forcedOn: ['two'] })
    await Promise.all([first, second])
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state.forcedOn, ['two'], 'the last write wins, and it is valid JSON')
    const entries = await readdir(join(home, 'skills-management'))
    assert.deepEqual(entries, ['mcp.json'])
  })
})

test('missing and empty are distinct statuses', async () => {
  await withHome(async () => {
    const missing = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    missing.loadSync()
    assert.equal(missing.status().status, 'missing')

    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    await store.replace({ forcedOn: [] })
    const reopened = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    reopened.loadSync()
    assert.equal(reopened.status().status, 'empty')
  })
})

test('the store reloads from disk, so a file that appears later is seen', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    assert.equal(store.status().status, 'missing')
    assert.deepEqual(store.get().forcedOn, [])

    // the user restores mcp.json from a backup while dsh is running
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ forcedOn: ['late'] }))
    assert.equal(store.reload().changed, true)
    assert.deepEqual(store.get().forcedOn, ['late'])
    assert.equal(store.status().status, 'ok')

    // a no-op reload reports no change
    assert.equal(store.reload().changed, false)
  })
})

test('an annotated state file is read through and NOT rewritten', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    const annotated = [
      '{',
      '  // note to self: keep this file tidy',
      '  "forcedOn": ["ssh-mcp-server",],',
      '}',
    ].join('\n')
    await writeFile(join(dir, 'mcp.json'), annotated)
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(store.loadSync().forcedOn, ['ssh-mcp-server'])
    assert.equal(store.status().status, 'ok')
    assert.equal(store.status().tolerated, 'comments')
    // the annotations survive: reading never rewrites
    assert.equal(await readFile(join(dir, 'mcp.json'), 'utf8'), annotated)
  })
})

test('an unreadable state file is reported instead of silently emptying the list', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    const junk = '{"forcedOn": [ this is not json'
    await writeFile(join(dir, 'mcp.json'), junk)
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(store.loadSync().forcedOn, [])
    const status = store.status()
    assert.equal(status.status, 'corrupt')
    assert.ok(status.error.length > 0, 'the parse error is carried for the UI')
    assert.equal(await readFile(join(dir, 'mcp.json'), 'utf8'), junk, 'the damaged file is left as found')
  })
})

test('retired state keys are ignored, and reported so nothing vanishes silently', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    // what an older version of this plugin wrote: a disabled list plus servers
    // added from the page, neither of which has a home here any more
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({
      version: 1,
      disabled: ['github'],
      servers: [{ serverName: 'old', transport: 'stdio', command: 'npx' }],
    }))
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(store.loadSync(), { forcedOn: [] }, 'nothing from the old shape is honoured')
    assert.deepEqual(store.status().legacy, { disabled: 1, servers: 1 }, 'but the counts are reported')

    // an empty old shape is not worth a notice
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ version: 1, disabled: [], servers: [] }))
    const quiet = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    quiet.loadSync()
    assert.equal(quiet.status().legacy, undefined)
  })
})

// ── the JSONC reader ────────────────────────────────────────────────────

test('parseJsonc accepts comments both ways and leaves strings alone', () => {
  const doc = [
    '{',
    '  // a line comment, with a quote in it: "',
    '  "servers": [',
    '    { "name": "a" }, // trailing comment',
    '    /* block',
    '       comment */',
    '    { "name": "b" },',
    '  ]',
    '}',
  ].join('\n')
  const parsed = mcpManager.parseJsonc(doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.hadComments, true)
  assert.deepEqual(parsed.value.servers.map((s) => s.name), ['a', 'b'], 'trailing comma is tolerated too')
})

test('parseJsonc does not mistake comment-like text inside strings for syntax', () => {
  const doc = JSON.stringify({
    servers: [
      { url: 'http://127.0.0.1:13337/mcp', path: 'D:\\tools\\a', note: 'a // b', other: '/* not a comment */' },
    ],
  })
  const parsed = mcpManager.parseJsonc(doc)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.hadComments, false, 'no comment was actually stripped')
  assert.deepEqual(parsed.value.servers[0], {
    url: 'http://127.0.0.1:13337/mcp',
    path: 'D:\\tools\\a',
    note: 'a // b',
    other: '/* not a comment */',
  })
})

test('parseJsonc reports what it cannot fix instead of guessing', () => {
  // a lost comma cannot be told apart from two adjacent values: refuse it
  const lost = '{\n  "servers": [\n    { "a": 1 }\n    { "a": 2 }\n  ]\n}'
  const parsed = mcpManager.parseJsonc(lost)
  assert.equal(parsed.ok, false)
  assert.ok(parsed.error.length > 0)
  // an unterminated block comment is named as such
  assert.match(mcpManager.parseJsonc('{ /* oops').error, /unterminated/)
  assert.equal(mcpManager.parseJsonc('not json at all').ok, false)
})

// ── the hand-written file ───────────────────────────────────────────────

test('readLocalConfig accepts the documented shapes and honours per-entry enabled', async () => {
  await withHome(async (home) => {
    // a bare array, with one entry parked
    await writeLocal(home, JSON.stringify([
      { serverName: 'a', transport: 'stdio', command: 'npx' },
      { serverName: 'b', transport: 'stdio', command: 'npx', enabled: false },
    ]))
    let local = mcpManager.readLocalConfig()
    assert.equal(local.status, 'ok')
    assert.deepEqual(local.servers.map((s) => [s.serverName, s.enabled]), [['a', true], ['b', false]])

    // an object with `servers` plus a top-level `disabled` park list
    await writeLocal(home, JSON.stringify({
      servers: [{ serverName: 'a', transport: 'stdio', command: 'npx' }],
      disabled: ['a'],
    }))
    local = mcpManager.readLocalConfig()
    assert.deepEqual(local.servers.map((s) => [s.serverName, s.enabled]), [['a', false]])

    // missing and empty are distinct, and neither throws
    assert.equal(mcpManager.readLocalConfig(join(home, 'nope.jsonc')).status, 'missing')
    await writeLocal(home, '{"servers": []}')
    assert.equal(mcpManager.readLocalConfig().status, 'empty')
  })
})

test('invalid entries in the hand-written file are reported, not dropped silently', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({
      servers: [
        { serverName: 'fine', transport: 'stdio', command: 'npx' },
        { serverName: 'bad name', transport: 'stdio', command: 'npx' },
        { serverName: 'no-command', transport: 'stdio' },
      ],
    }))
    const local = mcpManager.readLocalConfig()
    assert.deepEqual(local.servers.map((s) => s.serverName), ['fine'])
    assert.equal(local.invalid.length, 2)
    assert.deepEqual(local.invalid.map((e) => e.serverName), ['bad name', 'no-command'])
    for (const entry of local.invalid) assert.ok(entry.reason.length > 0, 'each carries a reason')
  })
})

test('the shipped example template parses, and demonstrates all three parked styles', async () => {
  const example = await readFile(new URL('../docs/mcp.local.example.jsonc', import.meta.url), 'utf8')
  await withHome(async (home) => {
    await writeLocal(home, example)
    const local = mcpManager.readLocalConfig()
    assert.equal(local.status, 'ok')
    assert.equal(local.hadComments, true, 'the template is JSONC, and comments must not break it')
    assert.deepEqual(local.servers.map((s) => s.serverName),
      ['my-stdio-server', 'my-http-server', 'my-ssh-server', 'parked-server'])
    assert.deepEqual(local.servers.map((s) => s.enabled), [true, true, true, false], 'the parked example is the switchable one')
    assert.deepEqual(mcpManager.mountableServers({ forcedOn: [] }, local).map((s) => s.serverName),
      ['my-stdio-server', 'my-http-server', 'my-ssh-server'])
  })
})

// ── validation ──────────────────────────────────────────────────────────

test('validateServerInput produces the exact dsh-mcp-client config shape', () => {
  assert.deepEqual(
    mcpManager.validateServerInput({ serverName: 'gh', transport: 'stdio', command: ' npx ', args: 'a\nb\n', cwd: ' /tmp ', env: { T: '${TOKEN}', L: 'lit' } }),
    { serverName: 'gh', transport: 'stdio', command: 'npx', args: ['a', 'b'], cwd: '/tmp', env: { T: { js: 'process.env.TOKEN' }, L: 'lit' } }
  )
  assert.deepEqual(
    mcpManager.validateServerInput({ serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', headers: { A: 'b' }, toolCallTimeoutMs: '5000' }),
    { serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', headers: { A: 'b' }, toolCallTimeoutMs: 5000 }
  )
})

test('validateServerInput refuses what the MCP client would refuse', () => {
  const bad = [
    [{ serverName: 'has space', transport: 'stdio', command: 'c' }, /serverName/],
    [{ serverName: '', transport: 'stdio', command: 'c' }, /serverName/],
    [{ serverName: 'a'.repeat(33), transport: 'stdio', command: 'c' }, /serverName/],
    [{ serverName: 'a', transport: 'nope', command: 'c' }, /transport/],
    [{ serverName: 'a', transport: 'stdio' }, /command is required/],
    [{ serverName: 'a', transport: 'streamable-http', url: 'ftp://x' }, /http\(s\)/],
    [{ serverName: 'a', transport: 'streamable-http', url: 'not a url' }, /not a valid URL/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', env: { '1BAD': 'x' } }, /must match/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', env: { A: 1 } }, /must be a string/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', args: [1] }, /array of strings/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', toolCallTimeoutMs: '0' }, /positive integer/],
    [null, /must be an MCP server object/],
  ]
  for (const [input, re] of bad) assert.throws(() => mcpManager.validateServerInput(input), re, JSON.stringify(input))
})

test('only the process.env.NAME !!js form is accepted', () => {
  assert.throws(
    () => mcpManager.validateServerInput({ serverName: 'a', transport: 'stdio', command: 'c', env: { X: { js: 'require("child_process").execSync("x")' } } }),
    /process\.env\.NAME/)
  assert.throws(
    () => mcpManager.validateServerInput({ serverName: 'a', transport: 'stdio', command: 'c', env: { X: { js: 'process.env.A || "b"' } } }),
    /process\.env\.NAME/)
})

test('mcpClientConfig resolves env references at mount time, never passing the expression through', () => {
  const server = mcpManager.validateServerInput({ serverName: 'gh', transport: 'stdio', command: 'npx', env: { T: '${MCP_TEST_TOKEN}', L: 'literal' } })
  const prev = process.env.MCP_TEST_TOKEN
  try {
    process.env.MCP_TEST_TOKEN = 'sekret'
    assert.deepEqual(mcpManager.mcpClientConfig(server).env, { T: 'sekret', L: 'literal' })
  } finally {
    if (prev === undefined) delete process.env.MCP_TEST_TOKEN; else process.env.MCP_TEST_TOKEN = prev
  }
  // unset: the key is omitted rather than leaking 'process.env.MCP_TEST_TOKEN'
  assert.deepEqual(mcpManager.mcpClientConfig(server).env, { L: 'literal' })
  assert.equal(mcpManager.mcpClientConfig({ serverName: 'w', transport: 'http' }).failOnStartupError, false)
  assert.equal(typeof mcpManager.mcpClientConfig({ serverName: 'w', transport: 'stdio', command: 'c' }).toolCallTimeoutMs, 'number')
})

// ── loader / tools helpers ──────────────────────────────────────────────

const entry = (id, serverName, extra = {}) => ({
  options: { id, name: MCP_PLUGIN_NAME, config: { serverName, transport: 'stdio', command: 'c', ...extra } },
  fiber: {},
  disabled: false,
})

test('entryOwner tells composed rows, ours, and another plugin\'s apart', () => {
  // a composed row: plain human-chosen id
  assert.deepEqual(mcpManager.entryOwner('mcp-github'), { owner: undefined })
  assert.deepEqual(mcpManager.entryOwner(''), { owner: undefined })
  assert.deepEqual(mcpManager.entryOwner(undefined), { owner: undefined })
  // ours
  assert.equal(mcpManager.entryOwner('sm-mcp-local').owner, 'self')
  // another MCP plugin's runtime mount, which the first version mislabelled
  const foreign = mcpManager.entryOwner('msm-mcp-ida-pro-mcp')
  assert.equal(foreign.owner, 'other')
  assert.equal(foreign.prefix, 'msm-mcp-')
  assert.equal(foreign.plugin, 'dsh-skills-mcp-group-manager')
})

test('mountedBy finds the owner of a serverName, whoever mounted it', () => {
  const loader = {
    entries: () => [
      entry('mcp-github', 'github'),
      entry('msm-mcp-ida', 'ida-pro-mcp'),
      entry('sm-mcp-mine', 'mine'),
    ],
  }
  assert.equal(mcpManager.mountedBy(loader, 'github').owner, undefined)
  assert.equal(mcpManager.mountedBy(loader, 'ida-pro-mcp').owner, 'other')
  assert.equal(mcpManager.mountedBy(loader, 'mine').owner, 'self')
  assert.equal(mcpManager.mountedBy(loader, 'nope'), undefined, 'unknown name = nobody owns it')
})

test('toolsOfServer counts exactly one namespace', () => {
  const schemas = [{ name: 'mcp__gh__a' }, { name: 'mcp__gh__b' }, { name: 'mcp__ghx__c' }]
  assert.deepEqual(mcpManager.toolsOfServer(schemas, 'gh'), ['mcp__gh__a', 'mcp__gh__b'])
  assert.deepEqual(mcpManager.toolsOfServer([], 'gh'), [])
})

// ── listServers / mountableServers ──────────────────────────────────────

test('listServers merges composed and hand-written rows, one row per name', () => {
  const loader = { entries: () => [entry('mcp-github', 'github'), entry('mcp-web', 'web', { transport: 'streamable-http' })] }
  const local = {
    servers: [
      { serverName: 'jads', transport: 'stdio', command: 'loc' },
      { serverName: 'web', transport: 'stdio', command: 'from-local' },
    ],
  }
  const schemas = [{ name: 'mcp__github__create' }, { name: 'mcp__jads__run' }]
  const rows = mcpManager.listServers(loader, { forcedOn: [] }, schemas, local)
  assert.deepEqual(rows.map((r) => r.serverName), ['github', 'jads', 'web'])
  const byName = Object.fromEntries(rows.map((r) => [r.serverName, r]))

  assert.equal(byName.github.source, 'configured')
  assert.equal(byName.github.enabled, true)
  assert.equal(byName.github.switchable, false, 'a composed row is on because its config says so')
  assert.equal(byName.github.toolCount, 1)

  assert.equal(byName.jads.source, 'local')
  assert.equal(byName.jads.enabled, true)
  assert.equal(byName.jads.switchable, false, 'this entry does not park itself')
  assert.equal(byName.jads.toolCount, 1)

  // the composed row wins the collision, and the shadowed local one is reported
  assert.equal(byName.web.source, 'configured')
  assert.equal(byName.web.command, 'c')
  assert.equal(byName.web.alsoDeclared, true)
})

test('listServers marks a parked entry as switchable and reports the override', () => {
  const local = {
    servers: [
      { serverName: 'parked', transport: 'stdio', command: 'loc', enabled: false },
      { serverName: 'forced', transport: 'stdio', command: 'loc', enabled: false },
    ],
  }
  const rows = mcpManager.listServers(undefined, { forcedOn: ['forced'] }, [], local)
  const byName = Object.fromEntries(rows.map((r) => [r.serverName, r]))
  assert.equal(byName.parked.enabled, false)
  assert.equal(byName.parked.enabledInFile, false)
  assert.equal(byName.parked.enabledForced, false)
  assert.equal(byName.parked.switchable, true, 'a parked entry is exactly what the switch is for')
  assert.equal(byName.forced.enabled, true)
  assert.equal(byName.forced.enabledInFile, false)
  assert.equal(byName.forced.enabledForced, true)
  assert.equal(byName.forced.switchable, true)
})

test('a foreign mount is listed read-only, and cannot be switched here', () => {
  const loader = { entries: () => [entry('msm-mcp-ida', 'ida-pro-mcp')] }
  const rows = mcpManager.listServers(loader, { forcedOn: [] }, [], { servers: [] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'foreign')
  assert.equal(rows[0].switchable, false)
  assert.equal(rows[0].owner, 'dsh-skills-mcp-group-manager')
})

test('mountableServers returns what the file says is on, plus the forced overrides', () => {
  const local = {
    servers: [
      { serverName: 'on', transport: 'stdio', command: 'c' },
      { serverName: 'parked', transport: 'stdio', command: 'c', enabled: false },
      { serverName: 'forced', transport: 'stdio', command: 'c', enabled: false },
    ],
  }
  assert.deepEqual(
    mcpManager.mountableServers({ forcedOn: [] }, local).map((s) => s.serverName),
    ['on'], 'a parked entry stays off until this page forces it on')
  assert.deepEqual(
    mcpManager.mountableServers({ forcedOn: ['forced'] }, local).map((s) => s.serverName),
    ['on', 'forced'])
  assert.ok(mcpManager.mountableServers({ forcedOn: [] }, local).every((s) => s.source === 'local'))
  assert.deepEqual(mcpManager.mountableServers({ forcedOn: [] }, undefined), [])
})

// ── the host surface, with a fake loader / tools ────────────────────────

/** Fake ctx capturing everything the host half registers. */
function fakeCtx({ entries = [], schemas = [] } = {}) {
  const created = []
  const removed = []
  const effects = []
  const loader = {
    entries: () => entries,
    async create(options) { created.push(options); entries.push({ options, fiber: {}, disabled: false }) },
    async remove(id) {
      removed.push(id)
      const at = entries.findIndex((e) => e.options.id === id)
      if (at >= 0) entries.splice(at, 1)
    },
  }
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    // the host half always registers its skill provider, so the fake needs it
    skills: { registerProvider: () => () => {} },
    get(name) {
      if (name === 'loader') return loader
      if (name === 'tools') return { schemas: () => schemas }
      return undefined
    },
    // like the real Cordis: the callback runs immediately and its return value
    // is the disposer, so registered routes/effects exist after apply() returns
    effect(callback, label) {
      const result = typeof callback === 'function' ? callback() : undefined
      effects.push({ callback, label, result })
      return typeof result === 'function' ? result : () => {}
    },
  }
  return { ctx, loader, created, removed, effects }
}

/** Build a ctx that also captures the web route, then return a `call` helper. */
function setupWithRoutes({ entries = [], schemas = [], config = {} } = {}) {
  const fake = fakeCtx({ entries, schemas })
  let handler
  fake.ctx.webServer = { register: (route) => { handler = route.handler; return () => {} } }
  plugin.apply(fake.ctx, { installedDir: 'C:/definitely-missing-skills', ...config })
  const call = async (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = {}
    const out = {}
    const res = { writeHead(status) { out.status = status }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk) } }
    if (body !== undefined) setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }, 20)
    await handler(req, res)
    return { status: out.status, payload: out.body ? JSON.parse(out.body) : undefined }
  }
  return { ...fake, call }
}

test('GET /api/mcp lists loader servers joined with the hand-written file', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({ servers: [{ serverName: 'jads', transport: 'stdio', command: 'loc' }] }))
    const { call } = setupWithRoutes({
      entries: [entry('mcp-github', 'github')],
      schemas: [{ name: 'mcp__github__create' }],
    })
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.loaderAvailable, true)
    assert.equal(got.payload.mountAvailable, true)
    assert.equal(got.payload.localStatus, 'ok')
    assert.deepEqual(got.payload.servers.map((s) => s.serverName), ['github', 'jads'])
    assert.equal(got.payload.servers[0].source, 'configured')
    assert.equal(got.payload.servers[0].toolCount, 1)
    assert.equal(got.payload.servers[1].source, 'local')
    assert.ok(got.payload.stateFile.includes('mcp.json'))
    assert.ok(got.payload.localFile.includes('mcp.local.jsonc'))
  })
})

test('the hand-written file is mounted at startup, and a name another layer declares is skipped', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({
      servers: [
        { serverName: 'jads', transport: 'stdio', command: 'loc', args: ['--x'] },
        { serverName: 'parked', transport: 'stdio', command: 'loc', enabled: false },
        { serverName: 'github', transport: 'stdio', command: 'from-local' },
      ],
    }))
    const { created } = setupWithRoutes({ entries: [entry('mcp-github', 'github')] })
    await settle()
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-jads'],
      'only what the file says is on, and never a name the composition already owns')
    assert.equal(created[0].name, MCP_PLUGIN_NAME)
    assert.equal(created[0].config.serverName, 'jads')
    assert.deepEqual(created[0].config.args, ['--x'])
    assert.equal(created[0].config.failOnStartupError, false)
  })
})

test('switching a parked entry on mounts it and records the override, leaving the file untouched', async () => {
  await withHome(async (home) => {
    const text = JSON.stringify({
      servers: [
        { serverName: 'parked', transport: 'stdio', command: 'loc', enabled: false },
        { serverName: 'live', transport: 'stdio', command: 'loc' },
      ],
    }, null, 2)
    await writeLocal(home, text)
    const { call, created, removed } = setupWithRoutes()
    await settle()
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-live'])

    const on = await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: true })
    assert.equal(on.status, 200)
    const row = on.payload.servers.find((s) => s.serverName === 'parked')
    assert.equal(row.enabled, true)
    assert.equal(row.enabledForced, true)
    assert.equal(row.enabledInFile, false, 'the file still says what it said')
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-live', 'sm-mcp-parked'])
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state, { forcedOn: ['parked'] }, 'the state file holds only the override')
    assert.equal(await readFile(join(home, 'skills-management', 'mcp.local.jsonc'), 'utf8'), text, 'the hand-written file is byte-identical')

    // the override survives a restart of the plugin
    const afterRestart = setupWithRoutes()
    await settle()
    assert.deepEqual(afterRestart.created.map((c) => c.id).sort(), ['sm-mcp-live', 'sm-mcp-parked'])

    // switching it off drops the override and the mount again
    const off = await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: false })
    assert.equal(off.status, 200)
    const offRow = off.payload.servers.find((s) => s.serverName === 'parked')
    assert.equal(offRow.enabled, false)
    assert.equal(offRow.enabledForced, false)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8')), { forcedOn: [] })
    assert.deepEqual(removed, ['sm-mcp-parked'], 'switching off really unmounts it')
    assert.equal(await readFile(join(home, 'skills-management', 'mcp.local.jsonc'), 'utf8'), text)
  })
})

test('a row whose own source says "on" is refused instead of silently doing nothing', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({ servers: [{ serverName: 'always-on', transport: 'stdio', command: 'loc' }] }))
    const { call, removed } = setupWithRoutes({ entries: [entry('mcp-github', 'github')] })
    await settle()

    const localRow = await call('PUT', '/skills-management/api/mcp', { serverName: 'always-on', enabled: false })
    assert.equal(localRow.status, 409)
    assert.match(localRow.payload.error, /never writes that file/)
    assert.match(localRow.payload.error, /mcp\.local\.jsonc/)

    const composed = await call('PUT', '/skills-management/api/mcp', { serverName: 'github', enabled: false })
    assert.equal(composed.status, 409)
    assert.match(composed.payload.error, /dsh config/)

    assert.deepEqual(removed, [], 'nothing was unmounted by a refused switch')
    assert.equal(existsSync(join(home, 'skills-management', 'mcp.json')), false, 'and nothing was written')
  })
})

test('PUT rejects a bad body and an unknown name; other methods are 405', async () => {
  await withHome(async () => {
    const { call } = setupWithRoutes()
    assert.equal((await call('PUT', '/skills-management/api/mcp', {})).status, 400)
    assert.equal((await call('PUT', '/skills-management/api/mcp', { serverName: 'x' })).status, 400)
    assert.equal((await call('PUT', '/skills-management/api/mcp', { serverName: 'x', enabled: true })).status, 404)
    assert.equal((await call('POST', '/skills-management/api/mcp', { serverName: 'x' })).status, 405)
    assert.equal((await call('DELETE', '/skills-management/api/mcp', { serverName: 'x' })).status, 405)
    // the endpoints that used to serve add / import / prune are gone
    assert.equal((await call('GET', '/skills-management/api/mcp/import')).status, 404)
    assert.equal((await call('POST', '/skills-management/api/mcp/prune', {})).status, 404)
  })
})

test('the state file is the only thing written', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({ servers: [{ serverName: 'parked', transport: 'stdio', command: 'loc', enabled: false }] }))
    const { call } = setupWithRoutes()
    await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: true })

    const written = await readdir(join(home, 'skills-management'))
    assert.deepEqual(written.sort(), ['mcp.json', 'mcp.local.jsonc'])
    assert.equal(existsSync(join(home, 'profiles')), false, 'no profile directory is ever created')
  })
})

test('apply() stays synchronous and registers the MCP mount effect', async () => {
  await withHome(async () => {
    const fake = fakeCtx({ entries: [entry('mcp-github', 'github')] })
    fake.ctx.webServer = { register: () => () => {} }
    const result = plugin.apply(fake.ctx, { installedDir: 'C:/definitely-missing-skills' })
    assert.equal(typeof result?.then, 'undefined', 'apply() must not return a promise')
    assert.ok(fake.effects.some((e) => /MCP/.test(e.label ?? '')), 'the mount effect is registered')
    await settle()
  })
})

test('with no loader/tools services the pane still reports state instead of failing', async () => {
  await withHome(async () => {
    let handler
    const ctx = {
      logger: { warn() {}, error() {} },
      skills: { registerProvider: () => () => {} },
      webServer: { register: (route) => { handler = route.handler; return () => {} } },
      effect: (fn) => fn(),
    }
    plugin.apply(ctx, { installedDir: 'C:/definitely-missing-skills' })
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = '/skills-management/api/mcp'
    req.headers = {}
    const out = {}
    const res = { writeHead(s) { out.status = s }, end(c) { out.body = String(c ?? '') } }
    await handler(req, res)
    assert.equal(out.status, 200)
    const payload = JSON.parse(out.body)
    assert.equal(payload.loaderAvailable, false)
    assert.deepEqual(payload.servers, [])
    assert.equal(payload.localStatus, 'missing')
  })
})

test('a broken hand-written file is reported and never blocks the plugin', async () => {
  await withHome(async (home) => {
    await writeLocal(home, '{ "servers": [ /* unterminated')
    const { call } = setupWithRoutes()
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.localStatus, 'corrupt')
    assert.match(got.payload.localError, /unterminated/)
    assert.deepEqual(got.payload.servers, [])
  })
})
