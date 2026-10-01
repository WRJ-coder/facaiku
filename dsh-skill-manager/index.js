/**
 * Skill Manager — category-aware skill management for DeepSeek Harness.
 *
 * Skills on disk follow one layout:
 *
 *   <root>/<category>/<skill-name>/SKILL.md     (category = the parent folder)
 *   <root>/<skill-name>.md                      (flat file, category = ROOT_CATEGORY)
 *
 * Scanned roots default to exactly the roots `@deepseek-ai/dsh-skill-filesystem`
 * reads, so this plugin never invents a private skill universe:
 *
 *   <project>/.dsh/skills, <project>/.agents/skills, ~/.dsh/skills,
 *   ~/.agents/skills, and the bundled skill directory.
 *
 * The plugin contributes one `ctx.skills` provider at a rank BELOW every
 * shipped filesystem rank. It therefore wins the merge for the skills it knows
 * and can enforce a blocked skill's invocation policy; every other name keeps
 * resolving through the shipped providers unchanged.
 *
 * Blocking is durable and twofold:
 *   1. the two canonical frontmatter fields are written into SKILL.md
 *      (`disable-model-invocation: true`, `user-invocable: false`), so the
 *      skill stays blocked for any reader that has never heard of this plugin;
 *   2. a blocklist file under `$DSH_HOME/skills/.system/skill-manager/` records
 *      the fields this plugin wrote and the values it found, so restoring is
 *      lossless and the management panel survives a restart.
 *
 * A blocked skill is invisible in the model catalog and in the `/` menu
 * (`modelInvocable` and `userInvocable` both false), while the management panel
 * keeps listing it so it can be restored.
 *
 * @module dsh-skill-manager
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

import {
  FIELD_MODEL,
  FIELD_USER,
  blockedByFrontmatter,
  editFrontmatter,
  fieldBoolean,
  fieldRaw,
  fieldValue,
  invocationOf,
  parseFrontmatter,
  stripBom,
} from './lib/frontmatter.js'

/** Loader id, `dsh.plugin.json` id, and this exported `name` are one value. */
export const name = 'skill-manager'

/** Hard dependency on the skill registry; every other service is acquired optionally. */
export const inject = ['skills']

/** Default provider name on `ctx.skills`; internal, never user-visible. */
const DEFAULT_PROVIDER_NAME = 'skill-manager'

/** Rank below PROJECT_DSH_RANK (100), the lowest shipped filesystem rank. */
const DEFAULT_RANK = 10

/** Category label for skills that sit directly inside a scanned root. */
const ROOT_CATEGORY = '(uncategorized)'

/** Blocklist file name inside this plugin's state directory. */
const BLOCKLIST_FILE = 'blocklist.json'
const BLOCKLIST_VERSION = 1

/** Separator between a category and a skill name in one command argument. */
const TARGET_SEPARATOR = '/'

/** Browser-facing route paths for the management API. */
const ROUTE_STATE = '/skill-manager/panel/state'
const ROUTE_SET = '/skill-manager/panel/set'

/** Default skill-name grammar, matching the shipped registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const Config = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  rank: z.number().default(DEFAULT_RANK),
  includeDefaultRoots: z.boolean().default(true),
  dshHome: z.string(),
  agentsHome: z.string(),
  projectSkillDirs: z.array(z.string()).default(['.dsh/skills', '.agents/skills']),
  customSkillDirs: z.array(z.string()).default([]),
  bundledSkillDir: z.string(),
  statePath: z.string(),
  projectMarker: z.string().default('.git'),
})

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Whether a path exists as a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk up from `cwd` for the nearest ancestor holding the project marker.
 * @param {string} cwd - absolute starting directory.
 * @param {string} marker - marker entry name, normally `.git`.
 * @returns {Promise<string>} the project root, or `cwd` when none is found.
 */
async function findProjectRoot(cwd, marker) {
  let current = resolve(cwd)
  while (true) {
    try {
      await stat(join(current, marker))
      return current
    } catch {
      // Not this directory; keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** Read a UTF-8 file, or undefined when it is absent or unreadable. */
async function readText(path) {
  try {
    return await readFile(path, { encoding: 'utf8' })
  } catch {
    return undefined
  }
}

/**
 * Write a file through a temporary sibling so a crash cannot leave a
 * half-written skill or blocklist behind.
 * @param {string} path - destination file.
 * @param {string} content - complete new content.
 */
async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, { encoding: 'utf8' })
  await rename(temporary, path)
}

// ---------------------------------------------------------------------------
// Blocklist store
// ---------------------------------------------------------------------------

/** An empty blocklist value. */
function emptyBlocklist() {
  return { version: BLOCKLIST_VERSION, blocked: {} }
}

/**
 * Read the durable blocklist, degrading an unreadable or malformed file to an
 * empty one instead of failing every panel read.
 * @param {string} path - blocklist file.
 * @param {object} logger - host logger.
 * @returns {Promise<{ version: number, blocked: Record<string, object> }>}
 */
async function readBlocklist(path, logger) {
  const raw = await readText(path)
  if (raw === undefined) return emptyBlocklist()
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object')
    const blocked = parsed.blocked
    if (blocked === null || typeof blocked !== 'object' || Array.isArray(blocked)) throw new TypeError('blocked is not an object')
    for (const [key, value] of Object.entries(blocked)) {
      if (value === null || typeof value !== 'object') throw new TypeError(`entry ${key} is not an object`)
    }
    return { version: BLOCKLIST_VERSION, blocked: { ...blocked } }
  } catch (error) {
    logger?.warn?.(`skill-manager: ignoring malformed blocklist at ${path}: ${String(error)}`)
    return emptyBlocklist()
  }
}

/** Identity of one skill: root kind, category, and name. */
function identity(rootKind, category, skillName) {
  return { rootKind, category, name: skillName }
}

/** Serialize an identity into a blocklist key. */
function identityKey(value) {
  return JSON.stringify([value.rootKind, value.category, value.name])
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Enumerate every skill under one root.
 *
 * The layout is `<root>/<category>/<skill>/SKILL.md`, so a root child is
 * normally a CATEGORY, not a skill: the scan descends exactly one more level.
 * A directory holding its own `SKILL.md` is accepted as the degenerate
 * category-less layout (`<root>/<skill>/SKILL.md`), and a `<root>/<name>.md`
 * file is a flat skill, matching the shipped provider's flat form.
 *
 * @param {{ path: string, rootKind: string }} root - scanned root.
 * @returns {Promise<object[]>} discovered entries, valid or not.
 */
async function scanRoot(root) {
  const entries = []
  for (const child of await listChildren(root.path)) {
    if (child.name.startsWith('.')) continue
    const childPath = join(root.path, child.name)
    if (child.isDirectory()) {
      if (await isDirectory(join(childPath, 'SKILL.md'))) continue
      if (await isFile(join(childPath, 'SKILL.md'))) {
        entries.push(await readEntry(join(childPath, 'SKILL.md'), childPath, root, child.name, false))
        continue
      }
      for (const skill of await listChildren(childPath)) {
        if (skill.name.startsWith('.')) continue
        const skillPath = join(childPath, skill.name)
        if (skill.isDirectory()) {
          if (!(await isFile(join(skillPath, 'SKILL.md')))) continue
          entries.push(await readEntry(join(skillPath, 'SKILL.md'), skillPath, root, child.name, false))
          continue
        }
        // A category-level Markdown file is a skill of that category, matching
        // the shipped provider's flat `<name>.md` form.
        if (skill.isFile() && skill.name.toLowerCase().endsWith('.md')) {
          entries.push(await readEntry(skillPath, childPath, root, child.name, true))
        }
      }
      continue
    }
    if (child.isFile() && child.name.toLowerCase().endsWith('.md')) {
      entries.push(await readEntry(childPath, root.path, root, ROOT_CATEGORY, true))
    }
  }
  return entries
}

/** Read one directory, degrading an unreadable path to no entries. */
async function listChildren(path) {
  try {
    const children = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
    return [...children].sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/** Whether a path exists as a regular file. */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Read one candidate skill file into an entry.
 * @param {string} filePath - the SKILL.md (or flat `<name>.md`) path.
 * @param {string} directory - the skill's resource base directory.
 * @param {{ path: string, rootKind: string }} root - owning scanned root.
 * @param {string} category - category name.
 * @param {boolean} flat - whether this is a flat `<name>.md` skill.
 * @returns {Promise<object>} the entry, with an empty field list when unreadable.
 */
async function readEntry(filePath, directory, root, category, flat) {
  const base = { filePath, directory, rootKind: root.rootKind, rootPath: root.path, category, flat }
  const stored = await readText(filePath)
  // A UTF-8 BOM is legal in a hand-edited Markdown file and must not hide the
  // frontmatter delimiter from the parser.
  const raw = stripBom(stored ?? '')
  if (stored === undefined) return { ...base, raw: '', body: '', fields: [], present: false }
  const parsed = parseFrontmatter(raw)
  return { ...base, raw, body: parsed.body.trim(), fields: parsed.fields, present: parsed.present }
}

/** Why an entry cannot be advertised, or undefined when it can. */
function entryDefect(entry) {
  if (!entry.present) return 'missing YAML frontmatter'
  const skillName = fieldValue(entry.fields, 'name')
  if (skillName === undefined || skillName.length === 0) return 'missing frontmatter name'
  if (!SKILL_NAME.test(skillName)) return `invalid skill name "${skillName}"`
  const description = fieldValue(entry.fields, 'description')
  if (description === undefined || description.length === 0) return 'missing frontmatter description'
  return undefined
}

/** The declared skill name of one entry. */
function entryName(entry) {
  return fieldValue(entry.fields, 'name') ?? basename(entry.directory)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Register the skill provider, the `/skills` command, and the management API.
 * @param {object} ctx - host plugin context.
 * @param {object} config - resolved plugin config.
 * @returns {Promise<void>} resolves once every contribution is registered.
 */
export async function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(config.dshHome)
  const resolved = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    rank: config.rank ?? DEFAULT_RANK,
    includeDefaultRoots: config.includeDefaultRoots ?? true,
    dshHome,
    agentsHome: resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')),
    projectSkillDirs: config.projectSkillDirs ?? ['.dsh/skills', '.agents/skills'],
    customSkillDirs: (config.customSkillDirs ?? []).map((entry) => resolve(entry)),
    bundledSkillDir:
      config.bundledSkillDir ??
      (config.includeDefaultRoots === false ? undefined : process.env.DSH_BUNDLED_SKILL_DIR),
    statePath: config.statePath ?? join(dshHome, 'skills', '.system', 'skill-manager', BLOCKLIST_FILE),
    projectMarker: config.projectMarker ?? '.git',
  }

  const blocklistFile = resolved.statePath
  // Read persistence BEFORE publishing the provider, so the very first catalog
  // read already honors a blocklist written by an earlier process.
  let blocklist = await readBlocklist(blocklistFile, ctx.logger)
  /** Registration control of this provider; the only correct invalidation route. */
  let control

  ctx.skills.registerProvider((registration) => {
    control = registration
    return {
      name: resolved.providerName,
      list: (options) => listCandidates(resolved, blocklist, options),
      get: (candidate) => loadDefinition(candidate, blocklist),
    }
  })

  ctx.effect(() => () => {
    control = undefined
  }, 'skill-manager: provider reference')

  /** Persist the blocklist and refresh the catalog. */
  async function commit(next) {
    blocklist = next
    await writeAtomic(blocklistFile, `${JSON.stringify(next, null, 2)}\n`)
    control?.invalidate()
  }

  /**
   * Collect every discovered entry for one workspace, keeping the winner when
   * two roots advertise the same identity.
   * @param {string | undefined} cwd - workspace directory.
   * @returns {Promise<{ roots: object[], all: object[], found: Map<string, object> }>}
   *   the scanned roots, every discovered entry, and the valid entries by identity.
   */
  async function collect(cwd) {
    const roots = await skillRoots(resolved, cwd)
    const found = new Map()
    const all = []
    for (const root of roots) {
      for (const entry of await scanRoot(root)) {
        all.push(entry)
        if (entryDefect(entry) !== undefined) continue
        const key = identityKey(identity(entry.rootKind, entry.category, entryName(entry)))
        if (!found.has(key)) found.set(key, entry)
      }
    }
    return { roots, all, found }
  }

  /**
   * Enable or block one skill, updating frontmatter and the blocklist.
   * @param {object} entry - discovered entry to change.
   * @param {boolean} enabled - true to enable, false to block.
   * @returns {Promise<{ ok: boolean, detail: string }>} the operation outcome.
   */
  async function setSkillEnabled(entry, enabled) {
    const key = identityKey(identity(entry.rootKind, entry.category, entryName(entry)))
    const record = blocklist.blocked[key]
    if (!enabled && record !== undefined) return { ok: true, detail: 'already blocked' }
    if (enabled && record === undefined) return { ok: true, detail: 'already enabled' }
    const stored = await readText(entry.filePath)
    if (stored === undefined) return { ok: false, detail: 'SKILL.md is not readable' }
    // Parse the same text discovery parsed: a leading BOM must not hide the
    // frontmatter block, or the plan would be built for a file shape that the
    // rewrite does not preserve.
    const current = stripBom(stored)
    const parsed = parseFrontmatter(current)
    const plan = {}
    if (!enabled) {
      if (fieldBoolean(parsed.fields, FIELD_MODEL) !== true) plan[FIELD_MODEL] = `${FIELD_MODEL}: true`
      if (fieldBoolean(parsed.fields, FIELD_USER) !== false) plan[FIELD_USER] = `${FIELD_USER}: false`
      const nextRaw = Object.keys(plan).length === 0 ? current : editFrontmatter(current, plan)
      if (nextRaw !== current) await writeAtomic(entry.filePath, nextRaw)
      await commit({
        version: BLOCKLIST_VERSION,
        blocked: {
          ...blocklist.blocked,
          [key]: {
            category: entry.category,
            name: entryName(entry),
            filePath: entry.filePath,
            rootKind: entry.rootKind,
            blockedAt: Date.now(),
            wroteModelInvocation: Object.hasOwn(plan, FIELD_MODEL),
            wroteUserInvocable: Object.hasOwn(plan, FIELD_USER),
            previous: {
              modelInvocation: fieldRaw(parsed.fields, FIELD_MODEL),
              userInvocable: fieldRaw(parsed.fields, FIELD_USER),
            },
          },
        },
      })
      return { ok: true, detail: 'blocked' }
    }
    if (record.wroteModelInvocation === true) {
      plan[FIELD_MODEL] = record.previous?.modelInvocation == null ? null : `${FIELD_MODEL}: ${record.previous.modelInvocation}`
    }
    if (record.wroteUserInvocable === true) {
      plan[FIELD_USER] = record.previous?.userInvocable == null ? null : `${FIELD_USER}: ${record.previous.userInvocable}`
    }
    const nextRaw = Object.keys(plan).length === 0 ? current : editFrontmatter(current, plan)
    if (nextRaw !== current) await writeAtomic(entry.filePath, nextRaw)
    const nextBlocked = { ...blocklist.blocked }
    delete nextBlocked[key]
    await commit({ version: BLOCKLIST_VERSION, blocked: nextBlocked })
    return { ok: true, detail: 'enabled' }
  }

  /**
   * Build the management view of every discovered skill for one workspace.
   * @param {string | undefined} cwd - workspace directory.
   * @returns {Promise<{ categories: object[], roots: object[], blockedCount: number }>}
   */
  async function snapshotSkills(cwd) {
    const { roots, all } = await collect(cwd)
    const categories = new Map()
    let blockedCount = 0
    for (const entry of all) {
      const defect = entryDefect(entry)
      const skillName = entryName(entry)
      const key = identityKey(identity(entry.rootKind, entry.category, skillName))
      const blocked = blockedByFrontmatter(entry.fields) || blocklist.blocked[key] !== undefined
      if (blocked) blockedCount += 1
      const categoryKey = JSON.stringify([entry.rootKind, entry.category])
      let category = categories.get(categoryKey)
      if (category === undefined) {
        category = { key: categoryKey, name: entry.category, rootKind: entry.rootKind, rootPath: entry.rootPath, skills: [] }
        categories.set(categoryKey, category)
      }
      category.skills.push({
        key,
        name: skillName,
        description: fieldValue(entry.fields, 'description') ?? '',
        whenToUse: fieldValue(entry.fields, 'whenToUse'),
        path: entry.filePath,
        directory: entry.directory,
        flat: entry.flat,
        blocked,
        usable: defect === undefined,
        defect,
      })
    }
    const ordered = [...categories.values()].sort((left, right) => {
      if (left.rootKind !== right.rootKind) return left.rootKind === 'project' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    for (const category of ordered) {
      category.skills.sort((left, right) => left.name.localeCompare(right.name))
      category.blockedCount = category.skills.filter((skill) => skill.blocked).length
    }
    return {
      categories: ordered,
      roots: roots.map((root) => ({ kind: root.rootKind, path: root.path })),
      blockedCount,
    }
  }

  // -------------------------------------------------------------------------
  // Management API for the browser panel
  // -------------------------------------------------------------------------

  /**
   * Handle one management request.
   *
   * These two routes sit outside the `/api` prefix, so the connection layer's
   * fence does not cover them; this handler therefore applies the same
   * same-origin rule the Plugin Manager does for its own bare-webServer routes:
   * the `Host` authority must be loopback, `sec-fetch-site` must not say
   * cross-site, and a present `Origin` must match `Host`.
   *
   * @param {object} request - node IncomingMessage.
   * @param {object} response - node ServerResponse.
   */
  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }
    try {
      if (!trustedRequest(request)) {
        send(403, { ok: false, error: 'untrusted origin' })
        return
      }
      if (request.method === 'GET' && url.pathname === ROUTE_STATE) {
        const cwd = url.searchParams.get('cwd')
        send(200, { ok: true, ...(await snapshotSkills(cwd ?? undefined)) })
        return
      }
      if (request.method === 'POST' && url.pathname === ROUTE_SET) {
        const payload = await readJson(request)
        const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined
        const enabled = payload.enabled === true
        const category = typeof payload.category === 'string' ? payload.category : undefined
        const skill = typeof payload.skill === 'string' ? payload.skill : undefined
        if (category === undefined) {
          send(400, { ok: false, error: 'missing category' })
          return
        }
        const { all } = await collect(cwd)
        const targets = all.filter((entry) => {
          if (entry.category !== category) return false
          if (skill !== undefined && entryName(entry) !== skill) return false
          return entryDefect(entry) === undefined
        })
        if (targets.length === 0) {
          const target = skill === undefined ? category : `${category}${TARGET_SEPARATOR}${skill}`
          send(404, { ok: false, error: `no usable skill matches ${target}` })
          return
        }
        const changes = []
        for (const entry of targets) {
          changes.push({ category: entry.category, name: entryName(entry), ...(await setSkillEnabled(entry, enabled)) })
        }
        const failed = changes.filter((change) => !change.ok)
        send(failed.length === 0 ? 200 : 500, { ok: failed.length === 0, changes, ...(await snapshotSkills(cwd)) })
        return
      }
      send(404, { ok: false, error: `unknown skill-manager endpoint "${url.pathname}"` })
    } catch (error) {
      ctx.logger?.warn?.(`skill-manager: request failed: ${String(error)}`)
      try {
        send(500, { ok: false, error: String(error) })
      } catch {
        response.destroy()
      }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: handleRequest }), 'skill-manager: state route')
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE_SET, handler: handleRequest }), 'skill-manager: set route')
  })

  // -------------------------------------------------------------------------
  // /skills command
  // -------------------------------------------------------------------------

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'skill-manager',
      name: 'skills',
      description: 'List, inspect, enable, block, or run managed skills',
      input: {
        hint: '[group <category>|enable <cat>/<skill>|disable <cat>/<skill>|enable-group <cat>|disable-group <cat>|run <cat>/<skill>|blocked]',
      },
      handler: (invocation) => executeSkillsCommand(invocation),
    })
  })

  /**
   * Run one `/skills` invocation.
   * @param {object} invocation - the command invocation.
   * @returns {Promise<{ kind: string, text: string }>} the command result.
   */
  async function executeSkillsCommand(invocation) {
    const parsed = parseSkillsCommand(invocation.rawInput)
    if (parsed.kind === 'usage') return { kind: 'error', text: `${parsed.message}\n\n${COMMAND_USAGE}` }
    const cwd = invocation.agent?.session?.header?.cwd
    const { all } = await collect(cwd)
    const usable = all.filter((entry) => entryDefect(entry) === undefined)
    const blockedOf = (entry) => blockedByFrontmatter(entry.fields) || blocklist.blocked[identityKey(identity(entry.rootKind, entry.category, entryName(entry)))] !== undefined

    if (parsed.kind === 'list') return { kind: 'success', text: renderCategoryList(await snapshotSkills(cwd)) }
    if (parsed.kind === 'blocked') return { kind: 'success', text: renderBlockedList(await snapshotSkills(cwd)) }
    if (parsed.kind === 'group') {
      const snapshot = await snapshotSkills(cwd)
      const category = snapshot.categories.find((candidate) => candidate.name === parsed.category)
      if (category === undefined) return { kind: 'error', text: `No category named "${parsed.category}".\n\n${renderCategoryList(snapshot)}` }
      return { kind: 'success', text: renderCategoryDetail(category) }
    }
    if (parsed.kind === 'run') {
      const matched = all.find((entry) => entry.category === parsed.category && entryName(entry) === parsed.skill)
      if (matched === undefined) {
        return { kind: 'error', text: `No skill "${parsed.category}${TARGET_SEPARATOR}${parsed.skill}" is registered.` }
      }
      const defect = entryDefect(matched)
      if (defect !== undefined) return { kind: 'error', text: `"${parsed.skill}" cannot be used: ${defect}.` }
      if (blockedOf(matched)) {
        return { kind: 'error', text: `"${parsed.skill}" is blocked. Run /skills enable ${parsed.category}${TARGET_SEPARATOR}${parsed.skill} first.` }
      }
      const raw = await readText(matched.filePath)
      if (raw === undefined) return { kind: 'error', text: `"${matched.filePath}" is not readable.` }
      const content = parseFrontmatter(raw).body.trim()
      const rendered = [
        `<skill_content name="${parsed.skill}">`,
        '<skill_resources>',
        `Base directory for this skill: ${matched.directory}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
        '</skill_resources>',
        '',
        '<skill_instructions>',
        content,
        '</skill_instructions>',
        '</skill_content>',
      ].join('\n')
      invocation.agent.followup({
        role: 'user',
        source: { kind: 'skill-invocation', name: parsed.skill, form: 'instructions' },
        content: [{ type: 'text', text: rendered }],
      })
      return { kind: 'success', text: `Skill "${parsed.category}${TARGET_SEPARATOR}${parsed.skill}" loaded into this session.` }
    }

    const enable = parsed.kind === 'enable' || parsed.kind === 'enable-group'
    const single = parsed.kind === 'enable' || parsed.kind === 'disable'
    const targets = single
      ? usable.filter((entry) => entry.category === parsed.category && entryName(entry) === parsed.skill)
      : usable.filter((entry) => entry.category === parsed.category)
    if (targets.length === 0) {
      const target = single ? `"${parsed.category}${TARGET_SEPARATOR}${parsed.skill}"` : `category "${parsed.category}"`
      return { kind: 'error', text: `No usable skill matches ${target}.\n\n${renderCategoryList(await snapshotSkills(cwd))}` }
    }
    const changes = []
    for (const entry of targets) changes.push(`${entryName(entry)}: ${(await setSkillEnabled(entry, enable)).detail}`)
    const verb = enable ? 'Enabled' : 'Blocked'
    return {
      kind: 'success',
      text: [
        `${verb} ${changes.length} skill(s) in ${parsed.category}.`,
        ...changes.map((line) => `  ${line}`),
        '',
        renderCategoryList(await snapshotSkills(cwd)),
      ].join('\n'),
    }
  }
}

const COMMAND_USAGE = [
  'Usage:',
  '  /skills                       list every category and its status',
  '  /skills group <category>      show one category in detail',
  '  /skills enable <cat>/<skill>  enable one skill',
  '  /skills disable <cat>/<skill> block one skill',
  '  /skills enable-group <cat>    enable a whole category',
  '  /skills disable-group <cat>   block a whole category',
  '  /skills run <cat>/<skill>     load one skill into this session',
  '  /skills blocked               list every blocked skill',
].join('\n')

/**
 * Parse the `/skills` argument grammar.
 * @param {string} rawInput - text after the command name.
 * @returns {{ kind: string, category?: string, skill?: string, message?: string }}
 */
function parseSkillsCommand(rawInput) {
  const input = (rawInput ?? '').trim()
  if (input.length === 0 || /^(list|ls)$/i.test(input)) return { kind: 'list' }
  if (/^blocked$/i.test(input)) return { kind: 'blocked' }
  const parts = input.split(/\s+/)
  const verb = parts[0].toLowerCase()
  const argument = parts.slice(1).join(' ').trim()
  if (verb === 'group') {
    if (argument.length === 0) return { kind: 'usage', message: '/skills group requires a category name.' }
    return { kind: 'group', category: argument }
  }
  if (verb === 'enable-group' || verb === 'disable-group') {
    if (argument.length === 0) return { kind: 'usage', message: `/skills ${verb} requires a category name.` }
    return { kind: verb, category: argument }
  }
  if (verb === 'enable' || verb === 'disable' || verb === 'run') {
    const target = splitTarget(argument)
    if (target === undefined) return { kind: 'usage', message: `/skills ${verb} requires <category>${TARGET_SEPARATOR}<skill>.` }
    return { kind: verb === 'enable' ? 'enable' : 'disable', category: target.category, skill: target.skill }
  }
  return { kind: 'usage', message: `Unknown /skills subcommand "${parts[0]}".` }
}

/** Split `category/skill` on the last separator, or undefined when malformed. */
function splitTarget(argument) {
  const at = argument.lastIndexOf(TARGET_SEPARATOR)
  if (at <= 0 || at === argument.length - 1) return undefined
  const category = argument.slice(0, at).trim()
  const skill = argument.slice(at + 1).trim()
  if (category.length === 0 || skill.length === 0) return undefined
  return { category, skill }
}

/** Render the category list. */
function renderCategoryList(snapshot) {
  if (snapshot.categories.length === 0) {
    return ['No skills found. Scanned roots:', ...snapshot.roots.map((root) => `  ${root.kind}: ${root.path}`)].join('\n')
  }
  const total = snapshot.categories.reduce((sum, category) => sum + category.skills.length, 0)
  const lines = [`Skills: ${snapshot.categories.length} categories, ${total} skills, ${snapshot.blockedCount} blocked`]
  for (const category of snapshot.categories) {
    lines.push(`  [${category.rootKind}] ${category.name} — ${category.skills.length} skills, ${category.blockedCount} blocked`)
  }
  lines.push('', 'Use /skills group <category> for detail.')
  return lines.join('\n')
}

/** Render one category in detail. */
function renderCategoryDetail(category) {
  const lines = [`Category ${category.name} (${category.rootKind})`, `Path: ${category.rootPath}`, '']
  for (const skill of category.skills) {
    lines.push(`  ${skill.name} [${skill.blocked ? 'blocked' : 'enabled'}]${skill.usable ? '' : ` — unusable: ${skill.defect}`}`)
    if (skill.usable && skill.description.length > 0) lines.push(`    ${skill.description}`)
  }
  return lines.join('\n')
}

/** Render every blocked skill. */
function renderBlockedList(snapshot) {
  const blocked = []
  for (const category of snapshot.categories) {
    for (const skill of category.skills) if (skill.blocked) blocked.push({ category, skill })
  }
  if (blocked.length === 0) return 'No skills are blocked.'
  return [
    `${blocked.length} blocked skill(s):`,
    ...blocked.map((item) => `  ${item.category.name}${TARGET_SEPARATOR}${item.skill.name} — ${item.skill.path}`),
  ].join('\n')
}

/**
 * Whether a request authority names loopback. `Host` is the one header a
 * DNS-rebinding page cannot forge, so it is what the check rests on.
 * @param {string | undefined} host - raw `Host` header.
 * @returns {boolean} true for 127.0.0.1, localhost, and [::1].
 */
function loopbackAuthority(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Same-origin rule for the plugin's own bare-webServer routes, matching the
 * Plugin Manager's rule: loopback authority, no cross-site hint, and a present
 * `Origin` equal to `Host`.
 * @param {object} request - node IncomingMessage.
 * @returns {boolean} whether the request may read or mutate skill state.
 */
function trustedRequest(request) {
  const host = request.headers.host
  if (typeof host !== 'string' || !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body with a small size cap. */
async function readJson(request, maxBytes = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Resolve every scanned root for one workspace.
 * @param {object} resolved - resolved plugin config.
 * @param {string | undefined} cwd - workspace directory.
 * @returns {Promise<Array<{ path: string, rootKind: string }>>} roots in scan order.
 */
async function skillRoots(resolved, cwd) {
  const roots = []
  if (resolved.includeDefaultRoots && typeof cwd === 'string' && cwd.length > 0) {
    const projectRoot = await findProjectRoot(cwd, resolved.projectMarker)
    for (const relative of resolved.projectSkillDirs) {
      roots.push({ path: isAbsolute(relative) ? relative : join(projectRoot, relative), rootKind: 'project' })
    }
  }
  for (const path of resolved.customSkillDirs) roots.push({ path, rootKind: 'custom' })
  if (resolved.includeDefaultRoots) {
    roots.push({ path: join(resolved.dshHome, 'skills'), rootKind: 'user' })
    roots.push({ path: join(resolved.agentsHome, 'skills'), rootKind: 'user' })
  }
  if (typeof resolved.bundledSkillDir === 'string' && resolved.bundledSkillDir.length > 0) {
    roots.push({ path: resolve(resolved.bundledSkillDir), rootKind: 'bundled' })
  }
  return roots
}

/** Skill-source label matching the shipped filesystem provider's vocabulary. */
function sourceOf(rootKind) {
  if (rootKind === 'project') return 'project-dsh'
  if (rootKind === 'user') return 'user-dsh'
  if (rootKind === 'bundled') return 'bundled'
  return 'custom'
}

/**
 * Provider `list()`: advertise every valid skill, with blocked skills marked
 * non-invocable under both policies so no consumer can show or load them.
 * @param {object} resolved - resolved plugin config.
 * @param {object} blocklist - current blocklist.
 * @param {{ cwd?: string }} options - lookup options.
 * @param {{ cwd?: string }} options - lookup options.
 * @returns {Promise<object[]>} provider candidates.
 */
async function listCandidates(resolved, blocklist, options) {
  const roots = await skillRoots(resolved, options?.cwd)
  const candidates = []
  const seen = new Set()
  for (const root of roots) {
    for (const entry of await scanRoot(root)) {
      if (entryDefect(entry) !== undefined) continue
      const skillName = entryName(entry)
      const key = identityKey(identity(entry.rootKind, entry.category, skillName))
      if (seen.has(key)) continue
      seen.add(key)
      const declared = invocationOf(entry.fields)
      const blocked = blockedByFrontmatter(entry.fields) || blocklist.blocked[key] !== undefined
      candidates.push({
        name: skillName,
        description: fieldValue(entry.fields, 'description'),
        ...(fieldValue(entry.fields, 'whenToUse') === undefined ? {} : { whenToUse: fieldValue(entry.fields, 'whenToUse') }),
        invocation: blocked ? { modelInvocable: false, userInvocable: false } : declared,
        source: sourceOf(entry.rootKind),
        provider: resolved.providerName,
        rank: resolved.rank,
        path: entry.filePath,
        locator: { filePath: entry.filePath, directory: entry.directory },
        resourceBase: { kind: 'directory', path: entry.directory },
        metadata: {
          'dsh-skill-manager': {
            category: entry.category,
            rootKind: entry.rootKind,
            rootPath: entry.rootPath,
            blocked,
            flat: entry.flat,
          },
        },
      })
    }
  }
  return candidates
}

/**
 * Provider `get()`: load one skill body from disk, re-reading the current file
 * so a body edit never needs a cache bump.
 * @param {object} candidate - the candidate this provider returned.
 * @param {object} blocklist - current blocklist.
 * @returns {Promise<object | undefined>} the skill definition, or undefined.
 */
async function loadDefinition(candidate, blocklist) {
  const locator = candidate.locator
  const raw = await readText(locator.filePath)
  if (raw === undefined) return undefined
  const parsed = parseFrontmatter(raw)
  const declared = invocationOf(parsed.fields)
  const meta = candidate.metadata?.['dsh-skill-manager'] ?? {}
  const key = identityKey(identity(meta.rootKind ?? 'user', meta.category ?? ROOT_CATEGORY, candidate.name))
  const blocked = blockedByFrontmatter(parsed.fields) || blocklist.blocked[key] !== undefined
  return {
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: blocked ? { modelInvocable: false, userInvocable: false } : declared,
    source: candidate.source,
    provider: candidate.provider,
    resourceBase: candidate.resourceBase,
    path: locator.filePath,
    metadata: candidate.metadata,
    content: parsed.body.trim(),
  }
}
