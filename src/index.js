'use strict'

/**
 * dsh-plugin-skills-management — Host half (local-only fork)
 *
 * FROKED / HARDENED: the upstream package shipped two remote-touching features
 * that this fork removes outright (see README "改造说明"):
 * - the ntd "market" (git clone/fetch of an external skill repo, access token
 *   handling, daily auto-sync) — gone;
 * - "share to the official repo" and its `share/run` endpoint, which spawned a
 *   `dsh` process with a prompt telling the model to read the stored token and
 *   push to GitCode — gone.
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
const YAML = require('yaml')
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

function parseSkillMd(content) {
  const yamlText = extractFrontmatter(content)
  if (yamlText === undefined) return { meta: {}, body: content }
  let meta = {}
  try {
    const parsed = YAML.parse(yamlText)
    if (parsed !== null && typeof parsed === 'object') meta = parsed
  } catch {}
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

// ── 注入开销估算（≈token / 字符）─────────────────────────────────────────
// 技能注入模型 = 名称+描述，两个指标都按该文本统计（字符数即其长度，token 数
// 用 js-tiktoken 的 cl100k_base 词表估算——与 tiktokenizer 同词表同值）。列表
// 接口的 description 是截断展示，统计必须喂截断前的全文。DeepSeek 自有分词与
// tiktoken 有差异，数值用于横向比较而非精确计费；词表加载失败时降级为只出字符数。
let usageEncoder = null
let usageEncoderFailed = false
let usageEncoderOverride  // 测试注入点：undefined 走正常加载，null 强制降级
function usageEncoderLazy() {
  if (usageEncoderOverride !== undefined) return usageEncoderOverride
  if (usageEncoderFailed) return null
  if (usageEncoder === null) {
    try {
      const { Tiktoken } = require('js-tiktoken/lite')
      usageEncoder = new Tiktoken(require('js-tiktoken/ranks/cl100k_base'))
    } catch { usageEncoderFailed = true }
  }
  return usageEncoder
}
const USAGE_MEMO_CAP = 25000
const usageMemo = new Map()
function usageStat(name, description) {
  const desc = typeof description === 'string' ? description : ''
  const text = `${name || ''}\n${desc}`
  const stat = { chars: text.length }
  const enc = usageEncoderLazy()
  if (enc !== null) {
    let tokens = usageMemo.get(text)
    if (tokens === undefined) {
      tokens = enc.encode(text).length
      if (usageMemo.size >= USAGE_MEMO_CAP) usageMemo.clear()
      usageMemo.set(text, tokens)
    }
    stat.tokens = tokens
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

module.exports = {
  name: 'skills-management',
  inject: ['skills', 'webServer', 'settings'],
  __internals: { extractFrontmatter, parseSkillMd, invocationPolicy, installDirName, EXECUTOR_DEFS, usageStat, usageMemo, setUsageEncoderOverride: (v) => { usageEncoderOverride = v } },

  apply(ctx, config = {}) {
    const installedDir = resolve(expandTilde(config.installedDir !== undefined ? config.installedDir : process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skills') : join(homedir(), '.dsh', 'skills')))
    const providerName = config.providerName !== undefined ? config.providerName : 'ntd-skills'

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
          // `from` is the source executor key — mandatory now that the market
          // universe is gone (there is nothing else to install from).
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

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
      },
    }), 'skills-management: api route')
  },
}
