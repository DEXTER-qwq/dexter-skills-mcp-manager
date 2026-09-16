'use strict'

/**
 * MCP manager — the pure logic behind the MCP pane.
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
 * - **The hand-written file** `mcp.local.jsonc` is read on every request and
 *   never written: it is the user's file, and it is where the servers live.
 *   Its servers are mounted/unmounted as real loader entries named
 *   `@deepseek-ai/dsh-mcp-client` (`sm-mcp-<name>`), so they take effect exactly
 *   like a configured row.
 *
 * The only thing written to disk is this plugin's own state file:
 *
 *   <DSH_HOME>/skills-management/mcp.json
 *
 * It holds one list, `forcedOn` — the hand-written entries this page switched on
 * although the file parks them. Reads fall back to an empty state on a missing
 * or corrupt file, and writes are atomic (temp file + rename) and serialized
 * through a promise chain.
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
/** Plugin-owned state: written by the plugin only. Strict JSON. */
const stateFile = () => join(stateDir(), 'mcp.json')
/** Hand-written config, one file per user: read by the plugin, NEVER written. */
const localFile = () => join(stateDir(), 'mcp.local.jsonc')

/**
 * Empty state — also the fallback for a missing or unreadable file.
 *
 * The state file holds exactly one thing: `forcedOn`, the server names this page
 * switched ON although the hand-written entry parks itself with
 * `"enabled": false`. Everything else about a server lives in
 * `mcp.local.jsonc`, which the user owns and this plugin never writes.
 *
 * There is no "off" list on purpose: switching a row off from the page would
 * mean overriding a source that says "on", and every on/off decision belongs to
 * a file that already states it. So the page offers exactly what it can honour —
 * forcing a parked entry on, and dropping that override again.
 */
const emptyState = () => ({ forcedOn: [] })

/** The string-list fields of the state file, sanitised identically. */
const nameList = (raw, field) => (Array.isArray(raw?.[field])
  ? [...new Set(raw[field].filter((name) => typeof name === 'string' && SERVER_NAME_RE.test(name)))]
  : [])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Parse a hand-editable JSON document: JSONC comments plus the two separator
 * mistakes people actually make.
 *
 * This exists for `mcp.local.jsonc`, the file a human owns, and for tolerating
 * an older plugin-written `mcp.json` that a human annotated. Three liberties,
 * all of which are the same liberties VS Code takes on `*.jsonc`:
 *
 *  1. `//` line comments and `/* *​/` block comments;
 *  2. a trailing comma before a closing bracket — what you get after commenting
 *     out the last element of an array;
 *  3. a doubled comma `},,`.
 *
 * A *lost* comma between two array elements cannot be recovered here (there is
 * no way to tell `} {` from two adjacent values that were always meant to be
 * separate), and guessing would silently merge or split a user's servers. That
 * case is reported instead, with the offset, so it can be fixed by hand.
 *
 * The scan is quote- and escape-aware because real values here look like syntax:
 * Windows paths (`"D:\\tools"`), URLs (`"http://127.0.0.1:13337/mcp"`), and a
 * literal `//` inside a string must all survive.
 *
 * @returns `{ ok: true, value, hadComments }` or
 *          `{ ok: false, error, hadComments }`.
 */
function parseJsonc(input) {
  const text = String(input)
  let out = ''
  let hadComments = false
  let quote = null
  let escape = false

  /** Index of the next character that is not whitespace and not a comment. */
  const nextMeaningful = (from) => {
    let j = from
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < text.length && text[j] !== '\n') j += 1
        continue
      }
      if (text[j] === '/' && text[j + 1] === '*') {
        const end = text.indexOf('*/', j + 2)
        if (end === -1) return { index: -1, char: undefined }
        j = end + 2
        continue
      }
      return { index: j, char: text[j] }
    }
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (escape) { escape = false; out += ch; continue }
    if (quote !== null) {
      if (ch === '\\') { escape = true; out += ch; continue }
      if (ch === quote) quote = null
      out += ch
      continue
    }
    if (ch === '"') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') {
      hadComments = true
      i += 1
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      hadComments = true
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return { ok: false, hadComments, error: 'unterminated /* comment' }
      i = end + 1
      continue
    }
    if (ch === ',') {
      const after = nextMeaningful(i + 1)
      // trailing before a closer, or doubled → drop it
      if (after.char === ']' || after.char === '}' || after.char === ',') continue
    }
    out += ch
  }

  try {
    return { ok: true, value: JSON.parse(out), hadComments }
  } catch (error) {
    const offset = Number(/(?:position|at position)\s+(\d+)/.exec(error.message)?.[1] ?? NaN)
    const hint = Number.isInteger(offset)
      ? ` near ${JSON.stringify(text.slice(Math.max(0, offset - 30), offset + 12))}`
      : ''
    return { ok: false, hadComments, error: `${error.message}${hint}` }
  }
}

/**
 * Read the hand-written config. Anything wrong with it is a status, never a
 * throw: the plugin must keep working with a broken local file, and the UI has
 * to be able to say what is wrong.
 *
 * @returns `{ servers, file, status, error }` where status is
 *          'ok' | 'missing' | 'empty' | 'corrupt'. `servers` is always an array.
 */
function readLocalConfig(file = localFile()) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { servers: [], file, status: error?.code === 'ENOENT' ? 'missing' : 'corrupt', error: String(error?.message ?? error) }
  }
  const parsed = parseJsonc(raw)
  if (!parsed.ok) return { servers: [], file, status: 'corrupt', error: parsed.error }
  // Accept both shapes: a bare array, or an object with `servers` (+ optional
  // `disabled`, so a hand-written file can park an entry without comments).
  const document = parsed.value
  const list = Array.isArray(document) ? document
    : isPlainObject(document) && Array.isArray(document.servers) ? document.servers
      : undefined
  if (list === undefined) {
    return { servers: [], file, status: 'corrupt', error: 'expected an array of servers, or an object with a "servers" array' }
  }
  const disabled = new Set(isPlainObject(document) && Array.isArray(document.disabled)
    ? document.disabled.filter((name) => typeof name === 'string')
    : [])
  const servers = []
  const invalid = []
  for (const entry of list) {
    try {
      const config = validateServerInput(entry)
      servers.push({ ...config, enabled: entry.enabled !== false && !disabled.has(config.serverName) })
    } catch (error) {
      invalid.push({ serverName: isPlainObject(entry) ? entry.serverName : undefined, reason: String(error?.message ?? error) })
    }
  }
  return {
    servers,
    file,
    status: servers.length === 0 && invalid.length === 0 ? 'empty' : 'ok',
    invalid,
    hadComments: parsed.hadComments,
  }
}

/**
 * Normalize an untrusted parsed document. Anything that does not match the
 * expected shape is dropped rather than repaired: this file is small, and a
 * half-understood entry is worse than a missing one.
 *
 * The reader understands exactly one key. Older state files also carried
 * `version`, `disabled` and `servers` (page-added servers were retired in favour
 * of hand-written config); those keys are ignored, and {@link legacyStateKeys}
 * reports the ones that still hold something so the page can say so instead of
 * letting the data disappear without a word.
 */
function normalizeState(raw) {
  if (!isPlainObject(raw)) return emptyState()
  return { forcedOn: nameList(raw, 'forcedOn') }
}

/** Retired state keys that still hold content, for the one-time notice. */
function legacyStateKeys(raw) {
  if (!isPlainObject(raw)) return undefined
  const out = {}
  if (Array.isArray(raw.disabled) && raw.disabled.length > 0) out.disabled = raw.disabled.length
  if (Array.isArray(raw.servers) && raw.servers.length > 0) out.servers = raw.servers.length
  return Object.keys(out).length === 0 ? undefined : out
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
  let tempSeq = 0
  /** How the last load went: 'ok' | 'missing' | 'empty' | 'corrupt'. */
  let loadStatus = { status: 'ok' }

  /**
   * Read + parse + normalize the plugin-owned file.
   *
   * Strict JSON is the format this file is written in; JSONC is merely
   * tolerated on read, because a user may have annotated it before the
   * hand-written file existed. The tolerance is never written back — that would
   * silently reformat someone's annotations — so this file stays exactly as it
   * is found unless the plugin itself has a state change to persist.
   */
  function ingest(rawText) {
    const parsed = parseJsonc(rawText)
    if (!parsed.ok) {
      loadStatus = { status: 'corrupt', error: parsed.error }
      logger.warn?.(`skills-management: MCP state unreadable (${stateFile()}): ${loadStatus.error}`)
      return state
    }
    state = normalizeState(parsed.value)
    loadStatus = {
      status: state.forcedOn.length === 0 ? 'empty' : 'ok',
      // the file was read through comments/stray commas; it was NOT rewritten
      tolerated: parsed.hadComments === true ? 'comments' : undefined,
      legacy: legacyStateKeys(parsed.value),
    }
    return state
  }

  function loadSync() {
    let raw
    try {
      raw = readFileSync(stateFile(), 'utf8')
    } catch (error) {
      loadStatus = { status: error?.code === 'ENOENT' ? 'missing' : 'corrupt', error: String(error?.message ?? error) }
      state = emptyState()
      return state
    }
    return ingest(raw)
  }

  async function load() {
    let raw
    try {
      raw = await fsP.readFile(stateFile(), 'utf8')
    } catch (error) {
      loadStatus = { status: error?.code === 'ENOENT' ? 'missing' : 'corrupt', error: String(error?.message ?? error) }
      state = emptyState()
      return state
    }
    return ingest(raw)
  }

  const get = () => state
  const status = () => loadStatus

  /** Replace the whole state and persist; serialized, atomic, never poisons the chain. */
  function replace(next) {
    state = normalizeState(next)
    const snapshot = JSON.stringify(state, null, 2)
    writeChain = writeChain.then(async () => {
      await fsP.mkdir(stateDir(), { recursive: true })
      // unique per write: a bare pid+Date.now() collides when two writes land in
      // the same millisecond, and a shared temp path defeats the atomic rename
      tempSeq += 1
      const temp = `${stateFile()}.${process.pid}.${Date.now()}.${tempSeq}.tmp`
      await fsP.writeFile(temp, snapshot, 'utf8')
      try {
        await fsP.rename(temp, stateFile())
      } catch (error) {
        // Windows can refuse a rename onto an existing file; clear the way and
        // retry once rather than leaving the write half-done
        if (error?.code === 'EPERM' || error?.code === 'EEXIST' || error?.code === 'EACCES') {
          await fsP.rm(stateFile(), { force: true })
          await fsP.rename(temp, stateFile())
        } else {
          throw error
        }
      }
    }).catch((error) => {
      logger.error?.(`skills-management: MCP state write failed (${stateFile()}): ${String(error)}`)
    })
    return writeChain
  }

  /**
   * Re-read from disk and report whether anything actually changed.
   *
   * The state file is a normal file: it can be renamed, restored from a backup
   * or written by hand while dsh is running. Without this the store would keep
   * whatever it read at startup and the page would report "nothing configured"
   * for a file that plainly has servers.
   */
  function reload() {
    const previous = state
    loadSync()
    return {
      changed: JSON.stringify(previous) !== JSON.stringify(state),
      previous,
      next: state,
    }
  }

  return { load, loadSync, reload, get, status, replace, file: stateFile(), dir: stateDir() }
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

/**
 * Which plugin owns a dynamic loader entry, judged by its id.
 *
 * A composed row (bundle / profile patch / agent preset) has a plain
 * human-chosen id like `mcp-github`. A row a plugin mounted at runtime carries
 * that plugin's own prefix — `sm-mcp-` for us, `msm-mcp-` for
 * dsh-skills-mcp-group-manager — and only its owner may create or remove it.
 * `owner` is `undefined` for composed rows, `'self'` for ours, and `'other'`
 * (with the raw prefix) for another plugin's.
 */
function entryOwner(id) {
  if (typeof id !== 'string' || id === '') return { owner: undefined }
  if (id.startsWith(MANAGED_ENTRY_PREFIX)) return { owner: 'self', prefix: MANAGED_ENTRY_PREFIX }
  const match = /^(.*?-mcp-)/.exec(id)
  if (match === null) return { owner: undefined }
  return { owner: 'other', prefix: match[1], plugin: FOREIGN_PREFIX_HINTS[match[1]] }
}

/** Prefix → plugin, only for the ones we have actually seen in the wild. */
const FOREIGN_PREFIX_HINTS = { 'msm-mcp-': 'dsh-skills-mcp-group-manager' }

/** Every MCP server the loader knows that this plugin should list. */
function loaderServers(loader) {
  const out = []
  if (loader === undefined || typeof loader.entries !== 'function') return out
  for (const entry of loader.entries()) {
    const options = entry?.options ?? {}
    if (options.name !== MCP_PLUGIN_NAME) continue
    const id = String(options.id ?? '')
    const config = options.config
    if (!isPlainObject(config) || typeof config.serverName !== 'string') continue
    out.push({
      id,
      config,
      ...entryOwner(id),
      live: entry.fiber !== undefined && entry.disabled !== true,
    })
  }
  return out
}

/**
 * The mounted entry for one serverName, whoever owns it. Used to refuse a mount
 * that would collide: `dsh-mcp-client` rejects a duplicate `serverName` in the
 * same scope, so two plugins both trying to mount `ida-pro-mcp` would make one
 * of them fail at startup.
 */
function mountedBy(loader, serverName) {
  for (const entry of loaderServers(loader)) {
    if (entry.config.serverName !== serverName) continue
    return { owner: entry.owner, prefix: entry.prefix, plugin: entry.plugin, id: entry.id }
  }
  return undefined
}

/** Live tool names of one server: `mcp__<serverName>__<tool>`. */
function toolsOfServer(schemas, serverName) {
  const prefix = `mcp__${serverName}__`
  return (Array.isArray(schemas) ? schemas : [])
    .map((tool) => tool?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(prefix))
}

/**
 * One server's state, as the API reports it.
 *
 * `source` decides what the row offers:
 * - `configured` — declared by a composition layer (bundle / profile patch /
 *   preset). Its config belongs to the user's dsh setup, so the row reports it.
 * - `foreign` — mounted at runtime by ANOTHER plugin. Removing or replacing it
 *   is that plugin's business, so the row is read-only here.
 * - `local` — declared in the hand-written `mcp.local.jsonc`, which this plugin
 *   never writes. `switchable` says whether this page's switch means anything
 *   for it: only a parked entry (`"enabled": false`) can be forced on.
 *
 * The input is a flat record assembled by {@link listServers} — never a live
 * loader object, so nothing un-serializable can escape through the API.
 */
function publicServer(record) {
  return {
    serverName: record.serverName,
    source: record.source,
    entryId: record.id,
    transport: record.transport,
    enabled: record.enabled,
    // false for a hand-written entry that parks itself with `"enabled": false`
    enabledInFile: record.enabledInFile !== false,
    // true when this page forced such an entry on, overriding the file
    enabledForced: record.enabledForced === true,
    // whether this page's switch can do anything for the row
    switchable: record.switchable === true,
    live: record.live === true,
    // true when another source declares this same name: the others are ignored,
    // because dsh-mcp-client refuses a duplicate serverName
    alsoDeclared: record.alsoDeclared === true,
    owner: record.ownerPlugin,
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
 * - **configured / foreign** — read from the loader. Always on as far as this
 *   plugin is concerned: a layer that wants one off says so in its own config.
 * - **local** — the hand-written `mcp.local.jsonc`. The plugin only ever reads
 *   that file, so its per-entry `enabled` is the default and the state file's
 *   `forcedOn` list is this page's override. A row is switchable exactly when
 *   the file parks it — otherwise there is nothing for the page to override.
 *
 * A name declared in more than one place resolves composed/foreign > local, and
 * the shadowed row is reported (`alsoDeclared: true`) rather than silently
 * dropped — a duplicate serverName would otherwise make `dsh-mcp-client` fail.
 *
 * @param loader - the loader service (may be absent in a minimal composition).
 * @param state - this plugin's state (just `forcedOn`).
 * @param schemas - `ctx.tools.schemas()`, for per-server tool counts.
 * @param local - `readLocalConfig()` output, or undefined when unavailable.
 */
function listServers(loader, state, schemas, local) {
  const forcedOn = new Set(Array.isArray(state?.forcedOn) ? state.forcedOn : [])
  const localServers = Array.isArray(local?.servers) ? local.servers : []
  const rows = []
  const loaderRows = loaderServers(loader)

  // Exactly one row per serverName, resolved by precedence:
  //   composed/foreign (innermost truth) > hand-written file.
  // The owner map decides the label up front so emission order cannot matter.
  const ownerOf = new Map()
  for (const server of localServers) ownerOf.set(server.serverName, 'local')
  for (const entry of loaderRows) {
    if (entry.owner !== 'self') ownerOf.set(entry.config.serverName, entry.owner === 'other' ? 'foreign' : 'configured')
  }
  const emitted = new Set()
  // Which DECLARING sources use each name. Our own loader mounts are excluded:
  // they are the consequence of a declaration, not a second one.
  const declaredBy = new Map()
  const declare = (name, source) => {
    const set = declaredBy.get(name) ?? new Set()
    set.add(source)
    declaredBy.set(name, set)
  }
  for (const server of localServers) declare(server.serverName, 'local')
  for (const entry of loaderRows) {
    if (entry.owner === 'self') continue
    declare(entry.config.serverName, entry.owner === 'other' ? 'foreign' : 'configured')
  }
  const push = (record) => {
    if (emitted.has(record.serverName)) return
    emitted.add(record.serverName)
    rows.push(publicServer({
      ...record,
      alsoDeclared: (declaredBy.get(record.serverName)?.size ?? 0) > 1,
    }))
  }

  // A server this plugin mounts also appears in the loader under our own prefix;
  // its provenance is the file that declared it, so our own loader rows are not
  // emitted directly — the declaring file's pass below emits them, which is what
  // gives them the right `source` and its `removable` flag.
  const ownEntries = new Map()
  for (const entry of loaderRows) {
    if (entry.owner === 'self') ownEntries.set(entry.config.serverName, entry)
  }

  // 1) rows we do not own: composed and other plugins'. This page cannot switch
  // them off — their own config says "on" — so it does not offer to.
  for (const entry of loaderRows) {
    if (entry.owner === 'self') continue
    push({
      id: entry.id,
      serverName: entry.config.serverName,
      source: entry.owner === 'other' ? 'foreign' : 'configured',
      ownerPlugin: entry.plugin,
      transport: entry.config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      enabledInFile: true,
      switchable: false,
      enabled: true,
      live: entry.live,
      toolCount: toolsOfServer(schemas, entry.config.serverName).length,
      command: entry.config.command,
      args: entry.config.args,
      env: entry.config.env,
      cwd: entry.config.cwd,
      url: entry.config.url,
      headers: entry.config.headers,
      toolCallTimeoutMs: entry.config.toolCallTimeoutMs,
    })
  }

  // 2) the hand-written file: its own `enabled` is the default, and the state
  // file's `forcedOn` list is this page's override. Only a parked entry can be
  // switched here — for an entry the file says is on there is nothing this page
  // could write that would mean "off".
  for (const server of localServers) {
    if (ownerOf.get(server.serverName) !== 'local') continue
    const own = ownEntries.get(server.serverName)
    const inFile = server.enabled !== false
    const forced = forcedOn.has(server.serverName)
    push({
      id: own === undefined ? `local:${server.serverName}` : own.id,
      serverName: server.serverName,
      source: 'local',
      transport: server.transport,
      enabledInFile: inFile,
      enabledForced: forced,
      switchable: !inFile,
      enabled: forced || inFile,
      live: own !== undefined && own.live,
      toolCount: toolsOfServer(schemas, server.serverName).length,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      toolCallTimeoutMs: server.toolCallTimeoutMs,
    })
  }

  // 3) our own mount whose entry the file no longer declares (edited by hand
  // while dsh was running) is still reported, so a live server cannot vanish
  for (const entry of ownEntries.values()) {
    push({
      id: entry.id,
      serverName: entry.config.serverName,
      source: 'local',
      transport: entry.config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      enabledInFile: true,
      enabledForced: false,
      switchable: false,
      enabled: true,
      live: entry.live,
      toolCount: toolsOfServer(schemas, entry.config.serverName).length,
      command: entry.config.command,
      args: entry.config.args,
      env: entry.config.env,
      cwd: entry.config.cwd,
      url: entry.config.url,
      headers: entry.config.headers,
      toolCallTimeoutMs: entry.config.toolCallTimeoutMs,
    })
  }

  rows.sort((a, b) => a.serverName.localeCompare(b.serverName))
  return rows
}

/**
 * Every server this plugin should mount: the hand-written file's entries that are
 * on, where "on" is the file's own `enabled` unless this page forced the name on
 * through `forcedOn`.
 *
 * Composed and foreign rows are not returned — they are already mounted by their
 * own layer, and `dsh-mcp-client` rejects a duplicate `serverName`. The caller
 * skips names another layer declares for the same reason.
 *
 * @returns copies tagged with `source: 'local'`.
 */
function mountableServers(state, local) {
  const out = []
  const forcedOn = new Set(Array.isArray(state?.forcedOn) ? state.forcedOn : [])
  for (const server of Array.isArray(local?.servers) ? local.servers : []) {
    if (server.enabled === false && !forcedOn.has(server.serverName)) continue
    out.push({ ...server, source: 'local' })
  }
  return out
}

module.exports = {
  MCP_PLUGIN_NAME,
  MANAGED_ENTRY_PREFIX,
  SERVER_NAME_RE,
  JS_ENV_RE,
  dshHome,
  stateDir,
  stateFile,
  localFile,
  createStore,
  normalizeState,
  validateServerInput,
  normalizeArgs,
  normalizeStringMap,
  mcpClientConfig,
  reviveJsValues,
  loaderServers,
  entryOwner,
  mountedBy,
  readLocalConfig,
  parseJsonc,
  toolsOfServer,
  listServers,
  mountableServers,
  publicServer,
  __internals: { emptyState, isPlainObject, envRefName },
}
