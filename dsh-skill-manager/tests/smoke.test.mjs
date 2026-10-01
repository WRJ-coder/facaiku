/**
 * Behavioural smoke test for dsh-skill-manager.
 *
 * It drives the plugin's own `apply()` against a stub context (a fake
 * `ctx.skills` that captures the provider, plus a fake `ctx.webServer` that
 * captures the two management routes) and exercises the real code paths:
 * discovery, blocking, restoring, persistence, and the `/skills` command.
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
    effect: () => () => {},
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

/** Apply the plugin against a private skill root, returning the harness. */
async function mount(skillRoot, statePath, entry = pluginEntry) {
  const harness = createHarness()
  const { apply } = await import(entry.href)
  await apply(harness.context, {
    dshHome: skillRoot,
    agentsHome: join(skillRoot, 'agents-home'),
    statePath,
    projectSkillDirs: [],
    bundledSkillDir: undefined,
  })
  return harness
}

/** Write one skill file and return its path. */
async function writeSkill(home, category, name, content) {
  const directory = join(home, 'skills', category, name)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, content, 'utf8')
  return file
}

/** Flip one skill through the management route. */
function setSkill(captured, category, skill, enabled) {
  return callRoute(captured.routes.get('/skill-manager/panel/set'), {
    method: 'POST',
    url: '/skill-manager/panel/set',
    body: { category, skill, enabled },
  })
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
    assert.equal(blocked.changes.length, 2, 'omitting `skill` acts on the whole category')
    assert.equal(blocked.blockedCount, 2)

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
