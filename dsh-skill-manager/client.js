/**
 * Skill Manager — browser half.
 *
 * Registers one Settings section ("技能管理" / "Skill Manager") that renders the
 * category tree, a search box, and single-skill plus category-level switches.
 * Data and every mutation travel through this plugin's own Host route
 * (`/skill-manager/api/...`), which the connection layer already authenticates
 * and which the plugin owns end to end.
 *
 * Blocked skills stay listed and greyed out so they can always be restored.
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

    const zh = {
      nav: '技能管理',
      title: '技能管理',
      intro: '按分类查看全部技能，单独或按分类启用、屏蔽。屏蔽后的技能在模型目录与 / 菜单中不可见，但仍列在此处以便随时恢复。',
      search: '搜索技能、分类或路径',
      refresh: '刷新',
      loading: '正在读取技能…',
      empty: '没有发现任何技能。请检查下方扫描的根目录。',
      noMatch: '没有匹配的技能。',
      enabled: '已启用',
      blocked: '已屏蔽',
      enable: '启用',
      block: '屏蔽',
      enableAll: '启用整组',
      blockAll: '屏蔽整组',
      skills: '个技能',
      blockedCount: '个已屏蔽',
      roots: '扫描的根目录',
      source: '来源',
      path: '路径',
      unusable: '不可用',
      failed: '技能管理接口失败',
      retry: '重试',
      allBlocked: '整组已屏蔽',
      allEnabled: '整组已启用',
      partial: '部分屏蔽',
    }

    const en = {
      nav: 'Skill Manager',
      title: 'Skill Manager',
      intro: 'Every skill grouped by category, with per-skill and per-category switches. A blocked skill is invisible in the model catalog and the / menu, yet stays listed here so it can be restored at any time.',
      search: 'Search skills, categories, or paths',
      refresh: 'Refresh',
      loading: 'Loading skills…',
      empty: 'No skills found. Check the scanned roots below.',
      noMatch: 'No matching skill.',
      enabled: 'enabled',
      blocked: 'blocked',
      enable: 'Enable',
      block: 'Block',
      enableAll: 'Enable all',
      blockAll: 'Block all',
      skills: 'skills',
      blockedCount: 'blocked',
      roots: 'Scanned roots',
      source: 'source',
      path: 'path',
      unusable: 'unusable',
      failed: 'Skill Manager API failed',
      retry: 'Retry',
      allBlocked: 'All blocked',
      allEnabled: 'All enabled',
      partial: 'Partly blocked',
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

    /** One authenticated JSON call against this plugin's Host route. */
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

    /** A themed switch matching the host's own toggle affordance. */
    function Switch({ checked, disabled, label, onToggle }) {
      return h(
        'button',
        {
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
        },
        h('span', {
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
        })),
      )
    }

    /** One status chip. */
    function Chip({ tone, children }) {
      const color = tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
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

    /** The Settings section. */
    function SkillManagerPanel() {
      const ctx = React.useContext(PluginContext)
      const t = ctx.t
      const [state, setState] = React.useState({ status: 'loading' })
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      const cwd = React.useMemo(() => readCwd(ctx), [ctx])

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

      const toggle = React.useCallback(async (category, skill, enabled) => {
        setBusy(true)
        try {
          const payload = await requestJson(ROUTE_SET, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd, category, ...(skill === undefined ? {} : { skill }), enabled }),
          })
          setState({ status: 'ready', data: payload })
        } catch (error) {
          setState({ status: 'error', error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [cwd])

      const data = state.data
      const categories = data?.categories ?? []
      const needle = query.trim().toLowerCase()
      const filtered = needle.length === 0
        ? categories
        : categories
            .map((category) => ({
              ...category,
              skills: category.skills.filter((skill) =>
                `${skill.name} ${skill.description} ${category.name} ${skill.path}`.toLowerCase().includes(needle)),
            }))
            .filter((category) => category.skills.length > 0 || category.name.toLowerCase().includes(needle))

      const total = categories.reduce((sum, category) => sum + category.skills.length, 0)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' } }, [
        h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          h('div', { key: 't', style: { fontSize: 15, fontWeight: 600 } }, t('title')),
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
              flex: '1 1 220px',
              minWidth: 180,
              height: 28,
              padding: '0 8px',
              borderRadius: 6,
              fontSize: 13,
              color: 'var(--dsw-alias-label-primary)',
              backgroundColor: 'var(--dsw-alias-bg-layer-2)',
              border: '0.5px solid var(--dsw-alias-border-l1)',
            },
          }),
          h('span', { key: 'c', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            `${total} ${t('skills')} · ${data?.blockedCount ?? 0} ${t('blockedCount')}`),
          h('button', {
            key: 'r',
            type: 'button',
            onClick: load,
            disabled: busy,
            style: buttonStyle(false),
          }, t('refresh')),
        ]),
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
        state.status === 'ready' && categories.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('empty'))
          : null,
        state.status === 'ready' && categories.length > 0 && filtered.length === 0
          ? h('div', { key: 'nomatch', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('noMatch'))
          : null,
        ...filtered.map((category) => {
          const isCollapsed = collapsed.has(category.key)
          const allBlocked = category.skills.length > 0 && category.blockedCount === category.skills.length
          const anyBlocked = category.blockedCount > 0
          const tone = allBlocked ? 'muted' : anyBlocked ? 'warn' : 'ok'
          const stateLabel = allBlocked ? t('allBlocked') : anyBlocked ? t('partial') : t('allEnabled')
          return h('section', {
            key: category.key,
            style: {
              border: '0.5px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              backgroundColor: 'var(--dsw-alias-bg-layer-1)',
              overflow: 'hidden',
            },
          }, [
            h('div', {
              key: 'h',
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexWrap: 'wrap' },
            }, [
              h('button', {
                key: 'disclose',
                type: 'button',
                'aria-expanded': !isCollapsed,
                onClick: () => setCollapsed((previous) => {
                  const next = new Set(previous)
                  if (next.has(category.key)) next.delete(category.key)
                  else next.add(category.key)
                  return next
                }),
                style: {
                  appearance: 'none',
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                  padding: '0 2px',
                },
              }, isCollapsed ? '▸' : '▾'),
              h('span', { key: 'n', style: { fontSize: 13, fontWeight: 600 } }, category.name),
              h('span', { key: 'k', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                `[${category.rootKind}] ${category.skills.length} ${t('skills')}`),
              h(Chip, { key: 's', tone }, stateLabel),
              h('span', { key: 'spacer', style: { flex: 1 } }),
              h('button', {
                key: 'bulk',
                type: 'button',
                disabled: busy || category.skills.length === 0,
                onClick: () => toggle(category.name, undefined, allBlocked),
                style: buttonStyle(allBlocked),
              }, allBlocked ? t('enableAll') : t('blockAll')),
            ]),
            isCollapsed ? null : h('div', {
              key: 'rows',
              style: { display: 'flex', flexDirection: 'column', borderTop: '0.5px solid var(--dsw-alias-border-l1)' },
            }, category.skills.map((skill) => h('div', {
              key: skill.key,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px',
                opacity: skill.blocked ? 0.55 : 1,
                borderTop: '0.5px solid var(--dsw-alias-border-l1)',
              },
            }, [
              h('div', { key: 'body', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, [
                h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                  h('span', {
                    key: 'name',
                    style: {
                      fontSize: 13,
                      fontWeight: 600,
                      textDecoration: skill.blocked ? 'line-through' : 'none',
                    },
                  }, skill.name),
                  h(Chip, { key: 'chip', tone: skill.blocked ? 'muted' : 'ok' }, skill.blocked ? t('blocked') : t('enabled')),
                  skill.usable ? null : h(Chip, { key: 'bad', tone: 'error' }, `${t('unusable')}: ${skill.defect}`),
                ]),
                skill.description.length > 0
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
                }, `${t('path')}: ${skill.path}`),
              ]),
              h(Switch, {
                key: 'sw',
                checked: !skill.blocked,
                disabled: busy || !skill.usable,
                label: `${skill.blocked ? t('enable') : t('block')} ${skill.name}`,
                onToggle: () => toggle(category.name, skill.name, skill.blocked),
              }),
            ]))),
          ])
        }),
        data === undefined
          ? null
          : h('div', { key: 'roots', style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 } }, [
              h('div', { key: 'rt', style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('roots')),
              ...(data.roots ?? []).map((root) => h('div', {
                key: `${root.kind}:${root.path}`,
                style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
              }, `${root.kind}: ${root.path}`)),
            ]),
      ])
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

    const PluginContext = React.createContext({ t: (key) => key })

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
