/**
 * SKILL.md frontmatter reading and writing.
 *
 * This module is deliberately dependency-free so it can be unit tested without
 * a DSH installation, and so the two rules that matter most live in one place:
 *
 * 1. **Byte fidelity.** Editing frontmatter must never disturb anything it does
 *    not own: unknown fields, field order, comments, blank lines, and the whole
 *    body survive the rewrite. Discovery and editing parse with the same
 *    function, so they can never disagree about a file's shape.
 * 2. **BOM tolerance.** A UTF-8 BOM is legal in a hand-edited Markdown file
 *    (Windows Notepad writes one). It must not hide the frontmatter delimiter;
 *    treating it as content used to make the writer prepend a *second*
 *    frontmatter block and bury the skill's `name` and `description` in the
 *    body.
 *
 * @module dsh-skill-manager/frontmatter
 */

/** Canonical frontmatter field that disables model invocation. */
export const FIELD_MODEL = 'disable-model-invocation'

/** Canonical frontmatter field that disables user invocation. */
export const FIELD_USER = 'user-invocable'

/** Remove a leading UTF-8 BOM, leaving every other byte untouched. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Split a SKILL.md document into its YAML frontmatter lines and its body.
 * @param {string} raw - complete file text, with or without a leading BOM.
 * @returns {{ fields: Array<{ key: string, line: string }>, body: string, present: boolean }}
 *   frontmatter lines in file order, the untouched body, and whether a
 *   well-formed frontmatter block was found.
 */
export function parseFrontmatter(raw) {
  const text = stripBom(raw)
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return { fields: [], body: text, present: false }
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return { fields: [], body: text, present: false }
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const bodyStart = nextNewline < 0 ? text.length : nextNewline + 1
      const fields = []
      for (const raw of text.slice(start, lineStart).split('\n')) {
        // A CRLF document leaves a CR in front of each line feed; the field
        // line recorded is the line without it, so every reader sees one shape.
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line.trim().length === 0) continue
        const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
        if (match === null) continue
        fields.push({ key: match[1], line })
      }
      return { fields, body: text.slice(bodyStart), present: true }
    }
    if (nextNewline < 0) return { fields: [], body: text, present: false }
    lineStart = nextNewline + 1
  }
  return { fields: [], body: text, present: false }
}

/** Raw right-hand side of one frontmatter field, or undefined when absent. */
export function fieldRaw(fields, key) {
  const entry = fields.find((candidate) => candidate.key === key)
  if (entry === undefined) return undefined
  return entry.line.slice(entry.line.indexOf(':') + 1).trim()
}

/**
 * One frontmatter scalar with YAML's own quoting undone and a trailing CR
 * dropped, so a CRLF document reads exactly like an LF one.
 * @param {Array<{ key: string, line: string }>} fields - parsed frontmatter lines.
 * @param {string} key - exact field name.
 * @returns {string | undefined} the unquoted value, or undefined when absent.
 */
export function fieldValue(fields, key) {
  const raw = fieldRaw(fields, key)
  if (raw === undefined) return undefined
  const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * One boolean frontmatter field, accepting the same spellings as the shipped
 * provider; an unparseable value reads as absent rather than throwing.
 */
export function fieldBoolean(fields, key) {
  const raw = fieldRaw(fields, key)
  if (raw === undefined) return undefined
  if (raw === 'true' || raw === '1' || /^(yes|on)$/i.test(raw)) return true
  if (raw === 'false' || raw === '0' || /^(no|off)$/i.test(raw)) return false
  return undefined
}

/** The invocation policy a frontmatter document expresses. */
export function invocationOf(fields) {
  return {
    modelInvocable: fieldBoolean(fields, FIELD_MODEL) !== true,
    userInvocable: fieldBoolean(fields, FIELD_USER) !== false,
  }
}

/** Whether a document is blocked by its own frontmatter alone. */
export function blockedByFrontmatter(fields) {
  return fieldBoolean(fields, FIELD_MODEL) === true || fieldBoolean(fields, FIELD_USER) === false
}

/**
 * Normalize a body to the one shape the writer emits: exactly one blank line
 * between the closing delimiter and the first content line, and no trailing
 * blank lines. The body's content is never altered.
 * @param {string} body - the document text after the closing delimiter.
 * @returns {string} `''` for an empty body, else `'\n'` plus the content lines.
 */
function normalizeBody(body) {
  const lines = body.split('\n')
  while (lines.length > 0 && lines[0].replace(/\r$/, '') === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].replace(/\r$/, '') === '') lines.pop()
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`
}

/**
 * Rebuild a document from field lines and a body.
 * @param {string[]} lines - exact frontmatter lines to keep, in order.
 * @param {string} body - text after the closing delimiter.
 * @returns {string} the complete document.
 */
function renderDocument(lines, body) {
  return ['---', ...lines, '---', normalizeBody(body)].join('\n')
}

/**
 * Apply a field plan to one SKILL.md text.
 *
 * The rewrite is lossless in both directions: the body is preserved byte for
 * byte (minus the blank lines that belonged to the delimiter), and every field
 * the plan does not name keeps its exact source line, position included.
 * Running a block/enable cycle over the same file therefore returns the
 * original bytes.
 *
 * A field the plan adds lands after the fields it does not touch, which keeps
 * every existing line where the author put it.
 *
 * @param {string} raw - current file text, with or without a leading BOM.
 * @param {Record<string, string | null>} plan - field name to replacement
 *   `key: value` line, or null to remove that field.
 * @returns {string} the rewritten document, without a BOM.
 */
export function editFrontmatter(raw, plan) {
  const text = stripBom(raw)
  const parsed = parseFrontmatter(text)
  if (!parsed.present) {
    const additions = Object.entries(plan)
      .filter(([, line]) => line !== null)
      .map(([, line]) => line)
    if (additions.length === 0) return text
    return renderDocument(additions, text)
  }
  const lines = []
  const placed = new Set()
  for (const entry of parsed.fields) {
    if (!Object.hasOwn(plan, entry.key)) {
      lines.push(entry.line)
      continue
    }
    placed.add(entry.key)
    const replacement = plan[entry.key]
    if (replacement !== null) lines.push(replacement)
  }
  // Fields the document did not carry yet are appended, so no existing line
  // moves and the result still reads top-to-bottom in the author's order.
  for (const [key, line] of Object.entries(plan)) {
    if (line === null || placed.has(key)) continue
    lines.push(line)
  }
  return renderDocument(lines, parsed.body)
}
