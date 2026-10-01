/**
 * Unit tests for the SKILL.md frontmatter reader/writer.
 *
 * This file imports only `../lib/frontmatter.js`, so it runs anywhere Node
 * runs — no DSH installation, no seeded `node_modules`:
 *
 *   node --test tests/frontmatter.test.mjs
 *   node tests/frontmatter.test.mjs          # in-process, same assertions
 *
 * The cases below are regressions for two defects found while building the
 * plugin: a directory-scan depth bug (covered by the behavioural suite) and,
 * here, the two ways a rewrite could damage a skill file.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

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
} from '../lib/frontmatter.js'

const registry = []
const test_ = (title, fn) => {
  registry.push({ title, fn })
  test(title, fn)
}

const BOM = '\uFEFF'

const SAMPLE = [
  '---',
  'name: security-audit',
  'description: Audit a change for injection, secret handling, and unsafe defaults.',
  'whenToUse: Use when reviewing code that touches input handling.',
  'disable-model-invocation: false',
  '---',
  '',
  '# Security audit',
  '',
  '1. Trace every external input to its sink.',
].join('\n')

test_('parses frontmatter fields in file order and keeps the body verbatim', () => {
  const parsed = parseFrontmatter(SAMPLE)
  assert.equal(parsed.present, true)
  assert.deepEqual(parsed.fields.map((field) => field.key), [
    'name',
    'description',
    'whenToUse',
    'disable-model-invocation',
  ])
  assert.equal(fieldValue(parsed.fields, 'name'), 'security-audit')
  // The parser is a pure splitter: the body is exactly what followed the
  // closing delimiter, including its first newline.
  assert.equal(parsed.body, SAMPLE.slice(SAMPLE.indexOf('---\n', 4) + 4))
  assert.match(parsed.body, /# Security audit/)
  assert.match(parsed.body, /Trace every external input to its sink\./)
})

test_('reports a document with no frontmatter as such', () => {
  const parsed = parseFrontmatter('# Just a body\n')
  assert.equal(parsed.present, false)
  assert.equal(parsed.fields.length, 0)
  assert.equal(parsed.body, '# Just a body\n')
})

test_('a leading BOM does not hide the frontmatter block', () => {
  const parsed = parseFrontmatter(BOM + SAMPLE)
  assert.equal(parsed.present, true, 'the delimiter must still be found')
  assert.equal(fieldValue(parsed.fields, 'name'), 'security-audit')
  assert.equal(stripBom(BOM + 'x'), 'x')
  assert.equal(stripBom('x'), 'x')
  assert.equal(stripBom(''), '')
})

test_('reads the canonical boolean spellings', () => {
  const fields = parseFrontmatter([
    '---',
    'a: true',
    'b: "yes"',
    'c: 1',
    'd: off',
    'e: false',
    'f: maybe',
    '---',
    '',
  ].join('\n')).fields
  assert.equal(fieldBoolean(fields, 'a'), true)
  assert.equal(fieldBoolean(fields, 'b'), undefined, 'quoted values are not coerced here')
  assert.equal(fieldBoolean(fields, 'c'), true)
  assert.equal(fieldBoolean(fields, 'd'), false)
  assert.equal(fieldBoolean(fields, 'e'), false)
  assert.equal(fieldBoolean(fields, 'f'), undefined)
  assert.equal(fieldBoolean(fields, 'missing'), undefined)
})

test_('unquotes scalar values and exposes the raw spelling separately', () => {
  const fields = parseFrontmatter(['---', 'q: "two words"', 's: \'single\'', '---', ''].join('\n')).fields
  assert.equal(fieldValue(fields, 'q'), 'two words')
  assert.equal(fieldValue(fields, 's'), 'single')
  assert.equal(fieldRaw(fields, 'q'), '"two words"')
})

test_('derives the invocation policy from the two canonical fields', () => {
  const policy = (lines) => invocationOf(parseFrontmatter(['---', ...lines, '---', ''].join('\n')).fields)
  assert.deepEqual(policy([]), { modelInvocable: true, userInvocable: true })
  assert.deepEqual(policy([`${FIELD_MODEL}: true`]), { modelInvocable: false, userInvocable: true })
  assert.deepEqual(policy([`${FIELD_USER}: false`]), { modelInvocable: true, userInvocable: false })
  assert.deepEqual(policy([`${FIELD_MODEL}: true`, `${FIELD_USER}: false`]), { modelInvocable: false, userInvocable: false })
  assert.equal(blockedByFrontmatter(parseFrontmatter(['---', `${FIELD_MODEL}: true`, '---', ''].join('\n')).fields), true)
  assert.equal(blockedByFrontmatter(parseFrontmatter(SAMPLE).fields), false)
})

test_('editing replaces a value in place and preserves every other byte', () => {
  const next = editFrontmatter(SAMPLE, { [FIELD_MODEL]: `${FIELD_MODEL}: true` })
  const expected = SAMPLE.replace(`${FIELD_MODEL}: false`, `${FIELD_MODEL}: true`)
  assert.equal(next, expected, 'only the target line changed')
  assert.equal(next.match(/^---$/gm).length, 2)
})

test_('editing appends a missing field without reordering existing ones', () => {
  const next = editFrontmatter(SAMPLE, { [FIELD_USER]: `${FIELD_USER}: false` })
  const lines = next.split('\n')
  assert.deepEqual(lines.slice(0, 7), [
    '---',
    'name: security-audit',
    'description: Audit a change for injection, secret handling, and unsafe defaults.',
    'whenToUse: Use when reviewing code that touches input handling.',
    'disable-model-invocation: false',
    'user-invocable: false',
    '---',
  ])
})

test_('a null plan entry removes the field and leaves the rest alone', () => {
  const next = editFrontmatter(SAMPLE, { [FIELD_MODEL]: null })
  assert.doesNotMatch(next, /disable-model-invocation/)
  assert.match(next, /name: security-audit/)
  assert.match(next, /whenToUse: Use when reviewing/)
  assert.match(next, /# Security audit/)
})

test_('a rewrite is byte-for-byte lossless when nothing changes', () => {
  // Applying an empty plan must not touch the document at all.
  assert.equal(editFrontmatter(SAMPLE, {}), SAMPLE)
})

test_('a BOM file never gains a second frontmatter block', () => {
  // Regression: discovery stripped the BOM but the writer did not, so the
  // writer missed the existing block and prepended a new one, burying `name`
  // and `description` in the body of the file.
  const damaged = BOM + SAMPLE
  const next = editFrontmatter(damaged, { [FIELD_USER]: `${FIELD_USER}: false` })
  assert.equal(next.match(/^---$/gm).length, 2, 'exactly one frontmatter block')
  assert.equal((next.match(/^name:/gm) ?? []).length, 1, 'the name field moved, it was not duplicated')
  assert.doesNotMatch(next, /\uFEFF/, 'the BOM is gone, not buried in the body')

  const parsed = parseFrontmatter(next)
  assert.equal(fieldValue(parsed.fields, 'name'), 'security-audit')
  assert.equal(fieldValue(parsed.fields, 'description'), 'Audit a change for injection, secret handling, and unsafe defaults.')
  assert.equal(fieldValue(parsed.fields, FIELD_MODEL), 'false', 'an untouched field keeps its value')
  assert.equal(fieldValue(parsed.fields, FIELD_USER), 'false')
  assert.match(parsed.body, /# Security audit/)
})

test_('a file with no frontmatter gains one without losing content', () => {
  const body = '# Notes\n\nNo frontmatter here.\n'
  const next = editFrontmatter(body, { [FIELD_MODEL]: `${FIELD_MODEL}: true` })
  // The body now sits after an exported block, in the writer's canonical shape:
  // one blank line after the delimiter, no trailing blank line.
  assert.equal(next, `---\n${FIELD_MODEL}: true\n---\n\n# Notes\n\nNo frontmatter here.`)
  const parsed = parseFrontmatter(next)
  assert.equal(parsed.present, true)
  assert.equal(parsed.body, '\n# Notes\n\nNo frontmatter here.')
  assert.ok(next.includes('No frontmatter here.'), 'the content is still there')
})
test_('CRLF documents keep working', () => {
  // Build a genuinely CRLF document: one trailing CR per line, not a bare LF
  // followed by a CR.
  const crlf = SAMPLE.slice(0, -1).split('\n').map((line) => `${line}\r\n`).join('')
  const parsed = parseFrontmatter(crlf)
  assert.equal(parsed.present, true)
  assert.equal(fieldValue(parsed.fields, 'name'), 'security-audit', 'a trailing CR is not part of the value')
  assert.equal(fieldBoolean(parsed.fields, FIELD_MODEL), false, 'CRLF booleans parse too')
  const next = editFrontmatter(crlf, { [FIELD_MODEL]: `${FIELD_MODEL}: true` })
  assert.match(next, new RegExp(`${FIELD_MODEL}: true`))
  assert.equal(next.match(/^---\r?$/gm).length, 2)
  assert.match(parseFrontmatter(next).body, /# Security audit/)
})

test_('fields and blank lines survive a rewrite', () => {
  // Comments are the one thing a rewrite drops: the parser reads `key: value`
  // lines, so a `#` line is neither a field nor body. Unknown fields, blank
  // separators, and line order are all preserved.
  const document = [
    '---',
    'name: perf-review',
    'description: Review a hot path.',
    '',
    'custom-field: keep me',
    '---',
    '',
    'Body.',
    '',
  ].join('\n')
  const next = editFrontmatter(document, { [FIELD_USER]: `${FIELD_USER}: false` })
  assert.match(next, /custom-field: keep me/)
  assert.match(next, /name: perf-review/)
  assert.match(next, /^$/m, 'an author blank line between fields stays')
  assert.match(next, /Body\./)
  assert.equal(next.match(/^---$/gm).length, 2)
})

test_('removing the last field leaves a valid empty frontmatter block', () => {
  const single = ['---', 'name: only-field', '---', '', 'Body.', ''].join('\n')
  const next = editFrontmatter(single, { name: null })
  assert.equal(next, ['---', '---', '', 'Body.'].join('\n'))
  assert.equal(parseFrontmatter(next).present, true, 'an empty block is still frontmatter')
  assert.equal(parseFrontmatter(next).body, '\nBody.')
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
