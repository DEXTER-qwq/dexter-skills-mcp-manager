'use strict'

/**
 * dsh-plugin-skills-management — Host half (local-only fork)
 *
 * FROKED / HARDENED: the upstream package shipped two remote-touching features
 * that this fork removes outright (see README "改造说明"):
 * - the ntd "market": cloning/fetching an external skill repository, storing an
 *   access token and auto-syncing it on a timer — gone;
 * - "share to the official repo" plus its run endpoint, which executed a model
 *   prompt (telling it to read the stored token and push upstream) through a
 *   spawned `dsh` process — gone.
 *
 * What is left is a purely local surface: every coding agent's on-machine
 * skills directory (`~/.claude/skills`, `~/.agents/skills`, …) is scanned for
 * display/preview; any of them can be copied into the dsh user library so the
 * `skill` tool can call it; skills can be deleted from a writable source; and
 * the native `disable-model-invocation` governance key can be toggled.
 *
 * No network access, no child processes, no outbound requests of any kind.
 */

const { createReadStream } = require('node:fs')
const { randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const { basename, join, relative, resolve, sep } = require('node:path')
const { homedir } = require('node:os')
// MCP 管理：不解析、不改写任何 dsh 配置文件。列表来自 loader（所有层都能看到），
// 用户新增的 server 用 loader.create 动态挂载，开关用 per-agent tools.restrict，
// 只有本插件自己的状态文件（$DSH_HOME/skills-management/mcp.json）会被写。
// 见 src/mcp-manager.js 顶部说明。
const mcpManager = require('./mcp-manager.js')
// settings 服务要求 schemastery schema（可调用 + toJSON；zod 不兼容，register 会抛错被吞）。
// 宿主沙箱内解析打包依赖可能抛 ERR_INTERNAL_ASSERTION（.pnpm 软链），因此优先沿
// dsh 全局安装取 settings 服务自用的那份副本，本地开发/测试再退回标准 require。
function loadSchemastery() {
  const errors = []
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    try { return createRequire(hostCopy)(hostCopy) } catch (e) { errors.push(String(e && e.code || e)) }
  }
  try { return require('@deepseek-ai/schemastery') } catch (e) { errors.push(String(e && e.code || e)) }
  if (process.env.SKILLS_SETTINGS_DEBUG) console.warn(`[skills-management] schemastery unavailable: ${errors.join(' | ')}`)
  return null
}
const Schema = loadSchemastery()

const SCAN_SKIP = new Set(['.git', 'node_modules'])
const RANK_INSTALLED = 100
const MAX_BODY_BYTES = 64 * 1024
const DESCRIPTION_LIMIT = 140
// 同款正则见 skill/skill/src/index.ts SKILL_NAME —— 不合规的候选会让 registry 抛错
const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Known on-machine skill sources (executor → skills dir). `sub` is relative
 * to $HOME; `dsh` is special — its root is the plugin's installedDir.
 */
const EXECUTOR_DEFS = [
  { key: 'dsh', label: 'DSH' },
  { key: 'claudecode', label: 'Claude Code', sub: '.claude/skills' },
  { key: 'zcode', label: 'ZCode', sub: '.zcode/skills' },
  { key: 'codex', label: 'Codex', sub: '.codex/skills' },
  { key: 'opencode', label: 'OpenCode', sub: '.opencode/skills' },
  { key: 'codebuddy', label: 'CodeBuddy', sub: '.codebuddy/skills' },
  { key: 'atomcode', label: 'AtomCode', sub: '.atomcode/skills' },
  { key: 'hermes', label: 'Hermes', sub: '.hermes/skills' },
  { key: 'kimi', label: 'Kimi', sub: '.kimi/skills' },
  { key: 'mobilecoder', label: 'MobileCoder', sub: '.mobile-coder/skills' },
  { key: 'codewhale', label: 'Codewhale', sub: '.codewhale/skills' },
  { key: 'kilo', label: 'Kilo', sub: '.kilo/skills' },
  { key: 'pi', label: 'Pi', sub: '.pi/skills' },
  { key: 'mimo', label: 'Mimo', sub: '.local/share/mimocode/skills' },
  { key: 'zhanlu', label: 'ZhanLu', sub: '.local/share/zhanlu/skills' },
  { key: 'workbuddy', label: 'WorkBuddy', sub: '.workbuddy/skills' },
  // agents 共享池曾是只读来源；治理键开关（disable-model-invocation）覆盖该根后
  // "只读"名不副实——与 dsh 的 user-agents 内置根对齐，按普通可写来源对待。
  { key: 'agents', label: 'Agents', sub: '.agents/skills' },
]

/** Target directory name when installing a (possibly nested) skill name. */
function installDirName(fullName) {
  const parts = String(fullName === undefined || fullName === null ? '' : fullName).split('/')
  return parts[parts.length - 1]
}

/** Absolute path with the $HOME prefix folded to `~` (no username leaks in UI). */
function displayPath(p) {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  return p
}

/** dsh 数据根（与宿主一致：$DSH_HOME，缺省 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

function extractFrontmatter(content) {
  const lines = content.split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') return undefined
  const yamlLines = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') return yamlLines.join('\n')
    yamlLines.push(line)
  }
  return undefined
}

// ── Frontmatter reader (no YAML dependency) ─────────────────────────────
// 这里**不是** YAML 实现,只认 SKILL.md frontmatter 实际出现的形状:
//   扁平标量(name/description/version/author/license/whenToUse/disable-model-invocation…)、
//   单/双引号标量、内联数组 [a, b]、块序列(- item)、以及一层嵌套映射
//   (Codex 的 metadata:/short-description:)。锚点别名、多行标量(| >)、
//   流式映射({a: b})、复杂键等构造一律**忽略**,绝不让它影响 name/description。
// 这样运行期第三方依赖为零,且不把不受信任的技能目录内容交给通用 YAML 解析器。
//
// 返回扁平化的 meta:顶层键 + 嵌套键(键名与叶子名),与旧 YAML.parse 的
// 读取面兼容——调用方只按字符串/数组/布尔取值,不做结构遍历。

function unquoteScalar(raw) {
  const text = raw.trim()
  if (text.length === 0) return ''
  if (text[0] === '"') {
    const end = text.lastIndexOf('"')
    if (end > 0) {
      try { return JSON.parse(text.slice(0, end + 1)) } catch { return text.slice(1, end) }
    }
    return text.slice(1)
  }
  if (text[0] === "'") {
    const end = text.lastIndexOf("'")
    if (end > 0) return text.slice(1, end).replace(/''/g, "'")
    return text.slice(1)
  }
  // A trailing comment starts at a '#' that is both preceded by whitespace and
  // followed by whitespace or end-of-line. So `foo  # note` drops the note,
  // while `issue #123 fix` and `https://x/y#frag` keep their text.
  let quote = null
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch !== '#') continue
    const before = text[i - 1]
    const after = text[i + 1]
    if ((before === ' ' || before === '\t') && (after === undefined || after === ' ' || after === '\t')) {
      return text.slice(0, i).trim()
    }
  }
  return text
}

/**
 * Scalar → value. Only the types the callers branch on get real types:
 * unquoted true/false, and ~/null as null. Everything else stays a string —
 * numbers included, because `version: 1.0` should render as the author wrote
 * it. **Quoted** scalars never coerce (`user-invocable: "false"` must stay the
 * string 'false' — `flagValue` reads the string form).
 */
function coerceScalar(raw) {
  const trimmedRaw = String(raw).trim()
  const text = unquoteScalar(trimmedRaw)
  const first = trimmedRaw[0]
  const quoted = first === '"' || first === "'"
  // unchanged ⇒ the value was a bare scalar, so type coercion is allowed
  if (!quoted && text === trimmedRaw) {
    const lowered = text.toLowerCase()
    if (lowered === '~' || lowered === 'null') return null
    if (lowered === 'true') return true
    if (lowered === 'false') return false
  }
  return text
}

/** The first top-level ':' followed by whitespace or end-of-line. Avoids
 *  splitting inside a quoted key, and does not special-case '#': a trailing
 *  comment is stripped later by unquoteScalar, so a value like
 *  `issue #123` keeps its text. */
function splitKeyValue(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':') {
      const next = text[i + 1]
      if (next === undefined || next === ' ' || next === '\t') {
        const key = text.slice(0, i).trim().replace(/^["']|["']$/g, '')
        if (key === '') return null
        return { key, rest: text.slice(i + 1) }
      }
    }
  }
  return null
}

/** [a, b, "c d"] → array; a malformed inline array degrades to a single string. */
function parseInlineArray(raw) {
  const inner = raw.slice(1, raw.lastIndexOf(']')).trim()
  if (inner === '') return []
  const out = []
  let current = ''
  let quote = null
  for (const ch of inner) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === ',') { out.push(coerceScalar(current)); current = ''; continue }
    current += ch
  }
  out.push(coerceScalar(current))
  return out
}

/** Flatten one block level: `key: value`, `key:` + nested block, `- item`.
 *  A pure sequence level comes back as `{ value: [...] }`. */
function parseBlock(lines) {
  const out = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#')) { index += 1; continue }
    const indent = line.length - line.trimStart().length
    const text = line.trim()

    // block sequence → collect same-or-deeper-indent "- x" items
    if (text === '-' || text.startsWith('- ')) {
      const items = []
      while (index < lines.length) {
        const cur = lines[index]
        const curText = cur.trim()
        if (curText === '') { index += 1; continue }
        const curIndent = cur.length - cur.trimStart().length
        if (curIndent < indent || !(curText === '-' || curText.startsWith('- '))) break
        if (curIndent > indent) { index += 1; continue } // nested under an item: ignored
        items.push(coerceScalar(curText === '-' ? '' : curText.slice(2)))
        index += 1
      }
      return { value: items }
    }

    const kv = splitKeyValue(text)
    if (kv === null) { index += 1; continue } // unsupported construct: skip the line
    const { key, rest } = kv
    const trimmed = rest.trim()

    if (trimmed === '') {
      // nested block: consume the deeper-indented run
      let end = index + 1
      while (end < lines.length) {
        const cur = lines[end]
        if (cur.trim() === '') { end += 1; continue }
        if (cur.length - cur.trimStart().length <= indent) break
        end += 1
      }
      const nested = parseBlock(lines.slice(index + 1, end))
      out[key] = Object.keys(nested).length === 1 && Array.isArray(nested.value) ? nested.value : nested
      index = end
      continue
    }
    if (trimmed.startsWith('|') || trimmed.startsWith('>')) {
      // block scalar: fold the indented run into one space-joined string
      const parts = []
      let end = index + 1
      while (end < lines.length && (lines[end].trim() === '' || lines[end].length - lines[end].trimStart().length > indent)) {
        if (lines[end].trim() !== '') parts.push(lines[end].trim())
        end += 1
      }
      out[key] = parts.join(trimmed.startsWith('>') ? ' ' : '\n')
      index = end
      continue
    }
    if (trimmed.startsWith('[')) {
      // well-formed inline array, else treat the whole thing as a plain string
      out[key] = trimmed.endsWith(']') && !trimmed.slice(1, -1).includes('[')
        ? parseInlineArray(trimmed)
        : coerceScalar(trimmed)
      index += 1
      continue
    }
    if (trimmed.startsWith('{')) { index += 1; continue } // flow mapping: ignored
    if (trimmed.startsWith('&') || trimmed.startsWith('*')) { index += 1; continue } // anchors/aliases: ignored
    out[key] = coerceScalar(trimmed)
    index += 1
  }
  return out
}

/** Flat meta view: top-level keys plus nested leaf keys (one level), so
 *  `metadata.short-description` is readable as `short-description`. */
function parseFrontmatterMeta(yamlText) {
  let top
  try { top = parseBlock(String(yamlText).split(/\r?\n/)) }
  catch { return {} }
  if (top === null || typeof top !== 'object' || Array.isArray(top)) return {}
  const flat = {}
  for (const [key, value] of Object.entries(top)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flat[key] = value
      for (const [childKey, childValue] of Object.entries(value)) {
        if (!(childKey in flat)) flat[childKey] = childValue
      }
    } else {
      flat[key] = value
    }
  }
  return flat
}

function parseSkillMd(content) {
  const yamlText = extractFrontmatter(content)
  if (yamlText === undefined) return { meta: {}, body: content }
  const meta = parseFrontmatterMeta(yamlText)
  const lines = content.split(/\r?\n/)
  let closer = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { closer = index; break }
  }
  const body = closer >= 0 ? lines.slice(closer + 1).join('\n').replace(/^\r?\n/, '') : content
  return { meta, body }
}

function buildEntry(root, dir, stat) {
  return { root, dir, relPath: relative(root, dir).split(sep).join('/'), stat }
}

async function scanSkillDirs(root, current, out, visited) {
  let entries
  try { entries = await fsP.readdir(current, { withFileTypes: true }) }
  catch { return }
  for (const entry of entries) {
    if (SCAN_SKIP.has(entry.name)) continue
    const dir = join(current, entry.name)
    // Follow symlinks: executor skills dirs routinely symlink entries from a
    // shared pool (~/.agents/skills); Dirent.isDirectory() would miss them.
    let dirStat
    try { dirStat = await fsP.stat(dir) } catch { continue }
    if (!dirStat.isDirectory()) continue
    let real
    try { real = await fsP.realpath(dir) } catch { continue }
    if (visited.has(real)) continue // symlink cycle guard
    visited.add(real)
    let hasSkillMd = false, skillMdStat
    try { skillMdStat = await fsP.stat(join(dir, 'SKILL.md')); hasSkillMd = skillMdStat.isFile() } catch { hasSkillMd = false }
    if (hasSkillMd) { out.push(buildEntry(root, dir, skillMdStat)) }
    else { await scanSkillDirs(root, dir, out, visited) }
  }
}

async function scanRoot(root) {
  const out = []
  let real
  try { await fsP.access(root) } catch { return out }
  try { real = await fsP.realpath(root) } catch { return out }
  await scanSkillDirs(root, root, out, new Set([real]))
  return out
}

async function readSkillEntry(entry) {
  const content = await fsP.readFile(join(entry.dir, 'SKILL.md'), 'utf8')
  const { meta, body } = parseSkillMd(content)
  const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : basename(entry.dir)
  return {
    entry,
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    version: typeof meta.version === 'string' ? meta.version : undefined,
    author: typeof meta.author === 'string' ? meta.author : undefined,
    license: typeof meta.license === 'string' ? meta.license : undefined,
    meta, body,
    modifiedAt: entry.stat !== undefined ? entry.stat.mtime.toISOString() : undefined,
  }
}

async function countFilesAndSize(dir) {
  let fileCount = 0, totalSize = 0
  const walk = async (current) => {
    const entries = await fsP.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      // stat follows symlinks so linked files/dirs count toward the skill
      let stat = await fsP.stat(entryPath).catch(() => undefined)
      if (stat === undefined) continue
      if (stat.isDirectory()) { await walk(entryPath) }
      else if (stat.isFile()) {
        fileCount += 1
        totalSize += stat.size
      }
    }
  }
  await walk(dir)
  return { fileCount, totalSize }
}

async function copyDir(from, to) {
  await fsP.mkdir(to, { recursive: true })
  const entries = await fsP.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const source = join(from, entry.name), target = join(to, entry.name)
    // Follow symlinks and materialize their targets: installs must be
    // self-contained (a linked references/ dir cannot dangle later).
    let stat
    try { stat = await fsP.stat(source) } catch { continue }
    if (stat.isDirectory()) { await copyDir(source, target) }
    else if (stat.isFile()) { await fsP.copyFile(source, target) }
  }
}

async function resolveSkillDir(root, fullName) {
  if (fullName === '' || fullName.includes('..') || fullName.includes('\\') || fullName.startsWith('/')) {
    throw new Error('invalid skill name')
  }
  const dir = resolve(root, fullName)
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('invalid skill name: escapes root')
  let stat
  try { stat = await fsP.stat(join(dir, 'SKILL.md')) }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Error(`skill '${fullName}' not found`)
    throw e
  }
  if (!stat.isFile()) throw new Error('not a skill directory')
  return dir
}

// ── Shared route helpers ────────────────────────────────────────────────

function validSkillName(name) {
  return typeof name === 'string' && name !== '' && !name.includes('..') && !name.includes('\\') && !name.startsWith('/')
}

/**
 * Resolve a skill dir under one source root by the identifier the client sends.
 * Tries the direct path `<root>/<name>` first (covers dir name == frontmatter
 * name, and nested relPaths like `grouped/foo`). On ENOENT, falls back to a
 * frontmatter-name scan: some sources ship a skill in a dir whose name ≠ its
 * frontmatter `name` (e.g. WorkBuddy's `dev-expert__skillhub/` whose frontmatter
 * `name` is `dev-expert`). The client lists & addresses such skills by their
 * frontmatter `name`, so the resolver must honor it. frontmatter `name` is always
 * single-segment kebab, so a slash-bearing request is a relPath that already
 * missed direct lookup and cannot be a frontmatter name — skip the scan.
 * Returns the skill dir or undefined.
 */
async function resolveSkillDirByName(root, name) {
  try { return await resolveSkillDir(root, name) }
  catch (e) {
    if (!String(e && e.message).includes('not found')) throw e
  }
  if (name.includes('/')) return undefined
  for (const entry of await scanRoot(root)) {
    try { if ((await readSkillEntry(entry)).name === name) return entry.dir }
    catch {}
  }
  return undefined
}

/** Resolve `<root>/<name>` to an existing skill dir under one source root. */
async function findDirUnderRoot(root, fullName, where) {
  const dir = await resolveSkillDirByName(root, fullName)
  if (dir === undefined) throw new Error(`skill '${fullName}' not found in ${where}`)
  return dir
}

async function sendSkillFile(res, skillDir, relPath, contentType) {
  const target = resolve(skillDir, relPath)
  const skillRoot = resolve(skillDir)
  if (!target.startsWith(skillRoot + sep)) throw new Error('invalid file path')
  const stat = await fsP.stat(target)
  if (!stat.isFile()) throw new Error('file not found')
  res.writeHead(200, {
    'content-type': contentType !== undefined && contentType !== '' ? contentType : 'application/octet-stream',
    'content-length': stat.size,
  })
  const stream = createReadStream(target)
  stream.pipe(res)
  await new Promise((fulfil, reject) => {
    stream.on('error', reject)
    res.on('close', () => fulfil())
    stream.on('end', () => fulfil())
  })
}

async function walkFiles(base, current, files = []) {
  const entries = await fsP.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(current, entry.name)
    let stat = await fsP.stat(entryPath).catch(() => undefined) // follows symlinks
    if (stat === undefined) continue
    if (stat.isDirectory()) { await walkFiles(base, entryPath, files) }
    else if (stat.isFile()) {
      files.push({ path: relative(base, entryPath).split(sep).join('/'), size: stat.size, modifiedAt: stat.mtime.toISOString() })
    }
  }
  return files
}

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0, chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function flagValue(meta, key) {
  const value = meta[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(lowered)) return true
    if (['false', 'no', 'off', '0'].includes(lowered)) return false
  }
  return undefined
}

function invocationPolicy(meta) {
  return { modelInvocable: flagValue(meta, 'disable-model-invocation') !== true, userInvocable: flagValue(meta, 'user-invocable') !== false }
}

function truncateDescription(text) {
  if (typeof text !== 'string') return ''
  const single = text.split(/\r?\n/)[0]
  return single.length > DESCRIPTION_LIMIT ? single.slice(0, DESCRIPTION_LIMIT) + '…' : single
}

// ── 注入开销估算（字符数 + 可选 token 估算器）─────────────────────────────
// 技能注入模型 = 名称+描述，指标取该文本的字符长度。列表接口的 description
// 是截断展示，统计必须喂截断前的全文。
//
// 原版用 js-tiktoken 的 cl100k_base 词表额外估算 token 数；本 fork 移除了该
// 依赖（运行期第三方依赖归零）。字符数是精确值，token 数在原版里也只是
// 「与 tiktokenizer 同词表」的近似值（DeepSeek 实际分词不同），故默认不再给出。
//
// 想恢复 token 数：`npm i js-tiktoken`，再把下面 usageTokenEncoder() 的
// 注释块打开即可（或者在宿主里注入一个编码器：见 __internals.setTokenEncoder，
// 任何带 `.encode(text) → array` 的对象都可以，客户端会自动改渲染 token）。
const USAGE_MEMO_CAP = 25000
const usageMemo = new Map()
let tokenEncoder
let tokenEncoderResolved = false
let tokenEncoderOverride // 测试/宿主注入点：undefined 走正常解析

/** cl100k_base 编码器（可选依赖，缺失即静默降级为只出字符数）。 */
function usageTokenEncoder() {
  if (tokenEncoderOverride !== undefined) return tokenEncoderOverride
  if (tokenEncoderResolved) return tokenEncoder
  tokenEncoderResolved = true
  tokenEncoder = null
  // 需要 token 估算时打开这两行（并 npm i js-tiktoken）：
  // try {
  //   const { Tiktoken } = require('js-tiktoken/lite')
  //   tokenEncoder = new Tiktoken(require('js-tiktoken/ranks/cl100k_base'))
  // } catch { tokenEncoder = null }
  return tokenEncoder
}

function usageStat(name, description) {
  const desc = typeof description === 'string' ? description : ''
  const text = `${name || ''}\n${desc}`
  const stat = { chars: text.length }
  const enc = usageTokenEncoder()
  if (enc !== null && enc !== undefined && typeof enc.encode === 'function') {
    let tokens = usageMemo.get(text)
    if (tokens === undefined) {
      try { tokens = enc.encode(text).length } catch { tokens = undefined }
      if (tokens !== undefined) {
        if (usageMemo.size >= USAGE_MEMO_CAP) usageMemo.clear()
        usageMemo.set(text, tokens)
      }
    }
    if (tokens !== undefined) stat.tokens = tokens
  }
  return stat
}

function expandTilde(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p
}

/**
 * 切换 dsh 原生治理键 `disable-model-invocation`（docs/subsystems/skills.md）。
 * modelInvocable=true 时移除该键；false 时写入 true。其余 frontmatter 键与正文原样保留。
 */
function setModelInvocable(content, modelInvocable) {
  const lines = String(content || '').split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') {
    return modelInvocable ? content : `---\ndisable-model-invocation: true\n---\n\n${content}`
  }
  let closer = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { closer = i; break }
  }
  if (closer === -1) return content
  let kept = lines.slice(1, closer).filter((l) => !/^disable-model-invocation\s*:/.test(l.trim()))
  if (!modelInvocable) kept = [...kept, 'disable-model-invocation: true']
  return [...lines.slice(0, 1), ...kept, ...lines.slice(closer)].join('\n')
}

async function atomicWriteJs(file, content) {
  await fsP.mkdir(join(file, '..'), { recursive: true })
  const temp = join(join(file, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content, 'utf8')
  await fsP.rename(temp, file)
}

// ── Executor（本机技能来源）运行时 sheet ─────────────────────────────────
// 内置表 EXECUTOR_DEFS 永远是默认值，这份 sheet 只存用户增量（目录覆盖 /
// 停用 / 新增），所以「恢复默认」= 清空整个 section。与 cordis 静态配置
// （executorDirs/disabledExecutors/extraExecutors）的优先级：cordis 最高。
const EXECUTOR_SETTINGS_NS = 'skills-management-executors'

function executorSettingsSchema() {
  if (!Schema) return null
  return Schema.object({
    dirs: Schema.dict(Schema.string()),      // 内置 key → 目录覆盖（dsh 锁定不接受）
    disabled: Schema.array(Schema.string()), // 停用的内置 key
    extra: Schema.array(Schema.object({      // 用户新增执行器
      key: Schema.string(),
      label: Schema.string(),
      dir: Schema.string(),
    })),
  })
}
const EXECUTOR_SHEET_DEFAULTS = Object.freeze({ dirs: {}, disabled: [], extra: [] })

function contentTypeFor(p) {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  const map = { md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', yaml: 'text/yaml', yml: 'text/yaml' }
  return map[ext]
}

// ── MCP 管理错误 → HTTP 状态码 ──────────────────────────────────────────
function mcpErrorStatus(error) {
  const message = String((error && error.message) || error)
  if (/not found|not managed|is not known/i.test(message)) return 404
  if (/already (exists|managed|configured)|cannot be removed|unavailable/i.test(message)) return 409
  if (/is required|must be|must match|is not a valid URL|only a process\.env/i.test(message)) return 400
  return 500
}

module.exports = {
  name: 'skills-management',
  inject: ['skills', 'webServer', 'settings', 'agents', 'tools', 'loader'],
  __internals: { extractFrontmatter, parseSkillMd, parseFrontmatterMeta, invocationPolicy, installDirName, EXECUTOR_DEFS, usageStat, usageMemo, setTokenEncoder: (v) => { tokenEncoderOverride = v } },

  apply(ctx, config = {}) {
    const installedDir = resolve(expandTilde(config.installedDir !== undefined ? config.installedDir : process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skills') : join(homedir(), '.dsh', 'skills')))
    const providerName = config.providerName !== undefined ? config.providerName : 'ntd-skills'

    // ── MCP 管理运行时 ────────────────────────────────────────────────────
    // apply() 必须保持同步：Cordis 把带 prototype 的函数当构造函数、会忽略返回的
    // promise，async apply 里 await 之后抛错会变成 unhandled rejection 并可能拖垮
    // 整个进程。所以这里只做同步注册，异步的挂载/同步都在事件回调或请求里做。
    const mcpStore = mcpManager.createStore({ logger: ctx.logger })
    mcpStore.loadSync()
    /** 服务可能在最小组合里缺席：一律用 ctx.get() 判定，别用属性访问（会抛 Guard 错）。 */
    const serviceOf = (name) => {
      try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] } catch { return undefined }
    }
    /** agent.id -> { deny, disposer }：当前生效的 MCP 遮蔽层。 */
    const mcpRestrictions = new Map()
    /** serverName -> loader entry id：本插件动态挂载的 server。 */
    const mountedMcp = new Map()
    const applyingRestrictions = new Set()
    let mcpWriteChain = Promise.resolve()

    /** 序列化状态改写，避免并发读改写互相覆盖。 */
    const withMcpLock = (task) => {
      const run = mcpWriteChain.then(task, task)
      mcpWriteChain = run.catch(() => {})
      return run
    }

    const disabledServerNames = () => (mcpStore.get().disabled ?? []).filter((n) => typeof n === 'string')

    /**
     * 把「已停用」落到某个 agent 的工具目录上。
     * 只 deny 当前真实存在的工具名（tools.restrict 对未知名字会抛错），并且
     * deny 集合没变就绝不重复 restrict —— restrict 会同步触发 tools/change，
     * 而我们的 tools/change 监听又会回到这里，不比较就会无限递归把进程卡死。
     */
    function applyMcpRestrictions(agent) {
      if (agent === undefined || typeof agent.id !== 'string') return
      if (applyingRestrictions.has(agent.id)) return
      applyingRestrictions.add(agent.id)
      try {
        const toolsService = serviceOf('tools')
        if (toolsService === undefined || typeof toolsService.schemas !== 'function') return
        const deny = mcpManager.denyNamesForDisabled(disabledServerNames(), toolsService.schemas())
        const current = mcpRestrictions.get(agent.id)
        if (current !== undefined && current.deny.join('\u0000') === deny.join('\u0000')) return
        if (current !== undefined) {
          // 先删表项再 dispose：disposer 会触发 tools/change，重入时必须看不到旧项
          mcpRestrictions.delete(agent.id)
          try { current.disposer() } catch { /* 已失效 */ }
        }
        if (deny.length === 0) return
        const agentCtx = agent.ctx
        if (agentCtx === undefined || typeof agentCtx.get !== 'function') return
        const scopedTools = agentCtx.get('tools')
        if (scopedTools === undefined || typeof scopedTools.restrict !== 'function') return
        const disposer = scopedTools.restrict({ deny })
        mcpRestrictions.set(agent.id, { deny, disposer })
      } catch (error) {
        ctx.logger.warn(`skills-management: MCP restrict failed: ${error && error.message}`)
      } finally {
        applyingRestrictions.delete(agent.id)
      }
    }

    const applyMcpRestrictionsToAll = () => {
      const agents = serviceOf('agents')
      if (agents === undefined || typeof agents.list !== 'function') return
      for (const agent of agents.list()) applyMcpRestrictions(agent)
    }

    /**
     * Who already owns that serverName in the loader: `undefined` = nobody, so
     * a mount is safe. A duplicate `serverName` makes `dsh-mcp-client` fail, so
     * this check is what keeps two MCP plugins from fighting over one server.
     */
    const ownerOfServer = (serverName) => mcpManager.mountedBy(serviceOf('loader'), serverName)

    async function mountMcpServer(server) {
      if (mountedMcp.has(server.serverName)) return
      const loader = serviceOf('loader')
      if (loader === undefined || typeof loader.create !== 'function') {
        throw new Error('the loader service is unavailable, so a new MCP server cannot be mounted')
      }
      const owner = ownerOfServer(server.serverName)
      if (owner !== undefined) {
        const by = owner.plugin !== undefined ? `the plugin '${owner.plugin}'` : 'a composition layer'
        const error = new Error(
          `MCP server '${server.serverName}' is already mounted by ${by} (entry '${owner.id}')`
          + (owner.owner === 'other' ? '; import it after that plugin is disabled, or manage it there' : ''))
        error.status = 409
        throw error
      }
      const entryId = mcpManager.MANAGED_ENTRY_PREFIX + server.serverName
      await loader.create({ id: entryId, name: mcpManager.MCP_PLUGIN_NAME, config: mcpManager.mcpClientConfig(server) })
      mountedMcp.set(server.serverName, entryId)
    }

    async function unmountMcpServer(serverName) {
      const entryId = mountedMcp.get(serverName)
      if (entryId === undefined) return
      const loader = serviceOf('loader')
      if (loader === undefined || typeof loader.remove !== 'function') {
        mountedMcp.delete(serverName)
        return
      }
      try {
        // 先等移除真的完成再清表：否则并发的挂载会在旧条目还在时又 create 一次
        await loader.remove(entryId)
      } catch (error) {
        ctx.logger.warn(`skills-management: unmount of '${serverName}' failed: ${error && error.message}`)
      }
      mountedMcp.delete(serverName)
    }

    /**
     * Mount every enabled server this plugin owns — the hand-written file's plus
     * the ones added on the page — and unmount the ones no longer wanted.
     * Called at startup and after any state change.
     */
    async function syncUserMcpMounts() {
      const loader = serviceOf('loader')
      if (loader === undefined) return
      const wanted = mcpManager.mountableServers(mcpStore.get(), mcpManager.readLocalConfig())
      const wantedNames = new Set(wanted.map((server) => server.serverName))
      // drop mounts whose entry is gone (deleted by hand, or its file changed)
      for (const serverName of [...mountedMcp.keys()]) {
        if (!wantedNames.has(serverName)) await unmountMcpServer(serverName)
      }
      for (const server of wanted) {
        try { await mountMcpServer(server) } catch (error) {
          ctx.logger.warn(`skills-management: mount of '${server.serverName}' failed: ${error && error.message}`)
        }
      }
    }

    /** 从其他插件可导入的候选（只读：不写状态、不挂载）。 */
    const mcpImportSnapshot = async () => {
      const sources = await mcpManager.readImportCandidates({
        exclude: (mcpStore.get().servers ?? []).map((server) => server.serverName),
        takenByOthers: mcpManager.loaderServers(serviceOf('loader'))
          .filter((entry) => entry.owner !== 'self')
          .map((entry) => entry.config.serverName),
      })
      const importable = sources.flatMap((source) => source.candidates
        .filter((candidate) => candidate.config !== undefined && candidate.conflict === undefined))
      return {
        sources: sources.map((source) => ({
          ...source,
          file: displayPath(source.file),
          candidates: source.candidates.map((candidate) => ({
            serverName: candidate.serverName,
            transport: candidate.transport,
            command: candidate.command,
            args: candidate.args,
            url: candidate.url,
            enabled: candidate.enabled,
            conflict: candidate.conflict,
            invalid: candidate.invalid,
          })),
        })),
        importableCount: importable.length,
      }
    }

    const mcpSnapshot = () => {
      const toolsService = serviceOf('tools')
      const schemas = toolsService !== undefined && typeof toolsService.schemas === 'function' ? toolsService.schemas() : []
      const loader = serviceOf('loader')
      const state = mcpStore.get()
      const stateStatus = typeof mcpStore.status === 'function' ? mcpStore.status() : { status: 'ok' }
      const local = mcpManager.readLocalConfig()
      return {
        servers: mcpManager.listServers(loader, state, schemas, local),
        stateFile: displayPath(mcpManager.stateFile()),
        localFile: displayPath(local.file),
        localStatus: local.status,
        localError: local.error,
        localInvalid: local.invalid,
        // 'corrupt' means the list below is NOT the whole truth — the page must say so
        stateStatus: stateStatus.status,
        stateError: stateStatus.error,
        stateBackup: stateStatus.backup === undefined ? undefined : displayPath(stateStatus.backup),
        loaderAvailable: loader !== undefined && typeof loader.entries === 'function',
        mountAvailable: loader !== undefined && typeof loader.create === 'function',
        restrictAvailable: toolsService !== undefined && typeof toolsService.schemas === 'function',
      }
    }

    // 启动接线（同步注册，异步动作 fire-and-forget 且自带兜底）
    ctx.effect(() => {
      applyMcpRestrictionsToAll()
      void syncUserMcpMounts().catch((error) => {
        ctx.logger.warn(`skills-management: initial MCP mount pass failed: ${error && error.message}`)
      })
      return () => {
        for (const { disposer } of mcpRestrictions.values()) {
          try { disposer() } catch { /* 已失效 */ }
        }
        mcpRestrictions.clear()
        for (const entryId of mountedMcp.values()) {
          const loader = serviceOf('loader')
          if (loader !== undefined && typeof loader.remove === 'function') void loader.remove(entryId).catch(() => {})
        }
        mountedMcp.clear()
      }
    }, 'skills-management: MCP mounts + restrictions')

    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', ({ agent }) => { applyMcpRestrictions(agent) })
      ctx.on('agent/disposed', ({ agent }) => {
        const current = mcpRestrictions.get(agent && agent.id)
        if (current !== undefined) {
          mcpRestrictions.delete(agent.id)
          try { current.disposer() } catch { /* 已失效 */ }
        }
      })
      // 新工具出现（server 重连、动态挂载完成）时补一次 restrict，让刚注册的
      // 工具也被 deny；compare-before-apply 保证不会因此循环。
      ctx.on('tools/change', () => { applyMcpRestrictionsToAll() })
    }

    // ── Executor (on-machine source) rows ──
    // dsh first (its root is the installed library, locked); then known defs
    // minus disabled; then user extras. Rows are recomputed per request so
    // runtime edits (executor-settings API → settings.yaml) apply without a
    // restart. Per-key priority: cordis 静态配置 > runtime sheet > 默认表，
    // `executorDirs` overrides keep making scans testable without $HOME.
    const executorDirsOverride = config.executorDirs !== undefined && config.executorDirs !== null && typeof config.executorDirs === 'object' ? config.executorDirs : {}
    const disabledExecutors = new Set(Array.isArray(config.disabledExecutors) ? config.disabledExecutors : [])
    const cordisExtras = (Array.isArray(config.extraExecutors) ? config.extraExecutors : []).filter((e) => e !== null && typeof e === 'object')
    let executorSettingsScope = null
    const executorSettingsOverrides = {} // fallback sheet when the service is absent
    const runtimeSheet = () => {
      const raw = executorSettingsScope && typeof executorSettingsScope.get === 'function'
        ? executorSettingsScope.get()
        : executorSettingsOverrides
      const v = raw && typeof raw === 'object' ? raw : {}
      return {
        dirs: v.dirs !== null && typeof v.dirs === 'object' && !Array.isArray(v.dirs) ? v.dirs : {},
        disabled: Array.isArray(v.disabled) ? v.disabled : [],
        extra: Array.isArray(v.extra) ? v.extra : [],
      }
    }
    const computeExecutorRows = () => {
      const sheet = runtimeSheet()
      const runtimeDisabled = new Set(sheet.disabled)
      const rows = []
      const seen = new Set()
      const pushExtra = (extra, locked) => {
        if (extra === null || typeof extra !== 'object') return
        if (typeof extra.key !== 'string' || extra.key === '') return
        if (typeof extra.dir !== 'string' || extra.dir === '') return
        if (seen.has(extra.key)) return
        seen.add(extra.key)
        rows.push({
          key: extra.key,
          label: typeof extra.label === 'string' && extra.label !== '' ? extra.label : extra.key,
          root: resolve(expandTilde(extra.dir)),
          readOnly: extra.readOnly === true,
          source: 'custom',
          locked: locked === true,
        })
      }
      for (const def of EXECUTOR_DEFS) {
        if (disabledExecutors.has(def.key) || runtimeDisabled.has(def.key)) continue
        let root
        if (def.key === 'dsh') root = installedDir
        else if (executorDirsOverride[def.key] !== undefined) root = resolve(expandTilde(String(executorDirsOverride[def.key])))
        else if (typeof sheet.dirs[def.key] === 'string' && sheet.dirs[def.key] !== '') root = resolve(expandTilde(sheet.dirs[def.key]))
        else root = def.sub !== undefined ? join(homedir(), ...def.sub.split('/')) : undefined
        if (seen.has(def.key)) continue
        seen.add(def.key)
        rows.push({ key: def.key, label: def.label, root, readOnly: def.readOnly === true, source: 'builtin', locked: def.key === 'dsh' })
      }
      for (const extra of cordisExtras) pushExtra(extra, true)
      for (const extra of sheet.extra) pushExtra(extra, false)
      return rows
    }
    /** 管理面板投影：全部内置（停用的也列，UI 置灰）+ 自定义，带可编辑性标记。 */
    const executorSheetProjection = () => {
      const sheet = runtimeSheet()
      const runtimeDisabled = new Set(sheet.disabled)
      const executors = []
      for (const def of EXECUTOR_DEFS) {
        const byConfig = executorDirsOverride[def.key] !== undefined
        const runtimeOverridden = typeof sheet.dirs[def.key] === 'string' && sheet.dirs[def.key] !== ''
        executors.push({
          key: def.key,
          label: def.label,
          source: 'builtin',
          locked: def.key === 'dsh',
          managedByConfig: byConfig,
          disabled: def.key !== 'dsh' && (disabledExecutors.has(def.key) || runtimeDisabled.has(def.key)),
          overridden: runtimeOverridden,
          defaultDir: def.key === 'dsh' ? displayPath(installedDir) : def.sub !== undefined ? '~/' + def.sub : '',
          dir: def.key === 'dsh'
            ? displayPath(installedDir)
            : byConfig ? displayPath(resolve(expandTilde(String(executorDirsOverride[def.key]))))
            : runtimeOverridden ? sheet.dirs[def.key]
            : def.sub !== undefined ? '~/' + def.sub : '',
        })
      }
      for (const extra of cordisExtras) {
        if (typeof extra.key !== 'string' || extra.key === '' || typeof extra.dir !== 'string' || extra.dir === '') continue
        executors.push({ key: extra.key, label: typeof extra.label === 'string' && extra.label !== '' ? extra.label : extra.key, source: 'custom', locked: false, managedByConfig: true, disabled: false, dir: extra.dir })
      }
      for (const extra of sheet.extra) {
        if (extra === null || typeof extra !== 'object') continue
        if (typeof extra.key !== 'string' || extra.key === '' || typeof extra.dir !== 'string' || extra.dir === '') continue
        executors.push({ key: extra.key, label: typeof extra.label === 'string' && extra.label !== '' ? extra.label : extra.key, source: 'custom', locked: false, managedByConfig: false, disabled: false, dir: extra.dir })
      }
      return executors
    }

    async function discoverInstalled() {
      const installed = []
      for (const entry of await scanRoot(installedDir)) {
        try { installed.push(await readSkillEntry(entry)) }
        catch (e) { ctx.logger.warn(`skills-management: skipping ${entry.dir}: ${e && e.message}`) }
      }
      return { installed }
    }

    /**
     * One executor row → summary + flat skill list (ntd `discover_skills_for`).
     * With `countsOnly` the expensive per-skill dir walks are skipped and
     * `skills` stays undefined — callers get `skillCount` only.
     */
    async function scanExecutor(row, countsOnly = false) {
      const summary = { key: row.key, label: row.label, dir: displayPath(row.root), dirExists: false, readOnly: row.readOnly, source: row.source, locked: row.locked === true, skillCount: 0 }
      if (!countsOnly) summary.skills = []
      try { await fsP.access(row.root) } catch { return summary }
      summary.dirExists = true
      for (const entry of await scanRoot(row.root)) {
        try {
          const read = await readSkillEntry(entry)
          // ntd naming: nested skill whose frontmatter name equals its dir
          // basename keeps the category path as display name.
          const listed = entry.relPath.includes('/') && read.name === basename(entry.dir) ? entry.relPath : read.name
          summary.skillCount += 1
          if (countsOnly) continue
          const { fileCount, totalSize } = await countFilesAndSize(entry.dir)
          summary.skills.push({ name: listed, relPath: entry.relPath, description: truncateDescription(read.description), keywords: read.keywords, version: read.version, author: read.author, fileCount, totalSize, modifiedAt: read.modifiedAt, modelInvocable: invocationPolicy(read.meta).modelInvocable, ...usageStat(listed, read.description) })
        } catch (e) { ctx.logger.warn(`skills-management: skipping ${entry.dir}: ${e && e.message}`) }
      }
      if (summary.skills !== undefined) {
        summary.skills.sort((a, b) => {
          const la = a.name.toLowerCase(), lb = b.name.toLowerCase()
          return la < lb ? -1 : la > lb ? 1 : 0
        })
      }
      return summary
    }

    function findExecutorRow(key) {
      return computeExecutorRows().find((row) => row.key === key)
    }

    /**
     * Locate a named skill dir either scoped to one executor source or via
     * the auto path (the dsh user library).
     * Returns `{ dir, executorKey|null, isInstalled }`.
     */
    async function locateNamedSkillDir(name, executorKey) {
      if (executorKey !== undefined && executorKey !== null && executorKey !== '' && executorKey !== 'auto') {
        const row = findExecutorRow(executorKey)
        if (row === undefined) throw new Error(`unknown executor '${executorKey}'`)
        const dir = await findDirUnderRoot(row.root, name, `${row.label} (${row.key})`)
        return { dir, executorKey: row.key, isInstalled: row.key === 'dsh' }
      }
      try { return { dir: await resolveSkillDir(installedDir, name), executorKey: 'dsh', isInstalled: true } }
      catch { throw new Error(`skill '${name}' not found`) }
    }

    /** Copy any source skill dir into the dsh user library and refresh. */
    async function copyIntoLibrary(sourceDir, shortName, overwrite) {
      const target = join(installedDir, shortName)
      if (!overwrite) {
        try { await fsP.access(target); throw new Error(`skill '${shortName}' already installed`) }
        catch (e) { if (e.code !== 'ENOENT') throw e }
      } else { await fsP.rm(target, { recursive: true, force: true }) }
      await copyDir(sourceDir, target)
      invalidate()
      return { name: shortName, path: target }
    }

    async function installFromExecutor(executorKey, fullName, overwrite) {
      const row = findExecutorRow(executorKey)
      if (row === undefined) throw new Error(`unknown executor '${executorKey}'`)
      const sourceDir = await findDirUnderRoot(row.root, fullName, `${row.label} (${row.key})`)
      return copyIntoLibrary(sourceDir, installDirName(fullName), overwrite)
    }

    async function deleteSkill(name, executorKey) {
      if (!validSkillName(name)) throw new Error('invalid skill name')
      const key = executorKey === undefined || executorKey === null || executorKey === '' ? 'dsh' : executorKey
      const row = findExecutorRow(key)
      if (row === undefined) throw new Error(`unknown executor '${key}'`)
      if (row.readOnly) throw new Error(`source '${key}' is read-only; cannot delete skills there`)
      const target = await resolveSkillDirByName(row.root, name)
      if (target === undefined) throw new Error(`skill '${name}' not found in ${row.label} (${row.key})`)
      await fsP.rm(target, { recursive: true })
      if (key === 'dsh') invalidate()
      return { removed: name, executor: key }
    }

    // ── Executor settings registration ──
    // settings 注册：静态 inject 已保证 ctx.settings 就绪（此前走动态 ctx.inject 且
    // schema 用 zod——不兼容导致 register 静默失败）
    if (Schema && ctx.settings && typeof ctx.settings.register === 'function') {
      try {
        executorSettingsScope = ctx.settings.register(EXECUTOR_SETTINGS_NS, executorSettingsSchema(), { base: EXECUTOR_SHEET_DEFAULTS })
      } catch (e) { ctx.logger.warn(`skills-management: executor settings register: ${e && e.message}`) }
    }

    let providerControl
    const invalidate = () => { if (providerControl !== undefined) providerControl.invalidate() }

    ctx.skills.registerProvider((control) => {
      providerControl = control
      control.signal.addEventListener('abort', () => { if (providerControl === control) providerControl = undefined }, { once: true })
      return {
        name: providerName,
        async list() {
          const { installed } = await discoverInstalled()
          const candidates = []
          // Fail-soft: the registry throws — and kills the requesting session's
          // turn — on candidates that fail harness validation (empty
          // description, non-kebab-case name). Hand-edited local skills trigger
          // both routinely, so pre-filter here.
          const isValid = (row) => {
            if (!row.name || !KEBAB_NAME_RE.test(row.name)) return `invalid name '${row.name}'`
            if (!row.description || row.description.trim() === '') return 'empty description'
            return undefined
          }
          for (const row of installed) {
            const why = isValid(row)
            if (why !== undefined) {
              ctx.logger.warn(`skills-management: skipping installed skill '${row.name}' (${row.entry.dir}): ${why}`)
              continue
            }
            candidates.push(toCandidate(row, 'user-installed', RANK_INSTALLED))
          }
          return candidates
        },
        async get(candidate) {
          const entry = candidate.locator
          try {
            const row = await readSkillEntry({ ...entry, stat: entry.stat ?? (await fsP.stat(join(entry.dir, 'SKILL.md'))) })
            return { name: row.name, description: row.description, whenToUse: typeof row.meta.whenToUse === 'string' ? row.meta.whenToUse : undefined, invocation: invocationPolicy(row.meta), source: candidate.source, provider: providerName, resourceBase: { kind: 'directory', path: entry.dir }, content: row.body, path: join(entry.dir, 'SKILL.md'), metadata: row.meta }
          } catch { return undefined }
        },
      }
    })

    function toCandidate(row, source, rank, invocationOverride) {
      const base = invocationPolicy(row.meta)
      const invocation = invocationOverride ? { ...base, ...invocationOverride } : base
      return { name: row.name, description: row.description, invocation, source, provider: providerName, rank, locator: { dir: row.entry.dir, root: row.entry.root, relPath: row.entry.relPath, stat: row.entry.stat }, path: join(row.entry.dir, 'SKILL.md'), metadata: row.meta, whenToUse: typeof row.meta.whenToUse === 'string' ? row.meta.whenToUse : undefined, resourceBase: { kind: 'directory', path: row.entry.dir } }
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/skills-management/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const query = url.searchParams

          // GET /skills-management/api/executor-settings → 执行器目录管理面板：
          // 全部内置（停用的也在，UI 置灰）+ 自定义，带每行可编辑性标记。
          if (req.method === 'GET' && apiPath.endsWith('/skills-management/api/executor-settings')) {
            sendJson(res, 200, { executors: executorSheetProjection(), settingsFile: join(dshHome(), 'settings.yaml') })
            return
          }

          // PUT /skills-management/api/executor-settings — body 就是下一份运行时
          // sheet {dirs, disabled, extra}。走 replace 整体替换（update 深合并
          // 删不掉 dict 里的键，恢复默认/删除行都需要整体覆写）；校验失败抛错 →
          // 外层 catch 回 400，持久化发生在校验通过之后。
          if (req.method === 'PUT' && apiPath.endsWith('/skills-management/api/executor-settings')) {
            const body = await readJsonBody(req)
            const dirs = {}
            if (body.dirs !== undefined && body.dirs !== null) {
              if (typeof body.dirs !== 'object' || Array.isArray(body.dirs)) throw new Error('dirs must be an object of executor key → directory')
              for (const [key, value] of Object.entries(body.dirs)) {
                if (key === 'dsh') throw new Error("executor 'dsh' is locked: its root is the installed skill library")
                if (!EXECUTOR_DEFS.some((d) => d.key === key)) throw new Error(`unknown executor '${key}'`)
                if (typeof value !== 'string' || value.trim() === '') throw new Error(`dir for '${key}' must be a non-empty string`)
                dirs[key] = value.trim()
              }
            }
            const disabled = []
            if (body.disabled !== undefined && body.disabled !== null) {
              if (!Array.isArray(body.disabled)) throw new Error('disabled must be an array of executor keys')
              for (const item of body.disabled) {
                const key = String(item)
                if (key === 'dsh') throw new Error("executor 'dsh' cannot be disabled")
                if (!EXECUTOR_DEFS.some((d) => d.key === key)) throw new Error(`unknown executor '${key}'`)
                disabled.push(key)
              }
            }
            const extra = []
            if (body.extra !== undefined && body.extra !== null) {
              if (!Array.isArray(body.extra)) throw new Error('extra must be an array of {key, label, dir}')
              for (const item of body.extra) {
                if (item === null || typeof item !== 'object') throw new Error('extra entries must be objects')
                const key = typeof item.key === 'string' ? item.key.trim() : ''
                if (!KEBAB_NAME_RE.test(key)) throw new Error(`executor key '${key || '(empty)'}' must be kebab-case (a-z 0-9 -)`)
                if (EXECUTOR_DEFS.some((d) => d.key === key) || extra.some((e) => e.key === key)) throw new Error(`executor key '${key}' already exists`)
                if (typeof item.dir !== 'string' || item.dir.trim() === '') throw new Error(`dir for '${key}' must be a non-empty string`)
                extra.push({ key, label: typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : key, dir: item.dir.trim() })
              }
            }
            const section = { dirs, disabled, extra }
            if (executorSettingsScope && typeof executorSettingsScope.replace === 'function') {
              await executorSettingsScope.replace(section)
            } else if (executorSettingsScope && typeof executorSettingsScope.update === 'function') {
              await executorSettingsScope.update(section)
            } else {
              Object.assign(executorSettingsOverrides, section)
            }
            sendJson(res, 200, { executors: executorSheetProjection(), settingsFile: join(dshHome(), 'settings.yaml') })
            return
          }

          // GET /skills-management/api/executors → on-machine sources.
          // Variants: ?mode=summary (counts only, no skill arrays) and
          // ?executor=<key> (one source, full list — lazy drill-in).
          if (req.method === 'GET' && apiPath.endsWith('/skills-management/api/executors')) {
            const scopeKey = query.get('executor')
            if (scopeKey !== null && scopeKey !== '') {
              const scoped = findExecutorRow(scopeKey)
              if (scoped === undefined) throw new Error(`unknown executor '${scopeKey}'`)
              sendJson(res, 200, { executor: await scanExecutor(scoped) })
              return
            }
            const countsOnly = query.get('mode') === 'summary'
            const executors = []
            for (const row of computeExecutorRows()) executors.push(await scanExecutor(row, countsOnly))
            sendJson(res, 200, { executors })
            return
          }

          // GET /skills-management/api → list (local library only)
          if (req.method === 'GET' && apiPath === '/skills-management/api') {
            const { installed } = await discoverInstalled()
            sendJson(res, 200, {
              installed: await Promise.all(installed.map(async (row) => { const { fileCount, totalSize } = await countFilesAndSize(row.entry.dir); return { name: row.name, description: truncateDescription(row.description), path: row.entry.dir, fileCount, totalSize, modifiedAt: row.modifiedAt, ...usageStat(row.name, row.description) } })),
            })
            return
          }

          // GET /skills-management/api/detail?name=&executor= → detail
          if (req.method === 'GET' && apiPath.endsWith('/skills-management/api/detail')) {
            const name = query.get('name') || ''
            const located = await locateNamedSkillDir(name, query.get('executor'))
            const content = await fsP.readFile(join(located.dir, 'SKILL.md'), 'utf8')
            const files = await walkFiles(located.dir, located.dir)
            const { fileCount, totalSize } = await countFilesAndSize(located.dir)
            const { meta, body } = parseSkillMd(content)
            const usage = usageStat(typeof meta.name === 'string' && meta.name !== '' ? meta.name : basename(name), meta.description)
            sendJson(res, 200, { name, shortName: basename(name), dir: displayPath(located.dir), executor: located.executorKey, isInstalled: located.isInstalled, content: body, contentWithMeta: content, meta, files, fileCount, totalSize, modifiedAt: files[0]?.modifiedAt, ...usage })
            return
          }

          // GET /skills-management/api/file?name=&path=&executor= → file content
          if (req.method === 'GET' && apiPath.endsWith('/skills-management/api/file')) {
            const name = query.get('name') || '', filePath = query.get('path') || ''
            const located = await locateNamedSkillDir(name, query.get('executor'))
            await sendSkillFile(res, located.dir, filePath, contentTypeFor(filePath))
            return
          }

          // POST /skills-management/api/install {name, from, overwrite?}
          // `from` is the source executor key — mandatory now that the remote
          // catalogue is gone (there is nothing else to install from).
          if (req.method === 'POST' && apiPath.endsWith('/skills-management/api/install')) {
            const body = await readJsonBody(req)
            if (typeof body.name !== 'string' || body.name === '') { sendJson(res, 400, { error: 'body must provide name' }); return }
            if (typeof body.from !== 'string' || body.from === '') { sendJson(res, 400, { error: 'body must provide from (source executor)' }); return }
            const result = await installFromExecutor(body.from, body.name, body.overwrite === true)
            sendJson(res, 201, { installed: { ...result, from: body.from } })
            return
          }

          // DELETE /skills-management/api {name, executor?} → remove
          if (req.method === 'DELETE' && apiPath.endsWith('/skills-management/api')) {
            const body = await readJsonBody(req)
            if (typeof body.name !== 'string' || body.name === '') { sendJson(res, 400, { error: 'body must provide name' }); return }
            sendJson(res, 200, await deleteSkill(body.name, typeof body.executor === 'string' ? body.executor : undefined))
            return
          }

          // PUT /skills-management/api/invocation {name, modelInvocable} → 治理键开关
          // dsh 原生 frontmatter 键（docs/subsystems/skills.md）：disable-model-invocation。
          // 解析范围：用户库（dsh）优先，找不到再查 ~/.agents/skills——dsh 的
          // skill-filesystem 把 user-agents 作为内置根全量扫进模型目录，这个开关
          // 同样管得住它们（其他键原样保留；写完靠宿主 watcher 失效，无需 invalidate）。
          if (req.method === 'PUT' && apiPath.endsWith('/skills-management/api/invocation')) {
            const body = await readJsonBody(req)
            if (typeof body.name !== 'string' || body.name === '') { sendJson(res, 400, { error: 'body must provide name' }); return }
            if (typeof body.modelInvocable !== 'boolean') { sendJson(res, 400, { error: 'body must provide modelInvocable boolean' }); return }
            // 与 dsh skill-filesystem 的 user-agents 根同款解析
            const agentsSkillsRoot = process.env.DSH_AGENTS_HOME !== undefined && process.env.DSH_AGENTS_HOME !== ''
              ? join(resolve(expandTilde(process.env.DSH_AGENTS_HOME)), 'skills')
              : join(homedir(), '.agents', 'skills')
            let skillDir
            let rootKey = 'dsh'
            try { skillDir = await resolveSkillDir(installedDir, body.name) }
            catch { skillDir = await resolveSkillDir(agentsSkillsRoot, body.name); rootKey = 'agents' }
            const file = join(skillDir, 'SKILL.md')
            const updated = setModelInvocable(await fsP.readFile(file, 'utf8'), body.modelInvocable)
            await atomicWriteJs(file, updated)
            invalidate()
            sendJson(res, 200, { name: body.name, modelInvocable: body.modelInvocable, root: rootKey })
            return
          }

          // ── MCP：从其他插件导入 server ────────────────────────────────
          // 别的插件动态挂的 MCP 只存在于它自己的状态文件里；它一被停用，
          // 那批 server 就随之消失。导入即把定义抄进本插件，改由本插件挂载。
          if (apiPath === '/skills-management/api/mcp/import') {
            if (req.method === 'GET') {
              sendJson(res, 200, await mcpImportSnapshot())
              return
            }
            if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
            const body = await readJsonBody(req)
            const requested = Array.isArray(body.serverNames) && body.serverNames.length > 0
              ? body.serverNames.map(String)
              : null
            const sources = await mcpManager.readImportCandidates({
              exclude: (mcpStore.get().servers ?? []).map((server) => server.serverName),
              takenByOthers: (mcpManager.loaderServers(serviceOf('loader')) ?? [])
                .filter((entry) => entry.owner !== 'self')
                .map((entry) => entry.config.serverName),
            })
            const picked = []
            for (const source of sources) {
              for (const candidate of source.candidates) {
                if (candidate.config === undefined || candidate.conflict !== undefined) continue
                if (requested !== null && !requested.includes(candidate.serverName)) continue
                picked.push(candidate)
              }
            }
            if (picked.length === 0) {
              // 同一个端点不该有时 200 有时 201：POST 一律 201
              sendJson(res, 201, { imported: [], skipped: [], ...mcpSnapshot(), ...(await mcpImportSnapshot()) })
              return
            }
            const imported = []
            const skipped = []
            await withMcpLock(async () => {
              const state = mcpStore.get()
              const servers = [...(state.servers ?? [])]
              for (const candidate of picked) {
                const server = { ...candidate.config, enabled: candidate.enabled !== false }
                servers.push(server)
                await mcpStore.replace({ ...state, servers })
                try {
                  await mountMcpServer(server)
                  imported.push(server.serverName)
                } catch (error) {
                  // 挂不上就把它留在状态里但标记未启用，别假装成功
                  ctx.logger.warn(`skills-management: imported '${server.serverName}' could not be mounted: ${error && error.message}`)
                  const current = mcpStore.get()
                  await mcpStore.replace({
                    ...current,
                    servers: (current.servers ?? []).map((entry) => (
                      entry.serverName === server.serverName ? { ...entry, enabled: false } : entry)),
                    disabled: [...new Set([...disabledServerNames(), server.serverName])],
                  })
                  skipped.push({ serverName: server.serverName, reason: String(error && error.message) })
                  if (body.keepDisabledOnFailure !== true) {
                    const cleaned = mcpStore.get()
                    await mcpStore.replace({
                      ...cleaned,
                      servers: (cleaned.servers ?? []).filter((entry) => entry.serverName !== server.serverName),
                      disabled: disabledServerNames().filter((name) => name !== server.serverName),
                    })
                  }
                }
              }
            })
            applyMcpRestrictionsToAll()
            // 两个列表都给：`servers` 是导入后的 MCP 列表（客户端直接渲染），
            // `sources` 是剩下还没导入的候选
            sendJson(res, 201, { imported, skipped, ...mcpSnapshot(), ...(await mcpImportSnapshot()) })
            return
          }

          // ── MCP 管理：/skills-management/api/mcp ──────────────────────
          // 全部基于 loader + 本插件状态文件：不解析、不改写任何 dsh 配置。
          if (apiPath === '/skills-management/api/mcp') {
            if (req.method === 'GET') {
              sendJson(res, 200, mcpSnapshot())
              return
            }
            if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }

            // PUT { serverName, enabled } → 开关（配置来源的只改遮蔽层，用户新增的还会挂载/卸载）
            if (req.method === 'PUT') {
              const body = await readJsonBody(req)
              if (typeof body.serverName !== 'string' || body.serverName === '') {
                sendJson(res, 400, { error: 'body must provide serverName' })
                return
              }
              if (typeof body.enabled !== 'boolean') {
                sendJson(res, 400, { error: 'body must provide enabled boolean' })
                return
              }
              const serverName = body.serverName
              const row = mcpSnapshot().servers.find((server) => server.serverName === serverName)
              if (row === undefined) { sendJson(res, 404, { error: `MCP server '${serverName}' is not known` }); return }
              // a hand-written row's own `enabled` is the truth, and that file is
              // not ours to write — a toggle here would only create a lie in our state
              if (row.source === 'local') {
                sendJson(res, 409, {
                  error: `MCP server '${serverName}' comes from the hand-written config file; set its "enabled" there and restart`,
                })
                return
              }
              const result = await withMcpLock(async () => {
                const state = mcpStore.get()
                const disabled = new Set(disabledServerNames())
                if (body.enabled) disabled.delete(serverName)
                else disabled.add(serverName)
                const servers = (state.servers ?? []).map((server) => (
                  server.serverName === serverName ? { ...server, enabled: body.enabled } : server))
                await mcpStore.replace({ ...state, disabled: [...disabled], servers })
                // 用户新增的 server 还要真的挂上/摘下来
                const userServer = servers.find((server) => server.serverName === serverName)
                if (userServer !== undefined && state.servers?.some((s) => s.serverName === serverName)) {
                  if (body.enabled) await mountMcpServer(userServer)
                  else await unmountMcpServer(serverName)
                }
              })
              void result
              applyMcpRestrictionsToAll()
              sendJson(res, 200, mcpSnapshot())
              return
            }

            // POST { serverName, transport, … } → 动态挂载一个新 server
            if (req.method === 'POST') {
              const body = await readJsonBody(req)
              const input = mcpManager.validateServerInput(body)
              const created = await withMcpLock(async () => {
                const state = mcpStore.get()
                if ((state.servers ?? []).some((server) => server.serverName === input.serverName)) {
                  const error = new Error(`MCP server '${input.serverName}' is already managed`)
                  error.status = 409
                  throw error
                }
                if (ownerOfServer(input.serverName) !== undefined) {
                  const owner = ownerOfServer(input.serverName)
                  const by = owner.plugin !== undefined ? `the plugin '${owner.plugin}'` : 'a composition layer'
                  const error = new Error(`MCP server '${input.serverName}' is already mounted by ${by}`)
                  error.status = 409
                  throw error
                }
                const server = { ...input, enabled: true }
                await mcpStore.replace({ ...state, servers: [...(state.servers ?? []), server] })
                await mountMcpServer(server)
                return server
              })
              applyMcpRestrictionsToAll()
              sendJson(res, 201, { created: created.serverName, ...mcpSnapshot() })
              return
            }

            // DELETE { serverName } → 只允许删本插件新增的
            const body = await readJsonBody(req)
            const serverName = typeof body.serverName === 'string' ? body.serverName
              : (typeof body.id === 'string' ? body.id : '')
            if (serverName === '') { sendJson(res, 400, { error: 'body must provide serverName' }); return }
            await withMcpLock(async () => {
              const state = mcpStore.get()
              const owned = (state.servers ?? []).some((server) => server.serverName === serverName)
              if (!owned) {
                const owner = ownerOfServer(serverName)
                const removable = owner !== undefined && owner.owner === 'self'
                const by = owner === undefined ? undefined
                  : owner.plugin !== undefined ? `the plugin '${owner.plugin}'` : 'a composition layer'
                const error = new Error(
                  removable ? `MCP server '${serverName}' is not tracked by this plugin`
                    : owner !== undefined
                      ? `MCP server '${serverName}' is mounted by ${by} and cannot be removed here`
                      : `MCP server '${serverName}' is not managed by this plugin`)
                error.status = owner !== undefined ? 409 : 404
                throw error
              }
              await unmountMcpServer(serverName)
              await mcpStore.replace({
                ...state,
                servers: (state.servers ?? []).filter((server) => server.serverName !== serverName),
                disabled: disabledServerNames().filter((name) => name !== serverName),
              })
            })
            applyMcpRestrictionsToAll()
            sendJson(res, 200, mcpSnapshot())
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          const message = String(error && error.message || error)
          if (String(req.url || '').includes('/skills-management/api/mcp')) {
            sendJson(res, error && error.status ? error.status : mcpErrorStatus(error), { error: message })
            return
          }
          sendJson(res, 400, { error: message })
        }
      },
    }), 'skills-management: api route')
  },
}
