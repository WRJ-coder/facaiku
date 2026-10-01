# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-02

### Added

- Category-aware skill discovery: `<root>/<category>/<skill>/SKILL.md`, plus the
  degenerate `<root>/<skill>/SKILL.md`, flat `<root>/<skill>.md`, and
  `<root>/<category>/<skill>.md` layouts.
- Roots identical to `@deepseek-ai/dsh-skill-filesystem`: project `.dsh/skills`
  and `.agents/skills`, user `$DSH_HOME/skills` and `~/.agents/skills`, optional
  custom directories, and the bundled skill directory.
- One `ctx.skills` provider at rank 10 (below every shipped filesystem rank),
  which enforces a blocked skill's invocation policy without widening discovery
  for any other name.
- Per-skill and per-category enable/block operations that write
  `disable-model-invocation: true` and `user-invocable: false` with an
  order-preserving frontmatter edit.
- Durable blocklist at `$DSH_HOME/skills/.system/skill-manager/blocklist.json`
  that records which fields were written and their prior values, so restoring is
  lossless and survives a restart.
- `/skills` command with `group`, `enable`, `disable`, `enable-group`,
  `disable-group`, `run`, and `blocked` subcommands.
- Settings panel registered into `settings.section`: category tree, search,
  per-skill switches, per-category batch switches, blocked rows kept visible and
  operable.
- Management routes `/skill-manager/panel/state` and `/skill-manager/panel/set`
  with a loopback-and-same-origin check.
- Plugin metadata: `dsh.plugin.json` manifest, bundle patch, localised card text
  (`locale/zh.json`, `locale/en.json`), and an SVG icon.

### Notes

- No build step: both the Host and Client halves are plain JavaScript that the
  Harness loads directly.
- `lib/frontmatter.js` holds the SKILL.md reader/writer as a dependency-free
  module so the two rules that matter most live in one place and can be unit
  tested without a DSH installation: an editing pass must not disturb anything
  it does not own, and a UTF-8 BOM must not hide the frontmatter delimiter.
- A discovery pass treats a root child as a *category*, not a skill: it reads
  one level deeper. A directory holding its own `SKILL.md` is still accepted as
  the category-less form.

### Fixed

- Discovery now reads `<root>/<category>/<skill>/SKILL.md` instead of stopping
  at the category directory, which had reported each category as a single
  unusable skill and never surfaced the skills inside it.
- Blocking a BOM-prefixed `SKILL.md` no longer prepends a second frontmatter
  block; the writer strips the BOM exactly as discovery does, so the skill's
  `name` and `description` stay in the frontmatter instead of being buried in
  the body. Covered by `tests/frontmatter.test.mjs`.
- A rewrite no longer accumulates a blank line per edit, and a field the plan
  adds is appended instead of being silently dropped, so a block/enable cycle
  is byte-for-byte lossless.
- CRLF documents parse identically to LF ones (the trailing CR is not part of a
  field value).
