/**
 * Behavioural smoke test for dsh-skill-manager.
 *
 * It drives the plugin's own `apply()` against a stub context (a fake
 * `ctx.skills` that captures the provider, plus a fake `ctx.webServer` that
 * captures the two management routes) and exercises the real code paths:
 * discovery, blocking, restoring, persistence, and the `/skills` command,
 * including the nested-category walk, its depth limits, the snapshot tree, and
 * recursive category switches.
 *
 * Run it from a directory where the DSH packages the plugin imports
 * (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-home-paths`) resolve — inside
 * a DSH installation, or inside a profile that has them:
 *
 *   node --test tests/smoke.test.mjs
 *
 * Running the file directly (`node tests/smoke.test.mjs`) also works: each
 * registered test is then executed in-process, which is what a confined
 * environment needs when it refuses the child process `node --test` spawns.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** Tests registered through `test_()`, replayed by the direct-run path. */
const registry = []
const test_ = (title, fn) => {
  registry.push({ title, fn })
  test(title, fn)
}

const here = dirname(fileURLToPath(import.meta.url))
const pluginEntry = new URL('../index.js', import.meta.url)

/** The category and skill names used by the fixtures below. */
const CATEGORY = '代码审查'
const DOC_CATEGORY = '文档'

/** Label a skill at the scanned root's own level is reported under. */
const ROOT_CATEGORY = '(uncategorized)'

/** A BOM-prefixed skill file, the shape Notepad and some editors produce. */
const BOM = '\uFEFF'
const SAMPLE = [
  '---',
  'name: security-audit',
  'description: Audit a change for injection and unsafe defaults.',
  'disable-model-invocation: false',
  '---',
  '',
  '# Security audit',
  '',
  'Body text that must survive every rewrite.',
  '',
].join('\n')

/** The same document renamed for a second fixture. */
function sampleFor(name) {
  return SAMPLE.replaceAll('security-audit', name)
}

/** Build the stub Host context, exposing everything the plugin registered. */
function createHarness() {
  const captured = { provider: undefined, routes: new Map(), commands: [] }
  const context = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    // `ctx.effect(body)` runs `body` immediately in Cordis and keeps the
    // function it returns as the disposer (see @deepseek-ai/cordis
    // `fiber.effect`). A stub that only returns a no-op never runs the body,
    // so every contribution the plugin registers inside an effect — its two
    // webServer routes — silently never happens and every route test dies on
    // `handler is not a function`.
    effect: (execute) => {
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    emit: () => {},
    inject: (names, callback) => {
      const services = {}
      for (const name of names) {
        if (name === 'webServer') {
          services.webServer = {
            register: (route) => {
              captured.routes.set(route.path, route.handler)
              return () => captured.routes.delete(route.path)
            },
          }
        }
        if (name === 'commands') {
          services.commands = { register: (definition) => captured.commands.push(definition) }
        }
      }
      callback({ ...context, ...services })
    },
    skills: {
      registerProvider: (create) => {
        captured.provider = create({ signal: new AbortController().signal, invalidate: () => {} })
        return () => {}
      },
    },
  }
  return { context, captured }
}

/** Call one captured route the way the browser would. */
async function callRoute(handler, { method = 'GET', url = '/', body } = {}) {
  const response = {
    status: undefined,
    payload: undefined,
    writeHead(status) {
      this.status = status
      return this
    },
    end(text) {
      this.payload = text
    },
    destroy() {},
  }
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:43120' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  await handler(request, response)
  return { status: response.status, body: response.payload === undefined ? undefined : JSON.parse(response.payload) }
}

/**
 * Apply the plugin against a private skill root, returning the harness.
 * @param {string} skillRoot - host home; skills live under `<skillRoot>/skills`.
 * @param {string} statePath - blocklist file.
 * @param {object} extra - config overrides, e.g. `{ maxDepth: 4 }`.
 * @param {URL} entry - plugin entry URL.
 */
async function mount(skillRoot, statePath, extra = {}, entry = pluginEntry) {
  const harness = createHarness()
  const { apply } = await import(entry.href)
  await apply(harness.context, {
    dshHome: skillRoot,
    agentsHome: join(skillRoot, 'agents-home'),
    statePath,
    projectSkillDirs: [],
    bundledSkillDir: undefined,
    ...extra,
  })
  return harness
}

/** Write one SKILL.md at a path relative to the scanned skills root. */
async function writeSkillAt(home, relative, content) {
  const directory = join(home, 'skills', relative)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, content, 'utf8')
  return file
}

/** Write one `<category>/<name>/SKILL.md` and return its path. */
function writeSkill(home, category, name, content) {
  return writeSkillAt(home, join(category, name), content)
}

/** POST one `/skill-manager/panel/set` payload verbatim. */
function postSet(captured, body) {
  return callRoute(captured.routes.get('/skill-manager/panel/set'), {
    method: 'POST',
    url: '/skill-manager/panel/set',
    body,
  })
}

/** Flip one skill through the management route. */
function setSkill(captured, category, skill, enabled) {
  return postSet(captured, { category, skill, enabled })
}

/** Read the snapshot the management panel reads. */
function readState(captured, query = '') {
  return callRoute(captured.routes.get('/skill-manager/panel/state'), {
    url: `/skill-manager/panel/state${query}`,
  })
}

/** A `/skills` runner bound to one workspace, recording injected followups. */
function commandRunner(captured, cwd) {
  const [command] = captured.commands
  assert.ok(command, 'the plugin registered the /skills command')
  const followups = []
  return {
    followups,
    run: (rawInput) => command.handler({
      rawInput,
      agent: { session: { header: { cwd } }, followup: (message) => followups.push(message) },
    }),
  }
}

/**
 * The category one entry REPORTS — the possibly truncated grouping path, not
 * the untruncated `fullCategoryPath` that travels beside it. A panel row
 * carries it in `categoryPath`; provider metadata carries the display label in
 * `category`. A skill at the root level reports `(uncategorized)`.
 */
function skillCategory(entry) {
  if (typeof entry?.categoryPath === 'string' && entry.categoryPath.length > 0) return entry.categoryPath
  if (typeof entry?.category === 'string' && entry.category.length > 0) return entry.category
  if (typeof entry?.fullCategoryPath === 'string' && entry.fullCategoryPath.length > 0) return entry.fullCategoryPath
  return ROOT_CATEGORY
}

/** One tree node's own label. */
function nodeName(node) {
  return node?.name ?? node?.categoryPath ?? node?.category
}

/**
 * The category path one flat entry describes. The legacy `categories` array
 * names it in `name`, while a `flatCategories`/tree node carries the path in
 * `path` and only its last segment in `name`; a node with no path at all is
 * the scanned-root level.
 */
function categoryName(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return undefined
  for (const key of ['fullCategoryPath', 'categoryPath', 'path']) {
    const value = entry[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (entry.depth !== undefined) return ROOT_CATEGORY
  return entry.name ?? entry.category ?? ROOT_CATEGORY
}

/** Every flat category entry a snapshot exposes, from either list shape. */
function flatEntries(state) {
  const entries = []
  for (const list of [state?.categories, state?.flatCategories]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) if (entry !== null && typeof entry === 'object') entries.push(entry)
  }
  return entries
}

/** Every category name a snapshot reports, from either flat list shape. */
function categoryNames(state) {
  return [...new Set(flatEntries(state).map((entry) => categoryName(entry)))]
}

/**
 * Every `{ group, skill }` row a snapshot exposes. `categories` and
 * `flatCategories` enumerate the same skills, so only one is read — the legacy
 * `categories` array when it has entries, else `flatCategories` — which keeps
 * row counts honest.
 */
function panelSkills(state) {
  const legacy = Array.isArray(state?.categories) ? state.categories : []
  const groups = legacy.length > 0
    ? legacy
    : (Array.isArray(state?.flatCategories) ? state.flatCategories : [])
  const rows = []
  for (const group of groups) {
    for (const skill of group?.skills ?? []) rows.push({ group, skill })
  }
  return rows
}

/** Walk a snapshot tree depth-first: `visit(node, depth)`, root nodes at 0. */
function walkTree(nodes, visit, depth = 0) {
  for (const node of nodes ?? []) {
    visit(node, depth)
    walkTree(node.children, visit, depth + 1)
  }
}

/** Every string anywhere in a JSON-ish value. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out)
  return out
}

/** The invocation policy of the single candidate with this name. */
function invocationOfName(candidates, name) {
  const found = candidates.filter((candidate) => candidate.name === name)
  assert.equal(found.length, 1, `exactly one candidate named "${name}"`)
  return found[0].invocation
}

/** A Windows path with forward slashes, for separator-agnostic assertions. */
function slashes(path) {
  return String(path).replaceAll('\\', '/')
}

test_('discovers the category/skill layout and reports source paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-'))
  try {
    const file = await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const candidates = await captured.provider.list({})

    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, 'security-audit')
    assert.equal(candidates[0].metadata['dsh-skill-manager'].category, CATEGORY)
    assert.equal(candidates[0].path, file)
    assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('accepts a SKILL.md that starts with a UTF-8 BOM', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-bom-'))
  try {
    await writeSkill(home, DOC_CATEGORY, 'api-doc', BOM + sampleFor('api-doc'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const candidates = await captured.provider.list({})

    assert.equal(candidates.length, 1, 'a BOM must not hide the skill from discovery')
    assert.equal(candidates[0].name, 'api-doc')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('blocking writes both fields without destroying the rest of the file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-block-'))
  try {
    const file = await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const blocked = await setSkill(captured, CATEGORY, 'security-audit', false)

    assert.equal(blocked.status, 200)
    const text = await readFile(file, 'utf8')
    assert.match(text, /^---\n/, 'the document still opens with frontmatter')
    assert.match(text, /disable-model-invocation: true/)
    assert.match(text, /user-invocable: false/)
    assert.match(text, /name: security-audit/, 'name survives the rewrite')
    assert.match(text, /description: Audit a change/, 'description survives the rewrite')
    assert.match(text, /Body text that must survive every rewrite\./)
    assert.equal(text.match(/^---$/gm).length, 2, 'exactly one frontmatter block')

    const candidates = await captured.provider.list({})
    assert.deepEqual(candidates[0].invocation, { modelInvocable: false, userInvocable: false })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('blocking a BOM-prefixed file keeps its original frontmatter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-block-bom-'))
  try {
    const file = await writeSkill(home, DOC_CATEGORY, 'api-doc', BOM + sampleFor('api-doc'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const blocked = await setSkill(captured, DOC_CATEGORY, 'api-doc', false)
    assert.equal(blocked.status, 200)

    const text = await readFile(file, 'utf8')
    assert.match(text, /name: api-doc/, 'the original name is not buried in the body')
    assert.match(text, /description: Audit a change/, 'the original description is preserved')
    assert.equal(text.match(/^---$/gm).length, 2, 'a BOM file must not gain a second frontmatter block')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('enabling restores the field values that were there before', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-restore-'))
  try {
    // `disable-model-invocation: false` must come back as false, not vanish.
    const file = await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    const before = await readFile(file, 'utf8')

    const { captured } = await mount(home, join(home, 'blocklist.json'))
    await setSkill(captured, CATEGORY, 'security-audit', false)
    const restored = await setSkill(captured, CATEGORY, 'security-audit', true)
    assert.equal(restored.status, 200)

    const after = await readFile(file, 'utf8')
    assert.equal(after, before, 'a block/enable cycle is byte-for-byte lossless')

    const candidates = await captured.provider.list({})
    assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the state route lists blocked skills so they stay manageable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-state-'))
  try {
    await writeSkill(home, CATEGORY, 'perf-review', sampleFor('perf-review'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    await setSkill(captured, CATEGORY, 'perf-review', false)

    const state = await callRoute(captured.routes.get('/skill-manager/panel/state'), {
      url: '/skill-manager/panel/state',
    })
    assert.equal(state.status, 200)
    assert.equal(state.body.blockedCount, 1)
    const skill = state.body.categories[0].skills[0]
    assert.equal(skill.name, 'perf-review')
    assert.equal(skill.blocked, true, 'a blocked skill is still listed')
    assert.equal(skill.usable, true, 'and stays restorable')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the blocklist survives a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-persist-'))
  try {
    await writeSkill(home, DOC_CATEGORY, 'api-doc', sampleFor('api-doc'))
    const statePath = join(home, 'blocklist.json')

    const first = await mount(home, statePath)
    await setSkill(first.captured, DOC_CATEGORY, 'api-doc', false)

    // A second mount stands in for the next process: same file, fresh plugin.
    const second = await mount(home, statePath)
    const candidates = await second.captured.provider.list({})
    assert.equal(candidates.length, 1)
    assert.deepEqual(candidates[0].invocation, { modelInvocable: false, userInvocable: false })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the skills command exposes the documented subcommands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-command-'))
  try {
    await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    assert.equal(captured.commands.length, 1)
    const [command] = captured.commands
    assert.equal(command.name, 'skills')

    let followups = 0
    const run = (rawInput) => command.handler({
      rawInput,
      agent: { session: { header: { cwd: home } }, followup: () => { followups += 1 } },
    })

    const list = await run('')
    assert.equal(list.kind, 'success')
    assert.match(list.text, new RegExp(CATEGORY))

    const group = await run(`group ${CATEGORY}`)
    assert.match(group.text, /security-audit/)

    const disabled = await run(`disable ${CATEGORY}/security-audit`)
    assert.equal(disabled.kind, 'success')

    const blocked = await run('blocked')
    assert.match(blocked.text, /security-audit/)

    const refused = await run(`run ${CATEGORY}/security-audit`)
    assert.equal(refused.kind, 'error', 'a blocked skill cannot be run')
    assert.equal(followups, 0)

    await run(`enable ${CATEGORY}/security-audit`)
    const invoked = await run(`run ${CATEGORY}/security-audit`)
    assert.equal(invoked.kind, 'success')
    assert.equal(followups, 1, 'running a skill injects it into the session')

    const unknown = await run('enable no-such-category/x')
    assert.equal(unknown.kind, 'error')

    const usage = await run('nonsense')
    assert.equal(usage.kind, 'error')
    assert.match(usage.text, /Usage:/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('a category-level batch switch covers every skill in it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-group-'))
  try {
    await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    await writeSkill(home, CATEGORY, 'perf-review', sampleFor('perf-review'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))

    const blocked = await callRoute(captured.routes.get('/skill-manager/panel/set'), {
      method: 'POST',
      url: '/skill-manager/panel/set',
      body: { category: CATEGORY, enabled: false },
    })
    assert.equal(blocked.status, 200)
    // `callRoute` returns `{ status, body }`; the payload is under `body`.
    assert.equal(blocked.body.changes.length, 2, 'omitting `skill` acts on the whole category')
    assert.equal(blocked.body.blockedCount, 2)

    const candidates = await captured.provider.list({})
    assert.equal(candidates.length, 2)
    for (const candidate of candidates) {
      assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: false })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Nested categories.
//
// The contract these tests encode:
//   * a directory holding SKILL.md is a skill, any other directory is a
//     category container and the walk descends into it;
//   * a skill's category is its directory's path relative to the scanned root
//     with the final segment removed (`<root>/分类A/子分类C/技能D` → `分类A/子分类C`),
//     and an empty result reads as `(uncategorized)`;
//   * `maxDepth` (default 4) bounds how many container directories may sit
//     above a skill, `maxCategoryDepth` (default 3) truncates the reported
//     category while `fullCategoryPath` keeps it whole;
//   * a category-level switch is limited to the category's own skills unless
//     `recursive: true` / a trailing `--recursive` asks for the subtree.
// ---------------------------------------------------------------------------

test_('discovers a three-level category path with the real SKILL.md path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-nested-'))
  try {
    const file = await writeSkill(home, '分类A/子分类C', '技能D', sampleFor('skill-d'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const candidates = await captured.provider.list({})

    assert.equal(candidates.length, 1, 'the walk descends two category levels')
    assert.equal(candidates[0].name, 'skill-d')
    assert.equal(
      skillCategory(candidates[0].metadata['dsh-skill-manager']),
      '分类A/子分类C',
      'the category is the skill directory path minus its final segment',
    )
    assert.equal(candidates[0].path, file, 'the reported path is the real SKILL.md')

    const state = await readState(captured)
    assert.equal(state.status, 200)
    const row = panelSkills(state.body).find((entry) => entry.skill.name === 'skill-d')
    assert.ok(row, 'the panel lists the nested skill')
    assert.equal(categoryName(row.group), '分类A/子分类C')
    assert.equal(skillCategory(row.skill), '分类A/子分类C')
    assert.equal(row.skill.path, file)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('a SKILL.md directly inside a root child is reported as (uncategorized)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-root-skill-'))
  try {
    // 分类A holds SKILL.md itself, so it is the skill and has no parent
    // category: the relative path minus its final segment is empty.
    const file = await writeSkillAt(home, '分类A', sampleFor('lone-skill'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const candidates = await captured.provider.list({})

    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, 'lone-skill')
    assert.equal(skillCategory(candidates[0].metadata['dsh-skill-manager']), '(uncategorized)')
    assert.equal(candidates[0].path, file)

    const state = await readState(captured)
    const row = panelSkills(state.body).find((entry) => entry.skill.name === 'lone-skill')
    assert.ok(row, 'the panel lists the root-level skill')
    assert.equal(categoryName(row.group), '(uncategorized)')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('maxDepth stops the walk below the configured level and reports the pruned directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-depth-'))
  try {
    // Four container directories above the skill is the default limit; a
    // fifth container puts the skill one level too deep.
    const found = await writeSkillAt(home, 'A/B/C/D/skill-deep', sampleFor('skill-deep'))
    await writeSkillAt(home, 'A/B/C/D/E/skill-too-deep', sampleFor('skill-too-deep'))

    const { captured } = await mount(home, join(home, 'blocklist.json'), { maxDepth: 4 })
    const candidates = await captured.provider.list({})

    // The same fixture one level higher, only to make a failure self-explaining.
    const deeper = await mount(home, join(home, 'blocklist-5.json'), { maxDepth: 5 })
    const atFive = (await deeper.captured.provider.list({})).map((candidate) => candidate.name)

    assert.deepEqual(
      candidates.map((candidate) => candidate.name),
      ['skill-deep'],
      `maxDepth 4 must find A/B/C/D/skill-deep; it returned ${JSON.stringify(candidates.map((c) => c.name))}`
        + ` (the same fixture at maxDepth 5 returns ${JSON.stringify(atFive)})`,
    )
    assert.equal(candidates[0].path, found)

    const state = await readState(captured)
    assert.equal(state.status, 200)
    // The specification says the pruned directory is reported but does not name
    // the field, so assert the path is present in the snapshot's own pruned
    // list when it has one, and anywhere in the payload otherwise.
    const pruned = (Array.isArray(state.body.depthPruned) ? state.body.depthPruned : allStrings(state.body))
      .map(slashes)
    assert.ok(
      pruned.some((path) => /(?:^|\/)A\/B\/C\/D\/E(?:\/skill-too-deep)?$/.test(path)),
      `the pruned directory must be reported; depthPruned=${JSON.stringify(state.body.depthPruned)}`,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('maxCategoryDepth truncates the reported category and keeps the full path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-cat-depth-'))
  try {
    // A four-segment category. `maxDepth` is raised so this fixture isolates
    // the category limit: under the default depth a four-segment category is
    // not reachable at all, which would test `maxDepth` instead.
    const file = await writeSkillAt(home, 'A/B/C/D/deep-skill', sampleFor('deep-skill'))
    const { captured } = await mount(home, join(home, 'blocklist.json'), { maxDepth: 5 })
    const candidates = await captured.provider.list({})

    assert.equal(candidates.length, 1, 'the skill is discovered so it can be attributed')
    assert.equal(
      skillCategory(candidates[0].metadata['dsh-skill-manager']),
      'A/B/C',
      'the reported category is the three-segment ancestor',
    )
    assert.equal(candidates[0].path, file)

    const state = await readState(captured)
    const row = panelSkills(state.body).find((entry) => entry.skill.name === 'deep-skill')
    assert.ok(row, 'the panel lists the truncated skill')
    assert.equal(categoryName(row.group), 'A/B/C')

    // Either surface may carry the untruncated path; assert on whichever does.
    const carriers = [row.skill, candidates[0].metadata['dsh-skill-manager']]
    const carrier = carriers.find((entry) => entry !== undefined && entry.fullCategoryPath !== undefined)
    assert.ok(carrier, `an entry must carry fullCategoryPath; saw ${JSON.stringify(carriers)}`)
    assert.equal(carrier.fullCategoryPath, 'A/B/C/D', 'the untruncated path is preserved')
    assert.equal(carrier.truncated, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('a category switch is limited to direct skills unless recursive is set', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-recursive-'))
  try {
    await writeSkill(home, '分类A', 'direct-skill', sampleFor('direct-skill'))
    await writeSkill(home, '分类A/子分类C', 'child-skill', sampleFor('child-skill'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))

    const shallow = await postSet(captured, { category: '分类A', enabled: false })
    assert.equal(shallow.status, 200)
    assert.deepEqual(
      shallow.body.changes.map((change) => change.name),
      ['direct-skill'],
      'omitting `recursive` touches only the category own skills',
    )

    let candidates = await captured.provider.list({})
    assert.deepEqual(invocationOfName(candidates, 'direct-skill'), { modelInvocable: false, userInvocable: false })
    assert.deepEqual(
      invocationOfName(candidates, 'child-skill'),
      { modelInvocable: true, userInvocable: true },
      'the nested skill is untouched',
    )

    const restore = await postSet(captured, { category: '分类A', skill: 'direct-skill', enabled: true })
    assert.equal(restore.status, 200)

    const deep = await postSet(captured, { category: '分类A', enabled: false, recursive: true })
    assert.equal(deep.status, 200)
    assert.deepEqual(
      deep.body.changes.map((change) => change.name).sort(),
      ['child-skill', 'direct-skill'],
      'recursive covers the subtree',
    )

    candidates = await captured.provider.list({})
    assert.equal(candidates.length, 2)
    for (const candidate of candidates) {
      assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: false })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the snapshot tree mirrors the flat list and omits empty categories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-tree-'))
  try {
    await writeSkill(home, '分类A', 'direct-skill', sampleFor('direct-skill'))
    await writeSkill(home, '分类A/子分类C', 'child-skill', sampleFor('child-skill'))
    await mkdir(join(home, 'skills', '空分类'), { recursive: true })

    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const state = await readState(captured)
    assert.equal(state.status, 200)
    assert.ok(Array.isArray(state.body.tree), 'the snapshot carries a tree')
    assert.ok(Array.isArray(state.body.flatCategories), 'the snapshot carries flatCategories')

    const names = categoryNames(state.body)
    assert.ok(names.includes('分类A'), `flat categories: ${JSON.stringify(names)}`)
    assert.ok(names.includes('分类A/子分类C'))
    assert.ok(!names.includes('空分类'), 'a directory holding no skill anywhere is not a category')

    const rows = panelSkills(state.body)
    assert.equal(rows.length, 2, 'two usable skills in the flat list')

    const nodes = []
    walkTree(state.body.tree, (node, depth) => nodes.push({ node, depth }))
    // Depth 0 is the scanned root itself, depth 1 its categories — that is
    // what `/skills tree 1` prints.
    const topLevel = nodes.filter(({ depth }) => depth === 1).map(({ node }) => nodeName(node))
    assert.ok(topLevel.includes('分类A'), `depth-1 categories: ${JSON.stringify(topLevel)}`)
    assert.ok(!topLevel.includes('子分类C'), 'a nested category is not top level')
    assert.ok(
      nodes.every(({ node }) => nodeName(node) !== '空分类'),
      'an empty category is absent from the tree too',
    )

    const parent = nodes.find(({ node, depth }) => depth === 1 && nodeName(node) === '分类A')?.node
    assert.ok(parent, '分类A is a depth-1 tree node')
    assert.ok(Array.isArray(parent.children), 'a category node exposes children')
    assert.equal(parent.children.length, 1)
    const child = parent.children[0]
    assert.equal(nodeName(child), '子分类C')
    assert.deepEqual(child.children ?? [], [], 'a leaf category has no children')
    assert.equal(child.totalSkills, 1)
    assert.equal(child.blockedSkills, 0)
    assert.equal(parent.blockedSkills, 0)
    assert.equal(
      parent.totalSkills,
      2,
      'a category node totals its whole subtree (one direct skill plus one nested), not only its own rows',
    )

    if (nodes.some(({ node }) => Array.isArray(node.skills))) {
      const listed = nodes.reduce((sum, { node }) => sum + (node.skills?.length ?? 0), 0)
      assert.equal(listed, rows.length, 'the tree lists exactly the skills the flat list does')
    }

    // Blocking one nested skill must show up on its own node and in the count.
    const blocked = await postSet(captured, { category: '分类A/子分类C', skill: 'child-skill', enabled: false })
    assert.equal(blocked.status, 200)
    const after = await readState(captured)
    assert.equal(after.body.blockedCount, 1, 'the snapshot counts the blocked skill')
    const refreshed = []
    walkTree(after.body.tree, (node) => refreshed.push(node))
    const leaf = refreshed.find((node) => nodeName(node) === '子分类C')
    assert.ok(leaf, 'the nested category is still in the tree')
    assert.equal(leaf.blockedSkills, 1, 'the leaf node counts its blocked skill')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('same-named skills in different deep categories stay independent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-twin-'))
  try {
    // Identical frontmatter names under two sibling subcategories: a blocklist
    // keyed on the name alone, or on the category alone, would merge them.
    await writeSkill(home, '分类A/子分类C', 'twin', sampleFor('twin'))
    await writeSkill(home, '分类A/子分类D', 'twin', sampleFor('twin'))
    const statePath = join(home, 'blocklist.json')
    const { captured } = await mount(home, statePath)

    let candidates = await captured.provider.list({})
    assert.equal(candidates.length, 2, 'both twins are discovered')
    assert.deepEqual(
      candidates.map((candidate) => skillCategory(candidate.metadata['dsh-skill-manager'])).sort(),
      ['分类A/子分类C', '分类A/子分类D'],
    )

    const blocked = await postSet(captured, { category: '分类A/子分类C', skill: 'twin', enabled: false })
    assert.equal(blocked.status, 200)
    candidates = await captured.provider.list({})
    const one = candidates.find((candidate) => skillCategory(candidate.metadata['dsh-skill-manager']) === '分类A/子分类C')
    const other = candidates.find((candidate) => skillCategory(candidate.metadata['dsh-skill-manager']) === '分类A/子分类D')
    assert.deepEqual(one.invocation, { modelInvocable: false, userInvocable: false })
    assert.deepEqual(
      other.invocation,
      { modelInvocable: true, userInvocable: true },
      'the twin in the other category is still invocable',
    )

    const blockedTwice = await postSet(captured, { category: '分类A/子分类D', skill: 'twin', enabled: false })
    assert.equal(blockedTwice.status, 200)
    const blocklist = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(Object.keys(blocklist.blocked).length, 2, 'two skills, two blocklist records')
    const snapshot = await readState(captured)
    assert.equal(snapshot.body.blockedCount, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the tree subcommand prints top-level categories only at depth 1', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-command-tree-'))
  try {
    await writeSkill(home, '分类A', 'direct-skill', sampleFor('direct-skill'))
    await writeSkill(home, '分类A/子分类C', 'child-skill', sampleFor('child-skill'))
    await writeSkill(home, '分类B', 'top-skill', sampleFor('top-skill'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const { run } = commandRunner(captured, home)

    const tree = await run('tree 1')
    // The next depth up, only to make a failure self-explaining.
    const deeper = await run('tree 2')
    assert.equal(tree.kind, 'success', 'tree is a known subcommand')
    assert.match(
      tree.text,
      /分类A/,
      `depth 1 prints the top-level categories; it printed:\n${tree.text}\n--- and depth 2 printed:\n${deeper.text}`,
    )
    assert.match(tree.text, /分类B/)
    assert.doesNotMatch(tree.text, /子分类C/, 'and not their subcategories')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the skills command resolves multi-level paths and --recursive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-command-nested-'))
  try {
    await writeSkill(home, '分类A', 'direct-skill', sampleFor('direct-skill'))
    await writeSkill(home, '分类A/子分类C', 'child-skill', sampleFor('child-skill'))
    await writeSkill(home, '分类B', 'top-skill', sampleFor('top-skill'))
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const { run } = commandRunner(captured, home)

    const nested = await run('group 分类A/子分类C')
    assert.equal(nested.kind, 'success', 'group resolves a multi-level category path')
    assert.match(nested.text, /child-skill/)

    const single = await run('disable 分类A/子分类C/child-skill')
    assert.equal(single.kind, 'success')
    let candidates = await captured.provider.list({})
    assert.deepEqual(invocationOfName(candidates, 'child-skill'), { modelInvocable: false, userInvocable: false })
    assert.deepEqual(invocationOfName(candidates, 'direct-skill'), { modelInvocable: true, userInvocable: true })
    await run('enable 分类A/子分类C/child-skill')

    const shallow = await run('disable-group 分类A')
    assert.equal(shallow.kind, 'success')
    candidates = await captured.provider.list({})
    assert.deepEqual(invocationOfName(candidates, 'direct-skill'), { modelInvocable: false, userInvocable: false })
    assert.deepEqual(
      invocationOfName(candidates, 'child-skill'),
      { modelInvocable: true, userInvocable: true },
      'without --recursive the subtree is untouched',
    )

    const restore = await run('enable-group 分类A --recursive')
    assert.equal(restore.kind, 'success')
    candidates = await captured.provider.list({})
    assert.deepEqual(invocationOfName(candidates, 'direct-skill'), { modelInvocable: true, userInvocable: true })
    assert.deepEqual(invocationOfName(candidates, 'child-skill'), { modelInvocable: true, userInvocable: true })

    const deep = await run('disable-group 分类A --recursive')
    assert.equal(deep.kind, 'success')
    candidates = await captured.provider.list({})
    for (const name of ['direct-skill', 'child-skill']) {
      assert.deepEqual(
        invocationOfName(candidates, name),
        { modelInvocable: false, userInvocable: false },
        `--recursive blocks ${name}`,
      )
    }
    assert.deepEqual(
      invocationOfName(candidates, 'top-skill'),
      { modelInvocable: true, userInvocable: true },
      'another category is untouched',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('the panel subcommand points at the settings panel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-panel-command-'))
  try {
    await writeSkill(home, CATEGORY, 'security-audit', SAMPLE)
    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const { run } = commandRunner(captured, home)

    const result = await run('panel')
    assert.equal(result.kind, 'success', 'panel is a known subcommand')
    assert.match(result.text, /设置|settings/i, 'the result names the settings panel')
    assert.match(result.text, /panel|面板|技能管理|skill manager/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Blocklist identity: fallout of keying on [root kind, category path, name].
// ---------------------------------------------------------------------------

test_('a root-level flat file and a root-level skill directory stay independent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-root-twin-'))
  try {
    // `<root>/twin.md` (flat) and `<root>/分类A/SKILL.md` (a directory skill at
    // the root level) both read as category `(uncategorized)` and carry the
    // same name, so an identity of [root kind, category path, name] merges
    // them and one of the two skills vanishes from the catalog.
    await mkdir(join(home, 'skills'), { recursive: true })
    const flat = join(home, 'skills', 'twin.md')
    await writeFile(flat, sampleFor('twin'), 'utf8')
    const directory = await writeSkillAt(home, '分类A', sampleFor('twin'))

    const { captured } = await mount(home, join(home, 'blocklist.json'))
    const candidates = await captured.provider.list({})
    assert.deepEqual(
      candidates.map((candidate) => candidate.path).sort(),
      [flat, directory].sort(),
      'both same-named root-level skills must be advertised',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test_('a skill blocked under the old blocklist key can still be enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-manager-legacy-key-'))
  try {
    await mkdir(join(home, 'skills'), { recursive: true })
    const file = join(home, 'skills', 'api-doc.md')
    await writeFile(file, [
      '---',
      'name: api-doc',
      'description: Audit an interface.',
      `${'disable-model-invocation'}: true`,
      `${'user-invocable'}: false`,
      '---',
      '',
      'Body.',
      '',
    ].join('\n'), 'utf8')

    // A record an earlier version wrote for the flat layout: it spelled the
    // root category `(uncategorized)` instead of the empty category path now
    // used for it, so the record no longer matches the skill.
    const statePath = join(home, 'blocklist.json')
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      blocked: {
        '["user","(uncategorized)","api-doc"]': {
          category: ROOT_CATEGORY,
          name: 'api-doc',
          filePath: file,
          rootKind: 'user',
          blockedAt: 1,
          wroteModelInvocation: true,
          wroteUserInvocable: true,
          previous: {},
        },
      },
    }, null, 2)}\n`, 'utf8')

    const { captured } = await mount(home, statePath)
    const enabled = await postSet(captured, { category: '', skill: 'api-doc', enabled: true })
    assert.equal(enabled.status, 200)

    const candidates = await captured.provider.list({})
    assert.deepEqual(
      candidates[0].invocation,
      { modelInvocable: true, userInvocable: true },
      'enabling must actually restore a skill whose blocklist record used the old key',
    )
    assert.doesNotMatch(await readFile(file, 'utf8'), /disable-model-invocation: true/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Direct-run fallback: replay every registered test in this process.
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])

if (isDirectRun) {
  let failed = 0
  for (const { title, fn } of registry) {
    try {
      await fn()
      console.log(`ok   ${title}`)
    } catch (error) {
      failed += 1
      console.log(`FAIL ${title}`)
      console.log(String(error?.stack ?? error).split('\n').map((line) => `     ${line}`).join('\n'))
    }
  }
  console.log(`\n${registry.length - failed}/${registry.length} passed`)
  process.exitCode = failed === 0 ? 0 : 1
}
