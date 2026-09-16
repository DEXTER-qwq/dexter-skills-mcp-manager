// Tests for src/mcp-manager.js and the host's MCP surface.
//
// Design under test: MCP servers are listed from the LOADER (never by parsing
// a config file), toggling is a per-agent tools.restrict({ deny }) layer, and
// adding/removing mounts a real loader entry. The only file written is this
// plugin's own state, so these tests must prove that (a) the state survives a
// round-trip, (b) validation refuses junk, and (c) the restrict layer is
// swapped only when the deny set really changes �?swapping it unconditionally
// recurses through `tools/change` and wedges the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
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

// ── state store ─────────────────────────────────────────────────────────

test('the store round-trips state through <DSH_HOME>/skills-management/mcp.json', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    assert.deepEqual(store.get(), { version: 1, disabled: [], forcedOn: [], servers: [] })
    assert.equal(store.file, join(home, 'skills-management', 'mcp.json'))

    await store.replace({
      version: 1,
      disabled: ['github', 'github'],
      servers: [{ serverName: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: {} }],
    })

    // a fresh store (another process / next boot) reads the same thing back
    const reopened = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    reopened.loadSync()
    const state = reopened.get()
    assert.deepEqual(state.disabled, ['github'], 'disabled list is de-duplicated')
    assert.equal(state.servers.length, 1)
    assert.equal(state.servers[0].serverName, 'local')
    assert.equal(state.servers[0].enabled, true, 'enabled defaults to true when absent')

    const raw = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.servers[0].command, 'npx')
  })
})

test('a corrupt or missing state file degrades to empty instead of throwing', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })

    const missing = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(missing.loadSync(), { version: 1, disabled: [], forcedOn: [], servers: [] })

    await writeFile(join(dir, 'mcp.json'), '{ not json')
    const broken = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(broken.loadSync(), { version: 1, disabled: [], forcedOn: [], servers: [] })

    // structurally wrong entries are dropped, not repaired
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({
      version: 1,
      disabled: ['ok-name', 'bad name', 42, 'a'.repeat(40)],
      servers: [
        { serverName: 'good', transport: 'stdio', command: 'c' },
        { serverName: 'bad name', transport: 'stdio', command: 'c' },
        { serverName: 'no-transport', command: 'c' },
        { serverName: 'good', transport: 'stdio', command: 'duplicate' },
        'not an object',
      ],
    }))
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    assert.deepEqual(store.get().disabled, ['ok-name'])
    assert.deepEqual(store.get().servers.map((s) => s.serverName), ['good'])
  })
})

test('writes are atomic: no temp file is left behind', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    await store.replace({ version: 1, disabled: [], servers: [] })
    await store.replace({ version: 1, disabled: ['a'], servers: [] })
    const dir = join(home, 'skills-management')
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    assert.deepEqual(entries, ['mcp.json'], `expected only the state file, saw ${entries.join(', ')}`)
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
  // a lost comma cannot be told apart from two adjacent values �?refuse it
  const lost = '{\n  "servers": [\n    { "a": 1 }\n    { "a": 2 }\n  ]\n}'
  const parsed = mcpManager.parseJsonc(lost)
  assert.equal(parsed.ok, false)
  assert.ok(parsed.error.length > 0)
  // an unterminated block comment is named as such
  assert.match(mcpManager.parseJsonc('{ /* oops').error, /unterminated/)
  assert.equal(mcpManager.parseJsonc('not json at all').ok, false)
})

// ── the plugin-owned state file ─────────────────────────────────────────

test('the store reloads from disk, so a file that appears later is seen', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    assert.equal(store.status().status, 'missing')
    assert.deepEqual(store.get().servers, [])

    // the user renames mcp.json.bak back while dsh is running
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({
      version: 1, disabled: [], servers: [{ serverName: 'late', transport: 'stdio', command: 'c' }],
    }))
    assert.equal(store.reload().changed, true)
    assert.deepEqual(store.get().servers.map((s) => s.serverName), ['late'])
    assert.equal(store.status().status, 'ok')

    // a no-op reload reports no change
    assert.equal(store.reload().changed, false)
  })
})

test('missing and empty are distinct statuses', async () => {
  await withHome(async () => {
    const missing = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    missing.loadSync()
    assert.equal(missing.status().status, 'missing')

    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    await store.replace({ version: 1, disabled: [], servers: [] })
    const reopened = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    reopened.loadSync()
    assert.equal(reopened.status().status, 'empty')
  })
})

test('an annotated plugin state file is read through and NOT rewritten', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    const annotated = [
      '{',
      '  "version": 1,',
      '  // note to self: keep this file tidy',
      '  "disabled": ["a"],',
      '  "servers": [{ "serverName": "one", "transport": "stdio", "command": "c" }],',
      '}',
    ].join('\n')
    await writeFile(join(dir, 'mcp.json'), annotated)
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    const state = store.loadSync()
    assert.deepEqual(state.servers.map((s) => s.serverName), ['one'])
    assert.deepEqual(state.disabled, ['a'])
    assert.equal(store.status().status, 'ok')
    assert.equal(store.status().tolerated, 'comments')
    // the annotations survive: reading never rewrites
    assert.equal(await readFile(join(dir, 'mcp.json'), 'utf8'), annotated)
  })
})

test('an unreadable plugin state file is reported instead of silently emptying the list', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    const junk = '{"servers": [ this is not json'
    await writeFile(join(dir, 'mcp.json'), junk)
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    assert.deepEqual(store.loadSync().servers, [])
    const status = store.status()
    assert.equal(status.status, 'corrupt')
    assert.ok(status.error.length > 0, 'the parse error is carried for the UI')
    assert.equal(await readFile(join(dir, 'mcp.json'), 'utf8'), junk, 'the damaged file is left as found')
  })
})

test('two writes in the same millisecond must not share a temp path', async () => {
  await withHome(async (home) => {
    const store = mcpManager.createStore({ logger: { warn() {}, error() {} } })
    store.loadSync()
    // no await between them: both land in the same tick, where Date.now() alone
    // would hand them the same temp filename
    const first = store.replace({ version: 1, disabled: [], servers: [{ serverName: 'one', transport: 'stdio', command: 'c' }] })
    const second = store.replace({ version: 1, disabled: [], servers: [{ serverName: 'two', transport: 'stdio', command: 'c' }] })
    await Promise.all([first, second])
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state.servers.map((s) => s.serverName), ['two'], 'the last write wins, and it is valid JSON')
    const entries = await (await import('node:fs/promises')).readdir(join(home, 'skills-management'))
    assert.deepEqual(entries, ['mcp.json'])
  })
})

// ── validation ──────────────────────────────────────────────────────────

test('validateServerInput produces the exact dsh-mcp-client config shape', () => {
  assert.deepEqual(
    mcpManager.validateServerInput({ serverName: 'gh', transport: 'stdio', command: ' npx ', args: 'a\nb\n', cwd: ' /tmp ', env: { T: '${TOKEN}', L: 'lit' } }),
    { serverName: 'gh', transport: 'stdio', command: 'npx', args: ['a', 'b'], cwd: '/tmp', env: { T: { js: 'process.env.TOKEN' }, L: 'lit' } })
  assert.deepEqual(
    mcpManager.validateServerInput({ serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', headers: { A: 'b' }, toolCallTimeoutMs: '5000' }),
    { serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', headers: { A: 'b' }, toolCallTimeoutMs: 5000 })
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

test('only the process.env.NAME !!js form is accepted from the API', () => {
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
    delete process.env.MCP_TEST_TOKEN
    // unset: the key is omitted rather than leaking 'process.env.MCP_TEST_TOKEN'
    assert.deepEqual(mcpManager.mcpClientConfig(server).env, { L: 'literal' })
  } finally {
    if (prev === undefined) delete process.env.MCP_TEST_TOKEN; else process.env.MCP_TEST_TOKEN = prev
  }
  assert.equal(mcpManager.mcpClientConfig({ serverName: 'w', transport: 'http' }).failOnStartupError, false)
  assert.equal(typeof mcpManager.mcpClientConfig({ serverName: 'w', transport: 'stdio', command: 'c' }).toolCallTimeoutMs, 'number')
})

// ── loader / tools helpers ──────────────────────────────────────────────

const entry = (id, serverName, extra = {}) => ({
  options: { id, name: MCP_PLUGIN_NAME, config: { serverName, transport: 'stdio', command: 'c', ...extra } },
  fiber: {},
  disabled: false,
})

test('configuredServers reads the loader and skips this plugin\'s own mounts', () => {
  const loader = {
    entries: () => [
      entry('mcp-github', 'github'),
      entry('sm-mcp-local', 'local'),          // ours: must not be listed as configured
      { options: { id: 'x', name: 'other-plugin', config: {} } },
      { options: { id: 'y', name: MCP_PLUGIN_NAME, config: {} } },   // no serverName
      { options: { id: 'z', name: MCP_PLUGIN_NAME, config: { serverName: 'dead' } }, disabled: true },
    ],
  }
  const servers = mcpManager.configuredServers(loader)
  assert.deepEqual(servers.map((s) => s.config.serverName), ['github', 'dead'])
  assert.equal(servers[0].live, true)
  assert.equal(servers[1].live, false, 'a disabled loader entry is not live')
  assert.deepEqual(mcpManager.configuredServers(undefined), [])
})

test('entryOwner tells composed rows, ours, and another plugin\'s apart', () => {
  // a composed row: plain human-chosen id
  assert.deepEqual(mcpManager.entryOwner('mcp-github'), { owner: undefined })
  assert.deepEqual(mcpManager.entryOwner(''), { owner: undefined })
  assert.deepEqual(mcpManager.entryOwner(undefined), { owner: undefined })
  // ours
  assert.equal(mcpManager.entryOwner('sm-mcp-local').owner, 'self')
  // another MCP plugin's runtime mount �?the case that regressed in the first
  // version, where it was mislabelled "configured" (and so shown as non-removable)
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

test('a foreign mount is listed read-only, not as a removable row', () => {
  const loader = { entries: () => [entry('msm-mcp-ida', 'ida-pro-mcp')] }
  const rows = mcpManager.listServers(loader, { version: 1, disabled: [], servers: [] }, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'foreign')
  assert.equal(rows[0].removable, false)
  assert.equal(rows[0].owner, 'dsh-skills-mcp-group-manager')
})

// ── importing from another plugin ───────────────────────────────────────

async function withForeignState(state, fn) {
  return withHome(async (home) => {
    const dir = join(home, 'mcp-skill-manager')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), JSON.stringify(state))
    return fn(home)
  })
}

const FOREIGN_STATE = {
  groups: [],
  mcp: [
    { serverName: 'ida-pro-mcp', transport: 'streamable-http', url: 'http://127.0.0.1:13337/mcp', enabled: true, addedByUser: true },
    { serverName: 'ssh-mcp-server', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: {}, toolCallTimeoutMs: 30000, enabled: true, addedByUser: true },
    { serverName: 'from-profile', transport: 'stdio', command: 'x', enabled: true, addedByUser: false },
  ],
}

test('readImportCandidates translates another plugin\'s state file', async () => {
  await withForeignState(FOREIGN_STATE, async () => {
    const sources = await mcpManager.readImportCandidates()
    assert.equal(sources.length, 1)
    assert.equal(sources[0].id, 'dsh-skills-mcp-group-manager')
    assert.equal(sources[0].available, true)
    // only addedByUser entries come over; a profile-configured one is not ours to copy
    assert.deepEqual(sources[0].candidates.map((c) => c.serverName), ['ida-pro-mcp', 'ssh-mcp-server'])
    const ssh = sources[0].candidates[1]
    assert.equal(ssh.config.command, 'npx')
    assert.equal(ssh.config.toolCallTimeoutMs, 30000)
    assert.equal(ssh.conflict, undefined)
  })
})

test('readImportCandidates marks conflicts instead of dropping silently', async () => {
  await withForeignState(FOREIGN_STATE, async () => {
    const sources = await mcpManager.readImportCandidates({
      exclude: ['ssh-mcp-server'],
      takenByOthers: ['ida-pro-mcp'],
    })
    const byName = Object.fromEntries(sources[0].candidates.map((c) => [c.serverName, c]))
    assert.equal(byName['ssh-mcp-server'].conflict, 'already-managed')
    assert.equal(byName['ida-pro-mcp'].conflict, 'name-taken')
  })
})

test('a missing or unreadable foreign state file is reported, not thrown', async () => {
  await withHome(async () => {
    const sources = await mcpManager.readImportCandidates()
    assert.equal(sources[0].available, false)
    assert.match(sources[0].error, /not installed|ENOENT|no state file/)
  })
  await withHome(async (home) => {
    const dir = join(home, 'mcp-skill-manager')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), '{ not json')
    const sources = await mcpManager.readImportCandidates()
    assert.equal(sources[0].available, false)
    assert.ok(sources[0].error.length > 0)
  })
})

test('an invalid foreign entry is flagged rather than imported', async () => {
  await withForeignState({
    mcp: [
      { serverName: 'bad name', transport: 'stdio', command: 'x', addedByUser: true },
      { serverName: 'no-command', transport: 'stdio', addedByUser: true },
    ],
  }, async () => {
    const sources = await mcpManager.readImportCandidates()
    for (const candidate of sources[0].candidates) {
      assert.equal(candidate.config, undefined)
      assert.ok(candidate.invalid.length > 0, `${candidate.serverName} must carry a reason`)
    }
  })
})

test('denyNamesForDisabled only names tools that are actually live', () => {
  const schemas = [
    { name: 'mcp__github__create' },
    { name: 'mcp__github__list' },
    { name: 'mcp__other__x' },
    { name: 'run_code' },
  ]
  assert.deepEqual(mcpManager.denyNamesForDisabled(['github'], schemas),
    ['mcp__github__create', 'mcp__github__list'])
  // an empty/absent tool surface yields nothing �?tools.restrict would throw on unknown names
  assert.deepEqual(mcpManager.denyNamesForDisabled(['offline'], schemas), [])
  assert.deepEqual(mcpManager.denyNamesForDisabled([], schemas), [])
})

test('toolsOfServer counts exactly one namespace', () => {
  const schemas = [{ name: 'mcp__gh__a' }, { name: 'mcp__gh__b' }, { name: 'mcp__ghx__c' }]
  assert.deepEqual(mcpManager.toolsOfServer(schemas, 'gh'), ['mcp__gh__a', 'mcp__gh__b'])
  assert.deepEqual(mcpManager.toolsOfServer([], 'gh'), [])
})

test('listServers merges configured + user servers and applies remembered flags', () => {
  const loader = { entries: () => [entry('mcp-github', 'github'), entry('mcp-web', 'web', { transport: 'streamable-http' })] }
  const state = {
    version: 1,
    disabled: ['web'],
    servers: [{ serverName: 'local', transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true }],
  }
  const schemas = [{ name: 'mcp__github__create' }, { name: 'mcp__local__run' }]
  const rows = mcpManager.listServers(loader, state, schemas)
  assert.deepEqual(rows.map((r) => r.serverName), ['github', 'local', 'web'])
  const byName = Object.fromEntries(rows.map((r) => [r.serverName, r]))
  assert.equal(byName.github.source, 'configured')
  assert.equal(byName.github.enabled, true)
  assert.equal(byName.github.toolCount, 1)
  assert.equal(byName.web.source, 'configured')
  assert.equal(byName.web.enabled, false)
  assert.equal(byName.local.source, 'user')
  assert.equal(byName.local.toolCount, 1)
})

// ── the host surface, with a fake loader / tools / agents ───────────────

/** Fake ctx capturing everything the host half registers. */
function fakeCtx({ entries = [], schemas = [] } = {}) {
  const created = []
  const removed = []
  const restrictions = []
  const disposers = []
  const listeners = new Map()
  const effects = []
  const agents = []
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
      if (name === 'agents') return { list: () => agents }
      return undefined
    },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    // like the real Cordis: the callback runs immediately and its return value
    // is the disposer, so registered routes/effects exist after apply() returns
    effect(callback, label) {
      const result = typeof callback === 'function' ? callback() : undefined
      effects.push({ callback, label, result })
      return typeof result === 'function' ? result : () => {}
    },
  }
  const agent = (id) => {
    const layers = []
    const a = {
      id,
      ctx: { get: (name) => (name === 'tools' ? {
        restrict(filter) {
          const layer = { id, deny: [...(filter.deny ?? [])] }
          layers.push(layer)
          restrictions.push(layer)
          disposers.push(layer)
          // real restrict() emits tools/change synchronously �?reproduce that
          const emit = listeners.get('tools/change')
          if (emit) emit()
          return () => { const at = layers.indexOf(layer); if (at >= 0) layers.splice(at, 1) }
        },
      } : undefined) },
      layers,
    }
    agents.push(a)
    return a
  }
  return { ctx, loader, created, removed, restrictions, agents, agent, listeners, effects }
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

test('GET /api/mcp lists loader servers joined with the plugin state', async () => {
  await withHome(async () => {
    const { call } = setupWithRoutes({
      entries: [entry('mcp-github', 'github')],
      schemas: [{ name: 'mcp__github__create' }],
    })
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.loaderAvailable, true)
    assert.equal(got.payload.mountAvailable, true)
    assert.equal(got.payload.servers.length, 1)
    assert.equal(got.payload.servers[0].serverName, 'github')
    assert.equal(got.payload.servers[0].source, 'configured')
    assert.equal(got.payload.servers[0].enabled, true)
    assert.equal(got.payload.servers[0].toolCount, 1)
    assert.ok(got.payload.stateFile.includes('mcp.json'))
  })
})

test('adding a server mounts a loader entry and persists it', async () => {
  await withHome(async () => {
    const { call, created, loader } = setupWithRoutes()
    const created1 = await call('POST', '/skills-management/api/mcp', {
      serverName: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'],
    })
    assert.equal(created1.status, 201)
    assert.equal(created1.payload.created, 'local')
    assert.equal(created.length, 1)
    assert.deepEqual(created[0].id, 'sm-mcp-local')
    assert.equal(created[0].name, MCP_PLUGIN_NAME)
    assert.equal(created[0].config.serverName, 'local')
    assert.equal(created[0].config.failOnStartupError, false)

    // it now appears in the list as a user server, and not twice
    const listed = await call('GET', '/skills-management/api/mcp')
    assert.deepEqual(listed.payload.servers.map((s) => s.serverName), ['local'])
    assert.equal(listed.payload.servers[0].source, 'user')
    assert.equal(loader.entries().filter((e) => e.options.name === MCP_PLUGIN_NAME).length, 1)

    // a duplicate is refused
    const dup = await call('POST', '/skills-management/api/mcp', { serverName: 'local', transport: 'stdio', command: 'npx' })
    assert.equal(dup.status, 409)

    // invalid input is a 400
    const bad = await call('POST', '/skills-management/api/mcp', { serverName: 'has space', transport: 'stdio', command: 'x' })
    assert.equal(bad.status, 400)

    // and it survives a restart of the plugin (same DSH_HOME, fresh apply)
    const second = setupWithRoutes()
    const after = await second.call('GET', '/skills-management/api/mcp')
    assert.deepEqual(after.payload.servers.map((s) => s.serverName), ['local'])
  })
})

test('removing only works for servers this plugin added', async () => {
  await withHome(async () => {
    const { call, removed } = setupWithRoutes({ entries: [entry('mcp-github', 'github')], schemas: [] })
    await call('POST', '/skills-management/api/mcp', { serverName: 'local', transport: 'stdio', command: 'npx' })

    const refused = await call('DELETE', '/skills-management/api/mcp', { serverName: 'github' })
    assert.equal(refused.status, 409)
    assert.match(refused.payload.error, /composition layer|cannot be removed/)

    const unknown = await call('DELETE', '/skills-management/api/mcp', { serverName: 'nope' })
    assert.equal(unknown.status, 404)

    const gone = await call('DELETE', '/skills-management/api/mcp', { serverName: 'local' })
    assert.equal(gone.status, 200)
    assert.deepEqual(gone.payload.servers.map((s) => s.serverName), ['github'], 'the configured row stays')
    assert.deepEqual(removed, ['sm-mcp-local'])
  })
})

test('toggling a configured server restricts its tools per agent and is remembered', async () => {
  await withHome(async () => {
    const { call, agent, restrictions, listeners } = setupWithRoutes({
      entries: [entry('mcp-github', 'github')],
      schemas: [{ name: 'mcp__github__create' }, { name: 'mcp__github__list' }, { name: 'run_code' }],
    })
    // the host wires one agent-less world in this fake; create one and let the
    // agent/created listener apply the current restriction
    const a = agent('agent-1')
    listeners.get('agent/created')({ agent: a })

    const off = await call('PUT', '/skills-management/api/mcp', { serverName: 'github', enabled: false })
    assert.equal(off.status, 200)
    const row = off.payload.servers.find((s) => s.serverName === 'github')
    assert.equal(row.enabled, false)
    assert.deepEqual(a.layers.map((l) => l.deny), [['mcp__github__create', 'mcp__github__list']])

    // repeating the same toggle must NOT swap the restriction layer again:
    // restrict() emits tools/change, whose listener re-runs the same function
    const before = restrictions.length
    await call('PUT', '/skills-management/api/mcp', { serverName: 'github', enabled: false })
    assert.equal(restrictions.length, before, 'an unchanged deny set must not touch the registry')

    const on = await call('PUT', '/skills-management/api/mcp', { serverName: 'github', enabled: true })
    assert.equal(on.payload.servers.find((s) => s.serverName === 'github').enabled, true)
    assert.deepEqual(a.layers, [], 'enabling releases the restriction')
  })
})

test('toggling a user server unmounts and remounts the loader entry', async () => {
  await withHome(async () => {
    const { call, removed } = setupWithRoutes()
    await call('POST', '/skills-management/api/mcp', { serverName: 'local', transport: 'stdio', command: 'npx' })

    const off = await call('PUT', '/skills-management/api/mcp', { serverName: 'local', enabled: false })
    assert.equal(off.status, 200)
    assert.equal(off.payload.servers.find((s) => s.serverName === 'local').enabled, false)
    assert.deepEqual(removed, ['sm-mcp-local'], 'disabling unmounts')

    const on = await call('PUT', '/skills-management/api/mcp', { serverName: 'local', enabled: true })
    assert.equal(on.payload.servers.find((s) => s.serverName === 'local').enabled, true)
    assert.equal(on.payload.servers.find((s) => s.serverName === 'local').live, true, 're-enabling remounts')

    const bad = await call('PUT', '/skills-management/api/mcp', { serverName: 'local' })
    assert.equal(bad.status, 400)
    const missing = await call('PUT', '/skills-management/api/mcp', { serverName: 'nope', enabled: false })
    assert.equal(missing.status, 404)
  })
})

test('the state file is the only thing written', async () => {
  await withHome(async (home) => {
    const { call } = setupWithRoutes({ entries: [entry('mcp-github', 'github')] })
    await call('PUT', '/skills-management/api/mcp', { serverName: 'github', enabled: false })
    await call('POST', '/skills-management/api/mcp', { serverName: 'local', transport: 'stdio', command: 'npx' })

    const { readdir } = await import('node:fs/promises')
    const written = await readdir(join(home, 'skills-management'))
    assert.deepEqual(written, ['mcp.json'])
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state.disabled, ['github'])
    assert.deepEqual(state.servers.map((s) => s.serverName), ['local'])
    assert.equal(existsSync(join(home, 'profiles')), false, 'no profile directory is ever created')
  })
})

test('apply() stays synchronous and wires the MCP listeners', async () => {
  await withHome(async () => {
    const fake = fakeCtx({ entries: [entry('mcp-github', 'github')] })
    fake.ctx.webServer = { register: () => () => {} }
    const result = plugin.apply(fake.ctx, { installedDir: 'C:/definitely-missing-skills' })
    assert.equal(typeof result?.then, 'undefined', 'apply() must not return a promise')
    for (const name of ['agent/created', 'agent/disposed', 'tools/change']) {
      assert.ok(fake.listeners.has(name), `listener ${name} registered`)
    }
    assert.ok(fake.effects.some((e) => /MCP/.test(e.label ?? '')), 'MCP effect registered')
  })
})

// ── the import surface, and the collision it exists to avoid ────────────

test('a server another plugin mounted cannot be added or removed here', async () => {
  await withHome(async () => {
    const { call } = setupWithRoutes({ entries: [entry('msm-mcp-ida-pro-mcp', 'ida-pro-mcp')] })
    const listed = await call('GET', '/skills-management/api/mcp')
    assert.equal(listed.payload.servers[0].source, 'foreign')
    assert.equal(listed.payload.servers[0].removable, false)
    assert.equal(listed.payload.servers[0].owner, 'dsh-skills-mcp-group-manager')

    // adding a same-named server would make dsh-mcp-client fail on a duplicate
    // serverName, so it must be refused up front
    const add = await call('POST', '/skills-management/api/mcp', { serverName: 'ida-pro-mcp', transport: 'streamable-http', url: 'http://127.0.0.1:13337/mcp' })
    assert.equal(add.status, 409)
    assert.match(add.payload.error, /already mounted by the plugin/)

    const del = await call('DELETE', '/skills-management/api/mcp', { serverName: 'ida-pro-mcp' })
    assert.equal(del.status, 409)
    assert.match(del.payload.error, /mounted by the plugin/)
  })
})

test('import takes ownership: refused while the other plugin holds the names, allowed once it lets go', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'mcp-skill-manager'), { recursive: true })
    await writeFile(join(home, 'mcp-skill-manager', 'state.json'), JSON.stringify(FOREIGN_STATE))
    const entries = [entry('msm-mcp-ida-pro-mcp', 'ida-pro-mcp'), entry('msm-mcp-ssh-mcp-server', 'ssh-mcp-server')]
    const { call, created } = setupWithRoutes({ entries })

    // while the other plugin is live, its names are taken
    const preview = await call('GET', '/skills-management/api/mcp/import')
    assert.equal(preview.status, 200)
    assert.equal(preview.payload.importableCount, 0)
    assert.deepEqual(preview.payload.sources[0].candidates.map((c) => c.conflict),
      ['name-taken', 'name-taken'])

    const blocked = await call('POST', '/skills-management/api/mcp/import', {})
    assert.equal(blocked.status, 201)
    assert.deepEqual(blocked.payload.imported, [], 'nothing imported while names are taken')

    // the other plugin is disabled �?its runtime mounts are gone
    entries.length = 0
    const ready = await call('GET', '/skills-management/api/mcp/import')
    assert.equal(ready.payload.importableCount, 2)

    const done = await call('POST', '/skills-management/api/mcp/import', {})
    assert.equal(done.status, 201)
    assert.deepEqual(done.payload.imported, ['ida-pro-mcp', 'ssh-mcp-server'])
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-ida-pro-mcp', 'sm-mcp-ssh-mcp-server'])
    // the response carries the post-import list so the pane can render at once
    assert.deepEqual(done.payload.servers.map((s) => s.serverName), ['ida-pro-mcp', 'ssh-mcp-server'])
    assert.ok(done.payload.servers.every((s) => s.source === 'user' && s.removable))

    // and it is persisted, so a restart keeps them
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state.servers.map((s) => s.serverName), ['ida-pro-mcp', 'ssh-mcp-server'])

    // now that we own them, the other plugin's file no longer offers them
    const again = await call('GET', '/skills-management/api/mcp/import')
    assert.equal(again.payload.importableCount, 0, 're-import must not duplicate')
    assert.deepEqual(again.payload.sources[0].candidates.map((c) => c.conflict),
      ['already-managed', 'already-managed'])

    // and they are removable by us
    const del = await call('DELETE', '/skills-management/api/mcp', { serverName: 'ida-pro-mcp' })
    assert.equal(del.status, 200)
    assert.deepEqual(del.payload.servers.map((s) => s.serverName), ['ssh-mcp-server'])
  })
})

test('import can be told to take only some of the candidates', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'mcp-skill-manager'), { recursive: true })
    await writeFile(join(home, 'mcp-skill-manager', 'state.json'), JSON.stringify(FOREIGN_STATE))
    const { call, created } = setupWithRoutes()
    const r = await call('POST', '/skills-management/api/mcp/import', { serverNames: ['ssh-mcp-server'] })
    assert.equal(r.status, 201)
    assert.deepEqual(r.payload.imported, ['ssh-mcp-server'])
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-ssh-mcp-server'])
  })
})

test('the hand-written local file is mounted at startup and shown read-only', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    // plugin-owned state: one server added on the page, with the same name as a
    // local one so the precedence rule is exercised
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({
      version: 1,
      disabled: [],
      servers: [{ serverName: 'clash', transport: 'stdio', command: 'from-state' }],
    }, null, 2))
    const localText = [
      '{',
      '  // hand-written, with a comment �?the plugin must never rewrite this',
      '  "servers": [',
      '    { "serverName": "jads", "transport": "stdio", "command": "loc", "args": ["--x"] },',
      '    { "serverName": "clash", "transport": "stdio", "command": "from-local" },',
      '  ]',
      '}',
    ].join('\n')
    await writeFile(join(dir, 'mcp.local.jsonc'), localText)

    const { call, created } = setupWithRoutes()
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.localStatus, 'ok')
    const byName = Object.fromEntries(got.payload.servers.map((s) => [s.serverName, s]))
    // exactly one row per name, and the hand-written file wins
    assert.deepEqual(got.payload.servers.map((s) => s.serverName), ['clash', 'jads'])
    assert.equal(byName.jads.source, 'local')
    assert.equal(byName.jads.removable, false)
    assert.equal(byName.clash.source, 'local')
    assert.equal(byName.clash.command, 'from-local')
    // and the duplicate declaration is flagged rather than hidden
    assert.equal(byName.clash.alsoDeclared, true)
    assert.equal(byName.jads.alsoDeclared, false)

    // both local servers were mounted under our own prefix
    assert.deepEqual(created.map((c) => c.id).sort(), ['sm-mcp-clash', 'sm-mcp-jads'])

    // toggling a local row works, and lands in OUR state �?the local file is
    // never written, so its bytes must be identical afterwards
    const toggled = await call('PUT', '/skills-management/api/mcp', { serverName: 'jads', enabled: false })
    assert.equal(toggled.status, 200)
    assert.equal(toggled.payload.servers.find((s) => s.serverName === 'jads').enabled, false)
    const state = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    assert.deepEqual(state.disabled, ['jads'])
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), localText)

    const back = await call('PUT', '/skills-management/api/mcp', { serverName: 'jads', enabled: true })
    assert.equal(back.payload.servers.find((s) => s.serverName === 'jads').enabled, true)

    // the duplicate declaration left in our own state can be cleaned up in one action
    assert.equal(got.payload.duplicateCount, 1)
    const pruned = await call('POST', '/skills-management/api/mcp/prune')
    assert.equal(pruned.status, 200)
    assert.deepEqual(pruned.payload.removed, ['clash'])
    assert.equal(pruned.payload.duplicateCount, 0)
    assert.deepEqual(pruned.payload.servers.map((s) => s.serverName), ['clash', 'jads'])
    assert.ok(pruned.payload.servers.every((s) => s.source === 'local'))
    // the hand-written file is still untouched, and still the live definition
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), localText)
    assert.equal(pruned.payload.servers.find((s) => s.serverName === 'clash').command, 'from-local')
  })
})

test('a local entry parked with "enabled": false can still be switched on', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    const localText = [
      '{',
      '  "servers": [',
      '    { "serverName": "parked", "transport": "stdio", "command": "loc", "enabled": false },',
      '    { "serverName": "live", "transport": "stdio", "command": "loc" },',
      '  ]',
      '}',
    ].join('\n')
    await writeFile(join(dir, 'mcp.local.jsonc'), localText)

    const { call, created, removed } = setupWithRoutes()
    const got = await call('GET', '/skills-management/api/mcp')
    const byName = Object.fromEntries(got.payload.servers.map((s) => [s.serverName, s]))
    // the row is present and off, and the page can say why
    assert.equal(byName.parked.enabled, false)
    assert.equal(byName.parked.enabledInFile, false)
    assert.equal(byName.parked.enabledForced, false)
    assert.equal(byName.live.enabled, true)
    assert.equal(byName.live.enabledInFile, true, 'every other row can be toggled')
    // only the unparked entry was mounted
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-live'])

    // switching it on works anyway: `disabled` cannot express "on", so the page
    // records the override in `forcedOn` and mounts it �?the file is untouched
    const on = await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: true })
    assert.equal(on.status, 200)
    const parkedRow = on.payload.servers.find((s) => s.serverName === 'parked')
    assert.equal(parkedRow.enabled, true)
    assert.equal(parkedRow.enabledForced, true)
    assert.equal(parkedRow.enabledInFile, false, 'the file still says what it said')
    assert.deepEqual(created.map((c) => c.id), ['sm-mcp-live', 'sm-mcp-parked'])
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), localText)
    const state = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    assert.deepEqual(state.forcedOn, ['parked'])
    assert.deepEqual(state.disabled, [])
    // and the override survives a restart of the plugin
    const afterRestart = await setupWithRoutes().call('GET', '/skills-management/api/mcp')
    assert.equal(afterRestart.payload.servers.find((s) => s.serverName === 'parked').enabled, true)

    // switching it back off drops the override and the mount, and the file's own
    // `enabled: false` takes over again
    const off = await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: false })
    assert.equal(off.status, 200)
    const offRow = off.payload.servers.find((s) => s.serverName === 'parked')
    assert.equal(offRow.enabled, false)
    assert.equal(offRow.enabledForced, false)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')).forcedOn, [])
    assert.deepEqual(removed, ['sm-mcp-parked'])
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), localText)
  })
})

test('a broken hand-written file is reported and never blocks the plugin', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mcp.local.jsonc'), '{ "servers": [ /* unterminated')
    const { call } = setupWithRoutes()
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.localStatus, 'corrupt')
    assert.match(got.payload.localError, /unterminated/)
    assert.deepEqual(got.payload.servers, [])
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
