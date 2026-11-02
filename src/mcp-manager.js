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
const { readFileSync, statSync } = require('node:fs')
const { join, resolve, sep } = require('node:path')
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

/** At most this many extra config files may be attached to one server. */
const RELATED_FILES_LIMIT = 16

/**
 * What the page shows as a "config file": the extensions a human would open and
 * edit. A detected path that is an executable or a tool's own script still
 * counts for the fingerprint (editing it should restart the server) but is not
 * listed as a config — `python.exe` beside `jadx_mcp_server.py` is noise, not a
 * configuration.
 */
const CONFIG_FILE_RE = /\.(jsonc?|ya?ml|toml|ini|conf|cfg|env|properties|txt)$/i
const looksLikeConfigFile = (file) => CONFIG_FILE_RE.test(String(file))

/**
 * `relatedFiles`: files the server *itself* reads at startup (ssh-mcp-server and
 * its `--config-file`), as opposed to the entry that starts it.
 *
 * They are stored in this plugin's own entry format and are **not** part of the
 * `dsh-mcp-client` config (which is strict), so {@link mcpClientConfig} strips
 * them. Two jobs: the pane shows them next to the server and opens them in its
 * file editor, and their stat joins the mount fingerprint — so editing such a
 * file and pressing save restarts exactly the servers that read it.
 */
function normalizeRelatedFiles(raw) {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') throw new Error('relatedFiles must be an array of file paths')
    const value = item.trim()
    if (value === '') continue
    if (value.includes('\0')) throw new Error('relatedFiles: a path may not contain a NUL byte')
    if (!out.includes(value)) out.push(value)
  }
  if (out.length > RELATED_FILES_LIMIT) {
    throw new Error(`relatedFiles accepts at most ${RELATED_FILES_LIMIT} paths`)
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
  const relatedFiles = normalizeRelatedFiles(input.relatedFiles)
  if (relatedFiles.length > 0) server.relatedFiles = relatedFiles
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

// ── related config files & mount fingerprint ────────────────────────────

/** Absolute path on this platform: `C:\…`, `\\server\share\…` or `/…`. */
function isAbsoluteFilePath(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || (value.startsWith('/') && !value.startsWith('//')))
}

/** Strip the quotes a hand-written arg may carry: `"C:\a b\x.json"`. */
function unquoteArg(value) {
  const text = String(value).trim()
  if (text.length >= 2 && ((text[0] === '"' && text.endsWith('"')) || (text[0] === "'" && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/** `~/x` / `~\x` → an absolute path under the home directory. */
function expandTildePath(value) {
  const text = unquoteArg(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function statFile(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat : undefined
  } catch { return undefined }
}

/** `~`-folded absolute path, for display only. */
function displayPath(p) {
  const home = homedir()
  if (typeof p !== 'string' || p === '') return ''
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  return p
}

/** True when `file` sits directly inside this plugin's own state directory. */
function isInsideStateDir(file) {
  const dir = resolve(stateDir())
  if (typeof file !== 'string' || file === '') return false
  if (process.platform === 'win32') return file.toLowerCase().startsWith(dir.toLowerCase() + sep)
  return file.startsWith(dir + sep)
}

/**
 * The config files a server reads itself.
 *
 * Two sources, because neither alone is enough:
 * - **declared** — `relatedFiles` in the entry, written through the pane;
 * - **detected** — an absolute path among `command`/`args` that names an
 *   existing file. `npx -y pkg --config-file C:\…\ssh-config.json` is exactly
 *   this shape, so the ssh case needs no extra configuration.
 *
 * Detection is deliberately conservative: only absolute paths, only existing
 * files, never a bare package spec or a flag (`-y`, `@scope/pkg`).
 */
function relatedFilesOf(server) {
  const config = isPlainObject(server) ? server : {}
  const out = []
  const seen = new Set()
  const push = (rawPath, origin) => {
    const file = expandTildePath(rawPath)
    if (!isAbsoluteFilePath(file)) return
    const key = process.platform === 'win32' ? file.toLowerCase() : file
    if (seen.has(key)) return
    const stat = statFile(file)
    // A detected path only counts when it exists (it came from the command line,
    // which may just as well be an option). A declared one is shown anyway, so a
    // file that has to be created yet can still be opened and written.
    if (stat === undefined && origin !== 'declared') return
    seen.add(key)
    out.push({
      path: file,
      display: displayPath(file),
      origin,
      exists: stat !== undefined,
      size: stat === undefined ? 0 : stat.size,
      modifiedAt: stat === undefined ? undefined : stat.mtime.toISOString(),
      mtimeMs: stat === undefined ? 0 : stat.mtimeMs,
      // only files this plugin owns may be opened in the page's editor
      editable: isInsideStateDir(file),
      // declared files are always listed; a detected one only when it looks like
      // something a human configures (the rest still feed the fingerprint)
      shown: origin === 'declared' || looksLikeConfigFile(file),
    })
  }
  for (const declared of normalizeRelatedFiles(config.relatedFiles)) push(declared, 'declared')
  if (config.transport === 'stdio') {
    for (const candidate of [config.command, ...(Array.isArray(config.args) ? config.args : [])]) push(candidate, 'detected')
  }
  return out
}

/**
 * What a mount was built from: the client config plus the stat of every file
 * that config points at.
 *
 * `syncLocalMcpMounts` remounts a server whose fingerprint changed, which is
 * what makes "edit the entry / edit ssh-config.json, press save" restart the
 * process — the MCP client reads its own config once, at startup.
 */
function serverFingerprint(server) {
  const files = relatedFilesOf(server).map((file) => [file.path, file.size, file.mtimeMs])
  return JSON.stringify({ config: mcpClientConfig(server), files })
}

// ── rewriting the hand-written file in place ────────────────────────────

/**
 * JSONC tokenizer: punctuation, strings, and bare literals with byte offsets,
 * comments skipped. It is the basis of the in-place editor: the pane rewrites
 * **only the entries it actually changed**, so every other line — comments,
 * blank lines, the author's own alignment, trailing commas — stays exactly as
 * written.
 */
function scanJsoncTokens(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) { i += 1; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return { ok: false, error: 'unterminated /* comment' }
      i = end + 2
      continue
    }
    if (ch === '"') {
      const start = i
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '"') { i += 1; break }
        i += 1
      }
      if (text[i - 1] !== '"' || i - 1 === start) return { ok: false, error: `unterminated string at ${start}` }
      tokens.push({ type: 'string', start, end: i, raw: text.slice(start, i) })
      continue
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, start: i, end: i + 1 })
      i += 1
      continue
    }
    const start = i
    while (i < text.length && !/[\s,\]}:]/.test(text[i])) i += 1
    if (i === start) return { ok: false, error: `unexpected character ${JSON.stringify(ch)} at ${start}` }
    tokens.push({ type: 'literal', start, end: i, raw: text.slice(start, i) })
  }
  return { ok: true, tokens }
}

/** String value of a token, or undefined when it is not a string. */
function tokenStringValue(token) {
  if (token === undefined || token.type !== 'string') return undefined
  try { return JSON.parse(token.raw) } catch { return undefined }
}

/**
 * Structural parse: enough of the document to know where every value sits.
 *
 * `{ ok: true, root, tokens }` where a node is
 * `{ type: 'object'|'array'|'scalar', start, end, props?, items? }`.
 */
function parseJsoncTree(text) {
  const scanned = scanJsoncTokens(String(text))
  if (!scanned.ok) return scanned
  const tokens = scanned.tokens
  let index = 0
  const fail = (message) => ({ ok: false, error: message })

  function node() {
    const token = tokens[index]
    if (token === undefined) return fail('unexpected end of document')
    if (token.type === 'string' || token.type === 'literal') {
      index += 1
      return { ok: true, node: { type: 'scalar', start: token.start, end: token.end, token } }
    }
    if (token.type !== 'punct') return fail(`unexpected token at ${token.start}`)
    if (token.value === '{') return objectNode()
    if (token.value === '[') return arrayNode()
    return fail(`unexpected ${JSON.stringify(token.value)} at ${token.start}`)
  }

  function objectNode() {
    const start = tokens[index].start
    index += 1
    const props = []
    for (;;) {
      const token = tokens[index]
      if (token === undefined) return fail('unterminated object')
      if (token.type === 'punct' && token.value === '}') { index += 1; return { ok: true, node: { type: 'object', start, end: token.end, props } } }
      if (token.type !== 'string') return fail(`expected a key at ${token.start}`)
      const key = tokenStringValue(token)
      index += 1
      const colon = tokens[index]
      if (colon === undefined || colon.type !== 'punct' || colon.value !== ':') return fail(`expected ':' at ${token.end}`)
      index += 1
      const value = node()
      if (!value.ok) return value
      props.push({ key, keyToken: token, value: value.node })
      const separator = tokens[index]
      if (separator === undefined) return fail('unterminated object')
      if (separator.type === 'punct' && separator.value === ',') { index += 1; continue }
      if (separator.type === 'punct' && separator.value === '}') { index += 1; return { ok: true, node: { type: 'object', start, end: separator.end, props } } }
      return fail(`expected ',' or '}' at ${separator.start}`)
    }
  }

  function arrayNode() {
    const start = tokens[index].start
    index += 1
    const items = []
    for (;;) {
      const token = tokens[index]
      if (token === undefined) return fail('unterminated array')
      if (token.type === 'punct' && token.value === ']') { index += 1; return { ok: true, node: { type: 'array', start, end: token.end, items } } }
      const value = node()
      if (!value.ok) return value
      items.push(value.node)
      const separator = tokens[index]
      if (separator === undefined) return fail('unterminated array')
      if (separator.type === 'punct' && separator.value === ',') { index += 1; continue }
      if (separator.type === 'punct' && separator.value === ']') { index += 1; return { ok: true, node: { type: 'array', start, end: separator.end, items } } }
      return fail(`expected ',' or ']' at ${separator.start}`)
    }
  }

  const parsed = node()
  if (!parsed.ok) return parsed
  if (index < tokens.length) return fail(`trailing content at ${tokens[index].start}`)
  return { ok: true, root: parsed.node, tokens }
}

/** The `servers` array of a document (bare array, or `{ servers: [...] }`). */
function locateServersArray(root) {
  if (root === undefined) return undefined
  if (root.type === 'array') return { array: root, disabled: undefined }
  if (root.type !== 'object') return undefined
  const servers = root.props.find((prop) => prop.key === 'servers' && prop.value.type === 'array')
  if (servers === undefined) return undefined
  const disabled = root.props.find((prop) => prop.key === 'disabled' && prop.value.type === 'array')
  return { array: servers.value, disabled: disabled === undefined ? undefined : disabled.value }
}

/** Key-sorted JSON, so two equal configs compare equal whatever the key order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

/** Field order of one written entry — the order a human would write it in. */
const ENTRY_KEY_ORDER = ['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'relatedFiles', 'enabled']

/**
 * One stored server → the object written to `mcp.local.jsonc`.
 *
 * `enabled: true` is omitted (it is the default); `enabled: false` is written
 * explicitly, which is what the pane's switch can then force back on.
 */
function storedEntry(config, enabled = true) {
  const out = {}
  for (const key of ENTRY_KEY_ORDER) {
    if (key === 'enabled') {
      if (enabled === false) out.enabled = false
      continue
    }
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

/** Pretty entry text; `indent` is the leading whitespace of the entry's line. */
function prettyEntry(entry, indent) {
  return JSON.stringify(entry, null, 2).split('\n')
    .map((line, index) => (index === 0 ? line : indent + line))
    .join('\n')
}

/** Leading whitespace of the line containing `offset`. */
function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart))
  return match === null ? '' : match[0]
}

/** Apply `{ start, end, text }` replacements, last one first so offsets hold. */
function applyTextEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  let boundary = out.length
  for (const edit of ordered) {
    if (edit.end > boundary) continue // overlapping edit: skip rather than corrupt
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    boundary = edit.start
  }
  return out
}

/**
 * Spans of the elements to delete, each widened to swallow one neighbouring
 * comma.
 *
 * A comma belongs to the pair it separates, so deleting a single item has to
 * take one, but adjacent deletions must not take the same one twice — that is
 * what merges the spans below. The search is bounded by the owning array: a
 * comma in a *sibling* container must never be borrowed (that turned the
 * document into `],` soup once already).
 */
function deleteSpans(tokens, array, items, drop) {
  const spans = []
  for (let index = 0; index < items.length; index += 1) {
    if (!drop(index)) continue
    const item = items[index]
    const after = tokens.find((token) => token.type === 'punct' && token.value === ','
      && token.start >= item.end && token.end <= array.end)
    if (after !== undefined) {
      spans.push({ start: item.start, end: after.end })
      continue
    }
    const before = [...tokens].reverse().find((token) => token.type === 'punct' && token.value === ','
      && token.end <= item.start && token.start >= array.start)
    spans.push(before === undefined ? { start: item.start, end: item.end } : { start: before.start, end: item.end })
  }
  spans.sort((a, b) => a.start - b.start)
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ start: span.start, end: span.end })
  }
  return merged
}

/**
 * Rewrite `mcp.local.jsonc` from the pane's desired server list.
 *
 * Only what actually differs is touched:
 * - an entry whose stored config equals the desired one keeps its exact text;
 * - a changed entry has its own `{ … }` span replaced (its comments go with it —
 *   the one thing in-place editing cannot keep, and the pane says so);
 * - a missing entry is deleted together with its separator;
 * - a new entry is appended after the last one, indented like its neighbours.
 *
 * A name enabled here is also dropped from a top-level `"disabled": [ … ]` list,
 * so "on" cannot be silently overridden by a list the user parked it in.
 *
 * @returns `{ ok: true, text, changed }` or `{ ok: false, error }`.
 */
function rewriteLocalConfig(rawText, desiredServers) {
  const text = String(rawText)
  const parsed = parseJsoncTree(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const located = locateServersArray(parsed.root)
  if (located === undefined) {
    return { ok: false, error: 'expected an array of servers, or an object with a "servers" array' }
  }
  const desired = new Map()
  for (const server of Array.isArray(desiredServers) ? desiredServers : []) {
    const config = validateServerInput(server)
    const enabled = server.enabled !== false
    desired.set(config.serverName, { config, enabled, entry: storedEntry(config, enabled) })
  }

  const edits = []
  const items = located.array.items
  /** Existing names, so the pane learns what a rewrite would drop. */
  const existing = new Map()
  const doomed = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const nameProp = item.type === 'object'
      ? item.props.find((prop) => prop.key === 'serverName' && prop.value.type === 'scalar')
      : undefined
    const name = nameProp === undefined ? undefined : tokenStringValue(nameProp.value.token)
    const wanted = name === undefined ? undefined : desired.get(name)
    if (name !== undefined) existing.set(name, true)
    if (wanted === undefined) {
      doomed.set(item, true) // deleted (or unnameable): drop the entry and one separator
      continue
    }
    // compare with what is stored, not with its formatting
    let stored
    let storedEnabled = true
    try {
      const raw = parseJsonc(text.slice(item.start, item.end))
      if (raw.ok && isPlainObject(raw.value)) {
        stored = validateServerInput(raw.value)
        storedEnabled = raw.value.enabled !== false
        if (located.disabled !== undefined
          && located.disabled.items.some((node) => tokenStringValue(node.token) === name)) {
          storedEnabled = false
        }
      }
    } catch { stored = undefined }
    const same = stored !== undefined
      && stableStringify(storedEntry(stored, storedEnabled)) === stableStringify(wanted.entry)
    if (!same) {
      edits.push({
        start: item.start,
        end: item.end,
        text: prettyEntry(wanted.entry, lineIndentAt(text, item.start)),
      })
    }
  }
  for (const span of deleteSpans(parsed.tokens, located.array, items, (index) => doomed.has(items[index]))) {
    edits.push({ ...span, text: '' })
  }

  // a name the pane switched on must not stay parked in the top-level list
  if (located.disabled !== undefined) {
    const nodes = located.disabled.items
    const unname = (index) => {
      const name = tokenStringValue(nodes[index].token)
      const wanted = name === undefined ? undefined : desired.get(name)
      return wanted !== undefined && wanted.enabled !== false
    }
    for (const span of deleteSpans(parsed.tokens, located.disabled, nodes, unname)) {
      edits.push({ ...span, text: '' })
    }
  }

  // appended entries: after the last one, indented like the file already is.
  // Two phases on purpose — the appends are placed into the text the removals
  // and replacements already produced, so an entry that was just deleted can
  // never be the anchor they are written behind.
  const appended = []
  for (const [name, wanted] of desired) {
    if (existing.has(name)) continue
    appended.push(wanted)
  }
  let next = edits.length === 0 ? text : applyTextEdits(text, edits)
  if (appended.length > 0) {
    const placed = parseJsoncTree(next)
    const target = placed.ok ? locateServersArray(placed.root) : undefined
    if (target === undefined) return { ok: false, error: 'the rewritten file lost its "servers" array' }
    const list = target.array.items
    const closeIndent = lineIndentAt(next, target.array.end - 1)
    const last = list[list.length - 1]
    const itemIndent = last === undefined ? closeIndent + '  ' : lineIndentAt(next, last.start)
    const body = appended.map((wanted) => prettyEntry(wanted.entry, itemIndent)).join(',\n' + itemIndent)
    next = last === undefined
      ? next.slice(0, target.array.end - 1) + `\n${itemIndent}${body}\n${closeIndent}` + next.slice(target.array.end - 1)
      : next.slice(0, last.end) + `,\n${itemIndent}${body}` + next.slice(last.end)
  }

  if (next === text) return { ok: true, text, changed: false }
  // never persist something the reader would then report as broken
  const check = parseJsonc(next)
  if (!check.ok) return { ok: false, error: `the rewritten file would not parse: ${check.error}` }
  return { ok: true, text: next, changed: true }
}

/**
 * The text a brand-new `mcp.local.jsonc` starts from: a header that says who
 * owns what, then the entries.
 */
function newLocalConfigText(servers) {
  const header = [
    '// 手写 MCP 配置 —— 由「MCP 管理」页面创建/更新。',
    '// 这个文件是本插件唯一的 server 来源：页面上改条目、开关都在这里落盘。',
    '// JSONC：// 与 /* */ 注释、尾随逗号都可以用；页面只重写被改动的那一条，',
    '// 其它行（含注释）保持原样。',
  ].join('\n')
  const list = (Array.isArray(servers) ? servers : []).map((server) => {
    const source = isPlainObject(server) && isPlainObject(server.config) ? server.config : server
    const enabled = isPlainObject(server) && server.enabled === false ? false : true
    return prettyEntry(storedEntry(validateServerInput(source), enabled), '    ')
  })
  const body = list.length === 0 ? '[]' : `[\n    ${list.join(',\n    ')}\n  ]`
  return `${header}\n{\n  "servers": ${body}\n}\n`
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
    // true when the entry lives in mcp.local.jsonc, so the pane can edit it
    editable: record.editable === true,
    // true when this page mounted it, so the pane can restart the process
    restartable: record.restartable === true,
    relatedFiles: Array.isArray(record.relatedFiles) ? record.relatedFiles : [],
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
      editable: false,
      restartable: false,
      relatedFiles: relatedFilesOf(entry.config),
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
      editable: true,
      restartable: true,
      relatedFiles: relatedFilesOf(server),
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
      editable: false,
      restartable: true,
      relatedFiles: relatedFilesOf(entry.config),
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
  RELATED_FILES_LIMIT,
  dshHome,
  stateDir,
  stateFile,
  localFile,
  createStore,
  normalizeState,
  validateServerInput,
  normalizeArgs,
  normalizeStringMap,
  normalizeRelatedFiles,
  mcpClientConfig,
  reviveJsValues,
  loaderServers,
  entryOwner,
  mountedBy,
  readLocalConfig,
  parseJsonc,
  parseJsoncTree,
  rewriteLocalConfig,
  newLocalConfigText,
  storedEntry,
  stableStringify,
  prettyEntry,
  displayPath,
  isInsideStateDir,
  isAbsoluteFilePath,
  relatedFilesOf,
  serverFingerprint,
  toolsOfServer,
  listServers,
  mountableServers,
  publicServer,
  __internals: { emptyState, isPlainObject, envRefName, locateServersArray, lineIndentAt, applyTextEdits },
}
