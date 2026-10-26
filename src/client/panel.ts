import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'
import { PANEL_ROUTE } from '../constants.js'
import { buildView, fetchPanel, type PanelView } from './viewmodel.js'
import type { PanelPayloadDto } from './dto.js'

const card = {
  border: '1px solid var(--dsw-alias-border-l1, #ffffff1f)',
  borderRadius: 12,
  padding: '14px 16px',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
}

const muted = { color: 'var(--dsw-alias-label-secondary, #9aa4b2)', fontSize: 13 }
const h1 = { margin: 0, fontSize: 20, color: 'var(--dsw-alias-label-primary, #e6e6e6)' }
const sectionTitle = { margin: '18px 0 8px', fontSize: 15, color: 'var(--dsw-alias-label-primary, #e6e6e6)' }

/**
 * Pure view: given a view model, return the element tree. Keeping the hooks in
 * `NovelPanel` makes every visual state renderable without a browser.
 */
export function panelElement(view: PanelView, loading: boolean, onRefresh: () => void): ReactElement {
  return createElement(
    'section',
    {
      'data-plugin': 'dsh-novel-write-engine',
      style: { padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 },
    },
    createElement(
      'header',
      { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      createElement('h1', { style: h1 }, view.title),
      createElement(
        'button',
        {
          type: 'button',
          onClick: onRefresh,
          disabled: loading,
          style: {
            marginLeft: 'auto',
            fontSize: 13,
            padding: '4px 12px',
            cursor: 'pointer',
            borderRadius: 8,
          },
        },
        loading ? '刷新中…' : '刷新',
      ),
    ),
    createElement('div', { style: muted }, view.subtitle),
    view.revision === '' ? null : createElement('div', { style: muted }, view.revision),
    view.next === '' ? null : createElement('div', { style: muted }, view.next),
    view.phases.length === 0
      ? null
      : createElement(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' as const } },
          ...view.phases.map((phase) =>
            createElement(
              'span',
              {
                key: phase.id,
                style: {
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--dsw-alias-border-l1, #ffffff1f)',
                  opacity: phase.done || phase.active ? 1 : 0.45,
                  background: phase.active
                    ? 'var(--dsw-alias-state-business-primary, #4f8ef7)'
                    : 'transparent',
                  color: phase.active ? '#fff' : 'inherit',
                },
              },
              phase.id,
            ),
          ),
        ),
    createElement('h2', { style: sectionTitle }, '章节'),
    view.rows.length === 0
      ? createElement('div', { style: card }, createElement('span', { style: muted }, '还没有归档的章节。'))
      : createElement(
          'table',
          { style: { ...card, width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 } },
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              ...['章', '标题', '字数', '评分', '状态', '摘要'].map((label) =>
                createElement(
                  'th',
                  { key: label, style: { textAlign: 'left', padding: '6px 8px', ...muted } },
                  label,
                ),
              ),
            ),
          ),
          createElement(
            'tbody',
            null,
            ...view.rows.map((row) =>
              createElement(
                'tr',
                { key: row.num },
                createElement('td', { style: { padding: '6px 8px' } }, row.num),
                createElement('td', { style: { padding: '6px 8px' } }, row.title),
                createElement('td', { style: { padding: '6px 8px' } }, row.words),
                createElement('td', { style: { padding: '6px 8px' } }, row.score),
                createElement(
                  'td',
                  { style: { padding: '6px 8px', opacity: row.tone === 'muted' ? 0.6 : 1 } },
                  row.badge,
                ),
                createElement(
                  'td',
                  { style: { padding: '6px 8px', ...muted } },
                  row.details === ''
                    ? '—'
                    : createElement(
                        'details',
                        null,
                        createElement('summary', { style: { cursor: 'pointer' } }, '展开'),
                        createElement('span', null, row.details),
                      ),
                ),
              ),
            ),
          ),
        ),
    createElement('h2', { style: sectionTitle }, view.blockingTitle),
    createElement(
      'div',
      { style: card },
      ...(view.blocking.length === 0
        ? [createElement('span', { key: 'none', style: muted }, '当前阶段没有阻塞项。')]
        : view.blocking.map((item) =>
            createElement(
              'div',
              {
                key: `${item.code}-${item.detail}`,
                style: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
              },
              createElement('strong', { style: { fontSize: 13 } }, item.code),
              createElement('span', { style: { fontSize: 13 } }, item.detail),
              item.hint === '' ? null : createElement('span', { style: muted }, item.hint),
            ),
          )),
    ),
  )
}

/** Stateful wrapper: fetch once, refresh on demand. */
export function NovelPanel(): ReactElement {
  const [view, setView] = useState<PanelView>(() => buildView(null))
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    // The host serves the panel under the document root; a leading slash would
    // bypass a documented --public-url prefix mount.
    const result = await fetchPanel(fetch, PANEL_ROUTE.replace(/^\/+/, ''))
    setView(buildView(result.payload as PanelPayloadDto | null, result.error))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return panelElement(view, loading, () => void load())
}

/** Sidebar icon: a small book mark, inheriting the current text colour. */
export function NovelIcon({ size }: { size?: number }): ReactElement {
  const edge = size ?? 18
  return createElement(
    'svg',
    { width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinejoin: 'round',
    }),
    createElement('path', {
      d: 'M8 7h8M8 10.5h5',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
    }),
  )
}

export { buildView }
