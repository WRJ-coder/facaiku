/**
 * Skill Manager — category-aware skill management for DeepSeek Harness.
 *
 * Skills on disk are discovered recursively under every scanned root:
 *
 *   <root>/<skill-name>/SKILL.md                category = '' (ROOT_CATEGORY)
 *   <root>/<a>/<skill-name>/SKILL.md            category = 'a'
 *   <root>/<a>/<b>/<skill-name>/SKILL.md        category = 'a/b'
 *   <root>/<name>.md                            flat file, category = ''
 *   <root>/<a>/<name>.md                        flat file, category = 'a'
 *
 * A directory is a SKILL when it directly holds a `SKILL.md`; every other
 * directory is a category container and the walk descends into it. The
 * category path of a skill directory is its path relative to the scanned root
 * with the skill's own segment removed, and its segments are always joined
 * with `/` — on every platform, never with `path.sep`.
 *
 * Two limits keep an arbitrarily deep tree bounded:
 *
 *   maxDepth           (4) deepest directory level whose CONTENTS are scanned,
 *                      counted from the scanned root: level 1 is a direct
 *                      child of the root, level 4 the deepest directory the
 *                      walk descends into. A `SKILL.md` seen while scanning a
 *                      directory is registered even though the skill's own
 *                      directory sits one level deeper, so
 *                      `<root>/a/b/c/d/<skill>` is found at the default limit
 *                      while `<root>/a/b/c/d/e/<skill>` is not. A category
 *                      container deeper than the limit is reported through
 *                      `depthPruned` so the panel can warn about it.
 *   maxCategoryDepth   (3) deepest category path reported as its own tree
 *                      node. A skill deeper than that is still discovered and
 *                      still manageable: it is grouped under its nearest
 *                      ancestor at exactly maxCategoryDepth, keeps its
 *                      untruncated path in `fullCategoryPath`, and is flagged
 *                      `truncated`. The two limits are deliberately different
 *                      sizes — discovery reaches one level below the deepest
 *                      scanned category, which is exactly the level reporting
 *                      truncates — so truncation is reachable with the
 *                      default config.
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
 * A blocklist key is `[root kind, FULL category path, skill name]` — never the
 * truncated category — so two same-named skills in different deep categories
 * stay distinct and an entry survives a change of `maxCategoryDepth`. A file
 * written by an earlier version, which keyed the truncated category, therefore
 * no longer matches any skill; that is acceptable, because the frontmatter
 * fields the same operation wrote stay authoritative for every reader.
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

/** Deepest directory level scanned under one root; level 1 is a direct child. */
const DEFAULT_MAX_DEPTH = 4

/** Deepest category path reported as its own tree node; deeper skills truncate. */
const DEFAULT_MAX_CATEGORY_DEPTH = 3

/** Separator inside a category path; `/` on every platform, never `path.sep`. */
const CATEGORY_SEPARATOR = '/'

/** Blocklist file name inside this plugin's state directory. */
const BLOCKLIST_FILE = 'blocklist.json'
const BLOCKLIST_VERSION = 1

/** Separator between a category and a skill name in one command argument. */
const TARGET_SEPARATOR = '/'

/** Browser-facing route paths for the management API. */
const ROUTE_STATE = '/skill-manager/panel/state'
const ROUTE_SET = '/skill-manager/panel/set'

/** Level count of `/skills tree` when the argument omits one, and its ceiling. */
const DEFAULT_TREE_DEPTH = 2
const MAX_TREE_DEPTH = 6

/** Trailing flags the `/skills` grammar accepts. */
const TRAILING_FLAGS = ['--recursive', '-r']

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
  maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
  maxCategoryDepth: z.number().default(DEFAULT_MAX_CATEGORY_DEPTH),
})

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

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
 * Drop every record that points at one file but is not the record just written.
 *
 * A blocklist can hold a stale entry for the same file under an older key shape
 * (the pre-nested-category key, or an earlier `maxCategoryDepth`). Leaving it
 * behind would keep the file listed as blocked after it was enabled, so the
 * caller replaces all of them with its own key.
 * @param {Record<string, object>} blocked - the current blocklist map.
 * @param {string} filePath - the skill file the caller is rewriting.
 * @returns {Record<string, object>} the map without those records.
 */
function withoutLegacyRecord(blocked, filePath) {
  const next = {}
  for (const [key, value] of Object.entries(blocked)) {
    if (value?.filePath === filePath) continue
    next[key] = value
  }
  return next
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

/**
 * Identity of one skill: root kind, the skill's own LOCATOR path, and name.
 *
 * The locator is the skill's full path below its scanned root — the category
 * segments plus the skill's own last segment — so it distinguishes:
 *
 *   - two same-named skills in different deep categories, which is what lets an
 *     identity survive a change of `maxCategoryDepth`;
 *   - a root-level flat file `<root>/twin.md` from a root-level directory skill
 *     `<root>/分类A/SKILL.md`, both of which have an EMPTY category path but
 *     different locators. Keying on the category path alone would collapse
 *     them into one identity, and the catalog would then silently drop one.
 *
 * @param {string} rootKind - `project`, `user`, `custom`, or `bundled`.
 * @param {string} locator - the skill's path below the root, `/`-joined.
 * @param {string} skillName - the declared skill name.
 * @returns {{ rootKind: string, locator: string, name: string }}
 */
function identity(rootKind, locator, skillName) {
  return { rootKind, locator, name: skillName }
}

/**
 * Serialize an identity into a blocklist key.
 *
 * The key embeds the FULL locator path. A blocklist file written by an earlier
 * version keyed `[rootKind, truncatedCategory, name]`, so its entries no longer
 * match any skill; that is why `setSkillEnabled` clears the frontmatter fields
 * for a skill whose frontmatter says blocked even when no record matches, so
 * such a skill can still be enabled from the panel.
 * @param {{ rootKind: string, locator: string, name: string }} value
 *   - the identity to serialize.
 * @returns {string} the blocklist key.
 */
function identityKey(value) {
  return JSON.stringify([value.rootKind, value.locator, value.name])
}

/** The locator of one entry: its path below its scanned root. */
function entryLocator(entry) {
  return joinCategory(entry.locatorSegments)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Coerce one configured depth limit to a usable integer.
 * @param {unknown} value - the configured value.
 * @param {number} fallback - default used when the value is not a finite number.
 * @param {number} minimum - smallest value the limit accepts.
 * @returns {number} the resolved limit.
 */
function depthLimit(value, fallback, minimum) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return number < minimum ? minimum : number
}

/**
 * Join category path segments with the platform-independent separator.
 * @param {string[]} segments - category directory names, outermost first.
 * @returns {string} the category path; `''` at the root level.
 */
function joinCategory(segments) {
  return segments.join(CATEGORY_SEPARATOR)
}

/**
 * Split a category path back into its segments.
 * @param {string} categoryPath - category path, `''` at the root level.
 * @returns {string[]} the segments; empty at the root level.
 */
function splitCategory(categoryPath) {
  return categoryPath.length === 0 ? [] : categoryPath.split(CATEGORY_SEPARATOR)
}

/** The label a category path is displayed under; the root level has a name. */
function categoryLabel(categoryPath) {
  return categoryPath.length === 0 ? ROOT_CATEGORY : categoryPath
}

/**
 * Truncate a category path to the deepest path a tree node may report.
 * @param {string} fullCategoryPath - the untruncated category path.
 * @param {number} maxCategoryDepth - deepest reported category depth.
 * @returns {{ categoryPath: string, truncated: boolean }} the grouping path and
 *   whether anything was cut off it.
 */
function truncateCategory(fullCategoryPath, maxCategoryDepth) {
  const segments = splitCategory(fullCategoryPath)
  if (segments.length <= maxCategoryDepth) return { categoryPath: fullCategoryPath, truncated: false }
  return { categoryPath: joinCategory(segments.slice(0, maxCategoryDepth)), truncated: true }
}

/**
 * The untruncated category path a provider metadata block describes.
 * @param {object} meta - one `dsh-skill-manager` metadata block.
 * @returns {string} the full category path, `''` at the root level.
 */
function categoryPathOf(meta) {
  if (typeof meta.fullCategoryPath === 'string') return meta.fullCategoryPath
  if (typeof meta.categoryPath === 'string') return meta.categoryPath
  // An older candidate carries only the display label, where the root level was
  // spelled `(uncategorized)` instead of the empty path.
  if (typeof meta.category === 'string') return meta.category === ROOT_CATEGORY ? '' : meta.category
  return ''
}

/**
 * Recursively enumerate every skill under one root.
 *
 * A directory holding a `SKILL.md` entry is a skill — even when that file
 * cannot be read, in which case the entry simply reports a defect — and every
 * other directory is a category container the walk descends into. A
 * `<name>.md` file directly inside a scanned root or a category directory is a
 * flat skill whose category is that containing directory's path.
 *
 * `maxDepth` bounds the deepest directory whose contents are listed. A skill
 * directory is registered as soon as its PARENT is scanned, so it may itself
 * sit one level below the limit; a container at the limit is descended into,
 * and only a container deeper than the limit is pruned and reported through
 * `depthPruned` — when it holds at least one visible entry, so the warning
 * names folders that actually contain something. Because each level is visited
 * once, a directory loop cannot make the walk unbounded.
 *
 * @param {{ path: string, rootKind: string }} root - scanned root.
 * @param {{ maxDepth: number, maxCategoryDepth: number }} limits - scan limits.
 * @returns {Promise<{ entries: object[], depthPruned: string[] }>} discovered
 *   entries, valid or not, and the category paths the depth limit pruned.
 */
async function scanRoot(root, limits) {
  const entries = []
  const depthPruned = []

  /**
   * Visit one directory.
   * @param {string} directory - absolute directory being read.
   * @param {string[]} segments - category path of `directory` under the root.
   * @param {number} level - level of `directory`, 0 at the root itself.
   */
  async function walk(directory, segments, level) {
    for (const child of await listChildren(directory)) {
      if (child.name.startsWith('.')) continue
      const childPath = join(directory, child.name)
      if (child.isDirectory()) {
        if (await isFile(join(childPath, 'SKILL.md'))) {
          entries.push(await readEntry(join(childPath, 'SKILL.md'), childPath, root, [...segments, child.name], false, level + 1, limits))
          continue
        }
        // A category container. At the limit its contents are still listed (a
        // skill directly inside it is found); past the limit it is not scanned.
        if (level + 1 > limits.maxDepth) {
          if ((await listChildren(childPath)).length > 0) depthPruned.push(joinCategory([...segments, child.name]))
          continue
        }
        await walk(childPath, [...segments, child.name], level + 1)
        continue
      }
      // A flat `<name>.md` file is a skill of the directory that holds it.
      // `README.md` is documentation, not a skill definition, so it is skipped
      // exactly as the shipped provider treats it — otherwise a category
      // README would surface as an unusable "skill" in the panel.
      if (child.isFile() && child.name.toLowerCase().endsWith('.md') && child.name.toLowerCase() !== 'readme.md') {
        entries.push(await readEntry(childPath, directory, root, [...segments, child.name], true, level + 1, limits))
      }
    }
  }

  await walk(root.path, [], 0)
  return { entries, depthPruned }
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
 * @param {string[]} locatorSegments - the skill's own path segments below the
 *   root, its last segment included; the category path is this minus the last.
 * @param {boolean} flat - whether this is a flat `<name>.md` skill.
 * @param {number} depth - the skill's own level below the scanned root.
 * @param {{ maxCategoryDepth: number }} limits - category-path reporting limit.
 * @returns {Promise<object>} the entry, with an empty field list when unreadable.
 */
async function readEntry(filePath, directory, root, locatorSegments, flat, depth, limits) {
  const fullCategoryPath = joinCategory(locatorSegments.slice(0, -1))
  const { categoryPath, truncated } = truncateCategory(fullCategoryPath, limits.maxCategoryDepth)
  const base = {
    filePath,
    directory,
    rootKind: root.rootKind,
    rootPath: root.path,
    categoryPath,
    fullCategoryPath,
    locatorSegments,
    truncated,
    depth,
    flat,
  }
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
// Snapshot model
// ---------------------------------------------------------------------------

/**
 * Resolve a category path to the tree nodes and roots that carry it.
 *
 * A path is not unique across scanned roots, so every match is returned; an
 * empty path matches each non-empty root node.
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @param {string} categoryPath - category path, `''` at the root level.
 * @returns {Array<{ node: object, root: object }>} every match, in tree order.
 */
function findCategoryNodes(snapshot, categoryPath) {
  const matches = []
  const visit = (node, root) => {
    if (node.path === categoryPath) matches.push({ node, root })
    for (const child of node.children) visit(child, root)
  }
  for (const root of snapshot.tree) visit(root, root)
  return matches
}

/** The physical directory one category path names under one scanned root. */
function categoryDirectory(root, categoryPath) {
  return join(root.name, ...splitCategory(categoryPath))
}

/**
 * Select the skill entries of one category path.
 *
 * The path is the TRUNCATED category path a skill is grouped under, and an
 * empty path is the root level (the skills directly inside a scanned root). A
 * path that several scanned roots share selects the matching skills of every
 * one of them. `recursive: false` matches the node exactly; `recursive: true`
 * also matches every descendant category, so an empty path selects every skill
 * in the snapshot.
 *
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @param {string} categoryPath - category path, `''` for the root level.
 * @param {{ recursive?: boolean }} [options] - subtree selection.
 * @returns {object[]} the matching snapshot skill entries, in snapshot order.
 */
function selectSkills(snapshot, categoryPath, options = {}) {
  const path = typeof categoryPath === 'string' ? categoryPath : ''
  const recursive = options.recursive === true
  const prefix = path.length === 0 ? '' : `${path}${CATEGORY_SEPARATOR}`
  return snapshot.skills.filter((skill) => {
    if (skill.categoryPath === path) return true
    if (!recursive) return false
    return path.length === 0 || skill.categoryPath.startsWith(prefix)
  })
}

/**
 * Group skill entries into one category tree per scanned root.
 *
 * A root node carries an empty `path` and depth 0; every category node below
 * it carries its category path and one more level of depth. `skills` are the
 * entries DIRECTLY at that node, while `totalSkills` and `blockedSkills` are
 * subtree totals over every discovered skill, usable or not.
 *
 * @param {Array<{ path: string, rootKind: string }>} roots - scanned roots, in order.
 * @param {object[]} skills - every snapshot skill entry, in scan order.
 * @returns {{ tree: object[], flatCategories: object[] }} the root nodes and
 *   every node of the same tree in depth-first order.
 */
function buildTree(roots, skills) {
  const tree = []
  const rootNodes = new Map()
  for (const root of roots) {
    const node = {
      key: JSON.stringify([root.rootKind, root.path, '']),
      name: root.path,
      kind: root.rootKind,
      path: '',
      depth: 0,
      skills: [],
      children: [],
      totalSkills: 0,
      blockedSkills: 0,
    }
    tree.push(node)
    const key = JSON.stringify([root.rootKind, root.path])
    if (!rootNodes.has(key)) rootNodes.set(key, node)
  }
  for (const skill of skills) {
    let node = rootNodes.get(JSON.stringify([skill.rootKind, skill.rootPath]))
    if (node === undefined) continue
    let path = ''
    for (const part of splitCategory(skill.categoryPath)) {
      path = path.length === 0 ? part : `${path}${CATEGORY_SEPARATOR}${part}`
      let child = node.children.find((candidate) => candidate.path === path)
      if (child === undefined) {
        child = {
          key: JSON.stringify([skill.rootKind, skill.rootPath, path]),
          name: part,
          kind: skill.rootKind,
          path,
          depth: node.depth + 1,
          skills: [],
          children: [],
          totalSkills: 0,
          blockedSkills: 0,
        }
        node.children.push(child)
      }
      node = child
    }
    node.skills.push(skill)
  }
  const finalize = (node) => {
    node.skills.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of node.children) finalize(child)
    // A node only ever exists along a skill's own path, so this filter drops
    // nothing today; it keeps the "no empty category" rule true by construction.
    node.children = node.children
      .filter((child) => child.totalSkills > 0)
      .sort((left, right) => left.name.localeCompare(right.name))
    node.totalSkills = node.skills.length + node.children.reduce((sum, child) => sum + child.totalSkills, 0)
    node.blockedSkills =
      node.skills.filter((skill) => skill.blocked).length
      + node.children.reduce((sum, child) => sum + child.blockedSkills, 0)
  }
  const kept = []
  for (const node of tree) {
    finalize(node)
    // A scanned root that holds no skill anywhere stays out of the tree; the
    // snapshot's own `roots` list still reports it.
    if (node.totalSkills > 0) kept.push(node)
  }
  const flatCategories = []
  const flatten = (node) => {
    flatCategories.push({
      key: node.key,
      path: node.path,
      name: node.name,
      kind: node.kind,
      depth: node.depth,
      skills: node.skills,
      totalSkills: node.totalSkills,
      blockedSkills: node.blockedSkills,
    })
    for (const child of node.children) flatten(child)
  }
  for (const node of kept) flatten(node)
  return { tree: kept, flatCategories }
}

/**
 * Build the management view of every discovered skill.
 *
 * The result carries three views of one discovery pass so both the panel and
 * the command layer can use the one that fits: `categories` is the flat list
 * kept for compatibility, `tree` is the per-root category tree, and
 * `flatCategories` is every tree node in depth-first order for cheap
 * resolution by path. Every node whose subtree holds no skill is omitted,
 * including a scanned root with no skills at all.
 *
 * Two depths appear here and mean different things: a NODE `depth` counts
 * category levels with 0 at a scanned root, while a SKILL `depth` is the
 * skill's own level below its root, so a top-level skill has depth 1 and sits
 * on the depth-0 root node.
 *
 * @param {{ roots: object[], all: object[], depthPruned: string[] }} collected
 *   - the output of one discovery pass.
 * @param {{ blocked: Record<string, object> }} blocklist - current blocklist.
 * @returns {object} the snapshot: `categories`, `tree`, `flatCategories`,
 *   `skills`, `depthPruned`, `roots`, and `blockedCount`.
 */
function buildSnapshot(collected, blocklist) {
  const categories = new Map()
  const skills = []
  let blockedCount = 0
  for (const entry of collected.all) {
    const defect = entryDefect(entry)
    const skillName = entryName(entry)
    const key = identityKey(identity(entry.rootKind, entryLocator(entry), skillName))
    const blocked = blockedByFrontmatter(entry.fields) || blocklist.blocked[key] !== undefined
    if (blocked) blockedCount += 1
    const skill = {
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
      categoryPath: entry.categoryPath,
      fullCategoryPath: entry.fullCategoryPath,
      truncated: entry.truncated,
      depth: entry.depth,
      rootKind: entry.rootKind,
      rootPath: entry.rootPath,
    }
    skills.push(skill)
    const categoryKey = JSON.stringify([entry.rootKind, entry.categoryPath])
    let category = categories.get(categoryKey)
    if (category === undefined) {
      category = {
        key: categoryKey,
        name: categoryLabel(entry.categoryPath),
        path: entry.categoryPath,
        rootKind: entry.rootKind,
        rootPath: entry.rootPath,
        skills: [],
      }
      categories.set(categoryKey, category)
    }
    category.skills.push(skill)
  }
  const ordered = [...categories.values()].sort((left, right) => {
    if (left.rootKind !== right.rootKind) return left.rootKind === 'project' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  for (const category of ordered) {
    category.skills.sort((left, right) => left.name.localeCompare(right.name))
    category.blockedCount = category.skills.filter((skill) => skill.blocked).length
  }
  const { tree, flatCategories } = buildTree(collected.roots, skills)
  return {
    categories: ordered,
    tree,
    flatCategories,
    skills,
    depthPruned: collected.depthPruned,
    roots: collected.roots.map((root) => ({ kind: root.rootKind, path: root.path })),
    blockedCount,
  }
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
    maxDepth: depthLimit(config.maxDepth, DEFAULT_MAX_DEPTH, 1),
    maxCategoryDepth: depthLimit(config.maxCategoryDepth, DEFAULT_MAX_CATEGORY_DEPTH, 0),
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
   * @returns {Promise<{ roots: object[], all: object[], found: Map<string, object>, depthPruned: string[] }>}
   *   the scanned roots, every discovered entry, the valid entries by identity,
   *   and the category paths the depth limit kept out of the scan.
   */
  async function collect(cwd) {
    const roots = await skillRoots(resolved, cwd)
    const found = new Map()
    const all = []
    const pruned = new Set()
    for (const root of roots) {
      const scanned = await scanRoot(root, resolved)
      for (const path of scanned.depthPruned) pruned.add(path)
      for (const entry of scanned.entries) {
        all.push(entry)
        if (entryDefect(entry) !== undefined) continue
        const key = identityKey(identity(entry.rootKind, entryLocator(entry), entryName(entry)))
        if (!found.has(key)) found.set(key, entry)
      }
    }
    return { roots, all, found, depthPruned: [...pruned] }
  }

  /**
   * Enable or block one skill, updating frontmatter and the blocklist.
   * @param {object} entry - discovered entry to change.
   * @param {boolean} enabled - true to enable, false to block.
   * @returns {Promise<{ ok: boolean, detail: string }>} the operation outcome.
   */
  async function setSkillEnabled(entry, enabled) {
    const key = identityKey(identity(entry.rootKind, entryLocator(entry), entryName(entry)))
    const stored = await readText(entry.filePath)
    if (stored === undefined) return { ok: false, detail: 'SKILL.md is not readable' }
    // Parse the same text discovery parsed: a leading BOM must not hide the
    // frontmatter block, or the plan would be built for a file shape that the
    // rewrite does not preserve.
    const current = stripBom(stored)
    const parsed = parseFrontmatter(current)
    const blockedInFrontmatter = blockedByFrontmatter(parsed.fields)
    /**
     * The record that governs this skill. A blocklist written by an earlier
     * version keys `[rootKind, truncatedCategory, name]`, which no longer
     * matches; its record is still found by file path so the upgrade can
     * restore the fields it wrote instead of merely clearing them.
     */
    const record = blocklist.blocked[key]
      ?? Object.entries(blocklist.blocked).find(([, value]) => value?.filePath === entry.filePath)?.[1]
    if (!enabled && record !== undefined) return { ok: true, detail: 'already blocked' }
    // `enabled` is a claim about the frontmatter too: a skill whose file says
    // blocked but which has no record (a legacy key, or a hand edit) must still
    // be restorable, so this is not reported as "already enabled".
    if (enabled && record === undefined && !blockedInFrontmatter) return { ok: true, detail: 'already enabled' }
    const plan = {}
    if (!enabled) {
      if (fieldBoolean(parsed.fields, FIELD_MODEL) !== true) plan[FIELD_MODEL] = `${FIELD_MODEL}: true`
      if (fieldBoolean(parsed.fields, FIELD_USER) !== false) plan[FIELD_USER] = `${FIELD_USER}: false`
      const nextRaw = Object.keys(plan).length === 0 ? current : editFrontmatter(current, plan)
      if (nextRaw !== current) await writeAtomic(entry.filePath, nextRaw)
      await commit({
        version: BLOCKLIST_VERSION,
        blocked: {
          ...withoutLegacyRecord(blocklist.blocked, entry.filePath),
          [key]: {
            name: entryName(entry),
            category: entry.categoryPath,
            fullCategoryPath: entry.fullCategoryPath,
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
    // Restoring: honour the record when it says which fields this plugin wrote,
    // and otherwise clear exactly the fields that are blocking the skill now.
    const wroteModel = record?.wroteModelInvocation === true || (record === undefined && fieldBoolean(parsed.fields, FIELD_MODEL) === true)
    const wroteUser = record?.wroteUserInvocable === true || (record === undefined && fieldBoolean(parsed.fields, FIELD_USER) === false)
    if (wroteModel) {
      plan[FIELD_MODEL] = record?.previous?.modelInvocation == null ? null : `${FIELD_MODEL}: ${record.previous.modelInvocation}`
    }
    if (wroteUser) {
      plan[FIELD_USER] = record?.previous?.userInvocable == null ? null : `${FIELD_USER}: ${record.previous.userInvocable}`
    }
    const nextRaw = Object.keys(plan).length === 0 ? current : editFrontmatter(current, plan)
    if (nextRaw !== current) await writeAtomic(entry.filePath, nextRaw)
    const nextBlocked = { ...withoutLegacyRecord(blocklist.blocked, entry.filePath) }
    delete nextBlocked[key]
    await commit({ version: BLOCKLIST_VERSION, blocked: nextBlocked })
    return { ok: true, detail: 'enabled' }
  }

  /**
   * Build the management view of every discovered skill for one workspace.
   * @param {string | undefined} cwd - workspace directory.
   * @returns {Promise<object>} the snapshot built by `buildSnapshot`: the flat
   *   `categories` list, the `tree` and `flatCategories` views of the same
   *   categories, every `skills` entry, `depthPruned`, `roots`,
   *   `blockedCount`, and the two live scan limits the panel reports.
   */
  async function snapshotSkills(cwd) {
    return {
      ...buildSnapshot(await collect(cwd), blocklist),
      maxDepth: resolved.maxDepth,
      maxCategoryDepth: resolved.maxCategoryDepth,
    }
  }

  // -------------------------------------------------------------------------
  // Management API for the browser panel
  // -------------------------------------------------------------------------

  /**
   * Handle one management request.
   *
   * `GET /skill-manager/panel/state` answers the full snapshot — `categories`,
   * `tree`, `flatCategories`, `skills`, `depthPruned`, `roots`, and
   * `blockedCount` — plus `selected`, the skills one optional `category` query
   * parameter selects. `category` may be empty (the root level) and is combined
   * with `recursive=1` (also `true`) to include descendant categories; with no
   * `category` at all, `selected` is every discovered skill.
   *
   * `POST /skill-manager/panel/set` takes `{ category, skill?, enabled, cwd?,
   * recursive?, kind? }` and answers `{ ok, changes, ...snapshot }`.
   * `recursive` defaults to false, so a category-level switch never touches
   * deeper categories unless it was asked to, and `kind` optionally restricts
   * the switch to one scanned root kind.
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
        const snapshot = await snapshotSkills(cwd ?? undefined)
        const category = url.searchParams.get('category')
        const recursive = truthyFlag(url.searchParams.get('recursive'))
        const selected = category === null ? snapshot.skills : selectSkills(snapshot, category, { recursive })
        send(200, { ok: true, ...snapshot, selected })
        return
      }
      if (request.method === 'POST' && url.pathname === ROUTE_SET) {
        const payload = await readJson(request)
        const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined
        const enabled = payload.enabled === true
        const category = typeof payload.category === 'string' ? payload.category : undefined
        const skill = typeof payload.skill === 'string' && payload.skill.length > 0 ? payload.skill : undefined
        const recursive = payload.recursive === true
        const kind = typeof payload.kind === 'string' && payload.kind.length > 0 ? payload.kind : undefined
        if (category === undefined) {
          send(400, { ok: false, error: 'missing category' })
          return
        }
        const collected = await collect(cwd)
        const targets = selectSkills(buildSnapshot(collected, blocklist), category, { recursive }).filter((entry) => {
          if (kind !== undefined && entry.rootKind !== kind) return false
          if (skill !== undefined && entry.name !== skill) return false
          return entry.usable
        })
        if (targets.length === 0) {
          const target = skill === undefined ? categoryLabel(category) : `${categoryLabel(category)}${TARGET_SEPARATOR}${skill}`
          send(404, { ok: false, error: `no usable skill matches ${target}` })
          return
        }
        const changes = []
        for (const target of targets) {
          const entry = collected.found.get(target.key)
          if (entry === undefined) continue
          changes.push({
            category: target.categoryPath,
            fullCategoryPath: target.fullCategoryPath,
            name: target.name,
            ...(await setSkillEnabled(entry, enabled)),
          })
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
        hint: '[tree [depth]|group [<categoryPath>]|enable <categoryPath>/<skill>|disable <categoryPath>/<skill>|enable-group <categoryPath> [--recursive]|disable-group <categoryPath> [--recursive]|run <categoryPath>/<skill>|blocked|panel]',
      },
      handler: (invocation) => executeSkillsCommand(invocation),
    })
  })

  /**
   * Run one `/skills` invocation.
   *
   * Every branch works from one snapshot so the tree a command reports and the
   * skills it switches can never disagree. A single-skill target resolves on
   * the LAST `/`, so a multi-level category path works; a category target
   * resolves through `selectSkills`, exactly like the POST route, and never
   * includes descendant categories unless the invocation asked for them.
   *
   * @param {object} invocation - the command invocation.
   * @returns {Promise<{ kind: string, text: string }>} the command result.
   */
  async function executeSkillsCommand(invocation) {
    const parsed = parseSkillsCommand(invocation.rawInput)
    if (parsed.kind === 'usage') return { kind: 'error', text: `${parsed.message}\n\n${COMMAND_USAGE}` }
    const cwd = invocation.agent?.session?.header?.cwd
    const collected = await collect(cwd)
    const snapshot = buildSnapshot(collected, blocklist)

    if (parsed.kind === 'list') return { kind: 'success', text: renderCategoryList(snapshot) }
    if (parsed.kind === 'tree') {
      return { kind: 'success', text: renderTree(snapshot, parsed.depth ?? DEFAULT_TREE_DEPTH) }
    }
    if (parsed.kind === 'panel') return { kind: 'success', text: PANEL_HINT }
    if (parsed.kind === 'blocked') return { kind: 'success', text: renderBlockedList(snapshot) }
    if (parsed.kind === 'group') {
      if (findCategoryNodes(snapshot, parsed.category).length === 0) {
        return {
          kind: 'error',
          text: `No category at "${categoryLabel(parsed.category)}".\n\n${renderCategoryList(snapshot)}`,
        }
      }
      return { kind: 'success', text: renderCategoryDetail(snapshot, parsed.category) }
    }
    if (parsed.kind === 'run') {
      const matched = snapshot.skills.find(
        (skill) => skill.categoryPath === parsed.category && skill.name === parsed.skill,
      )
      if (matched === undefined) {
        return {
          kind: 'error',
          text: `No skill "${categoryLabel(parsed.category)}${TARGET_SEPARATOR}${parsed.skill}" is registered.`,
        }
      }
      if (!matched.usable) return { kind: 'error', text: `"${parsed.skill}" cannot be used: ${matched.defect}.` }
      if (matched.blocked) {
        return {
          kind: 'error',
          text: `"${parsed.skill}" is blocked. Run /skills enable ${categoryLabel(parsed.category)}${TARGET_SEPARATOR}${parsed.skill} first.`,
        }
      }
      const raw = await readText(matched.path)
      if (raw === undefined) return { kind: 'error', text: `"${matched.path}" is not readable.` }
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
      return {
        kind: 'success',
        text: `Skill "${categoryLabel(parsed.category)}${TARGET_SEPARATOR}${parsed.skill}" loaded into this session.`,
      }
    }

    const enable = parsed.kind === 'enable' || parsed.kind === 'enable-group'
    const single = parsed.kind === 'enable' || parsed.kind === 'disable'
    const recursive = parsed.recursive === true
    const selected = selectSkills(snapshot, parsed.category, { recursive }).filter((skill) => skill.usable)
    const targets = single ? selected.filter((skill) => skill.name === parsed.skill) : selected
    if (targets.length === 0) {
      const target = single
        ? `"${categoryLabel(parsed.category)}${TARGET_SEPARATOR}${parsed.skill}"`
        : `category "${categoryLabel(parsed.category)}"`
      return { kind: 'error', text: `No usable skill matches ${target}.\n\n${renderCategoryList(snapshot)}` }
    }
    const changes = []
    for (const target of targets) {
      const entry = collected.found.get(target.key)
      if (entry === undefined) continue
      changes.push(`${target.name}: ${(await setSkillEnabled(entry, enable)).detail}`)
    }
    const verb = enable ? 'Enabled' : 'Blocked'
    return {
      kind: 'success',
      text: [
        `${verb} ${changes.length} skill(s) in ${categoryLabel(parsed.category)}${recursive ? ' (including subcategories)' : ''}.`,
        ...changes.map((line) => `  ${line}`),
        '',
        renderCategoryList(await snapshotSkills(cwd)),
      ].join('\n'),
    }
  }
}

/** Success text of `/skills panel`; the panel itself lives in the web UI. */
const PANEL_HINT = [
  'The skill management panel is in 设置 → 技能管理 (Settings → Skill Manager).',
  'It renders the same category tree these commands manage.',
  '',
  'Use /skills tree to list categories here, and /skills group <categoryPath> for one of them.',
].join('\n')

const COMMAND_USAGE = [
  'Usage:',
  '  /skills                              list top-level categories with subtree counts',
  `  /skills tree [depth]                 print the category tree (depth 1..${MAX_TREE_DEPTH}, default ${DEFAULT_TREE_DEPTH})`,
  '  /skills group [<categoryPath>]       show one category: its skills and its subcategories',
  '  /skills enable <categoryPath>/<skill>   enable one skill',
  '  /skills disable <categoryPath>/<skill>  block one skill',
  '  /skills enable-group <categoryPath> [--recursive]   enable a category',
  '  /skills disable-group <categoryPath> [--recursive]  block a category',
  '  /skills run <categoryPath>/<skill>   load one skill into this session',
  '  /skills blocked                      list every blocked skill',
  '  /skills panel                        where to find the management panel',
  '',
  `A category path may be empty for the root level, using a leading "${TARGET_SEPARATOR}"`,
  `for a single skill, and "${CATEGORY_SEPARATOR}" joins nested categories.`,
].join('\n')

/**
 * Parse the `/skills` argument grammar.
 *
 * A category path may be nested (`a/b/c`) and may be empty (the root level).
 * `--recursive` (or `-r`) is a TRAILING flag, stripped before the path is
 * resolved, so a category whose name contains a space keeps working.
 *
 * @param {string} rawInput - text after the command name.
 * @returns {{ kind: string, category?: string, skill?: string, recursive?: boolean, depth?: number, message?: string }}
 */
function parseSkillsCommand(rawInput) {
  const input = (rawInput ?? '').trim()
  if (input.length === 0 || /^(list|ls)$/i.test(input)) return { kind: 'list' }
  if (/^blocked$/i.test(input)) return { kind: 'blocked' }
  if (/^panel$/i.test(input)) return { kind: 'panel' }
  const parts = input.split(/\s+/)
  const verb = parts[0].toLowerCase()
  const argument = parts.slice(1).join(' ').trim()
  if (verb === 'tree') {
    if (argument.length === 0) return { kind: 'tree', depth: DEFAULT_TREE_DEPTH }
    if (!/^\d+$/.test(argument)) return { kind: 'usage', message: treeDepthMessage() }
    const depth = Number(argument)
    if (depth < 1 || depth > MAX_TREE_DEPTH) return { kind: 'usage', message: treeDepthMessage() }
    return { kind: 'tree', depth }
  }
  if (verb === 'group') {
    const stripped = stripTrailingFlags(argument)
    // `group` has no flag grammar, and its no-argument form means the root
    // level only while no flag was given: a bare flag keeps the old error.
    if (stripped.flags.length > 0) return { kind: 'usage', message: '/skills group requires a category name.' }
    return { kind: 'group', category: stripped.value }
  }
  if (verb === 'enable-group' || verb === 'disable-group') {
    const stripped = stripTrailingFlags(argument)
    if (stripped.value.length === 0) return { kind: 'usage', message: `/skills ${verb} requires a category name.` }
    return { kind: verb, category: stripped.value, recursive: stripped.flags.length > 0 }
  }
  if (verb === 'enable' || verb === 'disable' || verb === 'run') {
    const target = splitTarget(argument)
    if (target === undefined) {
      return { kind: 'usage', message: `/skills ${verb} requires <categoryPath>${TARGET_SEPARATOR}<skill>.` }
    }
    return { kind: verb, category: target.category, skill: target.skill }
  }
  return { kind: 'usage', message: `Unknown /skills subcommand "${parts[0]}".` }
}

/** The usage message of an out-of-range `/skills tree` depth. */
function treeDepthMessage() {
  return `/skills tree takes a depth between 1 and ${MAX_TREE_DEPTH}.`
}

/**
 * Split trailing `/skills` flags off one argument.
 * @param {string} argument - the raw argument text, already trimmed.
 * @returns {{ value: string, flags: string[] }} the remaining category path and
 *   the trailing flags that were removed, in the order they were written.
 */
function stripTrailingFlags(argument) {
  const flags = []
  let value = argument.trim()
  while (value.length > 0) {
    const match = /\s+(\S+)$/.exec(value)
    const last = match === null ? value : match[1]
    if (!TRAILING_FLAGS.includes(last.toLowerCase())) break
    flags.unshift(last.toLowerCase())
    value = (match === null ? '' : value.slice(0, match.index)).trim()
  }
  return { value, flags }
}

/**
 * Split `<categoryPath>/<skill>` on the LAST separator, so a multi-level
 * category path resolves on the skill name rather than on an inner segment.
 * The category path may be empty — the root level — which the caller writes as
 * a leading separator (`/skill-name`).
 * @param {string} argument - the raw target text.
 * @returns {{ category: string, skill: string } | undefined} the pair, or
 *   undefined when the target carries no separator or no skill after it.
 */
function splitTarget(argument) {
  const at = argument.lastIndexOf(TARGET_SEPARATOR)
  if (at < 0 || at === argument.length - 1) return undefined
  const category = argument.slice(0, at).trim()
  const skill = argument.slice(at + 1).trim()
  if (skill.length === 0) return undefined
  return { category, skill }
}

/** The "not scanned" warning lines, or none when nothing was pruned. */
function depthPrunedNotice(snapshot) {
  if (snapshot.depthPruned.length === 0) return []
  return ['', ...depthPrunedLines(snapshot)]
}

/** The warning lines themselves, shared by the list and tree renderers. */
function depthPrunedLines(snapshot) {
  return [
    `Warning: ${snapshot.depthPruned.length} folder(s) were not scanned (depth exceeded):`,
    ...snapshot.depthPruned.map((path) => `  ${categoryLabel(path)}`),
  ]
}

/** Render the top-level categories with their subtree counts. */
function renderCategoryList(snapshot) {
  if (snapshot.skills.length === 0) {
    return ['No skills found. Scanned roots:', ...snapshot.roots.map((root) => `  ${root.kind}: ${root.path}`)].join('\n')
  }
  const categoryLines = []
  for (const root of snapshot.tree) {
    // The root node's own skills have no category folder to name, so they are
    // listed as this root's root level.
    if (root.skills.length > 0) {
      const blocked = root.skills.filter((skill) => skill.blocked).length
      categoryLines.push(`  [${root.kind}] ${ROOT_CATEGORY} — ${root.skills.length} skills, ${blocked} blocked`)
    }
    for (const child of root.children) {
      categoryLines.push(`  [${child.kind}] ${child.path} — ${child.totalSkills} skills, ${child.blockedSkills} blocked`)
    }
  }
  return [
    `Skills: ${categoryLines.length} categories, ${snapshot.skills.length} skills, ${snapshot.blockedCount} blocked`,
    ...categoryLines,
    ...depthPrunedNotice(snapshot),
    '',
    'Use /skills tree for the whole tree and /skills group <categoryPath> for detail.',
  ].join('\n')
}

/**
 * Render the category tree, limited to `maxLevels` category levels.
 *
 * A scanned root is always printed as the unindented first line of its block,
 * and `maxLevels` counts category levels below it: level 1 is a root's own
 * top-level categories, so `maxLevels: 1` prints the roots and their
 * categories, and the default of 2 adds one more level.
 * @param {object} snapshot - snapshot to render.
 * @param {number} maxLevels - deepest category level to print, 1..MAX_TREE_DEPTH.
 * @returns {string} the rendered tree.
 */
function renderTree(snapshot, maxLevels) {
  if (snapshot.tree.length === 0) {
    return ['No skills found. Scanned roots:', ...snapshot.roots.map((root) => `  ${root.kind}: ${root.path}`)].join('\n')
  }
  const lines = []
  const visit = (node) => {
    const indent = '  '.repeat(node.depth)
    const counts = `${node.totalSkills} skills, ${node.blockedSkills} blocked`
    lines.push(node.path.length === 0
      ? `${indent}[${node.kind}] ${node.name} — ${counts}`
      : `${indent}${node.name} — ${counts}`)
    if (node.depth >= maxLevels) return
    for (const child of node.children) visit(child)
  }
  for (const root of snapshot.tree) visit(root)
  return [...lines, ...depthPrunedNotice(snapshot)].join('\n')
}

/**
 * Render one category path in detail: its direct skills and its child
 * categories with subtree counts. A path that several scanned roots share is
 * rendered once per root.
 * @param {object} snapshot - snapshot to render.
 * @param {string} categoryPath - category path, `''` at the root level.
 * @returns {string} the rendered detail.
 */
function renderCategoryDetail(snapshot, categoryPath) {
  const lines = []
  for (const { node, root } of findCategoryNodes(snapshot, categoryPath)) {
    if (lines.length > 0) lines.push('')
    lines.push(`Category ${categoryLabel(categoryPath)} (${node.kind})`)
    lines.push(`Path: ${categoryDirectory(root, categoryPath)}`)
    lines.push(`${node.totalSkills} skill(s) in this subtree, ${node.blockedSkills} blocked.`)
    if (node.skills.length === 0) {
      lines.push('  No skills directly in this category.')
    } else {
      for (const skill of node.skills) {
        lines.push(`  ${skill.name} [${skill.blocked ? 'blocked' : 'enabled'}]${skill.usable ? '' : ` — unusable: ${skill.defect}`}${skill.truncated ? ` — grouped here from ${skill.fullCategoryPath}` : ''}`)
        if (skill.usable && skill.description.length > 0) lines.push(`    ${skill.description}`)
      }
    }
    if (node.children.length > 0) {
      lines.push('  Subcategories:')
      for (const child of node.children) {
        lines.push(`    ${child.name} — ${child.totalSkills} skills, ${child.blockedSkills} blocked`)
      }
    }
  }
  return lines.join('\n')
}

/** Render every blocked skill. */
function renderBlockedList(snapshot) {
  const blocked = snapshot.skills.filter((skill) => skill.blocked)
  if (blocked.length === 0) return 'No skills are blocked.'
  return [
    `${blocked.length} blocked skill(s):`,
    ...blocked.map((skill) => `  ${categoryLabel(skill.categoryPath)}${TARGET_SEPARATOR}${skill.name} — ${skill.path}`),
  ].join('\n')
}

/**
 * Whether a query parameter asked for a boolean option, spelled `1` or `true`.
 * @param {string | null} value - the raw query parameter.
 * @returns {boolean} whether it was set.
 */
function truthyFlag(value) {
  if (typeof value !== 'string') return false
  return value === '1' || value.toLowerCase() === 'true'
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
 *
 * Candidates are de-duplicated on the same identity the blocklist uses, which
 * embeds the UNTRUNCATED category path; a skill's `maxDepth`/`maxCategoryDepth`
 * grouping never changes which candidate wins.
 *
 * @param {object} resolved - resolved plugin config.
 * @param {object} blocklist - current blocklist.
 * @param {{ cwd?: string }} options - lookup options.
 * @returns {Promise<object[]>} provider candidates.
 */
async function listCandidates(resolved, blocklist, options) {
  const roots = await skillRoots(resolved, options?.cwd)
  const candidates = []
  const seen = new Set()
  for (const root of roots) {
    for (const entry of (await scanRoot(root, resolved)).entries) {
      if (entryDefect(entry) !== undefined) continue
      const skillName = entryName(entry)
      const key = identityKey(identity(entry.rootKind, entryLocator(entry), skillName))
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
            // `category` is the display label this provider has always
            // published; `categoryPath` is the truncated grouping path the
            // panel switches on, and `fullCategoryPath` keeps it whole.
            category: categoryLabel(entry.categoryPath),
            categoryPath: entry.categoryPath,
            fullCategoryPath: entry.fullCategoryPath,
            // The skill's own path below its root, which is what the blocklist
            // key uses; `categoryPath` alone cannot tell a root-level flat file
            // and a root-level directory skill apart.
            locatorPath: entryLocator(entry),
            truncated: entry.truncated,
            depth: entry.depth,
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
 *
 * The blocklist key is rebuilt from the candidate's metadata, which must carry
 * the skill's full LOCATOR path — the truncated grouping path, or the category
 * path alone, would key a different entry.
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
  const key = identityKey(identity(meta.rootKind ?? 'user', meta.locatorPath ?? categoryPathOf(meta), candidate.name))
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
