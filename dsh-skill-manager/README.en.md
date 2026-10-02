# dsh-skill-manager

English | [中文](README.md)

> A DeepSeek Harness (DSH) plugin that turns category-organized skill folders on disk into a manageable catalog, with **per-skill** and **per-category** enable/block switches, `/skills` slash commands, and a graphical panel inside Settings.

---

## What it solves

DSH's shipped discovery (`@deepseek-ai/dsh-skill-filesystem`) scans **flat** roots only: `<root>/<skill>/SKILL.md` or `<root>/<name>.md`. Nested `**/SKILL.md` is deliberately unsupported (see that package's README).

This plugin adds the missing *category* level and the management around it:

```
~/.dsh/skills/代码审查/security-audit/SKILL.md
              └ category ┘└─ skill name ─┘
```

- The category is the skill's **parent folder name** (`代码审查` above); the skill name is the `name` field in `SKILL.md`'s frontmatter.
- The panel groups every skill by category and shows name, description, source path, and enable/block status.
- A blocked skill is invisible in the **model catalog injection** and in the **`/` menu**, but stays listed (greyed out) in the panel so it can be restored at any time.
- The blocklist is persisted and survives a restart.

## Features

| Capability | Detail |
|---|---|
| Category-grouped catalog | Scans user-level and project-level roots, merged for display by category |
| Per-skill switch | Writes `disable-model-invocation: true` and `user-invocable: false` into `SKILL.md` |
| Per-category batch switch | `/skills enable-group <category>`, `/skills disable-group <category>`, plus the panel's *Block all / Enable all* |
| Truly invisible to the model | The provider forces both `modelInvocable` and `userInvocable` to `false`, so neither the model catalog nor the `/` menu lists the skill |
| Still visible in the panel | The panel uses its own data route; blocking only affects *invocability*, not *manageability* |
| Persistence | The blocklist lives at `$DSH_HOME/skills/.system/skill-manager/blocklist.json` |
| Lossless restore | Records **which fields this plugin wrote** and their prior values, so enabling restores exactly (deletes a field that did not exist, restores the old value of one that did) |
| Slash commands | Nine `/skills` subcommands, listed below |
| Settings panel | Registered into the `settings.section` slot: category tree, search box, per-skill and per-category switches |
| No build step | Both halves are plain loadable JavaScript |

## Layout and scanned roots

A skill is a **directory containing `SKILL.md`**; a directory without one is a **category container** the scan descends into. A skill directory's path relative to its scanned root, **with the final segment removed**, is its category path.

| Layout on disk | Category path | Skill name |
|---|---|---|
| `<root>/分类A/SKILL.md` | `(uncategorized)` | the frontmatter `name` |
| `<root>/分类A/技能B/SKILL.md` | `分类A` | `技能B` |
| `<root>/分类A/子分类C/技能D/SKILL.md` | `分类A/子分类C` | `技能D` |
| `<root>/分类A/子分类C/子子分类E/技能F/SKILL.md` | `分类A/子分类C/子子分类E` | `技能F` |
| `<root>/技能G.md` | `(uncategorized)` | `技能G` |
| `<root>/分类A/技能H.md` | `分类A` | `技能H` |

Category paths are always joined with `/`, identically on every platform.

**Depth** is governed by two config fields:

- `maxDepth` (default 4) — scan at most four levels below a scanned root. `<root>/A/B/C/<skill>/SKILL.md` sits at level 4 and is found; a skill at level 5 is not scanned, and the pruned directories are reported in the panel footer as "skipped because they exceed the scan depth".
- `maxCategoryDepth` (default 3) — report at most three category levels as tree nodes. A deeper category path is **still discovered and still manageable**; it is attributed to its third-level ancestor, while the skill entry keeps the whole path in `fullCategoryPath` and sets `truncated: true`.

The scanned roots match DSH's shipped provider exactly, so this plugin never invents a private skill universe:

| Root | Meaning |
|---|---|
| `<project>/.dsh/skills` | Project-level; the project root is the nearest ancestor containing `.git` |
| `<project>/.agents/skills` | Project-level (agents-compatible) |
| `~/.dsh/skills` | User-level (`$DSH_HOME/skills`) |
| `~/.agents/skills` | User-level (agents-compatible) |
| `bundledSkillDir` | Packaged skills (`$DSH_BUNDLED_SKILL_DIR`), only when `includeDefaultRoots` is true |

Entries starting with `.` are skipped, so the plugin's own state directory `~/.dsh/skills/.system/` never shows up in the tree.

## Installation

### 1. Through DSH's own Plugin Manager (recommended)

In a DSH session, have the agent call `plugin_manager`:

```jsonc
// action: install_bundle, target: absolute path of this repository
{ "action": "install_bundle", "target": "D:/path/to/dsh-skill-manager" }
```

That records the package in the profile's `dsh.profile.bundles` and `dependencies` (as a `link:` or npm specifier) and the bundle patch takes effect.

### 2. By writing the profile patch yourself

Put the package into the profile's `node_modules` (or `pnpm add` it into the profile), then append to `<profile>/cordis.patch.yml`:

```yaml
- id: skill-manager
  name: 'dsh-skill-manager'
```

### 3. From GitHub / npm

```bash
dsh plugin add "github:<owner>/dsh-skill-manager"
# or
dsh plugin add "dsh-skill-manager"
```

Refresh the browser once afterwards: the Client half is a page-loaded module, while the Host half arrives through the profile patch.

## Slash commands

| Command | Effect |
|---|---|
| `/skills` | List top-level categories with subtree counts |
| `/skills tree [levels]` | Print the category tree, indented, optionally limited to N levels (1–6, default 2) |
| `/skills group <categoryPath>` | Show that category: its direct skills plus child categories with counts |
| `/skills enable <categoryPath>/<skill>` | Enable one skill |
| `/skills disable <categoryPath>/<skill>` | Block one skill |
| `/skills enable-group <categoryPath> [--recursive]` | Enable a category; `--recursive` includes its subcategories |
| `/skills disable-group <categoryPath> [--recursive]` | Block a category; `--recursive` includes its subcategories |
| `/skills run <categoryPath>/<skill>` | Manually invoke: injects the skill body into this session as a `<skill_content>` user message |
| `/skills blocked` | List every blocked skill with its path |
| `/skills panel` | Explain how to open the graphical panel |

A target is split on the **last** `/`, so `代码/审查/security-audit` resolves to category `代码/审查` and skill `security-audit`; a category name containing `/` works too. A category-level batch operation touches only that category's **direct** skills unless `--recursive` is given.

## How blocking works

Blocking is twofold; either layer stands on its own:

1. **Frontmatter** — the two canonical fields are written into `SKILL.md`. Even a reader that has never heard of this plugin will keep the skill blocked.

   ```yaml
   ---
   name: security-audit
   description: ...
   disable-model-invocation: true
   user-invocable: false
   ---
   ```

   The write is an order-preserving line edit: unknown fields, field order, comments, and the body survive byte for byte.

2. **Blocklist** — `$DSH_HOME/skills/.system/skill-manager/blocklist.json` records each blocked skill's path, root kind, timestamp, **which fields this plugin wrote**, and their prior values.

   Enabling restores exactly: only fields this plugin wrote are touched, and a field that did not exist is removed while one that had another value (`disable-model-invocation: false`, say) gets that value back.

Why the second layer? Because `SKILL.md` can be rewritten by a user or another tool. As long as the entry is in the blocklist, this plugin's provider forces that skill's `invocation` to `{ modelInvocable: false, userInvocable: false }`, so neither the model catalog nor the `/` menu can list it.

### Relationship to DSH's skill registry

The plugin registers one `ctx.skills.registerProvider()` provider at rank `10`, **below** the lowest rank of DSH's shipped filesystem provider (`100`). Lower rank wins within one registry layer, so:

- for the skills this plugin knows, its policy wins — which is exactly why blocking does not depend on the frontmatter write;
- for every other skill, the shipped provider still wins and this plugin neither widens nor changes discovery.

The plugin **overrides no other plugin's implementation**; it uses only the official `skills`, `commands`, and `webServer` services and the `settings.section` slot.

## Configuration

`Config` is validated at load time; override it from the profile patch:

```yaml
- id: skill-manager
  name: 'dsh-skill-manager'
  config:
    rank: 10
    includeDefaultRoots: true
    customSkillDirs:
      - 'D:/team-shared/skills'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `skill-manager` | Provider name on `ctx.skills` (internal) |
| `rank` | `10` | Provider precedence; must stay below the shipped filesystem provider's lowest rank (100) to override its policy |
| `maxDepth` | `4` | Deepest level scanned below a root (level 4 is a skill directory) |
| `maxCategoryDepth` | `3` | Deepest category path reported as its own node; deeper skills stay manageable, attributed to that ancestor and flagged `truncated` |
| `includeDefaultRoots` | `true` | Scan project-level, user-level, and bundled roots; when false only `customSkillDirs` remain |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | User-level root (`<dshHome>/skills`) |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Agents-compatible root (`<agentsHome>/skills`) |
| `projectSkillDirs` | `['.dsh/skills', '.agents/skills']` | Skill directories relative to the project root |
| `customSkillDirs` | `[]` | Extra absolute roots |
| `bundledSkillDir` | `$DSH_BUNDLED_SKILL_DIR` | Packaged skill directory |
| `statePath` | `<dshHome>/skills/.system/skill-manager/blocklist.json` | Blocklist file |
| `projectMarker` | `.git` | Marker that identifies a project root |

## Settings panel

Under **Settings → Skill Manager** (`settings.section`, order 18):

- Header: search box (matches skill name, description, category, and path), counts (total skills / blocked), refresh button.
- One card per category: name, source kind (project / user / custom / bundled), skill count, a status chip (*all enabled* / *partly blocked* / *all blocked*), a *Block all / Enable all* button, and a collapse toggle.
- One row per skill: name, status chip, description, path, and a switch. A blocked row is greyed with a struck-through name but stays fully operable so it can be restored.
- A footer lists the roots actually scanned, which is the fastest way to answer "why is my skill missing".

The panel reads and writes through two Host routes of this plugin:

| Route | Method | Purpose |
|---|---|---|
| `/skill-manager/panel/state` | GET | Returns the category tree (optionally `?cwd=<dir>` to include project-level skills) |
| `/skill-manager/panel/set` | POST | `{ category, skill?, enabled, cwd? }`; omitting `skill` acts on the whole category |

These two routes sit outside the `/api` prefix and therefore do not inherit DSH's connection-layer authentication. The handler applies its own same-origin rule: the `Host` authority must be loopback (`127.0.0.1` / `localhost` / `[::1]`), `Sec-Fetch-Site: cross-site` is refused outright, and a present `Origin` must equal `Host`.

## Code map

| File | Responsibility |
|---|---|
| `index.js` | Host half: root scanning, blocklist persistence, the skill provider, the `/skills` command, and the management routes |
| `lib/frontmatter.js` | SKILL.md frontmatter read/write, dependency-free and independently testable: order-preserving line edits, BOM tolerance, invocation-policy parsing |
| `client.js` | Client half: the `settings.section` registration and panel UI (React, host theme variables only, no DSH Client package imports) |
| `tests/frontmatter.test.mjs` | 15 frontmatter unit tests, runnable on any Node |
| `tests/smoke.test.mjs` | 9 behavioural tests: discovery, blocking, restoring, persistence, the `/skills` command, category-level batch switches |
| `cordis.patch.yml` | Bundle patch inserting one Host row with loader id `skill-manager` |
| `dsh.plugin.json` | Plugin manifest (id / display name / description / exports / platforms) |
| `locale/*.json` | Plugin Manager card text (zh / en) |
| `icon.svg` | Plugin icon |

### One identifier in three places

The loader id in `cordis.patch.yml`, the `id` in `dsh.plugin.json`, and the `name` exported by `index.js` are the same value:

```
skill-manager
```

### Local checks

There is no build step; both halves only need to be valid JavaScript:

```bash
npm run check            # node --check index.js && client.js && lib/frontmatter.js
npm run test:frontmatter # frontmatter unit tests, any Node environment
npm test                 # everything (the behavioural suite needs @deepseek-ai/* resolvable)
npm run pack:dry         # preview the files npm would publish
```

`tests/frontmatter.test.mjs` imports only `lib/frontmatter.js`, so it runs wherever Node runs.
`tests/smoke.test.mjs` needs `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-home-paths` to resolve —
run it inside a DSH installation or a profile that has them. Both files also run directly
(`node <file>`), executing every assertion in-process, which is what a confined environment needs when
it refuses the child process `node --test` spawns.

## Known limits

- **Category = parent folder**: the same skill name under two categories is two independent entries; the panel and the commands both address `<category>/<skill>`.
- **Rank semantics**: if a future shipped provider registers below rank 10, it would win the merge for a duplicate name and this plugin's enforcement of a blocked duplicate would weaken — lower `config.rank` to restore it.
- **Only fields this plugin wrote are restored**: if someone edits the two fields by hand after blocking, enabling restores from the record rather than preserving that manual edit.
- **`user-invocable: false` comes along**: the spec requires both fields when blocking, so both are handled together on restore.

## License

[MIT](LICENSE)
