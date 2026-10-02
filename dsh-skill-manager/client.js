/**
 * Skill Manager — browser half.
 *
 * Registers one Settings section (设置 → 技能管理) that renders the category
 * **tree**, a search box, per-skill and per-category switches, and bulk actions.
 *
 * Data and every mutation travel through this plugin's own Host routes
 * (`/skill-manager/panel/state` and `/skill-manager/panel/set`).
 *
 * Panel behaviour worth knowing:
 *   - Categories nest arbitrarily; a node shows its subtree skill/blocked counts.
 *   - Collapse state lives in a module-level set, so it survives the section
 *     unmounting (switching settings pages) for the life of the page.
 *   - Only the first level opens by default, and a category holding more than
 *     `AUTO_COLLAPSE_SKILLS` direct skills also starts collapsed.
 *   - Searching (or "blocked only") filters the tree and force-opens every
 *     surviving branch.
 *   - A category with more than `PAGE_SIZE` direct skills pages its rows.
 *   - Blocked skills stay listed and greyed out so they can always be restored.
 *
 * @module dsh-skill-manager/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'skill-manager'
    const ROUTE_STATE = '/skill-manager/panel/state'
    const ROUTE_SET = '/skill-manager/panel/set'

    /** Rows rendered per page inside one category. */
    const PAGE_SIZE = 50

    /** A category with more than this many direct skills starts collapsed. */
    const AUTO_COLLAPSE_SKILLS = 50

    /** Collapse state shared by every mount of the settings section. */
    const collapsedState = new Set()
    let collapseInitialized = false

    const zh = {
      nav: '技能管理',
      title: '技能管理',
      intro: '按分类树查看全部技能，支持单个技能、单个分类以及整个子树的启用/屏蔽。屏蔽后的技能在模型目录与 / 菜单中不可见，但仍保留在此处以便随时恢复。',
      search: '搜索技能、分类或路径',
      refresh: '刷新',
      loading: '正在读取技能…',
      empty: '没有发现任何技能。请检查下方扫描的根目录。',
      noMatch: '没有匹配的技能。',
      enabled: '已启用',
      blocked: '已屏蔽',
      frontmatterBlocked: 'frontmatter 已屏蔽',
      enable: '启用',
      block: '屏蔽',
      enableAll: '启用本级',
      blockAll: '屏蔽本级',
      enableSubtree: '启用此分类及其子分类',
      blockSubtree: '屏蔽此分类及其子分类',
      skills: '个技能',
      blockedCount: '个已屏蔽',
      subtree: '含子分类',
      roots: '扫描的根目录',
      path: '路径',
      unusable: '不可用',
      failed: '技能管理接口失败',
      retry: '重试',
      allBlocked: '整组已屏蔽',
      allEnabled: '整组已启用',
      partial: '部分屏蔽',
      expandAll: '全部展开',
      collapseAll: '全部折叠',
      expandOne: '展开此分类',
      collapseOne: '折叠此分类',
      onlyBlocked: '只看已屏蔽',
      selected: '已选择',
      clearSelection: '取消选择',
      applyBlock: '屏蔽所选',
      applyEnable: '启用所选',
      showMore: '显示更多',
      remaining: '条未显示',
      depthPruned: '有目录因超出扫描深度被跳过',
      collapsePanel: '收起面板',
      expandPanel: '展开面板',
      panelSummary: '个技能',
      treeDepth: '显示层数',
      sortLabel: '排序',
      sortName: '名称',
      sortBlocked: '屏蔽优先',
      sortSkills: '技能数',
      loadingAction: '处理中…',
      subtreeHint: '（含子分类）',
    }

    const en = {
      nav: 'Skill Manager',
      title: 'Skill Manager',
      intro: 'Browse every skill in a category tree and switch a single skill, one category, or a whole subtree. A blocked skill is invisible in the model catalog and the / menu, yet stays listed here so it can be restored at any time.',
      search: 'Search skills, categories, or paths',
      refresh: 'Refresh',
      loading: 'Loading skills…',
      empty: 'No skills found. Check the scanned roots below.',
      noMatch: 'No matching skill.',
      enabled: 'enabled',
      blocked: 'blocked',
      frontmatterBlocked: 'blocked by frontmatter',
      enable: 'Enable',
      block: 'Block',
      enableAll: 'Enable this level',
      blockAll: 'Block this level',
      enableSubtree: 'Enable this category and its subcategories',
      blockSubtree: 'Block this category and its subcategories',
      skills: 'skills',
      blockedCount: 'blocked',
      subtree: 'with subcategories',
      roots: 'Scanned roots',
      path: 'path',
      unusable: 'unusable',
      failed: 'Skill Manager API failed',
      retry: 'Retry',
      allBlocked: 'All blocked',
      allEnabled: 'All enabled',
      partial: 'Partly blocked',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      expandOne: 'Expand this category',
      collapseOne: 'Collapse this category',
      onlyBlocked: 'Blocked only',
      selected: 'selected',
      clearSelection: 'Clear',
      applyBlock: 'Block selected',
      applyEnable: 'Enable selected',
      showMore: 'Show more',
      remaining: 'more not shown',
      depthPruned: 'Some folders were skipped because they exceed the scan depth',
      collapsePanel: 'Collapse panel',
      expandPanel: 'Expand panel',
      panelSummary: 'skills',
      treeDepth: 'Levels',
      sortLabel: 'Sort',
      sortName: 'Name',
      sortBlocked: 'Blocked first',
      sortSkills: 'Skill count',
      loadingAction: 'Working…',
      subtreeHint: '(incl. subcategories)',
    }

    /** Read the current workspace directory, tolerating an unavailable service. */
    function readCwd(ctx) {
      try {
        const workspaces = ctx.get('workspaces')
        if (workspaces === undefined) return undefined
        const snapshot = workspaces.getSnapshot?.() ?? workspaces.snapshot?.()
        const active = snapshot?.activeId ?? snapshot?.active
        if (typeof active === 'string' && typeof snapshot?.byId?.[active]?.path === 'string') return snapshot.byId[active].path
        if (typeof snapshot?.activePath === 'string') return snapshot.activePath
      } catch {
        // A workspace face that changes shape must not break the panel.
      }
      return undefined
    }

    /** One authenticated JSON call against this plugin's Host routes. */
    async function requestJson(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let payload
      try {
        payload = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    /**
     * Rebuild the category tree from the flat category list, so the panel also
     * works when the Host does not project a `tree` of its own.
     * @param {object[]} flat - flat category rows.
     * @returns {object[]} root nodes carrying `children`.
     */
    function buildTree(flat) {
      const nodes = flat.map((category) => ({
        key: category.key,
        kind: category.kind,
        path: category.path,
        name: category.name,
        depth: category.depth,
        skills: category.skills ?? [],
        totalSkills: category.totalSkills ?? (category.skills ?? []).length,
        blockedSkills: category.blockedSkills ?? 0,
        children: [],
      }))
      const byPath = new Map()
      for (const node of nodes) byPath.set(`${node.kind}\u0000${node.path}`, node)
      const roots = []
      for (const node of nodes) {
        if (node.depth === 0) {
          roots.push(node)
          continue
        }
        const cut = node.path.lastIndexOf('/')
        const parentPath = cut < 0 ? '' : node.path.slice(0, cut)
        const parent = byPath.get(`${node.kind}\u0000${parentPath}`)
        if (parent === undefined) roots.push(node)
        else parent.children.push(node)
      }
      return roots
    }

    /** Whether one skill survives the current filters. */
    function skillVisible(skill, node, needle, blockedOnly) {
      if (blockedOnly && !skill.blocked) return false
      if (needle.length === 0) return true
      if (node.name.toLowerCase().includes(needle)) return true
      if ((node.path ?? '').toLowerCase().includes(needle)) return true
      return `${skill.name} ${skill.description ?? ''} ${skill.path ?? ''}`.toLowerCase().includes(needle)
    }

    /**
     * Filter one tree node, dropping it when neither it nor its subtree matches.
     * @returns {object | undefined} `{ node, skills, children }` or undefined.
     */
    function filterNode(node, needle, blockedOnly) {
      const skills = (node.skills ?? []).filter((skill) => skillVisible(skill, node, needle, blockedOnly))
      const children = (node.children ?? [])
        .map((child) => filterNode(child, needle, blockedOnly))
        .filter((child) => child !== undefined)
      if (skills.length === 0 && children.length === 0) return undefined
      return { node, skills, children }
    }

    /** A themed switch matching the host's own toggle affordance. */
    function Switch({ checked, disabled, label, onToggle }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: label,
        disabled,
        onClick: onToggle,
        style: {
          appearance: 'none',
          border: 'none',
          padding: 0,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          background: 'none',
          display: 'inline-flex',
          alignItems: 'center',
        },
      }, h('span', {
        style: {
          position: 'relative',
          display: 'inline-block',
          width: 30,
          height: 18,
          borderRadius: 9,
          transition: 'background-color .15s',
          backgroundColor: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 14 : 2,
          width: 14,
          height: 14,
          borderRadius: 7,
          transition: 'left .15s',
          backgroundColor: 'var(--dsw-alias-bg-base)',
        },
      })))
    }

    /** One status chip. */
    function Chip({ tone, children }) {
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : tone === 'warn'
          ? 'var(--dsw-alias-state-warn-primary)'
          : tone === 'muted'
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-alias-state-success-primary)'
      return h('span', {
        style: {
          flex: 'none',
          fontSize: 12,
          lineHeight: '18px',
          padding: '0 6px',
          borderRadius: 4,
          color,
          border: `0.5px solid ${color}`,
        },
      }, children)
    }

    /** Shared button look. */
    function buttonStyle(primary) {
      return {
        appearance: 'none',
        height: 26,
        padding: '0 10px',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
        color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
        backgroundColor: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
        border: '0.5px solid var(--dsw-alias-border-l1)',
      }
    }

    /** The small select used by the toolbar. */
    const selectStyle = {
      height: 26,
      borderRadius: 6,
      fontSize: 12,
      color: 'var(--dsw-alias-label-primary)',
      backgroundColor: 'var(--dsw-alias-bg-layer-2)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
    }

    const PluginContext = React.createContext({ t: (key) => key })

    /** The Settings section: toolbar, tree, and footer. */
    function SkillManagerPanel() {
      const ctx = React.useContext(PluginContext)
      const t = ctx.t
      const [state, setState] = React.useState({ status: 'loading' })
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [blockedOnly, setBlockedOnly] = React.useState(false)
      const [sort, setSort] = React.useState('name')
      const [depthLimit, setDepthLimit] = React.useState(0)
      const [panelOpen, setPanelOpen] = React.useState(true)
      const [selected, setSelected] = React.useState(() => new Set())
      const [, setVersion] = React.useState(0)
      const [visibleCounts, setVisibleCounts] = React.useState({})
      const cwd = React.useMemo(() => readCwd(ctx), [ctx])

      const bump = React.useCallback(() => setVersion((value) => value + 1), [])

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: previous.data === undefined ? 'loading' : previous.status }))
        try {
          const url = cwd === undefined ? ROUTE_STATE : `${ROUTE_STATE}?cwd=${encodeURIComponent(cwd)}`
          const payload = await requestJson(url, { method: 'GET' })
          setState({ status: 'ready', data: payload })
        } catch (error) {
          setState({ status: 'error', error: String(error?.message ?? error) })
        }
      }, [cwd])

      React.useEffect(() => {
        load()
      }, [load])

      const call = React.useCallback(async (body) => {
        setBusy(true)
        try {
          const payload = await requestJson(ROUTE_SET, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd, ...body }),
          })
          setState({ status: 'ready', data: payload })
          setSelected(new Set())
        } catch (error) {
          setState({ status: 'error', error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [cwd])

      const toggleSkill = React.useCallback(
        (skill, enabled) => call({ category: skill.categoryPath ?? '', skill: skill.name, enabled }),
        [call],
      )

      const toggleCategory = React.useCallback((node, enabled, recursive) => {
        const body = { category: node.path ?? '', enabled, recursive }
        // A root node has no category path of its own; its `kind` names the root,
        // which is what the Host needs to address the whole scanned root.
        if (node.depth === 0) body.kind = node.kind
        return call(body)
      }, [call])

      const setCollapsed = React.useCallback((key, collapsed) => {
        if (collapsed) collapsedState.add(key)
        else collapsedState.delete(key)
        bump()
      }, [bump])

      const data = state.data
      const flat = data?.flatCategories ?? data?.categories ?? []
      const tree = React.useMemo(() => {
        const provided = data?.tree
        if (Array.isArray(provided) && provided.length > 0) return provided
        return buildTree(flat)
      }, [data, flat])

      // First data arrival: leave only the top level open. A very large category
      // also starts collapsed so one folder cannot flood the panel on open.
      if (!collapseInitialized && flat.length > 0) {
        for (const node of flat) {
          if (node.depth > 0 && (node.skills ?? []).length > AUTO_COLLAPSE_SKILLS) collapsedState.add(node.key)
        }
        collapseInitialized = true
      }

      const needle = query.trim().toLowerCase()
      const searchActive = needle.length > 0 || blockedOnly

      const view = React.useMemo(() => {
        const roots = tree
          .map((node) => filterNode(node, needle, blockedOnly))
          .filter((entry) => entry !== undefined)
        const sorted = [...roots]
        if (sort === 'skills') sorted.sort((left, right) => (right.node.totalSkills ?? 0) - (left.node.totalSkills ?? 0))
        else if (sort === 'blocked') sorted.sort((left, right) => (right.node.blockedSkills ?? 0) - (left.node.blockedSkills ?? 0))
        else sorted.sort((left, right) => String(left.node.name).localeCompare(String(right.node.name)))
        return sorted
      }, [tree, needle, blockedOnly, sort])

      const totals = React.useMemo(() => {
        let skills = 0
        let blocked = 0
        for (const node of flat) {
          if (node.depth !== 0) continue
          skills += node.totalSkills ?? 0
          blocked += node.blockedSkills ?? 0
        }
        return { skills, blocked }
      }, [flat])

      const expandAll = React.useCallback(() => {
        for (const node of flat) collapsedState.delete(node.key)
        bump()
      }, [flat, bump])

      const collapseAll = React.useCallback(() => {
        for (const node of flat) if (node.depth > 0) collapsedState.add(node.key)
        bump()
      }, [flat, bump])

      const selectSkill = React.useCallback((skill, checked) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (checked) next.add(skill.key)
          else next.delete(skill.key)
          return next
        })
      }, [])

      const applySelected = React.useCallback(async (enabled) => {
        const targets = flat
          .flatMap((node) => (node.skills ?? []).map((skill) => ({ node, skill })))
          .filter((entry) => selected.has(entry.skill.key))
        if (targets.length === 0) return
        setBusy(true)
        try {
          let latest
          for (const target of targets) {
            latest = await requestJson(ROUTE_SET, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                cwd,
                category: target.skill.categoryPath ?? target.node.path ?? '',
                skill: target.skill.name,
                enabled,
              }),
            })
          }
          if (latest !== undefined) setState({ status: 'ready', data: latest })
          setSelected(new Set())
        } catch (error) {
          setState({ status: 'error', error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [flat, selected, cwd])

      const renderSkill = (skill) => h('div', {
        key: skill.key,
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '7px 10px 7px 34px',
          opacity: skill.blocked ? 0.55 : 1,
          borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        },
      }, [
        h('input', {
          key: 'pick',
          type: 'checkbox',
          checked: selected.has(skill.key),
          disabled: busy || !skill.usable,
          'aria-label': `${t('selected')} ${skill.name}`,
          onChange: (event) => selectSkill(skill, event.target.checked),
          style: { marginTop: 3, flex: 'none' },
        }),
        h('div', { key: 'body', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('span', {
              key: 'name',
              style: { fontSize: 13, fontWeight: 600, textDecoration: skill.blocked ? 'line-through' : 'none' },
            }, skill.name),
            h(Chip, { key: 'chip', tone: skill.blocked ? 'muted' : 'ok' }, skill.blocked ? t('blocked') : t('enabled')),
            skill.frontmatterBlocked === true ? h(Chip, { key: 'fm', tone: 'warn' }, t('frontmatterBlocked')) : null,
            skill.usable === false ? h(Chip, { key: 'bad', tone: 'error' }, `${t('unusable')}: ${skill.defect}`) : null,
            skill.truncated === true ? h(Chip, { key: 'cut', tone: 'muted' }, t('subtreeHint')) : null,
          ]),
          (skill.description ?? '').length > 0
            ? h('div', { key: 'd', style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, skill.description)
            : null,
          h('div', {
            key: 'p',
            title: skill.path,
            style: {
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, `${t('path')}: ${skill.path ?? ''}`),
        ]),
        h(Switch, {
          key: 'sw',
          checked: !skill.blocked,
          disabled: busy || skill.usable === false,
          label: `${skill.blocked ? t('enable') : t('block')} ${skill.name}`,
          onToggle: () => toggleSkill(skill, skill.blocked),
        }),
      ])

      const renderNode = (entry) => {
        const { node, skills, children } = entry
        const direct = node.skills ?? []
        const directBlocked = direct.filter((skill) => skill.blocked).length
        const allBlocked = direct.length > 0 && directBlocked === direct.length
        const anyBlocked = directBlocked > 0 || (node.blockedSkills ?? 0) > 0
        const tone = allBlocked ? 'muted' : anyBlocked ? 'warn' : 'ok'
        const stateLabel = allBlocked ? t('allBlocked') : anyBlocked ? t('partial') : t('allEnabled')
        const isCollapsed = !searchActive && collapsedState.has(node.key)
        const visible = visibleCounts[node.key] ?? PAGE_SIZE
        const shown = skills.slice(0, visible)
        const hidden = skills.length - shown.length
        const exceededDepth = depthLimit > 0 && node.depth + 1 >= depthLimit
        const hasSubtree = children.length > 0
        const label = node.depth === 0 ? `[${node.kind}] ${node.name}` : node.name

        return h('section', {
          key: node.key,
          style: {
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            backgroundColor: 'var(--dsw-alias-bg-layer-1)',
            marginLeft: node.depth > 0 ? 12 : 0,
            overflow: 'hidden',
          },
        }, [
          h('div', {
            key: 'h',
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', flexWrap: 'wrap' },
          }, [
            h('button', {
              key: 'disclose',
              type: 'button',
              'aria-expanded': !isCollapsed,
              'aria-label': isCollapsed ? t('expandOne') : t('collapseOne'),
              title: isCollapsed ? t('expandOne') : t('collapseOne'),
              onClick: () => setCollapsed(node.key, !collapsedState.has(node.key)),
              style: {
                appearance: 'none',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 12,
                width: 18,
                padding: 0,
                flex: 'none',
              },
            }, isCollapsed ? '▸' : '▾'),
            h('span', { key: 'n', style: { fontSize: 13, fontWeight: 600 } }, label),
            h(Chip, { key: 'count', tone: 'muted' },
              `${node.totalSkills ?? direct.length} ${t('skills')}${hasSubtree ? ` · ${t('subtree')}` : ''}`),
            (node.blockedSkills ?? 0) > 0 ? h(Chip, { key: 'blocked', tone: 'warn' }, `${node.blockedSkills} ${t('blockedCount')}`) : null,
            direct.length > 0 ? h(Chip, { key: 's', tone }, stateLabel) : null,
            h('span', { key: 'spacer', style: { flex: 1 } }),
            direct.length > 0
              ? h('button', {
                  key: 'bulk',
                  type: 'button',
                  disabled: busy,
                  title: allBlocked ? t('enableAll') : t('blockAll'),
                  onClick: () => toggleCategory(node, allBlocked, false),
                  style: buttonStyle(false),
                }, allBlocked ? t('enableAll') : t('blockAll'))
              : null,
            hasSubtree
              ? h('button', {
                  key: 'bulkdeep',
                  type: 'button',
                  disabled: busy,
                  title: allBlocked ? t('enableSubtree') : t('blockSubtree'),
                  onClick: () => toggleCategory(node, allBlocked, true),
                  style: buttonStyle(false),
                }, allBlocked ? `⇊ ${t('enableAll')}` : `⇊ ${t('blockAll')}`)
              : null,
          ]),
          isCollapsed ? null : h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column' } }, [
            ...shown.map(renderSkill),
            hidden > 0
              ? h('div', {
                  key: 'more',
                  style: { padding: '7px 10px 7px 34px', borderTop: '0.5px solid var(--dsw-alias-border-l1)' },
                }, h('button', {
                  type: 'button',
                  onClick: () => setVisibleCounts((previous) => ({ ...previous, [node.key]: visible + PAGE_SIZE })),
                  style: buttonStyle(false),
                }, `${t('showMore')} (${hidden} ${t('remaining')})`))
              : null,
            ...(exceededDepth ? [] : children.map(renderNode)),
          ]),
        ])
      }

      if (!panelOpen) {
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' } }, [
          h('button', { key: 'open', type: 'button', onClick: () => setPanelOpen(true), style: buttonStyle(false) }, `▸ ${t('expandPanel')}`),
          h('span', { key: 'sum', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            `${totals.skills} ${t('panelSummary')} · ${totals.blocked} ${t('blockedCount')}`),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' } }, [
        h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 't', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 'title', style: { fontSize: 15, fontWeight: 600 } }, t('title')),
            h('button', {
              key: 'shrink',
              type: 'button',
              title: t('collapsePanel'),
              onClick: () => setPanelOpen(false),
              style: buttonStyle(false),
            }, `▾ ${t('collapsePanel')}`),
          ]),
          h('div', { key: 'i', style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, t('intro')),
        ]),
        h('div', { key: 'tools', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
          h('input', {
            key: 'q',
            type: 'search',
            value: query,
            placeholder: t('search'),
            onChange: (event) => setQuery(event.target.value),
            style: {
              flex: '1 1 200px',
              minWidth: 160,
              height: 28,
              padding: '0 8px',
              borderRadius: 6,
              fontSize: 13,
              color: 'var(--dsw-alias-label-primary)',
              backgroundColor: 'var(--dsw-alias-bg-layer-2)',
              border: '0.5px solid var(--dsw-alias-border-l1)',
            },
          }),
          h('label', { key: 'bo', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: blockedOnly,
              onChange: (event) => setBlockedOnly(event.target.checked),
            }),
            t('onlyBlocked'),
          ]),
          h('label', { key: 'sort', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, [
            t('sortLabel'),
            h('select', {
              value: sort,
              onChange: (event) => setSort(event.target.value),
              style: selectStyle,
            }, [
              h('option', { key: 'name', value: 'name' }, t('sortName')),
              h('option', { key: 'blocked', value: 'blocked' }, t('sortBlocked')),
              h('option', { key: 'skills', value: 'skills' }, t('sortSkills')),
            ]),
          ]),
          h('label', { key: 'depth', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, [
            t('treeDepth'),
            h('select', {
              value: String(depthLimit),
              onChange: (event) => setDepthLimit(Number(event.target.value)),
              style: selectStyle,
            }, [
              h('option', { key: 'all', value: '0' }, '∞'),
              h('option', { key: '1', value: '1' }, '1'),
              h('option', { key: '2', value: '2' }, '2'),
              h('option', { key: '3', value: '3' }, '3'),
              h('option', { key: '4', value: '4' }, '4'),
            ]),
          ]),
          h('span', { key: 'c', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            `${totals.skills} ${t('skills')} · ${totals.blocked} ${t('blockedCount')}`),
          h('button', { key: 'ea', type: 'button', onClick: expandAll, style: buttonStyle(false) }, t('expandAll')),
          h('button', { key: 'ca', type: 'button', onClick: collapseAll, style: buttonStyle(false) }, t('collapseAll')),
          h('button', { key: 'r', type: 'button', onClick: load, disabled: busy, style: buttonStyle(false) }, t('refresh')),
        ]),
        selected.size > 0
          ? h('div', {
              key: 'bulkbar',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 6,
                backgroundColor: 'var(--dsw-alias-bg-layer-2)',
                border: '0.5px solid var(--dsw-alias-border-l1)',
              },
            }, [
              h('span', { key: 'n', style: { fontSize: 12 } }, `${t('selected')} ${selected.size}`),
              h('button', { key: 'b', type: 'button', disabled: busy, onClick: () => applySelected(false), style: buttonStyle(true) }, t('applyBlock')),
              h('button', { key: 'e', type: 'button', disabled: busy, onClick: () => applySelected(true), style: buttonStyle(false) }, t('applyEnable')),
              h('button', { key: 'c', type: 'button', onClick: () => setSelected(new Set()), style: buttonStyle(false) }, t('clearSelection')),
            ])
          : null,
        busy ? h('div', { key: 'busy', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('loadingAction')) : null,
        state.status === 'error'
          ? h('div', {
              key: 'err',
              style: {
                padding: '8px 10px',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--dsw-alias-state-error-primary)',
                border: '0.5px solid var(--dsw-alias-state-error-primary)',
                backgroundColor: 'var(--dsw-alias-bg-layer-1)',
              },
            }, [
              h('div', { key: 'm' }, `${t('failed')}: ${state.error}`),
              h('button', { key: 'retry', type: 'button', onClick: load, style: { ...buttonStyle(false), marginTop: 6 } }, t('retry')),
            ])
          : null,
        state.status === 'loading' && data === undefined
          ? h('div', { key: 'load', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
          : null,
        state.status === 'ready' && flat.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('empty'))
          : null,
        state.status === 'ready' && flat.length > 0 && view.length === 0
          ? h('div', { key: 'nomatch', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('noMatch'))
          : null,
        ...view.map(renderNode),
        (data?.depthPruned ?? []).length > 0
          ? h('div', { key: 'pruned', style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, [
              h('div', { key: 'h' }, `${t('depthPruned')}:`),
              ...data.depthPruned.map((path) => h('div', { key: path, style: { overflowWrap: 'anywhere' } }, path)),
            ])
          : null,
        (data?.roots ?? []).length > 0
          ? h('div', { key: 'roots', style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 } }, [
              h('div', { key: 'rt', style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } },
                `${t('roots')} · maxDepth=${data?.maxDepth ?? '?'} · maxCategoryDepth=${data?.maxCategoryDepth ?? '?'}`),
              ...data.roots.map((root) => h('div', {
                key: `${root.kind}:${root.path}`,
                style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
              }, `${root.kind}: ${root.path}`)),
            ])
          : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-manager: dictionaries')
        const t = ctx.locale.bind(NS)
        const face = { t }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'skill-manager',
          order: 18,
          label: () => t('nav'),
          locale: NS,
        }, function SkillManagerSection() {
          return h(PluginContext.Provider, { value: face }, h(SkillManagerPanel))
        }))
      },
    }
  },
})
