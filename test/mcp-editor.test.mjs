// Tests for the MCP editing surface: rewriting `mcp.local.jsonc` in place, the
// related-config-file detection (ssh-config.json and friends), the plugin's own
// config-file editor, and the routes that tie them together.
//
// What has to hold:
// - a save rewrites ONLY the entries it changed; comments elsewhere survive;
// - a new entry is appended, a removed one is deleted, and the result parses;
// - an entry whose client config or related file changed is REMOUNTED, which is
//   the whole point: an MCP server reads its own config once, at startup;
// - the file editor refuses anything outside the plugin's own directory and
//   refuses to save a `.json` that would no longer parse;
// - a file that cannot be read back is not silently thrown away by a save.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mcpManager = require('../src/mcp-manager.js')
const mcpFiles = require('../src/mcp-files.js')
const plugin = require('../src/index.js')

const MCP_PLUGIN_NAME = mcpManager.MCP_PLUGIN_NAME

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mcp-edit-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev
    await rm(home, { recursive: true, force: true })
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

async function writeLocal(home, text) {
  const dir = join(home, 'skills-management')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mcp.local.jsonc'), text)
  return { dir, file: join(dir, 'mcp.local.jsonc') }
}

const entry = (id, serverName, extra = {}) => ({
  options: { id, name: MCP_PLUGIN_NAME, config: { serverName, transport: 'stdio', command: 'c', ...extra } },
  fiber: {},
  disabled: false,
})

function setupWithRoutes({ entries = [], schemas = [] } = {}) {
  const created = []
  const removed = []
  const loader = {
    entries: () => entries,
    async create(options) {
      created.push(options)
      entries.push({ options, fiber: {}, disabled: false })
    },
    async remove(id) {
      removed.push(id)
      const at = entries.findIndex((e) => e.options.id === id)
      if (at >= 0) entries.splice(at, 1)
    },
  }
  let handler
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    skills: { registerProvider: () => () => {} },
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    get(name) {
      if (name === 'loader') return loader
      if (name === 'tools') return { schemas: () => schemas }
      return undefined
    },
    effect(callback) {
      const result = typeof callback === 'function' ? callback() : undefined
      return typeof result === 'function' ? result : () => {}
    },
  }
  plugin.apply(ctx, { installedDir: 'C:/definitely-missing-skills' })
  const call = async (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = {}
    const out = {}
    const res = { writeHead(status) { out.status = status }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk) } }
    if (body !== undefined) setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }, 10)
    await handler(req, res)
    return { status: out.status, payload: out.body ? JSON.parse(out.body) : undefined }
  }
  return { ctx, loader, created, removed, call }
}

// ── in-place rewrite ────────────────────────────────────────────────────

const NOTED_FILE = [
  '{',
  '  // keep me: this note is not about any single entry',
  '  "servers": [',
  '    { "serverName": "keep", "transport": "stdio", "command": "c" },  // trailing note',
  '    {',
  '      "serverName": "ssh",',
  '      "transport": "stdio",',
  '      "command": "npx",',
  '      "args": ["-y", "pkg"],',
  '    },',
  '  ],',
  '}',
  '',
].join('\n')

test('a save rewrites only the changed entry and keeps every other byte', () => {
  const desired = [
    { serverName: 'keep', transport: 'stdio', command: 'c' },
    { serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['-y', 'pkg', '--verbose'] },
  ]
  const rewritten = mcpManager.rewriteLocalConfig(NOTED_FILE, desired)
  assert.equal(rewritten.ok, true, rewritten.error)
  assert.equal(rewritten.changed, true)
  assert.ok(rewritten.text.includes('// keep me: this note is not about any single entry'), 'top-level comment survived')
  assert.ok(rewritten.text.includes('{ "serverName": "keep", "transport": "stdio", "command": "c" },  // trailing note'),
    'the untouched entry stayed byte-identical, comment and all')
  assert.ok(rewritten.text.includes('"--verbose"'), 'the changed entry was rewritten')
  assert.equal(mcpManager.parseJsonc(rewritten.text).ok, true)

  // saving the same list again is a no-op, not a reformat
  const again = mcpManager.rewriteLocalConfig(rewritten.text, desired)
  assert.equal(again.ok, true, again.error)
  assert.equal(again.changed, false)
  assert.equal(again.text, rewritten.text)
})

test('an unchanged list never touches the file', () => {
  const local = mcpManager.parseJsonc(NOTED_FILE)
  assert.equal(local.ok, true)
  const result = mcpManager.rewriteLocalConfig(NOTED_FILE, local.value.servers)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.changed, false)
  assert.equal(result.text, NOTED_FILE)
})

test('new entries are appended, removed entries disappear, and the result parses', () => {
  const desired = [{ serverName: 'fresh', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }]
  const rewritten = mcpManager.rewriteLocalConfig(NOTED_FILE, desired)
  assert.equal(rewritten.ok, true, rewritten.error)
  const parsed = mcpManager.parseJsonc(rewritten.text)
  assert.equal(parsed.ok, true, parsed.error)
  assert.deepEqual(parsed.value.servers.map((s) => s.serverName), ['fresh'])
  assert.ok(rewritten.text.includes('// keep me'), 'the document comment is still there')
})

test('enabling a parked name also drops it from the top-level disabled list', () => {
  const doc = [
    '{',
    '  "servers": [',
    '    { "serverName": "parked", "transport": "stdio", "command": "c", "enabled": false },',
    '  ],',
    '  "disabled": ["parked"],',
    '}',
  ].join('\n')
  const rewritten = mcpManager.rewriteLocalConfig(doc, [{ serverName: 'parked', transport: 'stdio', command: 'c', enabled: true }])
  assert.equal(rewritten.ok, true, rewritten.error)
  const parsed = mcpManager.parseJsonc(rewritten.text)
  assert.equal(parsed.ok, true, parsed.error)
  assert.deepEqual(parsed.value.disabled, [])
  assert.equal(parsed.value.servers[0].enabled, undefined, '"enabled": true is the default and is omitted')
})

test('a broken document is refused instead of half-rewritten', () => {
  const broken = '{ "servers": [ { "serverName": "a" } /* unterminated'
  const rewritten = mcpManager.rewriteLocalConfig(broken, [])
  assert.equal(rewritten.ok, false)
  assert.match(rewritten.error, /unterminated/)
})

test('newLocalConfigText starts a file the reader accepts', () => {
  const text = mcpManager.newLocalConfigText([
    { serverName: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'], enabled: true },
    { serverName: 'b', transport: 'streamable-http', url: 'http://h/mcp', enabled: false },
  ])
  const parsed = mcpManager.parseJsonc(text)
  assert.equal(parsed.ok, true, parsed.error)
  assert.deepEqual(parsed.value.servers.map((s) => [s.serverName, s.enabled]), [['a', undefined], ['b', false]],
    'an enabled entry omits "enabled"; a parked one writes it')
  assert.ok(text.includes('//'), 'the header explains the file')
})

// ── related config files ────────────────────────────────────────────────

test('relatedFilesOf finds the config file a stdio server is told to read', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const sshConfig = join(dir, 'ssh-config.json')
    await writeFile(sshConfig, '[]')
    const server = mcpManager.validateServerInput({
      serverName: 'ssh',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg', '--config-file', sshConfig],
    })
    const files = mcpManager.relatedFilesOf(server)
    assert.deepEqual(files.map((f) => f.path), [sshConfig])
    assert.equal(files[0].origin, 'detected')
    assert.equal(files[0].editable, true, 'it lives in the plugin directory, so the editor may open it')

    // a declared path is reported even when detection would miss it
    const declared = mcpManager.validateServerInput({
      serverName: 'custom',
      transport: 'stdio',
      command: 'python',
      args: ['x.py'],
      relatedFiles: [sshConfig],
    })
    assert.deepEqual(mcpManager.relatedFilesOf(declared).map((f) => [f.path, f.origin]), [[sshConfig, 'declared']])

    // a flag or a package spec is not a file
    const plain = mcpManager.validateServerInput({ serverName: 'plain', transport: 'stdio', command: 'npx', args: ['-y', '@scope/pkg'] })
    assert.deepEqual(mcpManager.relatedFilesOf(plain), [])
  })
})

test('the mount fingerprint changes when the server config or a related file does', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const config = join(dir, 'ssh-config.json')
    await writeFile(config, '[{"name":"one"}]')
    const server = mcpManager.validateServerInput({
      serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['--config-file', config],
    })
    const before = mcpManager.serverFingerprint(server)
    assert.equal(mcpManager.serverFingerprint(server), before, 'stable while nothing changes')

    // touch the file the server reads: the process must be rebuilt to see it
    await new Promise((resolve) => setTimeout(resolve, 15))
    await writeFile(config, '[{"name":"one"},{"name":"two"}]')
    assert.notEqual(mcpManager.serverFingerprint(server), before)

    const other = mcpManager.validateServerInput({ serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['--config-file', config, '--verbose'] })
    assert.notEqual(mcpManager.serverFingerprint(other), mcpManager.serverFingerprint(server), 'a changed argument counts too')
  })
})

// ── the plugin's config-file editor ────────────────────────────────────

test('the file list offers the MCP files, including a server config file', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    await writeFile(join(dir, 'ssh-config.json'), '[]')
    const names = mcpFiles.configFileList().map((f) => f.name)
    assert.ok(names.includes('mcp.local.jsonc'))
    assert.ok(names.includes('ssh-config.json'))
    assert.ok(names.includes('mcp.json'), 'listed even before it exists')
    const ssh = mcpFiles.configFileList().find((f) => f.name === 'ssh-config.json')
    assert.equal(ssh.editable, true)
    assert.equal(ssh.exists, true)
  })
})

test('the editor refuses to touch anything outside the plugin directory', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'skills-management'), { recursive: true })
    const outside = join(home, 'settings.yaml')
    await writeFile(outside, 'x: 1\n')
    assert.throws(() => mcpFiles.readConfigFile(outside), /outside/)
    await assert.rejects(async () => mcpFiles.writeConfigFile(outside, 'x: 2\n'), /outside/)
    assert.throws(() => mcpFiles.readConfigFile(join(home, 'skills-management', '..', 'settings.yaml')), /outside/)
    assert.equal(await readFile(outside, 'utf8'), 'x: 1\n', 'the file was never written')
  })
})

test('a .json file must stay strict JSON, and the previous version is kept', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const config = join(dir, 'ssh-config.json')
    await writeFile(config, '[]')
    await assert.rejects(async () => mcpFiles.writeConfigFile(config, '[] // no comments in .json'), /strict JSON/)
    assert.equal(await readFile(config, 'utf8'), '[]', 'a refused save wrote nothing')

    const written = await mcpFiles.writeConfigFile(config, '[{"name":"a"}]')
    assert.equal(written.backup, join(dir, 'ssh-config.json.bak'))
    assert.equal(await readFile(written.backup, 'utf8'), '[]')
    assert.equal(await readFile(config, 'utf8'), '[{"name":"a"}]')
    assert.ok(existsSync(join(dir, '.tmp')) === false, 'the temp file was renamed, not left behind')
    const listing = await readdir(dir)
    assert.ok(!listing.some((name) => name.endsWith('.tmp')), `no temp file left behind: ${listing.join(', ')}`)
  })
})

test('a .jsonc file accepts comments, because the reader tolerates them', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const written = await mcpFiles.writeConfigFile(join(dir, 'mcp.local.jsonc'), '{\n  // note\n  "servers": [],\n}\n')
    assert.equal(written.backup, join(dir, 'mcp.local.jsonc.bak'))
    assert.ok((await readFile(join(dir, 'mcp.local.jsonc'), 'utf8')).includes('// note'))
  })
})

// ── routes ──────────────────────────────────────────────────────────────

test('PUT /mcp/servers writes the file, mounts the new entry and remounts a changed one', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, JSON.stringify({
      servers: [
        { serverName: 'keep', transport: 'stdio', command: 'c' },
        { serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      ],
    }, null, 2))
    const sshConfig = join(dir, 'ssh-config.json')
    await writeFile(sshConfig, '[]')
    const { call, created, removed } = setupWithRoutes()
    await settle()
    assert.deepEqual(created.map((c) => c.id).sort(), ['sm-mcp-keep', 'sm-mcp-ssh'])

    const saved = await call('PUT', '/skills-management/api/mcp/servers', {
      servers: [
        { serverName: 'keep', transport: 'stdio', command: 'c' },
        { serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['--config-file', sshConfig] },
        { serverName: 'fresh', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      ],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.equal(saved.payload.saved.changed, true)
    assert.equal(saved.payload.saved.backup, join(dir, 'mcp.local.jsonc.bak'), 'the old file was kept')
    assert.deepEqual(saved.payload.servers.map((s) => s.serverName), ['fresh', 'keep', 'ssh'])

    // the changed and the new server were (re)mounted, the untouched one was not
    assert.ok(removed.includes('sm-mcp-ssh'), 'the changed server was unmounted first')
    assert.equal(created.filter((c) => c.id === 'sm-mcp-ssh').length, 2)
    assert.equal(created.filter((c) => c.id === 'sm-mcp-keep').length, 1, 'an unchanged server is not bounced')
    assert.equal(created.filter((c) => c.id === 'sm-mcp-fresh').length, 1)

    const onDisk = mcpManager.parseJsonc(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'))
    assert.equal(onDisk.ok, true, onDisk.error)
    assert.deepEqual(onDisk.value.servers.map((s) => s.serverName), ['keep', 'ssh', 'fresh'])
    assert.equal(onDisk.value.servers.find((s) => s.serverName === 'ssh').relatedFiles, undefined)
  })
})

test('PUT /mcp/servers refuses a name the dsh composition already declares', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const { call } = setupWithRoutes({ entries: [entry('mcp-github', 'github')] })
    await settle()
    const before = await readFile(join(dir, 'mcp.local.jsonc'), 'utf8')
    const refused = await call('PUT', '/skills-management/api/mcp/servers', {
      servers: [{ serverName: 'github', transport: 'stdio', command: 'npx' }],
    })
    assert.equal(refused.status, 409)
    assert.match(refused.payload.error, /already declared/)
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), before, 'nothing was written')
  })
})

test('PUT /mcp/servers refuses to drop entries it cannot read', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, JSON.stringify({
      servers: [
        { serverName: 'fine', transport: 'stdio', command: 'npx' },
        { serverName: 'bad name', transport: 'stdio', command: 'npx' },
      ],
    }, null, 2))
    const before = await readFile(join(dir, 'mcp.local.jsonc'), 'utf8')
    const { call } = setupWithRoutes()
    await settle()
    const refused = await call('PUT', '/skills-management/api/mcp/servers', {
      servers: [{ serverName: 'fine', transport: 'stdio', command: 'npx' }],
    })
    assert.equal(refused.status, 400)
    assert.match(refused.payload.error, /cannot be read/)
    assert.equal(await readFile(join(dir, 'mcp.local.jsonc'), 'utf8'), before, 'the unreadable entry is never thrown away')
  })
})

test('saving an entry as enabled drops a stale forced-on override', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({
      servers: [{ serverName: 'parked', transport: 'stdio', command: 'c', enabled: false }],
    }, null, 2))
    const { call } = setupWithRoutes()
    await settle()
    assert.equal((await call('PUT', '/skills-management/api/mcp', { serverName: 'parked', enabled: true })).status, 200)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8')).forcedOn, ['parked'])

    const saved = await call('PUT', '/skills-management/api/mcp/servers', {
      servers: [{ serverName: 'parked', transport: 'stdio', command: 'c', enabled: true }],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    const row = saved.payload.servers.find((s) => s.serverName === 'parked')
    assert.equal(row.enabled, true)
    assert.equal(row.enabledForced, false, 'the file says on, so nothing is being forced')
    const state = JSON.parse(await readFile(join(home, 'skills-management', 'mcp.json'), 'utf8'))
    assert.deepEqual(state.forcedOn, [], 'the override did not outlive the parking it was for')
  })
})

test('POST /mcp/reload rebuilds one server, and reload-all rebuilds every mount', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({
      servers: [
        { serverName: 'one', transport: 'stdio', command: 'c' },
        { serverName: 'two', transport: 'stdio', command: 'c' },
      ],
    }, null, 2))
    const { call, created, removed } = setupWithRoutes()
    await settle()
    assert.equal(created.length, 2)

    const one = await call('POST', '/skills-management/api/mcp/reload', { serverName: 'one' })
    assert.equal(one.status, 200, JSON.stringify(one.payload))
    assert.deepEqual(removed, ['sm-mcp-one'], 'exactly that entry was rebuilt')
    assert.equal(created.filter((c) => c.id === 'sm-mcp-one').length, 2)

    const all = await call('POST', '/skills-management/api/mcp/reload', {})
    assert.equal(all.status, 200)
    assert.equal(all.payload.sync.remounted.length, 2)
    assert.equal(created.length, 5, 'both mounts were rebuilt once more (2 boot + 1 single + 2 all)')

    const unknown = await call('POST', '/skills-management/api/mcp/reload', { serverName: 'nope' })
    assert.equal(unknown.status, 404)
  })
})

test('a parked entry cannot be reloaded until it is switched on', async () => {
  await withHome(async (home) => {
    await writeLocal(home, JSON.stringify({
      servers: [{ serverName: 'parked', transport: 'stdio', command: 'c', enabled: false }],
    }, null, 2))
    const { call } = setupWithRoutes()
    await settle()
    const refused = await call('POST', '/skills-management/api/mcp/reload', { serverName: 'parked' })
    assert.equal(refused.status, 409)
    assert.match(refused.payload.error, /parked/)
  })
})

test('GET /mcp/files and PUT /mcp/file edit a server config file and restart that server', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    const sshConfig = join(dir, 'ssh-config.json')
    await writeLocal(home, JSON.stringify({
      servers: [{ serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['--config-file', sshConfig] }],
    }, null, 2))
    await writeFile(sshConfig, '[]')
    const { call, created, removed } = setupWithRoutes()
    await settle()
    assert.equal(created.length, 1)

    const list = await call('GET', '/skills-management/api/mcp/files')
    assert.equal(list.status, 200)
    assert.ok(list.payload.files.some((f) => f.name === 'ssh-config.json'))
    assert.ok(list.payload.dir.length > 0)

    const read = await call('GET', '/skills-management/api/mcp/file?path=' + encodeURIComponent(sshConfig))
    assert.equal(read.status, 200)
    assert.equal(read.payload.file.text, '[]')

    const written = await call('PUT', '/skills-management/api/mcp/file', {
      path: sshConfig,
      text: '[{"name":"kali","host":"10.0.0.9"}]',
    })
    assert.equal(written.status, 200, JSON.stringify(written.payload))
    assert.equal(written.payload.backup, sshConfig + '.bak')
    assert.equal(written.payload.file.text, '[{"name":"kali","host":"10.0.0.9"}]',
      'the response carries the text the editor should show next')
    assert.equal(await readFile(sshConfig, 'utf8'), '[{"name":"kali","host":"10.0.0.9"}]')
    // the server that reads this file was restarted, so it sees the new host list
    assert.deepEqual(removed, ['sm-mcp-ssh'])
    assert.equal(created.filter((c) => c.id === 'sm-mcp-ssh').length, 2)
  })
})

test('PUT /mcp/file refuses an outside path and a bad .json body', async () => {
  await withHome(async (home) => {
    const { dir } = await writeLocal(home, '{"servers": []}')
    const { call } = setupWithRoutes()
    await settle()
    const outside = await call('PUT', '/skills-management/api/mcp/file', { path: join(home, 'settings.yaml'), text: 'x: 1\n' })
    assert.equal(outside.status, 400)
    assert.match(outside.payload.error, /outside/)
    assert.equal(existsSync(join(home, 'settings.yaml')), false)

    const bad = await call('PUT', '/skills-management/api/mcp/file', { path: join(dir, 'ssh-config.json'), text: 'not json' })
    assert.equal(bad.status, 400)
    assert.match(bad.payload.error, /strict JSON/)
  })
})

test('the related file kept by the plugin is visible on the server row', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    const sshConfig = join(dir, 'ssh-config.json')
    await writeLocal(home, JSON.stringify({
      servers: [{ serverName: 'ssh', transport: 'stdio', command: 'npx', args: ['--config-file', sshConfig] }],
    }, null, 2))
    await writeFile(sshConfig, '[]')
    const { call } = setupWithRoutes()
    await settle()
    const snapshot = await call('GET', '/skills-management/api/mcp')
    const row = snapshot.payload.servers.find((s) => s.serverName === 'ssh')
    assert.equal(row.editable, true)
    assert.equal(row.restartable, true)
    assert.deepEqual(row.relatedFiles.map((f) => [f.origin, f.editable]), [['detected', true]])
  })
})

test('a backup is a file, but not one the editor offers as a config', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'skills-management')
    await writeLocal(home, '{"servers": []}')
    const config = join(dir, 'ssh-config.json')
    await writeFile(config, '[]')
    const written = await mcpFiles.writeConfigFile(config, '[{"name":"a"}]')
    assert.equal(await readFile(written.backup, 'utf8'), '[]')
    const names = mcpFiles.configFileList().map((f) => f.name)
    assert.ok(names.includes('ssh-config.json'))
    assert.ok(!names.includes('ssh-config.json.bak'), 'a backup must not clutter the file list')
    assert.ok((await stat(config)).size >= 2)
  })
})
