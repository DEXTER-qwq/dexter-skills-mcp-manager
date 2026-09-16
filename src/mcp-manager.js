'use strict'

/**
 * MCP manager — plugin-owned state, and the pure logic behind the MCP pane.
 *
 * WHY THIS REPLACES THE OLD APPROACH: the first implementation managed MCP by
 * editing the profile's own `cordis.patch.yml`. That meant guessing which
 * profile was active, hand-writing YAML into a file dsh owns, and only seeing
 * the servers that happened to live in that one file. This module instead
 * follows the loader, which is the actual source of truth:
 *
 * - **Listing** reads `ctx.loader.entries()`, so every configured MCP server is
 *   visible no matter which layer declared it (bundle, profile patch, agent
 *   preset) — nothing is parsed or rewritten.
 * - **Enabling/disabling a configured server** uses the per-agent
 *   `tools.restrict({ deny })` layer: the server keeps running, but its tools
 *   are removed from that agent's catalog. No config file is touched.
 * - **Adding/removing a server** mounts/unmounts a real loader entry named
 *   `@deepseek-ai/dsh-mcp-client`, so it takes effect immediately and exactly
 *   like a configured row.
 *
 * The only thing written to disk is this plugin's own state file:
 *
 *   <DSH_HOME>/skills-management/mcp.json
 *
 * It holds the disabled flags and the user-added servers; reads fall back to an
 * empty state on a missing or corrupt file, and writes are atomic (temp file +
 * rename) and serialized through a promise chain.
 *
 * Runtime dependencies: node: builtins only.
 */

const fsP = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')

/** Loader entry name of the official MCP bridge plugin. */
const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
/** Loader entry id prefix for servers this plugin mounts itself. */
const MANAGED_ENTRY_PREFIX = 'sm-mcp-'
/** Same domain as dsh-mcp-client's own SERVER_NAME_PATTERN. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** `process.env.NAME` / `process.env['NAME']` / `process.env["NAME"]`. */
const JS_ENV_RE = /^process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([^'"\]]+)['"]\])$/
const STATE_VERSION = 1

/**
 * An `env`/`headers` value written as `KEY=${VAR}` in the UI: the user asked to
 * read a host environment variable rather than store a literal. Kept as the
 * canonical `process.env.VAR` expression in state, resolved at mount time.
 */
const envRefName = (value) => {
  if (typeof value !== 'string') return undefined
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim())
  return match === undefined || match === null ? undefined : match[1]
}

// ── store ───────────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? resolve(process.env.DSH_HOME)
    : join(homedir(), '.dsh')
}

const stateDir = () => join(dshHome(), 'skills-management')
const stateFile = () => join(stateDir(), 'mcp.json')

/** Empty state — also the fallback for a missing or unreadable file. */
const emptyState = () => ({ version: STATE_VERSION, disabled: [], servers: [] })

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Normalize an untrusted parsed document. Anything that does not match the
 * expected shape is dropped rather than repaired: this file is small, and a
 * half-understood entry is worse than a missing one.
 */
function normalizeState(raw) {
  if (!isPlainObject(raw)) return emptyState()
  const disabled = Array.isArray(raw.disabled)
    ? [...new Set(raw.disabled.filter((name) => typeof name === 'string' && SERVER_NAME_RE.test(name)))]
    : []
  const servers = []
  const seen = new Set()
  if (Array.isArray(raw.servers)) {
    for (const entry of raw.servers) {
      if (!isPlainObject(entry)) continue
      let validated
      try { validated = validateServerInput(entry) } catch { continue }
      if (seen.has(validated.serverName)) continue
      seen.add(validated.serverName)
      servers.push({ ...validated, enabled: entry.enabled !== false })
    }
  }
  return { version: STATE_VERSION, disabled, servers }
}

/**
 * Create the store. `loadSync` exists because the host `apply()` must stay
 * synchronous (Cordis treats a prototype-bearing function as a constructor and
 * ignores its promise, so an async apply turns a later throw into an unhandled
 * rejection that can take the process down).
 */
function createStore({ logger = console } = {}) {
  let state = emptyState()
  let writeChain = Promise.resolve()

  function loadSync() {
    try {
      state = normalizeState(JSON.parse(readFileSync(stateFile(), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`skills-management: MCP state unreadable (${stateFile()}): ${String(error)}; starting empty`)
      }
      state = emptyState()
    }
    return state
  }

  async function load() {
    try {
      state = normalizeState(JSON.parse(await fsP.readFile(stateFile(), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`skills-management: MCP state unreadable (${stateFile()}): ${String(error)}; starting empty`)
      }
      state = emptyState()
    }
    return state
  }

  const get = () => state

  /** Replace the whole state and persist; serialized, atomic, never poisons the chain. */
  function replace(next) {
    state = normalizeState(next)
    const snapshot = JSON.stringify(state, null, 2)
    writeChain = writeChain.then(async () => {
      await fsP.mkdir(stateDir(), { recursive: true })
      const temp = `${stateFile()}.${process.pid}.${Date.now()}.tmp`
      await fsP.writeFile(temp, snapshot, 'utf8')
      await fsP.rename(temp, stateFile())
    }).catch((error) => {
      logger.error?.(`skills-management: MCP state write failed (${stateFile()}): ${String(error)}`)
    })
    return writeChain
  }

  return { load, loadSync, get, replace, file: stateFile(), dir: stateDir() }
}

// ── validation ──────────────────────────────────────────────────────────

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

/** Accepts an array, or a newline-separated list (one argument per line). */
function normalizeArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  if (typeof raw === 'string') return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (!Array.isArray(raw)) throw new Error('args must be an array of strings')
  return raw.map((item) => {
    if (typeof item !== 'string') throw new Error('args must be an array of strings')
    return item
  })
}

/**
 * `KEY=value` maps. A `KEY=${VAR}` value is stored as `{ js: 'process.env.VAR' }`
 * so it keeps its `!!js` semantics (read the host environment) instead of being
 * frozen to a literal. Only that one expression form is accepted: writing an
 * arbitrary `!!js` expression from a web UI would be code execution.
 */
function normalizeStringMap(raw, label) {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) throw new Error(`${label} must be a mapping of name → value`)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim()
    if (!ENV_NAME_RE.test(name)) throw new Error(`${label} name ${JSON.stringify(key)} must match [A-Za-z_][A-Za-z0-9_]*`)
    if (isPlainObject(value) && typeof value.js === 'string') {
      if (!JS_ENV_RE.test(value.js.trim())) {
        throw new Error(`${label}.${name}: only a process.env.NAME expression is accepted (got "${value.js}")`)
      }
      out[name] = { js: value.js.trim() }
      continue
    }
    if (typeof value !== 'string') throw new Error(`${label}.${name} must be a string`)
    const ref = envRefName(value)
    out[name] = ref === undefined ? value : { js: `process.env.${ref}` }
  }
  return out
}

/**
 * Validate one submitted server into the exact `dsh-mcp-client` config shape.
 * Throws with a user-facing message; never guesses.
 */
function validateServerInput(input) {
  if (!isPlainObject(input)) throw new Error('body must be an MCP server object')
  const serverName = requireString(input.serverName, 'serverName')
  if (!SERVER_NAME_RE.test(serverName)) throw new Error('serverName must match [A-Za-z0-9_-]{1,32}')
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') {
    throw new Error("transport must be 'stdio' or 'streamable-http'")
  }
  const server = { serverName, transport: input.transport }
  if (input.transport === 'stdio') {
    server.command = requireString(input.command, 'command')
    server.args = normalizeArgs(input.args)
    const env = normalizeStringMap(input.env, 'env')
    if (env !== undefined) server.env = env
    if (typeof input.cwd === 'string' && input.cwd.trim() !== '') server.cwd = input.cwd.trim()
  } else {
    const url = requireString(input.url, 'url')
    let parsed
    try { parsed = new URL(url) } catch { throw new Error(`url is not a valid URL: ${url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must be http(s)')
    server.url = url
    const headers = normalizeStringMap(input.headers, 'headers')
    if (headers !== undefined) server.headers = headers
  }
  if (input.toolCallTimeoutMs !== undefined && input.toolCallTimeoutMs !== null && input.toolCallTimeoutMs !== '') {
    const value = Number(input.toolCallTimeoutMs)
    if (!Number.isInteger(value) || value <= 0) throw new Error('toolCallTimeoutMs must be a positive integer (ms)')
    server.toolCallTimeoutMs = value
  }
  return server
}

/**
 * The `dsh-mcp-client` plugin config for one stored server. `failOnStartupError:
 * false` keeps a server that cannot connect from killing the entry, and the
 * reconnect defaults come from the plugin itself.
 */
function mcpClientConfig(server) {
  const base = {
    serverName: server.serverName,
    transport: server.transport,
    toolCallTimeoutMs: typeof server.toolCallTimeoutMs === 'number' ? server.toolCallTimeoutMs : 60000,
    failOnStartupError: false,
  }
  if (server.transport === 'stdio') {
    return {
      ...base,
      command: server.command,
      args: server.args ?? [],
      // `!!js` values must be passed through as expressions, not strings
      env: reviveJsValues(server.env),
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    }
  }
  return { ...base, url: server.url, headers: reviveJsValues(server.headers) }
}

/**
 * Turn stored `{ js: 'process.env.X' }` entries into `!!js` tagged values.
 *
 * The loader parses `cordis.yml`/patch YAML with a `!!js` tag; entries created
 * through `ctx.loader.create()` are handed over as plain JS, so there is
 * nothing to tag — but a literal string "process.env.X" would be passed to the
 * server as a password. So a stored reference is resolved here, at mount time,
 * from the host environment. That keeps the promise the UI makes ("read the
 * host env var") without evaluating arbitrary code.
 */
function reviveJsValues(map) {
  if (!isPlainObject(map)) return {}
  const out = {}
  for (const [key, value] of Object.entries(map)) {
    if (isPlainObject(value) && typeof value.js === 'string') {
      const match = JS_ENV_RE.exec(value.js.trim())
      if (match !== null) {
        const name = match[1] ?? match[2]
        const resolved = process.env[name]
        // Unset variable: skip it rather than passing the expression text through
        if (resolved !== undefined) out[key] = resolved
        continue
      }
    }
    if (typeof value === 'string') out[key] = value
  }
  return out
}

// ── loader / tools helpers (pure; the caller supplies the services) ──────

/** Every configured MCP server the loader knows, in entry order. */
function configuredServers(loader) {
  const out = []
  if (loader === undefined || typeof loader.entries !== 'function') return out
  for (const entry of loader.entries()) {
    const options = entry?.options ?? {}
    if (options.name !== MCP_PLUGIN_NAME) continue
    const id = String(options.id ?? '')
    if (id.startsWith(MANAGED_ENTRY_PREFIX)) continue // our own dynamic mounts
    const config = options.config
    if (!isPlainObject(config) || typeof config.serverName !== 'string') continue
    out.push({ id, config, live: entry.fiber !== undefined && entry.disabled !== true })
  }
  return out
}

/** Live tool names of one server: `mcp__<serverName>__<tool>`. */
function toolsOfServer(schemas, serverName) {
  const prefix = `mcp__${serverName}__`
  return (Array.isArray(schemas) ? schemas : [])
    .map((tool) => tool?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(prefix))
}

/**
 * Exact deny list for the disabled servers against the live tool surface.
 * `tools.restrict` throws on an unknown name, so only names that are currently
 * registered are returned.
 */
function denyNamesForDisabled(disabledNames, schemas) {
  if (disabledNames.length === 0) return []
  const live = (Array.isArray(schemas) ? schemas : [])
    .map((tool) => tool?.name)
    .filter((name) => typeof name === 'string' && name.startsWith('mcp__'))
  const deny = []
  for (const serverName of disabledNames) {
    const prefix = `mcp__${serverName}__`
    for (const name of live) if (name.startsWith(prefix)) deny.push(name)
  }
  return deny
}

/**
 * One server's state, as the API reports it. `source` tells the UI whether the
 * row can be removed here: `configured` rows come from some composition layer
 * (bundle/patch/preset) and are only toggleable; `user` rows were added here.
 *
 * The input is a flat record assembled by {@link listServers} — never a live
 * loader object, so nothing un-serializable can escape through the API.
 */
function publicServer(record) {
  return {
    serverName: record.serverName,
    source: record.userAdded ? 'user' : 'configured',
    entryId: record.id,
    transport: record.transport,
    enabled: record.enabled,
    live: record.live === true,
    toolCount: record.toolCount ?? 0,
    command: record.command,
    args: record.args,
    env: record.env,
    cwd: record.cwd,
    url: record.url,
    headers: record.headers,
    toolCallTimeoutMs: record.toolCallTimeoutMs,
  }
}

/**
 * Merge the two universes into the rows the pane shows.
 *
 * Configured servers come from the loader (every composition layer, nothing
 * parsed); user servers come from this plugin's state. The `enabled` flag for a
 * configured server has no home in a config file, so it is remembered here by
 * serverName — that is exactly what the state file's `disabled` list is for.
 *
 * @param loader - the loader service (may be absent in a minimal composition).
 * @param state - this plugin's state.
 * @param schemas - `ctx.tools.schemas()`, for per-server tool counts.
 */
function listServers(loader, state, schemas) {
  const disabled = new Set(Array.isArray(state?.disabled) ? state.disabled : [])
  const userServers = Array.isArray(state?.servers) ? state.servers : []
  const rows = []
  const seen = new Set()

  for (const entry of configuredServers(loader)) {
    const serverName = entry.config.serverName
    if (seen.has(serverName)) continue
    seen.add(serverName)
    rows.push(publicServer({
      id: entry.id,
      serverName,
      userAdded: false,
      transport: entry.config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      enabled: !disabled.has(serverName),
      live: entry.live,
      toolCount: toolsOfServer(schemas, serverName).length,
      command: entry.config.command,
      args: entry.config.args,
      env: entry.config.env,
      cwd: entry.config.cwd,
      url: entry.config.url,
      headers: entry.config.headers,
      toolCallTimeoutMs: entry.config.toolCallTimeoutMs,
    }))
  }

  // user servers: liveness comes from their loader entry too, so a mount that
  // failed (bad command, port in use) shows as not-live instead of pretending
  const managedIds = new Map()
  if (loader !== undefined && typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      const id = String(entry?.options?.id ?? '')
      if (id.startsWith(MANAGED_ENTRY_PREFIX)) {
        managedIds.set(entry.options.config?.serverName ?? id, entry.fiber !== undefined && entry.disabled !== true)
      }
    }
  }

  for (const server of userServers) {
    if (seen.has(server.serverName)) continue
    seen.add(server.serverName)
    rows.push(publicServer({
      id: MANAGED_ENTRY_PREFIX + server.serverName,
      serverName: server.serverName,
      userAdded: true,
      transport: server.transport,
      enabled: server.enabled !== false,
      live: managedIds.get(server.serverName) === true,
      toolCount: toolsOfServer(schemas, server.serverName).length,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      toolCallTimeoutMs: server.toolCallTimeoutMs,
    }))
  }

  rows.sort((a, b) => a.serverName.localeCompare(b.serverName))
  return rows
}

module.exports = {
  MCP_PLUGIN_NAME,
  MANAGED_ENTRY_PREFIX,
  SERVER_NAME_RE,
  JS_ENV_RE,
  STATE_VERSION,
  dshHome,
  stateDir,
  stateFile,
  createStore,
  normalizeState,
  validateServerInput,
  normalizeArgs,
  normalizeStringMap,
  mcpClientConfig,
  reviveJsValues,
  configuredServers,
  toolsOfServer,
  denyNamesForDisabled,
  listServers,
  publicServer,
  __internals: { emptyState, isPlainObject, envRefName },
}
