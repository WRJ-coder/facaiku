# dsh-skill-manager

[English](README.en.md) | 中文

> DeepSeek Harness (DSH) 技能管理插件：把按分类摆放在磁盘上的技能整理成可管理的目录，并提供**单个技能**与**整个分类**的启用 / 屏蔽开关、`/skills` 斜杠指令，以及设置页里的图形化管理面板。

---

## 这个插件解决什么问题

DSH 自带的技能发现（`@deepseek-ai/dsh-skill-filesystem`）按**扁平**布局扫描根目录：`<root>/<skill>/SKILL.md` 或 `<root>/<name>.md`，并且**刻意不支持**嵌套的 `**/SKILL.md`（见该包 README）。

本插件补上的是"分类"这一层，以及围绕它的管理能力：

```
~/.dsh/skills/代码审查/security-audit/SKILL.md
              └─ 分类 ─┘└── 技能名 ──┘
```

- 分类名 = 技能的**父目录名**（上例为 `代码审查`），技能名 = `SKILL.md` frontmatter 里的 `name`。
- 管理面板按分类分组展示全部技能，含名称、描述、来源路径、启用 / 屏蔽状态。
- 屏蔽后的技能在**模型目录注入**和 **`/` 命令菜单**里完全不可见，但在管理面板中**仍然列出**（灰显），可随时恢复。
- 屏蔽名单持久化保存，重启后不丢失。

## 特性一览

| 能力 | 说明 |
|---|---|
| 分类分组目录 | 同时扫描用户级与项目级根目录，按分类合并展示 |
| 单技能开关 | 写入 SKILL.md frontmatter 的 `disable-model-invocation: true` 与 `user-invocable: false` |
| 分类级批量开关 | `/skills enable-group <分类>`、`/skills disable-group <分类>`，以及面板里的"屏蔽整组 / 启用整组" |
| 模型侧彻底不可见 | 技能提供方把被屏蔽技能的 `modelInvocable` 与 `userInvocable` 都置为 `false`，模型目录与 `/` 菜单都不会再出现它 |
| 管理面板仍可见 | 面板走独立数据通道，屏蔽状态只影响"可调用性"，不影响"可管理性" |
| 持久化 | 屏蔽记录写入 `$DSH_HOME/skills/.system/skill-manager/blocklist.json`，随进程重启保留 |
| 无损恢复 | 记录下屏蔽时**写入过哪些字段**以及字段原本的取值，启用时精确还原（原本没有该字段就删掉，原本有别的值就还原原值） |
| 斜杠指令 | `/skills` 九种子命令，见下文 |
| 设置页面板 | 注册到 `settings.section` 槽位，提供分类树、搜索框、单技能与分类级开关 |
| 内置函数 | 无需构建步骤：Host 与 Client 两半都是可直接加载的 JavaScript |

## 目录布局与扫描根目录

一个技能是**含 `SKILL.md` 的子文件夹**。插件默认扫描的根目录与 DSH 内置技能提供方完全一致，因此不会造出一个私有的技能宇宙：

| 根目录 | 说明 |
|---|---|
| `<项目根>/.dsh/skills` | 项目级；项目根 = 向上找到的第一个含 `.git` 的目录 |
| `<项目根>/.agents/skills` | 项目级（agents 兼容目录） |
| `~/.dsh/skills` | 用户级（即 `$DSH_HOME/skills`） |
| `~/.agents/skills` | 用户级（agents 兼容目录） |
| `bundledSkillDir` | 随包提供的技能目录（`$DSH_BUNDLED_SKILL_DIR`），默认只在 `includeDefaultRoots` 为真时启用 |

支持的布局：

```
<root>/<分类>/<技能名>/SKILL.md      ← 本插件的主布局
<root>/<技能名>/SKILL.md            ← 无分类的退化布局，分类记为技能自身
<root>/<技能名>.md                  ← 扁平技能，分类记为 (uncategorized)
<root>/<分类>/<技能名>.md           ← 分类下的扁平技能
```

以 `.` 开头的目录会被跳过，因此插件自己的状态目录 `~/.dsh/skills/.system/` 永远不会出现在分类列表里。

## 安装

### 方式一：用 DSH 自带插件管理器（推荐）

在 DSH 会话里让 agent 调用 `plugin_manager`：

```jsonc
// action: install_bundle, target: 本仓库的绝对路径
{ "action": "install_bundle", "target": "D:/path/to/dsh-skill-manager" }
```

它会把本包加入当前 profile 的 `dsh.profile.bundles` 与 `dependencies`（以 `link:` 或 npm 规格记录），随后 bundle patch 自动生效。

### 方式二：手工写 profile 补丁

把包放到 profile 的 `node_modules` 下（或用 `pnpm add` 装进 profile），然后在 `<profile>/cordis.patch.yml` 追加：

```yaml
- id: skill-manager
  name: 'dsh-skill-manager'
```

### 方式三：从 GitHub / npm 安装

```bash
dsh plugin add "github:<owner>/dsh-skill-manager"
# 或
dsh plugin add "dsh-skill-manager"
```

装好后**浏览器需要刷新一次**：Client 半边是随页面加载的模块，Host 半边才走 profile 补丁。

## 斜杠指令

| 指令 | 作用 |
|---|---|
| `/skills` | 列出所有分类及状态（技能数、已屏蔽数） |
| `/skills group <分类名>` | 查看分类详情（逐个技能的状态、描述、不可用原因） |
| `/skills enable <分类名>/<技能名>` | 启用单个技能 |
| `/skills disable <分类名>/<技能名>` | 屏蔽单个技能 |
| `/skills enable-group <分类名>` | 批量启用整个分类 |
| `/skills disable-group <分类名>` | 批量屏蔽整个分类 |
| `/skills run <分类名>/<技能名>` | 手动调用技能：把技能正文作为一条 `<skill_content>` 用户消息注入本会话，模型随即按该技能指令工作 |
| `/skills blocked` | 列出所有已屏蔽技能及其路径 |

分类名含 `/` 时按**最后一个** `/` 切分，因此 `文档/子类/api-doc` 也能正确解析。

## 屏蔽是怎么生效的

屏蔽是双层的，任何一层单独存在也成立：

1. **frontmatter**：把两个规范字段写进 SKILL.md。即使读这个文件的是从未听说过本插件的实现，技能也照样被屏蔽。

   ```yaml
   ---
   name: security-audit
   description: ...
   disable-model-invocation: true
   user-invocable: false
   ---
   ```

   写入是**保序的行级手术**：未知字段、字段顺序、注释、正文全部原样保留。

2. **屏蔽名单**：`$DSH_HOME/skills/.system/skill-manager/blocklist.json` 记录每个被屏蔽技能的路径、根类型、屏蔽时间，以及**本插件写入过哪些字段**和**这些字段原本的值**。

   启用时按记录精确还原：本插件写过的字段才动；原本不存在就删除该行，原本是别的值（例如 `disable-model-invocation: false`）就还原原值。

为什么还需要第二层？因为 SKILL.md 可能被用户或别的工具改写。只要还在名单里，本插件的技能提供方就会把该技能的 `invocation` 强制为 `{ modelInvocable: false, userInvocable: false }`，模型目录与 `/` 菜单都不会再出现它。

### 与 DSH 技能注册表的关系

本插件注册的是 `ctx.skills.registerProvider()` 的一个提供方，rank 为 `10`，**低于** DSH 内置文件系统提供方的最低 rank（`100`）。在同一个注册层里 rank 小者优先，因此：

- 对本插件认识的技能，本插件的策略生效（这正是不依赖 frontmatter 也能屏蔽的原因）；
- 对其余任何技能，内置提供方照旧胜出，本插件不会扩大或改变发现范围。

本插件**不覆盖任何其他插件的实现**，只使用官方的 `skills`、`commands`、`webServer` 服务与 `settings.section` 槽位。

## 配置

`Config` 会在加载时校验；在 profile 补丁里按需覆盖即可：

```yaml
- id: skill-manager
  name: 'dsh-skill-manager'
  config:
    rank: 10
    includeDefaultRoots: true
    customSkillDirs:
      - 'D:/team-shared/skills'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `skill-manager` | 注册到 `ctx.skills` 的提供方名称（内部使用，不面向用户） |
| `rank` | `10` | 提供方优先级；需低于 DSH 内置文件系统提供方的最低 rank（100）才能覆盖其策略 |
| `includeDefaultRoots` | `true` | 是否扫描项目级、用户级与随包根目录；关闭后只留 `customSkillDirs` |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 用户级根目录（`<dshHome>/skills`） |
| `agentsHome` | `$DSH_AGENTS_HOME` 或 `~/.agents` | agents 兼容根目录（`<agentsHome>/skills`） |
| `projectSkillDirs` | `['.dsh/skills', '.agents/skills']` | 相对项目根的技能目录 |
| `customSkillDirs` | `[]` | 额外根目录（绝对路径） |
| `bundledSkillDir` | `$DSH_BUNDLED_SKILL_DIR` | 随包技能目录 |
| `statePath` | `<dshHome>/skills/.system/skill-manager/blocklist.json` | 屏蔽名单文件 |
| `projectMarker` | `.git` | 判定项目根的标记文件 |

## 设置页面板

在 **设置 → 技能管理**（`settings.section`，order 18）：

- 顶栏：搜索框（匹配技能名、描述、分类名、路径）、统计（技能总数 / 已屏蔽数）、刷新按钮；
- 每个分类一张卡片：分类名、来源类型（project / user / custom / bundled）、技能数、状态徽标（整组已启用 / 部分屏蔽 / 整组已屏蔽）、"屏蔽整组 / 启用整组"按钮，可折叠；
- 每个技能一行：名称、状态徽标、描述、路径、开关；被屏蔽时整行灰显并给名称加删除线，但**始终可操作**以便恢复；
- 底部列出实际扫描的根目录，便于排查"技能为什么没出现"。

面板数据与操作走本插件自己的两条 Host 路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/skill-manager/panel/state` | GET | 返回分类树（可带 `?cwd=<工作目录>` 以包含项目级技能） |
| `/skill-manager/panel/set` | POST | `{ category, skill?, enabled, cwd? }`；省略 `skill` 即整组操作 |

这两条路由不在 `/api` 前缀内，因此不享受 DSH 的连接层鉴权；插件在处理器内部自行执行同源校验：`Host` 权威必须是回环地址（`127.0.0.1` / `localhost` / `[::1]`），`Sec-Fetch-Site: cross-site` 一律拒绝，携带 `Origin` 时必须与 `Host` 相同。

## 代码结构

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半边：目录扫描、屏蔽名单持久化、技能提供方、`/skills` 指令、管理路由 |
| `lib/frontmatter.js` | SKILL.md frontmatter 的读写（零依赖，可独立单测）：保序行级编辑、BOM 容错、调用策略解析 |
| `client.js` | Client 半边：`settings.section` 注册与管理面板 UI（React，仅用宿主主题变量，不导入任何 DSH Client 包） |
| `tests/frontmatter.test.mjs` | frontmatter 单元测试（15 项），可在任何 Node 环境运行 |
| `tests/smoke.test.mjs` | 行为测试（9 项）：发现、屏蔽、恢复、持久化、`/skills` 指令、分类级批量开关 |
| `cordis.patch.yml` | bundle 补丁：插入一行 Host 插件，loader id 为 `skill-manager` |
| `dsh.plugin.json` | 插件清单（id / 显示名 / 描述 / 导出 / 平台） |
| `locale/*.json` | 插件管理器卡片上的显示文案（zh / en） |
| `icon.svg` | 插件图标 |

### id 一致性

`cordis.patch.yml` 里的 loader id、`dsh.plugin.json` 的 `id`，以及 `index.js` 导出的 `name`，三处都是同一个值：

```
skill-manager
```

### 本地校验

无需构建，只要保证两半都是合法 JavaScript：

```bash
npm run check            # node --check index.js && client.js && lib/frontmatter.js
npm run test:frontmatter # frontmatter 单元测试，任何 Node 环境可跑
npm test                 # 全部测试（行为测试需要能解析 @deepseek-ai/* 的环境）
npm run pack:dry         # 预览将要发布到 npm 的文件
```

`tests/frontmatter.test.mjs` 只依赖 `lib/frontmatter.js`，因此在任何装有 Node 的地方都能运行；
`tests/smoke.test.mjs` 需要 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-home-paths` 可解析，
请在 DSH 安装目录或装有这些包的 profile 中运行。两个测试文件都支持直接 `node <file>` 执行（在进程内跑完所有断言），
以便在禁止 `node --test` 派生子进程的受限环境中使用。

## 已知边界

- **分类名 = 父目录名**：同一技能名出现在不同分类下是两个独立条目，互不影响；面板与指令都用 `<分类>/<技能名>` 定位。
- **rank 语义**：如果将来某个内置提供方的 rank 低于 10，它对重名技能的裁决会优先于本插件，届时本插件对"重名且被屏蔽"的强制力会下降——把 `config.rank` 调到更低即可。
- **不改写非本插件写入的字段**：只有"本插件写入过"的字段才会在启用时被还原；若屏蔽后有人手工改了这两个字段，启用时会按记录还原而不是保留手工改动。
- **`user-invocable: false` 是连带的**：规范要求屏蔽时同时写这两个字段，因此恢复时两个字段一起处理。

## 许可

[MIT](LICENSE)
