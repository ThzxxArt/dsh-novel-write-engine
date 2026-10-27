import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { PANEL_ROUTE } from '../constants.js'
import { buildView, fetchPanel, type PanelChapter, type PanelView } from './viewmodel.js'
import type { PanelPayloadDto } from './dto.js'

interface NweWindow {
  setInterval: (handler: () => void, timeout: number) => unknown
  clearInterval: (handle: unknown) => void
  addEventListener: (name: string, handler: () => void) => void
  removeEventListener: (name: string, handler: () => void) => void
}

interface NweDocument {
  visibilityState?: string
  addEventListener: (name: string, handler: () => void) => void
  removeEventListener: (name: string, handler: () => void) => void
}

const CSS = `
.nwe-root {
  --nwe-ink: var(--dsw-alias-label-primary, #ebe7dd);
  --nwe-muted: var(--dsw-alias-label-secondary, #9aa4b2);
  --nwe-surface: var(--dsw-alias-bg-layer-1, #171a20);
  --nwe-raised: var(--dsw-alias-bg-layer-2, #1e222a);
  --nwe-border: var(--dsw-alias-border-l1, #ffffff14);
  --nwe-gold: #8f6a28;
  --nwe-jade: #3f7f69;
  --nwe-rose: #9e5454;
  --nwe-gold: color-mix(in srgb, #b7862f 82%, var(--nwe-ink));
  --nwe-jade: color-mix(in srgb, #4f9f82 68%, var(--nwe-ink));
  --nwe-rose: color-mix(in srgb, #c96a6a 68%, var(--nwe-ink));
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: 100%;
  max-width: 1120px;
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(18px, 3.2vw, 38px);
  color: var(--nwe-ink);
  font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.55;
}
.nwe-root * { box-sizing: border-box; }
.nwe-root::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(ellipse 70% 40% at 92% 0%, color-mix(in srgb, var(--nwe-gold) 16%, transparent), transparent 70%),
    radial-gradient(ellipse 50% 30% at 0% 100%, color-mix(in srgb, var(--nwe-jade) 9%, transparent), transparent 70%);
}
.nwe-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 24px;
  border: 1px solid var(--nwe-border);
  border-radius: 20px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--nwe-gold) 10%, var(--nwe-surface)), var(--nwe-surface) 70%);
  box-shadow: 0 18px 50px -32px color-mix(in srgb, #000 70%, transparent);
}
.nwe-eyebrow {
  color: var(--nwe-gold);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .22em;
  text-transform: uppercase;
}
.nwe-title {
  margin: 8px 0 6px;
  font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
  font-size: clamp(26px, 3.4vw, 42px);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: .015em;
}
.nwe-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--nwe-muted);
  font-size: 12px;
}
.nwe-stage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 50%, transparent);
  border-radius: 999px;
  color: var(--nwe-gold);
  font-size: 11px;
  font-weight: 600;
}
.nwe-stage::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.nwe-stage.is-done { border-color: color-mix(in srgb, var(--nwe-jade) 50%, transparent); color: var(--nwe-jade); }
.nwe-refresh {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 8px 14px;
  border: 1px solid var(--nwe-border);
  border-radius: 10px;
  background: var(--nwe-raised);
  color: var(--nwe-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color .18s ease, transform .18s ease;
}
.nwe-refresh:hover:not(:disabled) { border-color: color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-border)); transform: translateY(-1px); }
.nwe-refresh:disabled { cursor: wait; opacity: .55; }
.nwe-root :focus-visible { outline: 2px solid var(--nwe-gold); outline-offset: 3px; }
.nwe-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}
.nwe-stat {
  padding: 13px 16px;
  border: 1px solid var(--nwe-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nwe-surface) 88%, var(--nwe-gold) 4%);
}
.nwe-stat-label { color: var(--nwe-muted); font-size: 11px; letter-spacing: .04em; }
.nwe-stat-value {
  margin-top: 3px;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -.02em;
}
.nwe-stat-unit { margin-left: 2px; color: var(--nwe-muted); font-size: 11px; font-weight: 400; }
.nwe-section { margin-top: 26px; }
.nwe-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.nwe-section-title {
  margin: 0;
  font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
  font-size: 17px;
  font-weight: 600;
}
.nwe-section-note { color: var(--nwe-muted); font-size: 11px; }
.nwe-phases {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 0;
  margin: 12px 0 0;
  padding: 14px 8px 10px;
  border: 1px solid var(--nwe-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nwe-surface) 92%, transparent);
  list-style: none;
}
.nwe-phase { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.nwe-phase:not(:last-child)::after {
  content: "";
  position: absolute;
  top: 8px;
  left: calc(50% + 11px);
  width: calc(100% - 22px);
  height: 1px;
  background: var(--nwe-border);
}
.nwe-phase.is-done:not(:last-child)::after { background: color-mix(in srgb, var(--nwe-jade) 55%, transparent); }
.nwe-dot {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--nwe-border);
  border-radius: 50%;
  background: var(--nwe-surface);
  color: transparent;
  font-size: 9px;
  font-weight: 700;
}
.nwe-phase.is-done .nwe-dot { border-color: color-mix(in srgb, var(--nwe-jade) 70%, transparent); background: color-mix(in srgb, var(--nwe-jade) 18%, var(--nwe-surface)); color: var(--nwe-jade); }
.nwe-phase.is-active .nwe-dot { border-color: var(--nwe-gold); background: var(--nwe-gold); color: #19150d; box-shadow: 0 0 0 4px color-mix(in srgb, var(--nwe-gold) 16%, transparent); }
.nwe-phase-label { overflow: hidden; max-width: 100%; color: var(--nwe-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.nwe-phase.is-active .nwe-phase-label { color: var(--nwe-ink); font-weight: 600; }
.nwe-next {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-top: 12px;
  padding: 15px 18px;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 35%, var(--nwe-border));
  border-left: 3px solid var(--nwe-gold);
  border-radius: 14px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--nwe-gold) 9%, transparent), transparent 72%), var(--nwe-surface);
}
.nwe-next-icon { display: grid; place-items: center; flex: 0 0 auto; width: 28px; height: 28px; border-radius: 9px; background: color-mix(in srgb, var(--nwe-gold) 15%, transparent); color: var(--nwe-gold); }
.nwe-next-kicker { color: var(--nwe-gold); font-size: 10px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; }
.nwe-next-title { margin-top: 2px; font-size: 15px; font-weight: 600; }
.nwe-next-detail { margin-top: 2px; color: var(--nwe-muted); font-size: 12px; }
.nwe-next-tool { margin-left: auto; align-self: center; flex: 0 0 auto; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.nwe-chapters { display: flex; flex-direction: column; gap: 9px; margin: 12px 0 0; padding: 0; list-style: none; }
.nwe-chapter {
  overflow: hidden;
  border: 1px solid var(--nwe-border);
  border-left: 2px solid var(--nwe-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nwe-surface) 92%, transparent);
  transition: border-color .18s ease, background .18s ease;
}
.nwe-chapter:hover { background: color-mix(in srgb, var(--nwe-surface) 84%, var(--nwe-gold) 5%); }
.nwe-chapter.is-ok { border-left-color: color-mix(in srgb, var(--nwe-jade) 70%, transparent); }
.nwe-chapter.is-bad { border-left-color: color-mix(in srgb, var(--nwe-rose) 70%, transparent); }
.nwe-chapter summary {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) minmax(200px, auto) 18px;
  gap: 16px;
  align-items: center;
  padding: 14px 18px;
  cursor: pointer;
  list-style: none;
}
.nwe-chapter summary::-webkit-details-marker { display: none; }
.nwe-chapter-num { color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: .04em; }
.nwe-chapter-title { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.nwe-chapter-stage { margin-top: 2px; color: var(--nwe-muted); font-size: 10px; }
.nwe-chevron { color: var(--nwe-muted); font-size: 16px; line-height: 1; transition: transform .18s ease; }
.nwe-chapter[open] .nwe-chevron { transform: rotate(90deg); }
.nwe-chapter-meta { display: flex; align-items: center; gap: 10px; justify-content: flex-end; color: var(--nwe-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-score { display: flex; flex-direction: column; gap: 4px; width: 92px; }
.nwe-score-line { display: flex; justify-content: space-between; gap: 6px; }
.nwe-score-value { color: var(--nwe-ink); font-size: 11px; }
.nwe-scorebar { overflow: hidden; height: 4px; border-radius: 99px; background: var(--nwe-border); }
.nwe-scorebar > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-jade)), var(--nwe-gold)); }
.nwe-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--nwe-border); border-radius: 999px; font-size: 10px; white-space: nowrap; }
.nwe-badge.is-ok { border-color: color-mix(in srgb, var(--nwe-jade) 45%, transparent); color: var(--nwe-jade); }
.nwe-badge.is-bad { border-color: color-mix(in srgb, var(--nwe-rose) 45%, transparent); color: var(--nwe-rose); }
.nwe-badge.is-muted { color: var(--nwe-muted); }
.nwe-chapter-detail { padding: 0 18px 15px 88px; color: var(--nwe-muted); font-size: 12px; line-height: 1.7; }
.nwe-empty, .nwe-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 260px;
  padding: 34px 24px;
  border: 1px dashed var(--nwe-border);
  border-radius: 18px;
  text-align: center;
}
.nwe-state-icon { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 12px; border-radius: 14px; background: color-mix(in srgb, var(--nwe-gold) 12%, transparent); color: var(--nwe-gold); }
.nwe-state-title { font-family: "Noto Serif SC", "Songti SC", Georgia, serif; font-size: 19px; }
.nwe-state-text { max-width: 460px; margin-top: 6px; color: var(--nwe-muted); font-size: 13px; }
.nwe-command { display: inline-block; margin-top: 14px; padding: 7px 12px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-raised); color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.nwe-skeleton { display: grid; gap: 10px; margin-top: 12px; }
.nwe-skeleton-line { height: 16px; border-radius: 8px; background: linear-gradient(90deg, var(--nwe-border), color-mix(in srgb, var(--nwe-border) 40%, transparent), var(--nwe-border)); background-size: 200% 100%; animation: nwe-shimmer 1.6s linear infinite; }
.nwe-skeleton-line.is-wide { height: 72px; }
.nwe-skeleton-line.is-short { width: 42%; }
.nwe-blocking { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.nwe-block { display: flex; gap: 11px; align-items: flex-start; padding: 13px 15px; border: 1px solid var(--nwe-border); border-left: 2px solid var(--nwe-rose); border-radius: 12px; background: color-mix(in srgb, var(--nwe-surface) 92%, transparent); }
.nwe-block-icon { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; border-radius: 7px; background: color-mix(in srgb, var(--nwe-rose) 14%, transparent); color: var(--nwe-rose); font-size: 11px; font-weight: 700; }
.nwe-block-code { color: var(--nwe-rose); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.nwe-block-detail { margin-top: 2px; font-size: 12px; }
.nwe-block-hint { margin-top: 3px; color: var(--nwe-muted); font-size: 11px; }
.nwe-pass { display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--nwe-jade) 30%, var(--nwe-border)); border-radius: 12px; color: var(--nwe-jade); font-size: 12px; background: color-mix(in srgb, var(--nwe-jade) 6%, var(--nwe-surface)); }
.nwe-footer { display: flex; justify-content: space-between; gap: 10px; margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--nwe-border); color: var(--nwe-muted); font-size: 10px; }
.nwe-footer code { color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@keyframes nwe-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (max-width: 760px) {
  .nwe-root { padding: 14px; }
  .nwe-hero { flex-direction: column; padding: 18px; }
  .nwe-refresh { width: 100%; justify-content: center; }
  .nwe-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-phases { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 12px; padding: 12px; }
  .nwe-phase:nth-child(3n)::after { display: none; }
  .nwe-chapter summary { grid-template-columns: 38px minmax(0, 1fr) 18px; gap: 10px; }
  .nwe-chapter-meta { display: grid; grid-column: 2 / 4; grid-row: 2; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; white-space: nowrap; }
  .nwe-chapter-meta > span:first-child { grid-column: auto; }
  .nwe-chevron { grid-column: 3; grid-row: 1; }
  .nwe-score { grid-column: auto; width: 100%; }
  .nwe-chapter-meta > .nwe-badge { grid-column: auto; grid-row: auto; }
  .nwe-chapter-detail { padding-left: 18px; }
  .nwe-next-tool { display: none; }
  .nwe-footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .nwe-skeleton-line { animation: none; }
  .nwe-refresh, .nwe-chapter { transition: none; }
}
`

const icon = (size: number, path: string): ReactElement =>
  createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: path,
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )

const refreshIcon = (): ReactElement =>
  icon(14, 'M20 11a8.1 8.1 0 0 0-15.5-4M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 4M20 20v-5h-5')
const arrowIcon = (): ReactElement => icon(14, 'M5 12h13M13 6l6 6-6 6')
const stateIcon = (): ReactElement =>
  icon(22, 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z')

const stat = (label: string, value: string, unit: string): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-stat', key: label },
    createElement('div', { className: 'nwe-stat-label' }, label),
    createElement(
      'div',
      { className: 'nwe-stat-value' },
      value,
      createElement('span', { className: 'nwe-stat-unit' }, unit),
    ),
  )

const chapterCard = (row: PanelChapter): ReactElement =>
  createElement(
    'li',
    { key: row.num },
    createElement(
      'details',
      { className: `nwe-chapter is-${row.tone}` },
      createElement(
        'summary',
        { 'aria-label': `第 ${row.num} 章 ${row.title}，${row.badge}，${row.score}` },
        createElement(
          'div',
          null,
          createElement('div', { className: 'nwe-chapter-num' }, `CH ${row.num.padStart(2, '0')}`),
        ),
        createElement(
          'div',
          { style: { minWidth: 0 } },
          createElement('div', { className: 'nwe-chapter-title' }, row.title),
          createElement('div', { className: 'nwe-chapter-stage' }, row.stageLabel),
        ),
        createElement(
          'div',
          { className: 'nwe-chapter-meta' },
          createElement('span', null, `${row.words} 字`),
          createElement(
            'div',
            { className: 'nwe-score' },
            createElement(
              'div',
              { className: 'nwe-score-line' },
              createElement('span', { className: 'nwe-score-value' }, row.score),
              createElement('span', { className: 'nwe-chapter-stage' }, `${row.scorePercent}%`),
            ),
            createElement(
              'div',
              {
                className: 'nwe-scorebar',
                role: 'progressbar',
                'aria-valuemin': 0,
                'aria-valuemax': 150,
                'aria-valuenow': row.scoreValue,
                'aria-label': `${row.title} 评分`,
              },
              createElement('span', { style: { width: `${row.scorePercent}%` } }),
            ),
          ),
          createElement('span', { className: `nwe-badge is-${row.tone}` }, row.badge),
        ),
        createElement('span', { className: 'nwe-chevron', 'aria-hidden': 'true' }, '›'),
      ),
      row.details === '' ? null : createElement('div', { className: 'nwe-chapter-detail' }, row.details),
    ),
  )

const phases = (view: PanelView): ReactElement =>
  createElement(
    'ol',
    { className: 'nwe-phases', 'aria-label': '创作阶段' },
    ...view.phases.map((phase) =>
      createElement(
        'li',
        {
          key: phase.id,
          className: `nwe-phase${phase.done ? ' is-done' : ''}${phase.active ? ' is-active' : ''}`,
          'aria-current': phase.active ? 'step' : undefined,
        },
        createElement('span', { className: 'nwe-dot', 'aria-hidden': 'true' }, phase.done ? '✓' : ''),
        createElement('span', { className: 'nwe-phase-label' }, phase.label),
      ),
    ),
  )

const footer = (): ReactElement =>
  createElement(
    'footer',
    { className: 'nwe-footer' },
    createElement('span', null, '只读面板 · 数据来自引擎 · 每 15 秒自动同步'),
    createElement('code', null, 'novel-workshop'),
  )

const loadingState = (): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-section', role: 'status', 'aria-live': 'polite' },
    createElement(
      'div',
      { className: 'nwe-skeleton' },
      ...Array.from({ length: 4 }, (_, index) =>
        createElement('div', {
          key: index,
          className: `nwe-skeleton-line${index === 0 ? ' is-wide' : index === 1 ? ' is-short' : ''}`,
        }),
      ),
    ),
    createElement('div', { className: 'nwe-section-note', style: { marginTop: 12 } }, '正在读取项目状态…'),
  )

const statePanel = (
  state: 'empty' | 'error' | 'outdated',
  view: PanelView,
  loading: boolean,
  onRefresh: () => void,
): ReactElement => {
  const title = state === 'empty' ? '还没有开局' : state === 'outdated' ? '面板需要刷新' : '书稿读取失败'
  return createElement(
    'div',
    { className: 'nwe-state', role: state === 'error' ? 'alert' : 'status' },
    createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
    createElement('div', { className: 'nwe-state-title' }, title),
    createElement('div', { className: 'nwe-state-text' }, view.subtitle),
    state === 'empty' ? createElement('code', { className: 'nwe-command' }, view.emptyCommand) : null,
    state === 'empty'
      ? createElement('div', { className: 'nwe-state-text' }, '创建后，面板会自动同步章节与门控状态。')
      : createElement(
          'button',
          {
            type: 'button',
            className: 'nwe-refresh',
            style: { marginTop: 16 },
            onClick: onRefresh,
            disabled: loading,
          },
          refreshIcon(),
          loading ? '刷新中…' : '重新读取',
        ),
  )
}

/**
 * Pure view: given a view model, return the element tree. Keeping the hooks in
 * `NovelPanel` makes every visual state renderable without a browser.
 */
export function panelElement(view: PanelView, loading: boolean, onRefresh: () => void): ReactElement {
  const ready = view.state === 'ready'
  return createElement(
    'section',
    {
      'data-plugin': 'dsh-novel-write-engine',
      className: 'nwe-root',
      'aria-busy': loading,
      'data-state': view.state,
    },
    createElement('style', { key: 'nwe-style' }, CSS),
    createElement(
      'header',
      { className: 'nwe-hero' },
      createElement(
        'div',
        null,
        createElement('div', { className: 'nwe-eyebrow' }, 'NOVEL STUDIO · 网文工坊'),
        createElement('h1', { className: 'nwe-title' }, view.title),
        createElement(
          'div',
          { className: 'nwe-meta' },
          createElement(
            'span',
            { className: `nwe-stage${view.stageLabel === '已完成' ? ' is-done' : ''}` },
            view.stageLabel,
          ),
          ready ? createElement('span', null, view.subtitle) : null,
          ready ? createElement('span', { 'aria-hidden': 'true' }, '·') : null,
          ready ? createElement('span', null, view.revisionLabel) : null,
        ),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'nwe-refresh',
          onClick: onRefresh,
          disabled: loading,
          'aria-label': '刷新项目状态',
        },
        refreshIcon(),
        loading ? '刷新中…' : '刷新',
      ),
    ),
    ready
      ? createElement(
          'div',
          { className: 'nwe-stats', 'aria-label': '项目统计' },
          stat('已归档', String(view.stats.chapters), '章'),
          stat('总字数', view.stats.words.toLocaleString('zh-CN'), '字'),
          stat('平均评分', view.stats.averageScore === 0 ? '—' : String(view.stats.averageScore), '/150'),
          stat('待处理', String(view.stats.blocking), '项'),
        )
      : null,
    view.state === 'loading' ? loadingState() : null,
    view.state === 'error' || view.state === 'empty' || view.state === 'outdated'
      ? statePanel(view.state, view, loading, onRefresh)
      : null,
    ready ? phases(view) : null,
    ready && view.nextTitle !== ''
      ? createElement(
          'section',
          { className: 'nwe-next', 'aria-label': '下一步' },
          createElement('div', { className: 'nwe-next-icon' }, arrowIcon()),
          createElement(
            'div',
            null,
            createElement('div', { className: 'nwe-next-kicker' }, 'NEXT MOVE'),
            createElement('div', { className: 'nwe-next-title' }, view.nextTitle),
            createElement('div', { className: 'nwe-next-detail' }, view.nextDetail),
          ),
          view.nextTool === '' ? null : createElement('code', { className: 'nwe-next-tool' }, view.nextTool),
        )
      : null,
    ready
      ? createElement(
          'section',
          { className: 'nwe-section' },
          createElement(
            'div',
            { className: 'nwe-section-head' },
            createElement('h2', { className: 'nwe-section-title' }, '章节'),
            createElement('span', { className: 'nwe-section-note' }, `${view.rows.length} 条记录`),
          ),
          view.rows.length === 0
            ? createElement(
                'div',
                { className: 'nwe-empty', style: { marginTop: 12, minHeight: 170 } },
                createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
                createElement('div', { className: 'nwe-state-title' }, '书架还是空的'),
                createElement('div', { className: 'nwe-state-text' }, '完成第一次归档后，章节会出现在这里。'),
              )
            : createElement('ul', { className: 'nwe-chapters' }, ...view.rows.map(chapterCard)),
        )
      : null,
    ready
      ? createElement(
          'section',
          { className: 'nwe-section' },
          createElement(
            'div',
            { className: 'nwe-section-head' },
            createElement('h2', { className: 'nwe-section-title' }, '门控'),
            createElement('span', { className: 'nwe-section-note' }, view.blockingTitle),
          ),
          view.blocking.length === 0
            ? createElement(
                'div',
                { className: 'nwe-pass', role: 'status' },
                createElement('span', { 'aria-hidden': 'true' }, '✓'),
                createElement('span', null, '当前阶段没有阻塞项，可以继续下一步。'),
              )
            : createElement(
                'ul',
                { className: 'nwe-blocking', 'aria-label': '阻塞项' },
                ...view.blocking.map((item) =>
                  createElement(
                    'li',
                    { className: 'nwe-block', key: `${item.code}-${item.detail}` },
                    createElement('span', { className: 'nwe-block-icon', 'aria-hidden': 'true' }, '!'),
                    createElement(
                      'div',
                      null,
                      createElement('div', { className: 'nwe-block-code' }, item.code),
                      createElement('div', { className: 'nwe-block-detail' }, item.detail),
                      item.hint === ''
                        ? null
                        : createElement('div', { className: 'nwe-block-hint' }, item.hint),
                    ),
                  ),
                ),
              ),
        )
      : null,
    footer(),
  )
}

/** Stateful wrapper: fetch once, refresh on demand and after returning to the tab. */
export function NovelPanel(): ReactElement {
  const [view, setView] = useState<PanelView>(() => buildView(null))
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const inFlight = useRef(false)

  const load = useCallback(async (silent = false) => {
    if (inFlight.current) return
    inFlight.current = true
    if (!silent) setLoading(true)
    // The host serves the panel under the document root; a leading slash would
    // bypass a documented --public-url prefix mount.
    const result = await fetchPanel(fetch, PANEL_ROUTE.replace(/^\/+/, ''))
    if (!alive.current) return
    setView(buildView(result.payload as PanelPayloadDto | null, result.error))
    if (!silent) setLoading(false)
    inFlight.current = false
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const win = (globalThis as { window?: NweWindow }).window
    const doc = (globalThis as { document?: NweDocument }).document
    if (win === undefined || doc === undefined) return
    const refreshWhenVisible = (): void => {
      if (doc.visibilityState !== 'hidden') void load(true)
    }
    const timer = win.setInterval(refreshWhenVisible, 15_000)
    win.addEventListener('focus', refreshWhenVisible)
    doc.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      alive.current = false
      win.clearInterval(timer)
      win.removeEventListener('focus', refreshWhenVisible)
      doc.removeEventListener('visibilitychange', refreshWhenVisible)
    }
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
