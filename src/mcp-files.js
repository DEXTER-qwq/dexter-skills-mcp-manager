'use strict'

/**
 * The MCP pane's config-file surface.
 *
 * WHY THIS EXISTS: an MCP server is started by an entry in
 * `mcp.local.jsonc`, but a stdio server routinely reads a config file *of its
 * own* — `ssh-mcp-server --config-file …\ssh-config.json` is the case this was
 * written for. Adding an SSH host therefore means editing a second file, and
 * doing that from the page is exactly what the pane's file editor is for.
 *
 * Scope, deliberately narrow:
 * - only files **inside** `$DSH_HOME/skills-management` may be read or written.
 *   A related file elsewhere (a tool's own script, an `.exe`) is shown by the
 *   pane but never opened for editing here;
 * - only text files, and only up to {@link MAX_EDIT_BYTES};
 * - a `.json` file must still parse as **strict** JSON after an edit — a
 *   comment-tolerant reader would happily save something the MCP server itself
 *   cannot load. `.jsonc` gets the tolerant reader, anything else no check;
 * - the previous bytes are kept as `<name>.bak` before every write, and the
 *   write itself is atomic (temp file + rename, with the Windows rename retry).
 *
 * Nothing here knows about servers; the caller decides what to restart.
 */

const fsP = require('node:fs/promises')
const { readFileSync, readdirSync, statSync } = require('node:fs')
const { basename, dirname, join, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { stateDir, parseJsonc, displayPath } = require('./mcp-manager.js')

/** Largest file the editor will open (bytes). */
const MAX_EDIT_BYTES = 512 * 1024
/** Names that may be opened in the page's editor. */
const EDITABLE_NAME_RE = /\.(jsonc?|ya?ml|toml|txt|md|ini|conf|cfg)$/i
/** The two files the MCP feature is about, listed even before they exist. */
const KNOWN_NAMES = ['mcp.local.jsonc', 'mcp.json']

/** `~`/absolute path → absolute path, no existence requirement. */
function expandPath(input) {
  const text = String(input === undefined || input === null ? '' : input).trim()
  if (text === '') throw new Error('a file path is required')
  if (text === '~') return process.env.USERPROFILE || process.env.HOME || '~'
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || '~'
    return join(home, text.slice(2))
  }
  return resolve(text)
}

/** Case-insensitive prefix check on Windows, so `c:\x` and `C:\X` agree. */
function samePrefix(file, dir) {
  if (process.platform !== 'win32') return file.startsWith(dir + sep)
  return file.toLowerCase().startsWith(dir.toLowerCase() + sep)
}

/**
 * Resolve a client-supplied path to a file this plugin may touch.
 *
 * The guard is the point of the function: the pane must not become an arbitrary
 * file writer. Anything that does not sit directly inside the state directory is
 * refused, and that refusal is final — there is no "force" flag.
 */
function resolveConfigFile(input) {
  const file = expandPath(input)
  const dir = resolve(stateDir())
  if (!samePrefix(file, dir)) {
    throw new Error(`'${file}' is outside ${displayPath(dir)}; only files in this plugin's own directory can be edited here`)
  }
  return file
}

/** One file's line in the pane's file list. */
function describeFile(file) {
  let stat
  try { stat = statSync(file) } catch { stat = undefined }
  const exists = stat !== undefined && stat.isFile()
  return {
    name: basename(file),
    rawPath: file,
    path: displayPath(file),
    exists,
    size: exists ? stat.size : 0,
    modifiedAt: exists ? stat.mtime.toISOString() : undefined,
    editable: exists && EDITABLE_NAME_RE.test(file),
  }
}

/**
 * Every file the pane can open, `mcp.local.jsonc` and `mcp.json` first (they are
 * the ones that exist even when empty), then anything else with an editable
 * extension — `ssh-config.json` shows up here.
 */
function configFileList() {
  const dir = resolve(stateDir())
  const names = []
  let entries = []
  try { entries = readdirSync(dir) } catch { entries = [] }
  for (const entry of entries) {
    if (!EDITABLE_NAME_RE.test(entry)) continue
    names.push(entry)
  }
  for (const known of KNOWN_NAMES) {
    if (!names.includes(known)) names.unshift(known)
  }
  return [...new Set(names)].map((name) => describeFile(join(dir, name)))
}

/**
 * Read one editable file. A file that does not exist yet reads as empty, so a
 * declared related file can be created from the page instead of erroring on the
 * first click.
 *
 * @returns `{ name, rawPath, path, text, size, exists, modifiedAt }`
 * @throws when the path is outside the state dir, or is not text.
 */
function readConfigFile(input) {
  const file = resolveConfigFile(input)
  let stat
  try { stat = statSync(file) } catch {
    return { name: basename(file), rawPath: file, path: displayPath(file), text: '', size: 0, exists: false, modifiedAt: undefined }
  }
  if (!stat.isFile()) throw new Error(`'${displayPath(file)}' is not a regular file`)
  if (stat.size > MAX_EDIT_BYTES) {
    throw new Error(`'${displayPath(file)}' is ${stat.size} bytes; the editor stops at ${MAX_EDIT_BYTES}`)
  }
  const text = readFileSync(file, 'utf8')
  if (text.includes('\0')) throw new Error(`'${displayPath(file)}' looks like a binary file`)
  return {
    name: basename(file),
    rawPath: file,
    path: displayPath(file),
    text,
    size: stat.size,
    exists: true,
    modifiedAt: stat.mtime.toISOString(),
  }
}

/** Validate what the editor is about to save. Returns an error message or undefined. */
function validateText(file, text) {
  if (typeof text !== 'string') return 'content must be a string'
  if (/\.json$/i.test(file)) {
    try { JSON.parse(text) } catch (error) {
      const message = String(error && error.message || error)
      return `${basename(file)} must be strict JSON: ${message}`
    }
    return undefined
  }
  if (/\.jsonc$/i.test(file)) {
    const parsed = parseJsonc(text)
    return parsed.ok ? undefined : `${basename(file)} cannot be parsed: ${parsed.error}`
  }
  return undefined
}

/** Atomic write with the Windows rename retry the state store already uses. */
async function atomicWrite(file, text) {
  const dir = dirname(file)
  await fsP.mkdir(dir, { recursive: true })
  const temp = join(dir, `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, text, 'utf8')
  try {
    await fsP.rename(temp, file)
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST' || error.code === 'EACCES')) {
      await fsP.rm(file, { force: true })
      await fsP.rename(temp, file)
      return
    }
    await fsP.rm(temp, { force: true })
    throw error
  }
}

/**
 * Write a file the editor owns.
 *
 * @returns `{ file, backup, backupDisplay }` where `backup` is the absolute
 *          path of the previous content, when there was one.
 */
async function writeConfigFile(input, text) {
  const file = resolveConfigFile(input)
  const problem = validateText(file, text)
  if (problem !== undefined) throw new Error(problem)
  let backup
  try {
    const previous = readFileSync(file, 'utf8')
    if (previous !== text) {
      backup = `${file}.bak`
      await atomicWrite(backup, previous)
    }
  } catch { backup = undefined }
  await atomicWrite(file, text)
  return {
    file: describeFile(file),
    backup,
    backupDisplay: backup === undefined ? undefined : displayPath(backup),
  }
}

module.exports = {
  MAX_EDIT_BYTES,
  EDITABLE_NAME_RE,
  KNOWN_NAMES,
  expandPath,
  resolveConfigFile,
  configFileList,
  readConfigFile,
  writeConfigFile,
  validateText,
}
