'use strict'

/**
 * dsh-profile-layer — read and write the MCP rows this plugin manages inside a
 * profile's own cordis patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`).
 *
 * Why this file exists: in dsh an MCP server IS a loader entry —
 * `{ id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport,
 * … } }` — and the profile patch layer is the user's own, last-applied place to
 * declare one. Managing MCP servers therefore means editing that YAML file.
 *
 * Editing rules (deliberate, and why this is not a generic YAML library):
 *
 * 1. ONLY the rows between our two marker comments are ever rewritten. Every
 *    other byte — the user's comments, ordering, their own patches — lives
 *    outside the replaced region and is preserved verbatim.
 * 2. Inside the markers we are the only author, so the parser here only has to
 *    round-trip our own emitter's output. It is nevertheless *strict*: a line
 *    it cannot account for aborts the read instead of being dropped, and a
 *    `!!js` expression outside the documented `process.env.NAME` form makes the
 *    block read-only. Refusing beats silently losing a user's config.
 * 3. The file's top-level value must stay a YAML array. Appending our block to
 *    a file containing `[]` would merge into one flow sequence and break the
 *    parse, so bootstrap replaces a standalone `[]` line.
 * 4. A file with real content but no markers is NOT edited at all.
 *
 * `!!js`: the loader supports these expressions, and we always re-emit the tag
 * so an expression is never downgraded to a literal string. But because writing
 * that tag from a web UI is arbitrary code execution in the host process, only
 * the documented `process.env.NAME` form is accepted from the API.
 *
 * Runtime dependencies: node: builtins only.
 */

const fsP = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { join, resolve, basename } = require('node:path')
const { homedir } = require('node:os')

/** Loader entry name of the official MCP bridge plugin. */
const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const BEGIN_MARKER = '# >>> skills-management: MCP servers (managed block — edit via the MCP 管理 page) >>>'
const END_MARKER = '# <<< skills-management: MCP servers <<<'
/** Every row we emit uses this id prefix; it is how we recognize our own rows. */
const MANAGED_ID_PREFIX = 'mcp-'
/** `serverName` contract, copied from dsh-mcp-client's own schema. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
/** `process.env.NAME`, `process.env['NAME']` or `process.env["NAME"]` only. */
const JS_ENV_RE = /^process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\['([^'\]\\]+)'\]|\["([^"\]\\]+)"\])$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RECONNECT_KEYS = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts']

// ── profile resolution ──────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? resolve(process.env.DSH_HOME)
    : join(homedir(), '.dsh')
}

/**
 * Profile to manage, in priority order: an explicit name, the directory when
 * one is pinned explicitly (its basename IS the profile), then the environment
 * — `DSH_DESKTOP_DEFAULT_PROFILE` is what the Desktop shim exports for exactly
 * this purpose.
 */
function activeProfileName(config = {}) {
  for (const candidate of [config.profile, process.env.SKILLS_MCP_PROFILE]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  if (typeof config.profileDir === 'string' && config.profileDir.trim() !== '') {
    const base = basename(resolve(config.profileDir.trim()))
    if (base !== '') return base
  }
  for (const candidate of [process.env.DSH_DESKTOP_DEFAULT_PROFILE, process.env.DSH_PROFILE]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function assertProfileName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\')
    || name === '.' || name === '..' || name === 'node_modules') {
    throw new Error(`invalid profile name ${JSON.stringify(name)}`)
  }
  return name
}

function profileDirFor(name, config = {}) {
  // Validate unconditionally: with a pinned config.profileDir the name is not
  // used to build the path, but accepting a path-bearing name there would make
  // `?profile=../etc` a silent no-op instead of the 400 it deserves.
  assertProfileName(name)
  if (typeof config.profileDir === 'string' && config.profileDir.trim() !== '') {
    return resolve(config.profileDir.trim())
  }
  return join(dshHome(), 'profiles', name)
}

async function readPatchReload(dir) {
  try {
    const manifest = JSON.parse(await fsP.readFile(join(dir, 'package.json'), 'utf8'))
    const value = manifest?.dsh?.profile?.patchReload
    return value === 'live' || value === 'startup' ? value : 'live'
  } catch { return undefined }
}

/** Every directory that looks like a profile, for the profile switcher. */
async function listProfiles() {
  const root = join(dshHome(), 'profiles')
  let entries = []
  try { entries = await fsP.readdir(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'package.json'))) continue
    const patchFile = join(dir, PROFILE_PATCH_FILENAME)
    out.push({
      name: entry.name,
      hasPatchFile: existsSync(patchFile),
      patchReload: await readPatchReload(dir),
    })
  }
  return out
}

// ── tiny YAML subset (only the shapes our own block contains) ───────────

/** `{ js: 'process.env.X' }` — a value that must keep its `!!js` tag. */
const jsExpr = (expr) => ({ js: expr })
const isJsExpr = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.js === 'string'

/**
 * Quote every string. A quoted scalar can never be re-read as a number,
 * boolean, `null` or tag by accident, which is what makes the round-trip safe.
 */
function quoteScalar(text) {
  return JSON.stringify(String(text))
}

/** Scalars only — containers inside a sequence are not part of our shape. */
function emitInline(value) {
  if (isJsExpr(value)) return `!!js ${value.js}`
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined) return "''"
  return quoteScalar(value)
}

/**
 * Render a YAML block node. `indent` is the column where this node's entries
 * start, and each level indents its children by two from there — so a nested
 * map under `env:` really does land deeper than `env:` itself.
 */
function emitNode(value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((item) => (item !== null && typeof item === 'object' && !isJsExpr(item)
      ? `${pad}-${emitNode(item, indent + 2).replace(/^\n/, '')}`
      : `${pad}- ${emitInline(item)}`)).join('\n')
  }
  if (value !== null && typeof value === 'object' && !isJsExpr(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    return keys.map((key) => {
      const child = value[key]
      if (child !== null && typeof child === 'object' && !isJsExpr(child)) {
        const isEmpty = Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0
        return isEmpty
          ? `${pad}${emitKey(key)}: ${Array.isArray(child) ? '[]' : '{}'}`
          : `${pad}${emitKey(key)}:\n${emitNode(child, indent + 2)}`
      }
      return `${pad}${emitKey(key)}: ${emitInline(child)}`
    }).join('\n')
  }
  return `${pad}${emitInline(value)}`
}

/** A value as it appears after `key:` — inline scalar, or an indented block. */
function emitValue(value, indent) {
  if (value !== null && typeof value === 'object' && !isJsExpr(value)) {
    const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0
    if (isEmpty) return Array.isArray(value) ? '[]' : '{}'
    return '\n' + emitNode(value, indent)
  }
  return emitInline(value)
}

/** Bare when obviously safe, quoted otherwise. */
function emitKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : quoteScalar(key)
}

/** Strip an unquoted trailing comment (` #…`) and surrounding blanks. */
function stripPlain(raw) {
  const text = raw.trim()
  let quote = null
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch !== '#') continue
    const before = text[i - 1], after = text[i + 1]
    if ((before === ' ' || before === '\t') && (after === undefined || after === ' ' || after === '\t')) {
      return text.slice(0, i).trim()
    }
  }
  return text
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  // Our emitter quotes every string, so a bare flow collection can only be an
  // empty container we wrote ourselves.
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text.startsWith('!!js ')) return jsExpr(text.slice(5).trim())
  if (text[0] === '"') {
    const end = text.lastIndexOf('"')
    if (end > 0) { try { return JSON.parse(text.slice(0, end + 1)) } catch { return text.slice(1, end) } }
    return text.slice(1)
  }
  if (text[0] === "'") {
    const end = text.lastIndexOf("'")
    if (end > 0) return text.slice(1, end).replace(/''/g, "'")
    return text.slice(1)
  }
  const bare = stripPlain(text)
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (/^-?\d+$/.test(bare)) return Number(bare)
  return bare
}

/** First `key:` whose `:` ends the line or is followed by whitespace. */
function splitKeyValue(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch !== ':') continue
    const next = text[i + 1]
    if (next === undefined || next === ' ' || next === '\t') {
      const key = text.slice(0, i).trim().replace(/^["']|["']$/g, '')
      if (key === '') return null
      return { key, rest: text.slice(i + 1) }
    }
  }
  return null
}

const indentOf = (line) => line.length - line.trimStart().length

/**
 * Parse the content of one block node (a map body at some indentation).
 * Handles the two shapes our emitter produces: `key: value` scalars, `key:`
 * followed by an indented child node, and `- value` sequence items. Anything
 * it cannot account for throws — a strict reader is what makes writing back safe.
 */
function parseFlat(lines, label) {
  const out = {}
  let index = 0
  const seq = []
  while (index < lines.length) {
    const line = lines[index]
    const text = line.trim()
    if (text === '' || text.startsWith('#')) { index += 1; continue }
    const indent = indentOf(line)
    if (/^-\s/.test(text) || text === '-') {
      // stray items at a map body's level: keep them rather than dropping them
      seq.push(parseScalar(text.replace(/^-\s*/, '')))
      index += 1
      continue
    }
    const kv = splitKeyValue(text)
    if (kv === null) throw new Error(`${label}: cannot parse ${JSON.stringify(text)}`)
    if (kv.rest.trim() !== '') { out[kv.key] = parseScalar(kv.rest); index += 1; continue }
    let end = index + 1
    while (end < lines.length) {
      const cur = lines[end]
      if (cur.trim() === '') { end += 1; continue }
      if (indentOf(cur) <= indent) break
      end += 1
    }
    const nested = lines.slice(index + 1, end)
    out[kv.key] = startsWithSequence(nested) ? parseSequence(nested, label) : parseFlat(nested, label)
    index = end
  }
  if (seq.length > 0) out.__seq = seq
  delete out.__seq
  return out
}

function startsWithSequence(lines) {
  for (const line of lines) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    return /^-\s/.test(text) || text === '-'
  }
  return false
}

function parseSequence(lines, label) {
  const items = []
  for (const line of lines) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    if (!/^-\s/.test(text) && text !== '-') throw new Error(`${label}: expected a sequence item, got ${JSON.stringify(text)}`)
    items.push(parseScalar(text.replace(/^-\s*/, '')))
  }
  return items
}

// ── markers and the managed block ───────────────────────────────────────

function locateBlock(text) {
  const begin = text.indexOf(BEGIN_MARKER)
  if (begin === -1) return undefined
  const endAt = text.indexOf(END_MARKER, begin)
  if (endAt === -1) return undefined
  return { begin, end: endAt + END_MARKER.length }
}

/** Offsets of standalone `[]` lines — the shipped empty-template body. */
function locateEmptyArrays(text) {
  const offsets = []
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '[]') offsets.push(offset)
    offset += line.length + 1
  }
  return offsets
}

/** True when the file holds nothing but comments, blanks and `[]`. */
function isEmptyPatchFile(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '[]') continue
    return false
  }
  return true
}

/**
 * Parse the managed block: the patch rows, each with its insert entry and the
 * config body that follows. Throws when a line cannot be accounted for — a
 * partial read must never be written back.
 */
function parseManagedBlock(blockLines) {
  const rows = []
  const disabled = new Set()
  let current = null
  let section = 'patch' // patch → insert → config
  let configLines = []

  const flush = () => {
    if (current === null) return
    current.configLines = configLines
    rows.push(current)
    configLines = []
  }

  for (const line of blockLines) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue

    if (section === 'config' && !(indentOf(line) === 0 && /^-\s/.test(text))) {
      configLines.push(line)
      continue
    }
    section = section === 'config' ? 'patch' : section

    if (indentOf(line) === 0) {
      const idMatch = /^-\s+id:\s*(\S+)\s*$/.exec(text)
      if (idMatch === null) throw new Error(`managed block: unexpected top-level line ${JSON.stringify(text)}`)
      flush()
      current = { id: idMatch[1], name: undefined, configLines: undefined }
      section = 'patch'
      continue
    }
    if (current === null) throw new Error(`managed block: content before the first row: ${JSON.stringify(text)}`)

    if (section === 'patch') {
      const kv = splitKeyValue(text)
      if (kv === null) throw new Error(`managed block: cannot parse ${JSON.stringify(text)}`)
      if (kv.key === 'name') { current.name = parseScalar(kv.rest); continue }
      if (kv.key === 'disable') { disabled.add(current.id); continue }
      if (kv.key === 'insert') { section = 'insert'; continue }
      throw new Error(`managed block: unexpected patch key ${JSON.stringify(kv.key)}`)
    }
    if (section === 'insert') {
      const entryId = /^-\s+id:\s*(\S+)\s*$/.exec(text)
      if (entryId) {
        if (current.entryId !== undefined && entryId[1] !== current.id) {
          throw new Error(`managed block: row ${current.id} inserts entry ${entryId[1]} — expected the same id`)
        }
        current.entryId = entryId[1]
        continue
      }
      const kv = splitKeyValue(text)
      if (kv === null) throw new Error(`managed block: cannot parse ${JSON.stringify(text)}`)
      if (kv.key === 'config') { section = 'config'; configLines = []; continue }
      throw new Error(`managed block: unexpected insert key ${JSON.stringify(kv.key)}`)
    }
    throw new Error('managed block: unreachable parse state')
  }
  flush()
  return { rows, disabled }
}

// ── read ────────────────────────────────────────────────────────────────

/** True when any value carries a `!!js` expression we must not rewrite. */
function containsForeignJs(value) {
  if (isJsExpr(value)) return !JS_ENV_RE.test(value.js)
  if (Array.isArray(value)) return value.some(containsForeignJs)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsForeignJs)
  return false
}

function normalizeRow(patch, disabled) {
  const config = patch.config ?? {}
  const managed = typeof patch.id === 'string' && patch.id.startsWith(MANAGED_ID_PREFIX)
  return {
    id: patch.id,
    editable: managed,
    enabled: managed ? !disabled.has(patch.id) : !disabled.has(patch.id),
    serverName: typeof config.serverName === 'string' ? config.serverName : '',
    transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: typeof config.command === 'string' ? config.command : '',
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {},
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    url: typeof config.url === 'string' ? config.url : '',
    headers: config.headers !== null && typeof config.headers === 'object' && !Array.isArray(config.headers) ? config.headers : {},
    toolCallTimeoutMs: typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : undefined,
    failOnStartupError: config.failOnStartupError === true,
    reconnect: config.reconnect !== null && typeof config.reconnect === 'object' && !Array.isArray(config.reconnect) ? config.reconnect : undefined,
    hasForeignJs: containsForeignJs(config),
  }
}

/**
 * Read the MCP rows declared in one profile's patch layer.
 * @returns `{ profile, profileDir, patchFile, patchReload, fileMissing, markersPresent, canBootstrap, parseError, foreignJs, rows }`
 */
async function readMcpRows(profileName, config = {}) {
  const dir = profileDirFor(profileName, config)
  const patchFile = join(dir, PROFILE_PATCH_FILENAME)
  const result = {
    profile: profileName,
    profileDir: dir,
    patchFile,
    patchReload: await readPatchReload(dir),
    fileMissing: false,
    markersPresent: false,
    canBootstrap: false,
    parseError: undefined,
    foreignJs: false,
    rows: [],
  }

  let text
  try { text = await fsP.readFile(patchFile, 'utf8') }
  catch { result.fileMissing = true; result.canBootstrap = true; return result }

  const block = locateBlock(text)
  if (block === undefined) {
    result.canBootstrap = isEmptyPatchFile(text) || locateEmptyArrays(text).length === 1
    return result
  }
  result.markersPresent = true

  try {
    const { rows, disabled } = parseManagedBlock(text.slice(block.begin, block.end).split(/\r?\n/))
    for (const row of rows) {
      if (row.name !== MCP_PLUGIN) continue
      const config2 = parseFlat(row.configLines ?? [], `row ${row.id}`)
      const normalized = normalizeRow({ id: row.id, config: config2 }, disabled)
      if (normalized.hasForeignJs) result.foreignJs = true
      result.rows.push(normalized)
    }
  } catch (error) {
    result.parseError = String((error && error.message) || error)
  }
  return result
}

// ── write ───────────────────────────────────────────────────────────────

/** Render the managed block from `{ id, config }` entries plus disabled ids. */
function buildBlock(entries, disabledIds) {
  const lines = [BEGIN_MARKER]
  /** `config:` sits at column 6, so its keys sit at 8 and their children at 10. */
  const fieldIndent = 8
  for (const entry of entries) {
    const id = entry.id
    const config = entry.config
    lines.push(`- id: ${id}`)
    lines.push(`  name: ${MCP_PLUGIN}`)
    lines.push('  insert:')
    lines.push(`    - id: ${id}`)
    lines.push('      config:')
    const emitField = (key, value) => {
      const rendered = emitValue(value, fieldIndent + 2)
      lines.push(rendered.startsWith('\n') ? `${' '.repeat(fieldIndent)}${key}:${rendered}` : `${' '.repeat(fieldIndent)}${key}: ${rendered}`)
    }
    emitField('serverName', config.serverName)
    emitField('transport', config.transport)
    if (config.transport === 'streamable-http') {
      emitField('url', config.url)
      if (config.headers !== undefined) emitField('headers', config.headers)
    } else {
      emitField('command', config.command)
      emitField('args', config.args ?? [])
      if (config.env !== undefined) emitField('env', config.env)
      if (typeof config.cwd === 'string' && config.cwd !== '') emitField('cwd', config.cwd)
    }
    if (typeof config.toolCallTimeoutMs === 'number') emitField('toolCallTimeoutMs', config.toolCallTimeoutMs)
    if (config.failOnStartupError === true) emitField('failOnStartupError', true)
    if (config.reconnect !== undefined) emitField('reconnect', config.reconnect)
  }
  for (const id of disabledIds) {
    lines.push(`- id: ${id}`)
    lines.push('  disable: true')
  }
  lines.push(END_MARKER)
  return lines.join('\n')
}

/**
 * Replace (or bootstrap) the managed block. Throws rather than touching a file
 * whose own entries we would have to rewrite.
 */
function spliceBlock(text, entries, disabledIds) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = buildBlock(entries, disabledIds).split('\n').join(eol)
  const existing = locateBlock(text)
  if (existing !== undefined) return text.slice(0, existing.begin) + replacement + text.slice(existing.end)

  const emptyArrays = locateEmptyArrays(text)
  if (emptyArrays.length === 1) return text.slice(0, emptyArrays[0]) + replacement + eol
  if (text.trim() === '') return replacement + eol
  if (isEmptyPatchFile(text)) {
    const head = text.replace(/\s*$/, '')
    return (head === '' ? '' : head + eol) + replacement + eol
  }
  throw new Error(
    `${PROFILE_PATCH_FILENAME} already declares its own patch entries, so the MCP block cannot be added `
    + 'safely. The file was left untouched — add the block by hand, or manage another profile.')
}

/** Unique managed id derived from a server name. */
function managedId(serverName, taken) {
  const base = MANAGED_ID_PREFIX + String(serverName).replace(/[^A-Za-z0-9_-]/g, '-')
  let id = base
  let n = 2
  while (taken.has(id)) { id = `${base}-${n}`; n += 1 }
  return id
}

// ── validation ──────────────────────────────────────────────────────────

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

/** Both `env` and `headers` are `dict(String)` upstream; `!!js` allowed in both. */
function normalizeStringMap(raw, label) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be a mapping of name → value`)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim()
    if (!ENV_NAME_RE.test(name)) throw new Error(`${label} name ${JSON.stringify(key)} must match [A-Za-z_][A-Za-z0-9_]*`)
    if (isJsExpr(value)) {
      if (!JS_ENV_RE.test(value.js)) {
        throw new Error(`${label}.${name}: only a process.env.NAME expression is accepted from this page (got "${value.js}")`)
      }
      out[name] = jsExpr(value.js.trim())
      continue
    }
    if (typeof value !== 'string') throw new Error(`${label}.${name} must be a string`)
    out[name] = value
  }
  return out
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

function normalizeReconnect(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('reconnect must be a mapping')
  const out = {}
  for (const key of RECONNECT_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    const num = Number(value)
    if (!Number.isInteger(num) || num < 0) throw new Error(`reconnect.${key} must be a non-negative integer`)
    out[key] = num
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate submitted input into the exact `dsh-mcp-client` config shape. */
function normalizeServerInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('body must be an MCP server object')
  const serverName = requireString(input.serverName, 'serverName')
  if (!SERVER_NAME_RE.test(serverName)) throw new Error('serverName must match [A-Za-z0-9_-]{1,32}')
  const transport = input.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') throw new Error("transport must be 'stdio' or 'streamable-http'")

  const config = { serverName, transport }
  if (transport === 'stdio') {
    config.command = requireString(input.command, 'command')
    config.args = normalizeArgs(input.args)
    const env = normalizeStringMap(input.env, 'env')
    if (env !== undefined) config.env = env
    if (typeof input.cwd === 'string' && input.cwd.trim() !== '') config.cwd = input.cwd.trim()
  } else {
    const url = requireString(input.url, 'url')
    let parsed
    try { parsed = new URL(url) } catch { throw new Error(`url is not a valid URL: ${url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must be http(s)')
    config.url = url
    const headers = normalizeStringMap(input.headers, 'headers')
    if (headers !== undefined) config.headers = headers
  }
  if (input.toolCallTimeoutMs !== undefined && input.toolCallTimeoutMs !== null && input.toolCallTimeoutMs !== '') {
    const value = Number(input.toolCallTimeoutMs)
    if (!Number.isInteger(value) || value <= 0) throw new Error('toolCallTimeoutMs must be a positive integer (ms)')
    config.toolCallTimeoutMs = value
  }
  if (input.failOnStartupError === true) config.failOnStartupError = true
  const reconnect = normalizeReconnect(input.reconnect)
  if (reconnect !== undefined) config.reconnect = reconnect
  return config
}

// ── mutations ───────────────────────────────────────────────────────────

/**
 * Load the mutable state. Refuses when the file cannot be round-tripped
 * faithfully, so a write can never drop something we failed to understand.
 */
async function loadState(profileName, config = {}) {
  const read = await readMcpRows(profileName, config)
  if (read.parseError !== undefined) {
    throw new Error(`the managed MCP block in ${read.patchFile} cannot be parsed (${read.parseError}); fix it by hand first`)
  }
  if (read.foreignJs) {
    throw new Error('the managed block contains a !!js expression outside the process.env.NAME form; edit it by hand')
  }
  if (!read.fileMissing && !read.markersPresent && !read.canBootstrap) {
    throw new Error(
      `${read.patchFile} already declares its own patch entries, so it will not be rewritten. `
      + 'Add the MCP block by hand, or manage another profile.')
  }

  let text = ''
  try { text = await fsP.readFile(read.patchFile, 'utf8') } catch { text = '' }
  const entries = []
  const disabledIds = []
  const block = locateBlock(text)
  if (block !== undefined) {
    const parsed = parseManagedBlock(text.slice(block.begin, block.end).split(/\r?\n/))
    for (const row of parsed.rows) {
      if (row.name !== MCP_PLUGIN) continue
      entries.push({ id: row.id, config: parseFlat(row.configLines ?? [], `row ${row.id}`) })
    }
    disabledIds.push(...parsed.disabled)
  }
  return { read, text, entries, disabledIds, patchFile: read.patchFile }
}

/** Atomically write the managed block back. */
async function writeState(state, entries, disabledIds) {
  const text = spliceBlock(state.text, entries, disabledIds)
  await fsP.mkdir(join(state.patchFile, '..'), { recursive: true })
  const temp = `${state.patchFile}.${process.pid}.${Date.now()}.tmp`
  await fsP.writeFile(temp, text, 'utf8')
  await fsP.rename(temp, state.patchFile)
}

module.exports = {
  MCP_PLUGIN,
  PROFILE_PATCH_FILENAME,
  BEGIN_MARKER,
  END_MARKER,
  MANAGED_ID_PREFIX,
  SERVER_NAME_RE,
  JS_ENV_RE,
  jsExpr,
  isJsExpr,
  dshHome,
  activeProfileName,
  profileDirFor,
  listProfiles,
  readPatchReload,
  readMcpRows,
  normalizeServerInput,
  normalizeStringMap,
  normalizeArgs,
  managedId,
  loadState,
  writeState,
  __internals: {
    parseManagedBlock,
    parseFlat,
    parseSequence,
    startsWithSequence,
    parseScalar,
    splitKeyValue,
    stripPlain,
    buildBlock,
    spliceBlock,
    locateBlock,
    locateEmptyArrays,
    isEmptyPatchFile,
    emitNode,
    emitValue,
    emitInline,
    containsForeignJs,
  },
}
