// Behavioural tests for src/mcp-profile.js — the reader/writer of the profile's
// own cordis patch layer. The file it edits is the user's, so every rule here
// is a safety property, not a nicety: outside the markers nothing may change,
// and anything the reader cannot fully account for must abort the write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mcpProfile = require('../src/mcp-profile.js')
const { buildBlock, spliceBlock, parseManagedBlock, parseFlat, locateBlock, isEmptyPatchFile } = mcpProfile.__internals

/** The file dsh ships into a fresh profile. */
const SHIPPED = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const entry = (serverName, extra = {}) => ({
  id: mcpProfile.MANAGED_ID_PREFIX + serverName,
  config: { serverName, transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], ...extra },
})

const readBlock = (text) => {
  const block = locateBlock(text)
  assert.ok(block !== undefined, 'managed block missing')
  return parseManagedBlock(text.slice(block.begin, block.end).split(/\r?\n/))
}

const readConfigs = (text) => readBlock(text).rows
  .filter((row) => row.name === mcpProfile.MCP_PLUGIN)
  .map((row) => ({ id: row.id, config: parseFlat(row.configLines, row.id) }))

// ── bootstrap and splicing ──────────────────────────────────────────────

test('bootstrap replaces the shipped [] line and keeps the header comments', () => {
  const out = spliceBlock(SHIPPED, [entry('github')], [])
  assert.ok(out.includes('# Your patch layer'), 'header comments preserved')
  assert.equal((out.match(/^\[\]$/gm) || []).length, 0, 'the standalone [] must be gone')
  assert.ok(out.trimEnd().endsWith(mcpProfile.END_MARKER), 'block is last')
  assert.deepEqual(readConfigs(out).map((r) => r.id), ['mcp-github'])
})

test('re-splicing replaces the block in place (idempotent)', () => {
  const once = spliceBlock(SHIPPED, [entry('a'), entry('b')], [])
  assert.equal(spliceBlock(once, [entry('a'), entry('b')], []), once)
})

test('content outside the markers survives a rewrite verbatim', () => {
  const first = spliceBlock(SHIPPED, [entry('a')], [])
  const userEdited = first.replace(
    mcpProfile.END_MARKER,
    `${mcpProfile.END_MARKER}\n\n# my own patch below\n- id: my-thing\n  name: '@x/y'\n`)
  const after = spliceBlock(userEdited, [entry('a'), entry('b')], [])
  assert.ok(after.includes('# my own patch below'), 'user comment kept')
  assert.ok(after.includes("- id: my-thing"), 'user patch kept')
  assert.ok(after.includes('mcp-b'), 'new row written')
})

test('a file with its own entries and no markers is never rewritten', () => {
  const own = "- id: something\n  name: '@x/y'\n"
  assert.throws(() => spliceBlock(own, [entry('a')], []), /left untouched|by hand/)
  assert.equal(isEmptyPatchFile(own), false)
})

test('comments-only and empty files bootstrap; CRLF is preserved', () => {
  assert.ok(locateBlock(spliceBlock('# only a comment', [entry('a')], [])) !== undefined)
  assert.ok(locateBlock(spliceBlock('', [entry('a')], [])) !== undefined)
  const crlf = spliceBlock(SHIPPED.replace(/\n/g, '\r\n'), [entry('a')], [])
  assert.ok(crlf.includes('\r\n'), 'CRLF kept')
  assert.ok(!/[^\r]\n/.test(crlf), 'no bare LF introduced')
})

// ── the value round-trip ────────────────────────────────────────────────

test('every config shape round-trips exactly', () => {
  const configs = [
    { id: 'mcp-a', config: { serverName: 'a', transport: 'stdio', command: 'cmd', args: [], env: {}, cwd: 'C:\\x y\\z', toolCallTimeoutMs: 1000, failOnStartupError: true, reconnect: { enabled: false, maxAttempts: 3 } } },
    { id: 'mcp-b', config: { serverName: 'b', transport: 'streamable-http', url: 'https://h/mcp', headers: { Authorization: 'Bearer a b' } } },
    { id: 'mcp-c', config: { serverName: 'c', transport: 'stdio', command: 'npx', args: ['a', 'b c', 'd:e', '#hash'], env: { TOKEN: mcpProfile.jsExpr('process.env.TOKEN'), LIT: 'plain' } } },
  ]
  assert.deepEqual(readConfigs(spliceBlock(SHIPPED, configs, [])), configs)
})

test('values that look like other YAML types are never re-read as them', () => {
  const tricky = {
    id: 'mcp-t',
    config: {
      serverName: 't', transport: 'stdio', command: 'c',
      args: ['true', '123', 'null', '~', '[]', '{}', '- x', 'a: b', '#c', '!!js evil', '  padded  '],
      env: { A: 'true' },
    },
  }
  assert.deepEqual(readConfigs(spliceBlock(SHIPPED, [tricky], [])), [tricky])
})

test('disable rows are emitted after the entries and parsed back', () => {
  const out = spliceBlock(SHIPPED, [entry('a'), entry('b')], ['mcp-b'])
  const parsed = readBlock(out)
  assert.deepEqual([...parsed.disabled], ['mcp-b'])
  assert.deepEqual(parsed.rows.filter((r) => r.name === mcpProfile.MCP_PLUGIN).map((r) => r.id), ['mcp-a', 'mcp-b'])
})

test('foreign !!js expressions are detected (so the block can be made read-only)', () => {
  const bad = spliceBlock(SHIPPED, [{ id: 'mcp-x', config: { serverName: 'x', transport: 'stdio', command: 'c', env: { A: mcpProfile.jsExpr('require("fs").rmSync("/")') } } }], [])
  assert.equal(mcpProfile.__internals.containsForeignJs(parseFlat(readBlock(bad).rows[0].configLines, 'x')), true)
  assert.equal(mcpProfile.__internals.containsForeignJs({ A: mcpProfile.jsExpr('process.env.OK') }), false)
  assert.equal(mcpProfile.__internals.containsForeignJs({ A: mcpProfile.jsExpr("process.env['OK']") }), false)
})

// ── input validation (mirrors dsh-mcp-client's own schema) ──────────────

test('normalizeServerInput builds the exact upstream config shape', () => {
  assert.deepEqual(
    mcpProfile.normalizeServerInput({ serverName: 'gh', transport: 'stdio', command: 'npx', args: 'a\nb\n', env: { T: { js: 'process.env.T' } }, cwd: ' /tmp ' }),
    { serverName: 'gh', transport: 'stdio', command: 'npx', args: ['a', 'b'], env: { T: mcpProfile.jsExpr('process.env.T') }, cwd: '/tmp' })
  assert.deepEqual(
    mcpProfile.normalizeServerInput({ serverName: 'web', transport: 'streamable-http', url: 'http://x/mcp', headers: { A: 'b' }, toolCallTimeoutMs: '5000' }),
    { serverName: 'web', transport: 'streamable-http', url: 'http://x/mcp', headers: { A: 'b' }, toolCallTimeoutMs: 5000 })
})

test('normalizeServerInput refuses what upstream would refuse', () => {
  const bad = [
    [{ serverName: 'has space', transport: 'stdio', command: 'c' }, /serverName/],
    [{ serverName: 'a'.repeat(33), transport: 'stdio', command: 'c' }, /serverName/],
    [{ serverName: 'a', transport: 'nope', command: 'c' }, /transport/],
    [{ serverName: 'a', transport: 'stdio' }, /command is required/],
    [{ serverName: 'a', transport: 'streamable-http', url: 'ftp://x' }, /http\(s\)/],
    [{ serverName: 'a', transport: 'streamable-http', url: 'not a url' }, /not a valid URL/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', env: { '1BAD': 'x' } }, /must match/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', toolCallTimeoutMs: '0' }, /positive integer/],
    [{ serverName: 'a', transport: 'stdio', command: 'c', reconnect: { maxAttempts: -1 } }, /non-negative/],
  ]
  for (const [input, re] of bad) assert.throws(() => mcpProfile.normalizeServerInput(input), re, JSON.stringify(input))
})

test('only the process.env.NAME !!js form is accepted from the API', () => {
  assert.throws(
    () => mcpProfile.normalizeServerInput({ serverName: 'a', transport: 'stdio', command: 'c', env: { X: { js: 'require("child_process").execSync("x")' } } }),
    /process\.env\.NAME/)
  assert.throws(
    () => mcpProfile.normalizeServerInput({ serverName: 'a', transport: 'stdio', command: 'c', env: { X: { js: 'process.env.A || "b"' } } }),
    /process\.env\.NAME/)
})

test('managedId stays unique and consistent with the serverName contract', () => {
  const taken = new Set()
  const first = mcpProfile.managedId('my-server', taken)
  taken.add(first)
  const second = mcpProfile.managedId('my-server', taken)
  assert.equal(first, 'mcp-my-server')
  assert.notEqual(first, second)
  assert.ok(mcpProfile.SERVER_NAME_RE.test('my-server'))
})

// ── filesystem-level read/write ─────────────────────────────────────────

test('readMcpRows + loadState + writeState work against a real profile dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-profile-'))
  const profileDir = join(root, 'profiles', 'demo')
  try {
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [], patchReload: 'live' } } }))
    await writeFile(join(profileDir, 'cordis.patch.yml'), SHIPPED)
    const config = { profileDir }

    const before = await mcpProfile.readMcpRows('demo', config)
    assert.equal(before.fileMissing, false)
    assert.equal(before.markersPresent, false)
    assert.equal(before.canBootstrap, true)
    assert.equal(before.patchReload, 'live')
    assert.deepEqual(before.rows, [])

    const state = await mcpProfile.loadState('demo', config)
    const id = mcpProfile.managedId('github', new Set(state.entries.map((e) => e.id)))
    state.entries.push({ id, config: mcpProfile.normalizeServerInput({ serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }) })
    await mcpProfile.writeState(state, state.entries, state.disabledIds)

    const after = await mcpProfile.readMcpRows('demo', config)
    assert.equal(after.markersPresent, true)
    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0].serverName, 'github')
    assert.equal(after.rows[0].editable, true)
    assert.equal(after.rows[0].enabled, true)
    assert.deepEqual(after.rows[0].args, ['-y', 'pkg'])

    // disable → row still listed but marked disabled, and the config is untouched
    const state2 = await mcpProfile.loadState('demo', config)
    await mcpProfile.writeState(state2, state2.entries, [id])
    const disabled = await mcpProfile.readMcpRows('demo', config)
    assert.equal(disabled.rows[0].enabled, false)
    assert.equal(disabled.rows[0].serverName, 'github')

    // remove → block stays (markers remain) but carries no rows
    const state3 = await mcpProfile.loadState('demo', config)
    await mcpProfile.writeState(state3, state3.entries.filter((e) => e.id !== id), [])
    const removed = await mcpProfile.readMcpRows('demo', config)
    assert.deepEqual(removed.rows, [])
    assert.equal(removed.markersPresent, true)

    // the shipped header comment is still there after every write
    const raw = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.ok(raw.includes('# Your patch layer for this dsh profile'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadState refuses a file that has its own entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-refuse-'))
  const profileDir = join(root, 'profiles', 'demo')
  try {
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), '{}')
    await writeFile(join(profileDir, 'cordis.patch.yml'), "- id: mine\n  name: '@x/y'\n")
    await assert.rejects(() => mcpProfile.loadState('demo', { profileDir }), /will not be rewritten/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing patch file is reported as bootstrap-able, not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-missing-'))
  try {
    const read = await mcpProfile.readMcpRows('demo', { profileDir: join(root, 'profiles', 'demo') })
    assert.equal(read.fileMissing, true)
    assert.equal(read.canBootstrap, true)
    assert.deepEqual(read.rows, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile names are validated before they reach the filesystem', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'node_modules']) {
    assert.throws(() => mcpProfile.profileDirFor(bad), /invalid profile name/)
  }
  assert.ok(mcpProfile.profileDirFor('desktop').endsWith(join('profiles', 'desktop')))
})

// ── the HTTP surface (host routes) ──────────────────────────────────────

const plugin = require('../src/index.js')
const { EventEmitter } = require('node:events')

function setupMcpPlugin(config) {
  let handler
  const ctx = {
    skills: { registerProvider: () => {} },
    webServer: { register: (route) => { handler = route.handler } },
    effect: (fn) => fn(),
    logger: { warn: () => {} },
  }
  plugin.apply(ctx, { installedDir: config.installedDir ?? 'C:/definitely-missing', ...config })
  return async (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = {}
    const out = {}
    const res = {
      writeHead(status) { out.status = status },
      end(chunk) { out.body = chunk === undefined ? '' : String(chunk) },
    }
    if (body !== undefined) setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }, 20)
    await handler(req, res)
    return { status: out.status, payload: out.body ? JSON.parse(out.body) : undefined }
  }
}

async function makeMcpProfile() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-api-'))
  const profileDir = join(root, 'profiles', 'demo')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { '@weibaohui/skills-management': 'link:D:/x' }, dsh: { profile: { bundles: [], patchReload: 'live' } } }))
  await writeFile(join(profileDir, 'cordis.patch.yml'), SHIPPED)
  return { root, profileDir }
}

// ── profile discovery (the Host never says which profile is active) ─────

/** Point DSH_HOME at a temp layout and restore the environment afterwards. */
async function withFakeHome(layout, fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-home-'))
  const prev = { DSH_HOME: process.env.DSH_HOME, APPDATA: process.env.APPDATA, SKILLS_MCP_PROFILE: process.env.SKILLS_MCP_PROFILE }
  try {
    for (const [name, manifest] of Object.entries(layout.profiles ?? {})) {
      const dir = join(root, 'profiles', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    }
    process.env.DSH_HOME = root
    delete process.env.SKILLS_MCP_PROFILE
    if (layout.appData === undefined) delete process.env.APPDATA
    else {
      process.env.APPDATA = join(root, 'appdata')
      await mkdir(join(process.env.APPDATA, 'DSH Desktop', 'profile-selection'), { recursive: true })
      await writeFile(join(process.env.APPDATA, 'DSH Desktop', 'profile-selection', 'state.json'), JSON.stringify(layout.appData))
    }
    return await fn(root)
  } finally {
    if (prev.DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev.DSH_HOME
    if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA
    if (prev.SKILLS_MCP_PROFILE === undefined) delete process.env.SKILLS_MCP_PROFILE; else process.env.SKILLS_MCP_PROFILE = prev.SKILLS_MCP_PROFILE
    await rm(root, { recursive: true, force: true })
  }
}

const withPlugin = () => ({ dependencies: { '@weibaohui/skills-management': 'link:D:/x' } })

test('detectProfile picks the only profile that has this plugin installed', async () => {
  await withFakeHome({ profiles: { desktop: withPlugin(), other: { dependencies: {} } } }, async () => {
    const detected = await mcpProfile.detectProfile()
    assert.equal(detected.name, 'desktop')
    assert.equal(detected.source, 'sole-profile-with-plugin')
    assert.deepEqual(detected.names, ['desktop'])
  })
})

test('detectProfile prefers the Desktop active profile among several plugin installs', async () => {
  await withFakeHome({
    profiles: { desktop: withPlugin(), web: withPlugin() },
    appData: { version: 2, active: 'web' },
  }, async () => {
    const detected = await mcpProfile.detectProfile()
    assert.equal(detected.name, 'web')
    assert.equal(detected.source, 'desktop-active')
  })
})

test('detectProfile refuses to guess when several profiles qualify and none is marked active', async () => {
  await withFakeHome({ profiles: { desktop: withPlugin(), web: withPlugin() } }, async () => {
    const detected = await mcpProfile.detectProfile()
    assert.equal(detected.name, undefined)
    assert.equal(detected.source, 'ambiguous')
    assert.deepEqual(detected.names, ['desktop', 'web'])
  })
})

test('a single profile is used even when no manifest lists the plugin', async () => {
  await withFakeHome({ profiles: { solo: { dependencies: {} } } }, async () => {
    const detected = await mcpProfile.detectProfile()
    assert.equal(detected.name, 'solo')
    assert.equal(detected.source, 'sole-profile')
  })
})

test('resolveProfile honours config.profile over detection, and flags unknown names', async () => {
  await withFakeHome({
    profiles: { desktop: withPlugin(), web: withPlugin() },
    appData: { version: 2, active: 'desktop' },
  }, async () => {
    assert.equal((await mcpProfile.resolveProfile({ profile: 'web' })).name, 'web')
    const unknown = await mcpProfile.resolveProfile({ profile: 'nope' })
    assert.equal(unknown.name, 'nope')
    assert.equal(unknown.unknown, true)
    assert.equal(unknown.detected, 'desktop')
    // an explicitly pinned directory mirrors its basename and is never "unknown"
    const pinned = await mcpProfile.resolveProfile({ profileDir: join(tmpdir(), 'profiles', 'pinned') })
    assert.equal(pinned.name, 'pinned')
    assert.equal(pinned.unknown, undefined)
  })
})

test('activeProfileName keeps its documented precedence', async () => {
  const prev = { SKILLS_MCP_PROFILE: process.env.SKILLS_MCP_PROFILE, DSH_DESKTOP_DEFAULT_PROFILE: process.env.DSH_DESKTOP_DEFAULT_PROFILE }
  try {
    process.env.SKILLS_MCP_PROFILE = 'from-env'
    assert.equal(mcpProfile.activeProfileName(), 'from-env')
    assert.equal(mcpProfile.activeProfileName({ profile: 'explicit' }), 'explicit')
    delete process.env.SKILLS_MCP_PROFILE
    // an explicit name still beats a pinned directory
    assert.equal(mcpProfile.activeProfileName({ profileDir: 'D:/x/profiles/pinned', profile: 'named' }), 'named')
    // with no name, the pinned directory's basename is the profile
    assert.equal(mcpProfile.activeProfileName({ profileDir: 'D:/x/profiles/pinned' }), 'pinned')
    process.env.DSH_DESKTOP_DEFAULT_PROFILE = 'from-desktop'
    assert.equal(mcpProfile.activeProfileName(), 'from-desktop')
    delete process.env.DSH_DESKTOP_DEFAULT_PROFILE
    assert.equal(mcpProfile.activeProfileName(), undefined)
  } finally {
    if (prev.SKILLS_MCP_PROFILE === undefined) delete process.env.SKILLS_MCP_PROFILE; else process.env.SKILLS_MCP_PROFILE = prev.SKILLS_MCP_PROFILE
    if (prev.DSH_DESKTOP_DEFAULT_PROFILE === undefined) delete process.env.DSH_DESKTOP_DEFAULT_PROFILE; else process.env.DSH_DESKTOP_DEFAULT_PROFILE = prev.DSH_DESKTOP_DEFAULT_PROFILE
  }
})

test('GET /api/mcp reports the profile state, then POST/PUT/DELETE manage rows', async () => {
  const { root, profileDir } = await makeMcpProfile()
  try {
    const call = setupMcpPlugin({ mcpProfileDir: profileDir })
    const base = '/skills-management/api/mcp'

    const before = await call('GET', base)
    assert.equal(before.status, 200)
    assert.equal(before.payload.profile, mcpProfile.activeProfileName({ profileDir }))
    assert.equal(before.payload.canWrite, true)
    assert.deepEqual(before.payload.servers, [])
    assert.ok(before.payload.patchFile.includes('cordis.patch.yml'))
    assert.deepEqual(before.payload.warnings, [])

    const created = await call('POST', base, { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: { js: 'process.env.TOKEN' } } })
    assert.equal(created.status, 201)
    assert.equal(created.payload.id, 'mcp-github')
    assert.equal(created.payload.servers.length, 1)
    assert.equal(created.payload.servers[0].serverName, 'github')
    assert.equal(created.payload.servers[0].editable, true)
    assert.deepEqual(created.payload.servers[0].env, { TOKEN: { js: 'process.env.TOKEN' } })

    const dup = await call('POST', base, { serverName: 'github', transport: 'stdio', command: 'x' })
    assert.equal(dup.status, 409)
    assert.match(dup.payload.error, /already exists/)

    const bad = await call('POST', base, { serverName: 'has space', transport: 'stdio', command: 'x' })
    assert.equal(bad.status, 400)

    const updated = await call('PUT', base, { id: 'mcp-github', serverName: 'github', transport: 'streamable-http', url: 'http://localhost:9/mcp', enabled: false })
    assert.equal(updated.status, 200)
    assert.equal(updated.payload.servers[0].transport, 'streamable-http')
    assert.equal(updated.payload.servers[0].enabled, false)

    const reEnabled = await call('PUT', base, { id: 'mcp-github', serverName: 'github', transport: 'streamable-http', url: 'http://localhost:9/mcp', enabled: true })
    assert.equal(reEnabled.payload.servers[0].enabled, true)

    const gone = await call('DELETE', base, { ids: ['mcp-github'] })
    assert.equal(gone.status, 200)
    assert.deepEqual(gone.payload.servers, [])

    const missing = await call('DELETE', base, { id: 'mcp-nope' })
    assert.equal(missing.status, 404)

    // the shipped template's own text survived every write
    const raw = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.ok(raw.includes('# Your patch layer for this dsh profile'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rows the plugin does not own are listed but never rewritten', async () => {
  const { root, profileDir } = await makeMcpProfile()
  try {
    const call = setupMcpPlugin({ mcpProfileDir: profileDir })
    const base = '/skills-management/api/mcp'
    // hand-written row inside the managed block, as a user might add
    await writeFile(join(profileDir, 'cordis.patch.yml'), spliceBlock(SHIPPED, [{ id: 'hand-made', config: { serverName: 'mine', transport: 'stdio', command: 'x', args: [] } }], []))

    const listed = await call('GET', base)
    assert.equal(listed.payload.servers.length, 1)
    assert.equal(listed.payload.servers[0].editable, false)

    const attempt = await call('PUT', base, { id: 'hand-made', serverName: 'mine', transport: 'stdio', command: 'y' })
    assert.equal(attempt.status, 409)
    assert.match(attempt.payload.error, /not managed by this plugin/)

    const del = await call('DELETE', base, { id: 'hand-made' })
    assert.equal(del.status, 409)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a patch file with its own entries reports canWrite:false and refuses writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-foreign-'))
  try {
    const profileDir = join(root, 'profiles', 'demo')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), '{}')
    const own = "- id: mine\n  name: '@x/y'\n"
    await writeFile(join(profileDir, 'cordis.patch.yml'), own)

    const call = setupMcpPlugin({ mcpProfileDir: profileDir })
    const base = '/skills-management/api/mcp'
    const got = await call('GET', base)
    assert.equal(got.status, 200)
    assert.equal(got.payload.canWrite, false)
    assert.equal(got.payload.warnings.length, 1)

    const refused = await call('POST', base, { serverName: 'a', transport: 'stdio', command: 'c' })
    assert.equal(refused.status, 409)
    assert.equal(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'), own, 'file untouched')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid profile name is a 400, and the removed profile surfaces stay 404', async () => {
  const { root, profileDir } = await makeMcpProfile()
  try {
    const call = setupMcpPlugin({ mcpProfileDir: profileDir })
    const bad = await call('GET', '/skills-management/api/mcp?profile=../etc')
    assert.equal(bad.status, 400)
    assert.match(bad.payload.error, /invalid profile name/)

    for (const [method, url] of [
      ['GET', '/skills-management/api/market/status'],
      ['POST', '/skills-management/api/share/run'],
    ]) {
      const gone = await call(method, url, method === 'GET' ? undefined : {})
      assert.equal(gone.status, 404)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The regression that made the pane report "HTTP 400" on a real Desktop: the
// Host does not export DSH_DESKTOP_DEFAULT_PROFILE, so with no mcpProfile
// configured the route used to have no profile at all. It must now infer one.
test('with nothing configured the route infers the profile instead of failing', async () => {
  await withFakeHome({
    profiles: {
      desktop: { dependencies: { '@weibaohui/skills-management': 'link:D:/x' }, dsh: { profile: { patchReload: 'live' } } },
      other: { dependencies: {} },
    },
    appData: { version: 2, active: 'desktop' },
  }, async (home) => {
    await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), SHIPPED)
    const call = setupMcpPlugin({})   // no mcpProfile, no mcpProfileDir
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 200)
    assert.equal(got.payload.profile, 'desktop')
    assert.equal(got.payload.profileSource, 'desktop-active')
    assert.equal(got.payload.canWrite, true)
    assert.deepEqual(got.payload.servers, [])
    // and a write lands in that inferred profile's patch file
    const created = await call('POST', '/skills-management/api/mcp', { serverName: 'gh', transport: 'stdio', command: 'npx' })
    assert.equal(created.status, 201)
    const raw = await readFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.ok(raw.includes('mcp-gh'), 'row written to the inferred profile')
    // the other profile was left alone
    assert.equal(existsSync(join(home, 'profiles', 'other', 'cordis.patch.yml')), false)
  })
})

test('an ambiguous profile is a 409 that names the candidates, not a silent guess', async () => {
  await withFakeHome({
    profiles: {
      a: { dependencies: { '@weibaohui/skills-management': 'link:D:/x' } },
      b: { dependencies: { '@weibaohui/skills-management': 'link:D:/x' } },
    },
  }, async () => {
    const call = setupMcpPlugin({})
    const got = await call('GET', '/skills-management/api/mcp')
    assert.equal(got.status, 409)
    assert.equal(got.payload.reason, 'ambiguous')
    assert.deepEqual(got.payload.profiles.sort(), ['a', 'b'])
    assert.match(got.payload.hint, /profile/)
    // an explicit choice resolves it
    const picked = await call('GET', '/skills-management/api/mcp?profile=b')
    assert.equal(picked.status, 200)
    assert.equal(picked.payload.profile, 'b')
  })
})

test('a requested profile that does not exist is reported, not invented', async () => {
  await withFakeHome({ profiles: { desktop: { dependencies: {} } } }, async () => {
    const call = setupMcpPlugin({})
    const got = await call('GET', '/skills-management/api/mcp?profile=nope')
    assert.equal(got.status, 200)
    assert.equal(got.payload.profile, 'nope')
    assert.equal(got.payload.warnings.length, 1)
    assert.match(got.payload.warnings[0], /does not exist/)
    // writes to a non-existent profile are refused with the candidates
    const put = await call('POST', '/skills-management/api/mcp?profile=nope', { serverName: 'x', transport: 'stdio', command: 'c' })
    assert.equal(put.status, 409)
    assert.deepEqual(put.payload.profiles, ['desktop'])
  })
})
