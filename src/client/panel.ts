import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ADMIN_OPERATION_COUNT,
  ADMIN_OPERATION_GROUPS,
  COMMAND_COMBINATIONS,
  COMMAND_ENTRY,
  COMMAND_FORM_COUNT,
  COMMAND_GROUPS,
} from '../command-reference.js'
import { PANEL_CHAPTER_LIMIT, PANEL_ROUTE, PANEL_VERSION } from '../constants.js'
import { buildView, fetchPanel, type PanelChapter, type PanelProject, type PanelView } from './viewmodel.js'
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
  --nwe-gold: var(--dsw-alias-label-accent, color-mix(in srgb, var(--nwe-ink) 58%, var(--nwe-raised)));
  --nwe-accent: var(--nwe-gold);
  --nwe-font: var(--dsw-font-family, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  --nwe-jade: color-mix(in srgb, #4f9f82 68%, var(--nwe-ink));
  --nwe-rose: color-mix(in srgb, #c96a6a 68%, var(--nwe-ink));
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: 100%;
  max-width: 1120px;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  margin: 0 auto;
  padding: clamp(18px, 3.2vw, 38px);
  color: var(--nwe-ink);
  font-family: var(--nwe-font);
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
  font-size: 12px;
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
  font-size: 12px;
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
.nwe-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; }
.nwe-project { display: flex; align-items: center; gap: 6px; min-width: 0; }
.nwe-project-label { color: var(--nwe-muted); font-size: 12px; white-space: nowrap; }
.nwe-project-select {
  max-width: 260px;
  min-height: 36px;
  padding: 6px 28px 6px 10px;
  border: 1px solid var(--nwe-border);
  border-radius: 10px;
  background: var(--nwe-raised);
  color: var(--nwe-ink);
  font: inherit;
  font-size: 12px;
}
.nwe-rootline { margin-top: 5px; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.nwe-damaged { margin-top: 10px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--nwe-rose) 36%, var(--nwe-border)); border-radius: 10px; color: var(--nwe-rose); background: color-mix(in srgb, var(--nwe-rose) 7%, transparent); font-size: 12px; }
.nwe-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 11px;
  border: 1px solid var(--nwe-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--nwe-raised) 76%, transparent);
  color: var(--nwe-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color .18s ease, color .18s ease, transform .18s ease;
}
.nwe-help:hover { border-color: color-mix(in srgb, var(--nwe-gold) 60%, var(--nwe-border)); color: var(--nwe-ink); transform: translateY(-1px); }
.nwe-help svg { flex: 0 0 auto; }
.nwe-root :focus-visible { outline: 2px solid var(--nwe-gold); outline-offset: 3px; }
.nwe-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3.5vw, 42px);
  background: color-mix(in srgb, #000 76%, transparent);
  backdrop-filter: blur(7px);
}
.nwe-modal {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: min(88vh, 920px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 24%, var(--nwe-border));
  border-radius: 20px;
  background: var(--nwe-surface);
  box-shadow: 0 30px 90px -24px #000;
}
.nwe-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex: 0 0 auto;
  padding: 21px 24px 17px;
  border-bottom: 1px solid var(--nwe-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--nwe-gold) 10%, var(--nwe-raised)), var(--nwe-surface) 72%);
}
.nwe-modal-heading { min-width: 0; }
.nwe-modal-title {
  margin: 7px 0 5px;
  font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
  font-size: clamp(21px, 2.5vw, 27px);
  font-weight: 600;
  line-height: 1.25;
}
.nwe-modal-sub { margin: 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.6; }
.nwe-modal-close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border: 1px solid var(--nwe-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--nwe-raised) 82%, transparent);
  color: var(--nwe-muted);
  font: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.nwe-modal-close:hover { border-color: color-mix(in srgb, var(--nwe-gold) 55%, var(--nwe-border)); color: var(--nwe-ink); }
.nwe-modal-body { overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px 26px; }
.nwe-tutorial-intro { padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--nwe-jade) 28%, var(--nwe-border)); border-radius: 12px; background: color-mix(in srgb, var(--nwe-jade) 6%, transparent); }
.nwe-tutorial-intro p { margin: 0; font-size: 13px; line-height: 1.75; }
.nwe-tutorial-intro p + p { margin-top: 7px; }
.nwe-tutorial-block { margin-top: 22px; }
.nwe-tutorial-block h3 {
  margin: 0 0 9px;
  font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
  font-size: 16px;
  font-weight: 600;
}
.nwe-tutorial-block > p { margin: 0 0 10px; color: var(--nwe-muted); font-size: 12px; line-height: 1.7; }
.nwe-tutorial-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.nwe-tutorial-card { padding: 11px 12px; border: 1px solid var(--nwe-border); border-radius: 11px; background: color-mix(in srgb, var(--nwe-raised) 52%, transparent); }
.nwe-tutorial-card strong { display: block; color: var(--nwe-gold); font-size: 12px; }
.nwe-tutorial-card span { display: block; margin-top: 4px; color: var(--nwe-muted); font-size: 12px; line-height: 1.65; }
.nwe-steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.nwe-step { padding: 12px 14px; border: 1px solid var(--nwe-border); border-left: 2px solid color-mix(in srgb, var(--nwe-gold) 58%, var(--nwe-border)); border-radius: 11px; background: color-mix(in srgb, var(--nwe-surface) 86%, var(--nwe-raised) 14%); }
.nwe-step-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.nwe-step-no { color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; letter-spacing: .06em; }
.nwe-step h4 { margin: 0; font-size: 13px; font-weight: 600; }
.nwe-step-tool { margin-left: auto; padding: 2px 6px; border: 1px solid var(--nwe-border); border-radius: 5px; color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: nowrap; }
.nwe-step p { margin: 6px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.7; }
.nwe-step p strong { color: var(--nwe-ink); font-weight: 600; }
.nwe-tutorial-note { margin: 12px 0 0; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--nwe-gold) 8%, transparent); color: var(--nwe-muted); font-size: 12px; line-height: 1.7; }
.nwe-tutorial-note strong { color: var(--nwe-gold); }
.nwe-command-groups { display: grid; gap: 9px; margin-top: 10px; }
.nwe-command-group { overflow: hidden; border: 1px solid var(--nwe-border); border-radius: 11px; background: color-mix(in srgb, var(--nwe-surface) 88%, var(--nwe-raised)); }
.nwe-command-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--nwe-border); background: color-mix(in srgb, var(--nwe-raised) 45%, transparent); }
.nwe-command-group-head h4 { margin: 0; font-size: 12px; font-weight: 650; letter-spacing: .02em; }
.nwe-command-group-head span { color: var(--nwe-muted); font-size: 12px; text-align: right; }
.nwe-command-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--nwe-border); }
.nwe-command-row { min-width: 0; padding: 9px 11px; background: var(--nwe-surface); }
.nwe-command-form { display: block; color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.nwe-command-desc { display: block; margin-top: 3px; color: var(--nwe-muted); font-size: 12px; line-height: 1.55; }
.nwe-command-subhead { margin: 17px 0 0; font-size: 12px; font-weight: 650; letter-spacing: .02em; }
.nwe-admin-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 9px; }
.nwe-admin-group { padding: 10px 11px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, var(--nwe-raised) 42%, transparent); }
.nwe-admin-group h5 { margin: 0; color: var(--nwe-ink); font-size: 12px; }
.nwe-admin-group p { margin: 3px 0 7px; color: var(--nwe-muted); font-size: 12px; line-height: 1.5; }
.nwe-admin-list { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; list-style: none; }
.nwe-admin-list code { padding: 2px 5px; border: 1px solid var(--nwe-border); border-radius: 5px; color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
.nwe-command-combos { display: grid; gap: 7px; margin: 9px 0 0; padding: 0; list-style: none; }
.nwe-command-combos li { padding: 10px 12px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, var(--nwe-surface) 86%, var(--nwe-raised)); }
.nwe-command-combos strong { display: block; color: var(--nwe-ink); font-size: 12px; }
.nwe-command-steps { display: block; margin: 4px 0 0; padding: 7px 9px; border: 1px solid var(--nwe-border); border-radius: 7px; background: color-mix(in srgb, #000 16%, var(--nwe-surface)); color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.nwe-command-combos p { margin: 5px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.55; }
.nwe-faq { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.nwe-faq li { padding: 10px 12px; border: 1px solid var(--nwe-border); border-radius: 10px; }
.nwe-faq strong { display: block; color: var(--nwe-ink); font-size: 12px; }
.nwe-faq p { margin: 4px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.65; }
.nwe-copy-block { margin-top: 0; }
.nwe-copy-row { display: flex; align-items: center; gap: 10px; margin-top: 7px; }
.nwe-copy-status { color: var(--nwe-muted); font-size: 12px; }
.nwe-prompt { overflow-x: auto; margin: 0; padding: 12px 14px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, #000 24%, var(--nwe-surface)); color: var(--nwe-ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.75; white-space: pre-wrap; }
.nwe-checklist { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.nwe-checklist li { display: flex; gap: 7px; color: var(--nwe-muted); font-size: 12px; line-height: 1.6; }
.nwe-checklist li::before { content: "✓"; color: var(--nwe-jade); font-weight: 700; }
.nwe-modal-foot { flex: 0 0 auto; padding: 10px 24px; border-top: 1px solid var(--nwe-border); color: var(--nwe-muted); font-size: 12px; }
.nwe-help-label { white-space: nowrap; }
.nwe-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 18px 0 0; padding: 4px; border: 1px solid var(--nwe-border); border-radius: 12px; background: color-mix(in srgb, var(--nwe-raised) 65%, transparent); }
.nwe-tab { padding: 7px 13px; border: 0; border-radius: 8px; background: transparent; color: var(--nwe-muted); font: inherit; font-size: 12px; cursor: pointer; }
.nwe-tab.is-active { background: color-mix(in srgb, var(--nwe-gold) 14%, transparent); color: var(--nwe-ink); }
.nwe-tab:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: 2px; }
.nwe-section-list { display: grid; gap: 7px; }
.nwe-data-row { border: 1px solid var(--nwe-border); border-radius: 9px; background: color-mix(in srgb, var(--nwe-raised) 55%, transparent); }
.nwe-data-row > summary { cursor: pointer; padding: 9px 11px; font-size: 12px; overflow-wrap: anywhere; }
.nwe-data-json { margin: 0; padding: 0 11px 11px; color: var(--nwe-muted); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.nwe-subsection { margin: 14px 0 0; }
.nwe-subsection > h3 { margin: 0 0 6px; color: var(--nwe-muted); font-size: 12px; font-weight: 600; letter-spacing: .04em; }
.nwe-kv { display: grid; grid-template-columns: minmax(72px, max-content) minmax(0, 1fr); gap: 4px 12px; margin: 0; padding: 0 11px 11px; font-size: 12px; }
.nwe-kv dt { color: var(--nwe-muted); }
.nwe-kv dd { margin: 0; overflow-wrap: anywhere; }
.nwe-quality-summary { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 6px; color: var(--nwe-muted); font-size: 12px; }
.nwe-dim { display: grid; grid-template-columns: 72px minmax(0, 1fr) 76px; align-items: center; gap: 9px; font-size: 12px; }
.nwe-dim > span:last-child { color: var(--nwe-muted); text-align: right; font-variant-numeric: tabular-nums; }
.nwe-dim .nwe-v6-bar { margin: 0; }
.nwe-health-flags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.nwe-empty { padding: 18px; border: 1px dashed var(--nwe-border); border-radius: 10px; color: var(--nwe-muted); font-size: 12px; }
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
.nwe-stat-label { color: var(--nwe-muted); font-size: 12px; letter-spacing: .04em; }
.nwe-stat-value {
  margin-top: 3px;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -.02em;
}
.nwe-stat-unit { margin-left: 2px; color: var(--nwe-muted); font-size: 12px; font-weight: 400; }
.nwe-overview-charts { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(260px, .9fr); gap: 12px; margin-top: 14px; }
.nwe-viz-card { min-width: 0; padding: 13px 15px 11px; border: 1px solid var(--nwe-border); border-radius: 12px; background: linear-gradient(145deg, color-mix(in srgb, var(--nwe-gold) 6%, var(--nwe-surface)), var(--nwe-surface) 58%); }
.nwe-viz-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nwe-viz-title { display: flex; align-items: center; gap: 8px; color: var(--nwe-ink); font-size: 13px; font-weight: 650; }
.nwe-viz-title svg { color: var(--nwe-gold); }
.nwe-viz-note { color: var(--nwe-muted); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.nwe-viz-empty { display: grid; place-items: center; min-height: 196px; color: var(--nwe-muted); font-size: 12px; text-align: center; }
.nwe-trend-chart { display: block; width: 100%; height: 196px; margin-top: 2px; overflow: visible; }
.nwe-word-chart { display: flex; align-items: flex-end; gap: 7px; height: 196px; margin-top: 2px; padding: 6px 2px 0; border-bottom: 1px solid var(--nwe-border); background: repeating-linear-gradient(to top, transparent 0, transparent calc(25% - 1px), var(--nwe-border) 25%); }
.nwe-word-col { display: flex; flex: 1 1 0; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 0; height: 100%; gap: 4px; }
.nwe-word-value { height: 12px; color: var(--nwe-muted); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-word-track { display: flex; align-items: flex-end; justify-content: center; flex: 0 0 142px; width: 100%; height: 142px; min-height: 0; }
.nwe-word-track > span { display: block; width: min(72%, 30px); min-height: 3px; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, var(--nwe-gold), color-mix(in srgb, var(--nwe-gold) 28%, transparent)); }
.nwe-word-label { color: var(--nwe-muted); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-section { margin-top: 26px; }
.nwe-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.nwe-section-title {
  margin: 0;
  font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
  font-size: 17px;
  font-weight: 600;
}
.nwe-section-note { color: var(--nwe-muted); font-size: 12px; }
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
  font-size: 12px;
  font-weight: 700;
}
.nwe-phase.is-done .nwe-dot { border-color: color-mix(in srgb, var(--nwe-jade) 70%, transparent); background: color-mix(in srgb, var(--nwe-jade) 18%, var(--nwe-surface)); color: var(--nwe-jade); }
.nwe-phase.is-active .nwe-dot { border-color: var(--nwe-gold); background: var(--nwe-gold); color: #19150d; box-shadow: 0 0 0 4px color-mix(in srgb, var(--nwe-gold) 16%, transparent); }
.nwe-phase-label { overflow: hidden; max-width: 100%; color: var(--nwe-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.nwe-phase.is-active .nwe-phase-label { color: var(--nwe-ink); font-weight: 600; }
.nwe-book-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
.nwe-book-card { padding: 14px 16px; border: 1px solid var(--nwe-border); border-radius: 14px; background: color-mix(in srgb, var(--nwe-surface) 92%, transparent); }
.nwe-book-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.nwe-book-title { font-family: "Noto Serif SC", "Songti SC", Georgia, serif; font-size: 14px; font-weight: 600; }
.nwe-book-note { color: var(--nwe-muted); font-size: 12px; }
.nwe-progress { overflow: hidden; height: 7px; margin-top: 10px; border-radius: 99px; background: var(--nwe-border); }
.nwe-progress > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--nwe-jade), var(--nwe-gold)); }
.nwe-progress-legend { display: flex; justify-content: space-between; margin-top: 5px; color: var(--nwe-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.nwe-volumes { max-height: 190px; overflow-y: auto; overscroll-behavior: contain; padding-right: 3px; }
.nwe-volume { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--nwe-muted); font-size: 12px; }
.nwe-volume strong { overflow: hidden; color: var(--nwe-ink); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.nwe-volume.is-current strong { color: var(--nwe-gold); }
.nwe-copy { margin-top: 8px; padding: 6px 10px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-raised); color: var(--nwe-muted); font: inherit; font-size: 12px; cursor: pointer; }
.nwe-copy:hover { border-color: color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-border)); color: var(--nwe-ink); }
.nwe-resume-fallback { margin-top: 6px; padding: 8px 10px; border: 1px solid var(--nwe-border); border-radius: 8px; background: color-mix(in srgb, #000 24%, var(--nwe-surface)); color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.nwe-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.nwe-chip { padding: 3px 8px; border: 1px solid var(--nwe-border); border-radius: 999px; color: var(--nwe-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.nwe-bars { display: flex; align-items: flex-end; gap: 5px; height: 54px; margin-top: 10px; }
.nwe-bar { flex: 1 1 0; min-width: 4px; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, var(--nwe-gold), color-mix(in srgb, var(--nwe-gold) 35%, transparent)); }
.nwe-health { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--nwe-muted); font-size: 12px; }
.nwe-health.is-bad { color: var(--nwe-rose); }
.nwe-activity { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 0; padding: 0; list-style: none; }
.nwe-activity li { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 8px; color: var(--nwe-muted); font-size: 12px; }
.nwe-activity code { color: var(--nwe-ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
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
.nwe-next-kicker { color: var(--nwe-gold); font-size: 12px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; }
.nwe-next-title { margin-top: 2px; font-size: 15px; font-weight: 600; }
.nwe-next-detail { margin-top: 2px; color: var(--nwe-muted); font-size: 12px; }
.nwe-next-tool { margin-left: auto; align-self: center; flex: 0 0 auto; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.nwe-chapters { display: flex; flex-direction: column; gap: 9px; margin: 12px 0 0; padding: 0; list-style: none; }
.nwe-chapter-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, var(--nwe-raised) 55%, transparent); }
.nwe-chapter-toolbar label { display: grid; gap: 3px; color: var(--nwe-muted); font-size: 12px; }
.nwe-chapter-toolbar input, .nwe-chapter-toolbar select { min-height: 30px; padding: 4px 7px; border: 1px solid var(--nwe-border); border-radius: 7px; color: var(--nwe-ink); background: var(--nwe-surface); font: inherit; font-size: 12px; }
.nwe-chapter-toolbar input { min-width: 150px; }
.nwe-section-search { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--nwe-muted); font-size: 12px; }
.nwe-section-search input { min-height: 30px; min-width: 180px; padding: 4px 8px; border: 1px solid var(--nwe-border); border-radius: 7px; color: var(--nwe-ink); background: var(--nwe-surface); font: inherit; font-size: 12px; }
.nwe-table-wrap { overflow-x: auto; margin-top: 10px; border: 1px solid var(--nwe-border); border-radius: 10px; }
.nwe-chapter-detail { margin-top: 12px; padding: 12px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, var(--nwe-raised) 45%, transparent); }
.nwe-detail-text { max-height: 360px; overflow: auto; margin: 8px 0 0; padding: 10px; border-radius: 8px; background: var(--nwe-surface); color: var(--nwe-ink); font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.nwe-chapter-table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 12px; }
.nwe-chapter-table th, .nwe-chapter-table td { padding: 8px 10px; border-bottom: 1px solid var(--nwe-border); text-align: left; vertical-align: top; }
.nwe-chapter-table th { color: var(--nwe-muted); font-weight: 600; background: color-mix(in srgb, var(--nwe-raised) 55%, transparent); }
.nwe-chapter-table tr:last-child td { border-bottom: 0; }
.nwe-chapter-table td.is-num { color: var(--nwe-gold); font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-chapter-table .nwe-table-title { font-weight: 600; overflow-wrap: anywhere; }
.nwe-pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: var(--nwe-muted); font-size: 12px; }
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
.nwe-chapter-num { color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; letter-spacing: .04em; }
.nwe-chapter-title { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.nwe-chapter-stage { margin-top: 2px; color: var(--nwe-muted); font-size: 12px; }
.nwe-chevron { color: var(--nwe-muted); font-size: 16px; line-height: 1; transition: transform .18s ease; }
.nwe-chapter[open] .nwe-chevron { transform: rotate(90deg); }
.nwe-chapter-meta { display: flex; align-items: center; gap: 10px; justify-content: flex-end; color: var(--nwe-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-score { display: flex; flex-direction: column; gap: 4px; width: 92px; }
.nwe-score-line { display: flex; justify-content: space-between; gap: 6px; }
.nwe-score-value { color: var(--nwe-ink); font-size: 12px; }
.nwe-scorebar { overflow: hidden; height: 4px; border-radius: 99px; background: var(--nwe-border); }
.nwe-scorebar > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-jade)), var(--nwe-gold)); }
.nwe-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--nwe-border); border-radius: 999px; font-size: 12px; white-space: nowrap; }
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
.nwe-project-choices { display: flex; flex-direction: column; gap: 8px; width: min(560px, 100%); margin-top: 16px; }
.nwe-project-choice { display: flex; flex-direction: column; gap: 3px; padding: 10px 13px; border: 1px solid var(--nwe-border); border-radius: 10px; background: var(--nwe-raised); color: var(--nwe-ink); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.nwe-project-choice:hover { border-color: color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-border)); }
.nwe-project-choice span { overflow-wrap: anywhere; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.nwe-skeleton { display: grid; gap: 10px; margin-top: 12px; }
.nwe-skeleton-line { height: 16px; border-radius: 8px; background: linear-gradient(90deg, var(--nwe-border), color-mix(in srgb, var(--nwe-border) 40%, transparent), var(--nwe-border)); background-size: 200% 100%; animation: nwe-shimmer 1.6s linear infinite; }
.nwe-skeleton-line.is-wide { height: 72px; }
.nwe-skeleton-line.is-short { width: 42%; }
.nwe-blocking { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.nwe-block { display: flex; gap: 11px; align-items: flex-start; padding: 13px 15px; border: 1px solid var(--nwe-border); border-left: 2px solid var(--nwe-rose); border-radius: 12px; background: color-mix(in srgb, var(--nwe-surface) 92%, transparent); }
.nwe-block-icon { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; border-radius: 7px; background: color-mix(in srgb, var(--nwe-rose) 14%, transparent); color: var(--nwe-rose); font-size: 12px; font-weight: 700; }
.nwe-block-code { color: var(--nwe-rose); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.nwe-block-detail { margin-top: 2px; font-size: 12px; }
.nwe-block-hint { margin-top: 3px; color: var(--nwe-muted); font-size: 12px; }
.nwe-pass { display: flex; align-items: center; gap: 9px; margin-top: 12px; padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--nwe-jade) 30%, var(--nwe-border)); border-radius: 12px; color: var(--nwe-jade); font-size: 12px; background: color-mix(in srgb, var(--nwe-jade) 6%, var(--nwe-surface)); }
.nwe-footer { display: flex; justify-content: space-between; gap: 10px; margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--nwe-border); color: var(--nwe-muted); font-size: 12px; }
.nwe-footer-actions { display: flex; align-items: center; gap: 8px; }
.nwe-footer code { color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@keyframes nwe-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (max-width: 760px) {
  .nwe-root { padding: 14px; }
  .nwe-hero { flex-direction: column; padding: 18px; }
  .nwe-actions { width: 100%; }
  .nwe-project { width: 100%; order: 3; }
  .nwe-project-select { flex: 1; max-width: none; }
  .nwe-refresh { flex: 1; justify-content: center; }
  .nwe-help { flex: 0 0 auto; }
  .nwe-modal-backdrop { align-items: flex-end; padding: 8px; }
  .nwe-modal { width: 100%; max-height: 92vh; border-radius: 16px; }
  .nwe-modal-head { padding: 17px 18px 14px; }
  .nwe-modal-body { padding: 16px 18px 22px; }
  .nwe-modal-foot { padding: 9px 18px; }
  .nwe-tutorial-cards { grid-template-columns: 1fr; }
  .nwe-command-rows, .nwe-admin-groups { grid-template-columns: 1fr; }
  .nwe-command-group-head { align-items: flex-start; flex-direction: column; gap: 2px; }
  .nwe-command-group-head span { text-align: left; }
  .nwe-step-tool { margin-left: 0; }
  .nwe-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-book-grid { grid-template-columns: 1fr; }
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
/* v5 desk: one accent, compact chrome, content before decoration. */
.nwe-root {
  max-width: 1180px;
  padding: clamp(14px, 2.2vw, 28px);
  background: transparent;
}
.nwe-root::before { display: none; }
.nwe-hero {
  align-items: center;
  padding: 14px 16px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--nwe-surface) 94%, var(--nwe-raised));
  box-shadow: none;
}
.nwe-hero-title { min-width: 0; }
.nwe-eyebrow { color: var(--nwe-muted); font-size: 12px; letter-spacing: .16em; }
.nwe-title {
  margin: 4px 0 4px;
  font-family: inherit;
  font-size: clamp(21px, 2.4vw, 28px);
  font-weight: 650;
  letter-spacing: -.015em;
}
.nwe-meta { gap: 7px; font-size: 12px; }
.nwe-actions { gap: 7px; }
.nwe-project { flex-wrap: wrap; gap: 5px; }
.nwe-project-label { font-size: 12px; }
.nwe-project-select {
  max-width: 310px;
  min-height: 32px;
  padding: 5px 26px 5px 9px;
  border-radius: 8px;
  background: var(--nwe-surface);
  font-size: 12px;
}
.nwe-project-search {
  width: 124px;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-surface);
  color: var(--nwe-ink);
  font: inherit;
  font-size: 12px;
}
.nwe-project-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--nwe-muted);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.nwe-refresh, .nwe-help { min-height: 32px; padding: 6px 10px; border-radius: 8px; }
.nwe-rootline { font-size: 12px; margin-top: 3px; }
.nwe-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin-top: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--nwe-border);
  border-bottom: 1px solid var(--nwe-border);
}
.nwe-stat {
  padding: 0 12px;
  border: 0;
  border-right: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
}
.nwe-stat:last-child { border-right: 0; }
.nwe-stat-label { font-size: 12px; }
.nwe-stat-value { margin-top: 1px; font-size: 18px; font-weight: 600; }
.nwe-section { margin-top: 18px; }
.nwe-section-title { font-family: inherit; font-size: 14px; font-weight: 650; }
.nwe-section-note { font-size: 12px; }
.nwe-next {
  margin-top: 12px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 32%, var(--nwe-border));
  border-left: 3px solid var(--nwe-gold);
  border-radius: 10px;
  background: color-mix(in srgb, var(--nwe-gold) 5%, var(--nwe-surface));
}
.nwe-next-icon { width: 24px; height: 24px; border-radius: 7px; }
.nwe-next-body { min-width: 0; }
.nwe-next-title { font-size: 14px; }
.nwe-next-detail { font-size: 12px; }
.nwe-next-tool { font-size: 12px; }
.nwe-desk {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr);
  gap: 18px;
  align-items: start;
}
.nwe-desk-main, .nwe-desk-side { min-width: 0; }
.nwe-desk-side { padding-left: 18px; border-left: 1px solid var(--nwe-border); }
.nwe-desk-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 16px;
}
.nwe-desk-kicker { color: var(--nwe-muted); font-size: 12px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase; }
.nwe-desk-note { color: var(--nwe-gold); font-size: 12px; }
.nwe-desk-main .nwe-phases { margin-top: 8px; }
.nwe-desk-side .nwe-book-grid { grid-template-columns: 1fr; }
.nwe-desk-side .nwe-section { margin-top: 16px; }
.nwe-advisories, .nwe-legacy-list { display: flex; flex-direction: column; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; }
.nwe-advisory {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: baseline;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 24%, var(--nwe-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--nwe-gold) 5%, transparent);
  font-size: 12px;
}
.nwe-advisory-code { color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: nowrap; }
.nwe-advisory-detail { color: var(--nwe-ink); line-height: 1.5; }
.nwe-advisory-hint { color: var(--nwe-muted); font-size: 12px; white-space: nowrap; }
.nwe-advisory-empty {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--nwe-gold) 18%, var(--nwe-border));
  border-radius: 7px;
  color: var(--nwe-muted);
  font-size: 12px;
}

.nwe-pending-section { border-left: 3px solid var(--nwe-gold); padding-left: 10px; }
.nwe-pending-error { border-left-color: #b3261e; }
.nwe-pending-detail { margin: 8px 0 0; color: var(--nwe-ink); font-size: 12px; line-height: 1.6; }
.nwe-pending-hint { margin: 4px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.5; }

.nwe-v6-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.nwe-v6-card { border: 1px solid var(--nwe-border); border-radius: 8px; padding: 10px; background: var(--nwe-surface); }
.nwe-v6-card[open] { grid-column: span 2; }
.nwe-v6-card > summary { cursor: pointer; font: 600 12px/1.4 var(--nwe-font); color: var(--nwe-ink); }
.nwe-v6-card > summary:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: 2px; }
.nwe-v6-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.nwe-v6-list li, .nwe-v6-list b, .nwe-v6-list span { min-width: 0; overflow-wrap: anywhere; }
.nwe-v6-list li { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: 8px; font-size: 12px; line-height: 1.55; color: var(--nwe-muted); }
.nwe-v6-list b { color: var(--nwe-ink); font-weight: 600; overflow-wrap: anywhere; }
.nwe-v6-bars { display: grid; gap: 4px; margin-top: 8px; }
.nwe-v6-bar { display: grid; grid-template-columns: 7em minmax(0, 1fr) 3em; gap: 6px; align-items: center; font-size: 12px; color: var(--nwe-muted); }
.nwe-v6-bar span { height: 4px; border-radius: 2px; background: var(--nwe-border); overflow: hidden; }
.nwe-v6-bar span i { display: block; height: 100%; background: var(--nwe-accent); }
.nwe-v6-note { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--nwe-muted); }
.nwe-v6-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.nwe-v6-tags span { border: 1px solid var(--nwe-border); border-radius: 999px; padding: 2px 7px; font-size: 12px; color: var(--nwe-muted); }
.nwe-chapter-extra { margin-top: 6px; font-size: 12px; color: var(--nwe-muted); line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 640px) { .nwe-v6-grid { grid-template-columns: 1fr; } .nwe-v6-card[open] { grid-column: auto; } }
.nwe-legacy {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 8px;
  border: 1px dashed var(--nwe-border);
  border-radius: 7px;
  color: var(--nwe-muted);
  font-size: 12px;
  line-height: 1.5;
}
.nwe-legacy code { color: var(--nwe-muted); font-size: 12px; white-space: nowrap; }
.nwe-chapters-section { margin-top: 20px; }
.nwe-desk-main .nwe-chapters {
  max-height: 460px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-gutter: stable;
}
.nwe-chapter { border-radius: 9px; }
.nwe-chapter summary { padding: 10px 13px; }
.nwe-chapter-detail { padding-left: 68px; }
@media (max-width: 900px) {
  .nwe-desk { grid-template-columns: 1fr; gap: 0; }
  .nwe-desk-side { padding-left: 0; border-left: 0; }
  .nwe-desk-side .nwe-section { margin-top: 18px; }
}
@media (max-width: 760px) {
  .nwe-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 0; padding: 8px 0; }
  .nwe-stat:nth-child(2) { border-right: 0; }
  .nwe-stat { padding: 0 8px; }
  .nwe-project { order: 3; width: 100%; }
  .nwe-project-select { flex: 1; max-width: none; }
  .nwe-project-search { flex: 1 1 100%; width: auto; }
  .nwe-project-toggle { flex: 1 1 100%; }
  .nwe-desk-main .nwe-chapters { max-height: 360px; }
  .nwe-chapter-detail { padding-left: 18px; }
  .nwe-advisory { grid-template-columns: 1fr; gap: 2px; }
  .nwe-advisory-hint { white-space: normal; }
}
@media (prefers-reduced-motion: reduce) {
  .nwe-skeleton-line { animation: none; }
  .nwe-refresh, .nwe-chapter { transition: none; }
}

/* v8 workbench: quiet chrome, editorial hierarchy, content over ornament. */
.nwe-root {
  --nwe-accent: color-mix(in srgb, #b4471f 82%, var(--nwe-ink));
  --nwe-accent-soft: color-mix(in srgb, var(--nwe-accent) 9%, transparent);
  --nwe-ok: color-mix(in srgb, #2f7d5b 82%, var(--nwe-ink));
  --nwe-warn: color-mix(in srgb, #9a6700 82%, var(--nwe-ink));
  --nwe-bad: color-mix(in srgb, #b42318 82%, var(--nwe-ink));
  --nwe-gold: var(--nwe-accent);
  --nwe-jade: var(--nwe-ok);
  --nwe-rose: var(--nwe-bad);
  max-width: 1240px;
  padding: clamp(22px, 2.8vw, 38px) clamp(20px, 3.4vw, 46px) 30px;
  font-size: 13px;
  line-height: 1.65;
}
.nwe-hero {
  align-items: flex-end;
  gap: 32px;
  padding: 0 0 22px;
  border: 0;
  border-bottom: 1px solid var(--nwe-border);
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.nwe-brand { display: flex; align-items: flex-start; gap: 14px; min-width: 0; }
.nwe-brand-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: var(--nwe-accent);
  color: #fffaf4;
  font-size: 18px;
  font-weight: 700;
  box-shadow: inset 0 1px 0 #ffffff2e;
}
.nwe-eyebrow { color: var(--nwe-muted); font-size: 11px; font-weight: 700; letter-spacing: .16em; }
.nwe-title {
  margin: 5px 0 6px;
  font-family: inherit;
  font-size: clamp(26px, 3vw, 34px);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -.04em;
}
.nwe-meta { gap: 6px 10px; color: var(--nwe-muted); font-size: 12px; }
.nwe-stage {
  border: 0;
  border-radius: 5px;
  padding: 3px 7px;
  background: var(--nwe-accent-soft);
  color: var(--nwe-accent);
  font-size: 11px;
  font-weight: 650;
}
.nwe-stage::before { display: none; }
.nwe-rootline {
  margin-top: 4px;
  color: color-mix(in srgb, var(--nwe-ink) 46%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.nwe-revision { padding-left: 9px; border-left: 1px solid var(--nwe-border); }
.nwe-actions { align-items: center; gap: 8px; }
.nwe-project-label { font-size: 11px; color: var(--nwe-muted); }
.nwe-project-select,
.nwe-project-search {
  min-height: 34px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-surface);
  color: var(--nwe-ink);
  font-size: 12px;
}
.nwe-project-select { max-width: 300px; padding: 6px 28px 6px 10px; }
.nwe-project-search { width: 132px; padding: 6px 9px; }
.nwe-refresh,
.nwe-help {
  min-height: 34px;
  padding: 7px 11px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: transparent;
  color: var(--nwe-ink);
  font: inherit;
  font-size: 12px;
}
.nwe-refresh {
  border-color: var(--nwe-border);
  background: transparent;
  color: var(--nwe-ink);
}
.nwe-refresh:hover:not(:disabled) {
  border-color: var(--nwe-accent);
  background: var(--nwe-accent-soft);
  transform: none;
}
.nwe-help { background: color-mix(in srgb, var(--nwe-surface) 70%, transparent); color: var(--nwe-muted); }
.nwe-help:hover { border-color: var(--nwe-accent); color: var(--nwe-ink); transform: none; }
.nwe-refresh:disabled { cursor: wait; opacity: .55; }
.nwe-next {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  gap: 14px;
  align-items: start;
  margin-top: 22px;
  padding: 18px 20px;
  border: 1px solid color-mix(in srgb, var(--nwe-accent) 22%, var(--nwe-border));
  border-left: 3px solid var(--nwe-accent);
  border-radius: 11px;
  background: color-mix(in srgb, var(--nwe-accent) 5%, var(--nwe-surface));
}
.nwe-next-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--nwe-accent);
  color: #fffaf4;
}
.nwe-next-kicker { color: var(--nwe-accent); font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.nwe-next-title { margin: 2px 0 3px; font-size: 19px; font-weight: 650; line-height: 1.25; letter-spacing: -.025em; }
.nwe-next-detail { max-width: 62ch; color: var(--nwe-muted); font-size: 12.5px; line-height: 1.6; }
.nwe-next-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  padding-top: 2px;
  color: var(--nwe-muted);
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
}
.nwe-next-tool {
  margin: 1px 0 0;
  padding: 4px 7px;
  border: 1px solid var(--nwe-border);
  border-radius: 5px;
  background: var(--nwe-surface);
  color: var(--nwe-muted);
  font-size: 11px;
}
.nwe-next .nwe-copy {
  margin-top: 10px;
  padding: 6px 11px;
  border: 1px solid var(--nwe-accent);
  border-radius: 6px;
  background: var(--nwe-accent);
  color: #fffaf4;
  font-size: 11px;
}
.nwe-next .nwe-copy:hover { border-color: color-mix(in srgb, var(--nwe-accent) 84%, var(--nwe-ink)); background: color-mix(in srgb, var(--nwe-accent) 84%, var(--nwe-ink)); color: #fffaf4; }
.nwe-tabs {
  gap: 25px;
  flex-wrap: nowrap;
  overflow-x: auto;
  margin-top: 20px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
  scrollbar-width: none;
}
.nwe-tabs::-webkit-scrollbar { display: none; }
.nwe-tab {
  position: relative;
  padding: 10px 1px 11px;
  border-radius: 0;
  color: var(--nwe-muted);
  font-size: 13px;
  white-space: nowrap;
}
.nwe-tab:hover { color: var(--nwe-ink); }
.nwe-tab.is-active { background: transparent; color: var(--nwe-ink); font-weight: 650; }
.nwe-tab.is-active::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--nwe-accent);
}
.nwe-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin-top: 20px;
  padding: 0 0 18px;
  border: 0;
  border-bottom: 1px solid var(--nwe-border);
}
.nwe-stat {
  min-width: 0;
  padding: 0 22px;
  border: 0;
  border-right: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
}
.nwe-stat:first-child { padding-left: 0; }
.nwe-stat:last-child { padding-right: 0; border-right: 0; }
.nwe-stat-label { color: var(--nwe-muted); font-size: 11px; font-weight: 500; letter-spacing: .03em; }
.nwe-stat-value {
  margin-top: 3px;
  font-size: 30px;
  font-weight: 650;
  line-height: 1.05;
  letter-spacing: -.045em;
}
.nwe-stat-unit { margin-left: 4px; color: var(--nwe-muted); font-size: 11px; font-weight: 400; letter-spacing: 0; }
.nwe-stat-unit.is-note { display: block; margin: 5px 0 0; font-size: 11px; line-height: 1.45; }
.nwe-desk {
  grid-template-columns: minmax(0, 1.55fr) minmax(290px, .75fr);
  gap: 40px;
  margin-top: 24px;
}
.nwe-desk-side { padding-left: 32px; border-left: 1px solid var(--nwe-border); }
.nwe-desk-heading { margin: 0 0 10px; }
.nwe-desk-kicker { color: var(--nwe-muted); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
.nwe-desk-note { color: var(--nwe-muted); font-size: 11px; }
.nwe-section { margin-top: 25px; }
.nwe-section-head { align-items: center; margin-bottom: 10px; }
.nwe-section-title { font-family: inherit; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.nwe-section-note { color: var(--nwe-muted); font-size: 11px; }
.nwe-phases {
  margin-top: 8px;
  padding: 13px 2px 7px;
  border: 0;
  border-top: 1px solid var(--nwe-border);
  border-bottom: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
}
.nwe-phase { gap: 5px; }
.nwe-phase:not(:last-child)::after { top: 8px; left: calc(50% + 12px); width: calc(100% - 24px); background: var(--nwe-border); }
.nwe-dot {
  width: 17px;
  height: 17px;
  border: 1.5px solid color-mix(in srgb, var(--nwe-ink) 24%, transparent);
  background: var(--nwe-surface);
  font-size: 11px;
}
.nwe-phase.is-done .nwe-dot { border-color: var(--nwe-ok); background: color-mix(in srgb, var(--nwe-ok) 13%, var(--nwe-surface)); color: var(--nwe-ok); }
.nwe-phase.is-active .nwe-dot { border-color: var(--nwe-accent); background: var(--nwe-accent); color: #fffaf4; box-shadow: 0 0 0 3px var(--nwe-accent-soft); }
.nwe-phase-label { margin-top: 1px; font-size: 11px; }
.nwe-phase.is-active .nwe-phase-label { color: var(--nwe-ink); }
.nwe-pass {
  margin-top: 6px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--nwe-ok);
  font-size: 12px;
}
.nwe-block {
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--nwe-bad) 20%, var(--nwe-border));
  border-left: 3px solid var(--nwe-bad);
  border-radius: 7px;
  background: color-mix(in srgb, var(--nwe-bad) 4%, var(--nwe-surface));
}
.nwe-block-icon { width: 20px; height: 20px; border-radius: 5px; }
.nwe-advisory {
  padding: 8px 0;
  border: 0;
  border-bottom: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
}
.nwe-advisory:last-child { border-bottom: 0; }
.nwe-advisory-code { color: var(--nwe-warn); }
.nwe-advisory-hint { color: var(--nwe-muted); font-size: 11px; }
.nwe-chapters { gap: 0; margin-top: 8px; border-top: 1px solid var(--nwe-border); }
.nwe-chapter {
  border: 0;
  border-bottom: 1px solid var(--nwe-border);
  border-radius: 0;
  background: transparent;
}
.nwe-chapter.is-ok, .nwe-chapter.is-bad { border-left: 0; }
.nwe-chapter:hover { background: color-mix(in srgb, var(--nwe-accent) 4%, transparent); }
.nwe-chapter summary {
  grid-template-columns: 48px minmax(0, 1fr) auto 14px;
  gap: 12px;
  padding: 13px 4px;
}
.nwe-chapter-num { color: var(--nwe-accent); font-size: 11px; font-weight: 650; letter-spacing: .02em; }
.nwe-chapter-title { display: block; font-size: 14px; font-weight: 600; }
.nwe-chapter-stage { display: block; margin-top: 1px; color: var(--nwe-muted); font-size: 11px; }
.nwe-chapter-meta { gap: 12px; color: var(--nwe-muted); font-size: 11px; }
.nwe-score { width: 104px; }
.nwe-score-value { font-size: 11px; }
.nwe-scorebar { height: 3px; }
.nwe-scorebar > span { background: var(--nwe-accent); }
.nwe-badge { padding: 2px 6px; border-radius: 5px; font-size: 11px; }
.nwe-badge.is-ok { border-color: color-mix(in srgb, var(--nwe-ok) 34%, transparent); color: var(--nwe-ok); }
.nwe-badge.is-bad { border-color: color-mix(in srgb, var(--nwe-bad) 34%, transparent); color: var(--nwe-bad); }
.nwe-chapter-extra {
  margin: 0;
  padding: 0 4px 12px 64px;
  color: var(--nwe-muted);
  font-size: 11px;
  line-height: 1.55;
}
.nwe-chapter-detail {
  margin: 0 4px 10px 64px;
  padding: 10px 12px;
  border: 0;
  border-radius: 6px;
  background: var(--nwe-surface);
}
.nwe-glance {
  padding: 15px 16px 14px;
  border: 1px solid var(--nwe-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--nwe-surface) 76%, var(--nwe-raised));
}
.nwe-glance-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.nwe-glance-title { margin: 8px 0 4px; font-size: 17px; font-weight: 650; line-height: 1.35; letter-spacing: -.02em; }
.nwe-glance-text {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--nwe-muted);
  font-size: 12.5px;
  line-height: 1.65;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.nwe-glance-bar { overflow: hidden; height: 6px; margin-top: 14px; border-radius: 99px; background: var(--nwe-border); }
.nwe-glance-bar > span { display: block; height: 100%; border-radius: inherit; background: var(--nwe-accent); }
.nwe-glance-legend { display: flex; justify-content: space-between; margin-top: 5px; color: var(--nwe-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.nwe-glance-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 15px 0 0; }
.nwe-glance-facts > div { padding: 0 12px; border-left: 1px solid var(--nwe-border); }
.nwe-glance-facts > div:first-child { padding-left: 0; border-left: 0; }
.nwe-glance-facts dt { color: var(--nwe-muted); font-size: 11px; letter-spacing: .05em; }
.nwe-glance-facts dd { margin: 2px 0 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.nwe-activity { gap: 0; margin-top: 18px; }
.nwe-activity li { grid-template-columns: 62px minmax(0, 1fr) auto; gap: 8px; padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--nwe-border) 65%, transparent); font-size: 11px; }
.nwe-activity li:last-child { border-bottom: 0; }
.nwe-dossier { margin-top: 32px; padding-top: 13px; border-top: 1px solid var(--nwe-border); }
.nwe-dossier > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  list-style: none;
  font-size: 14px;
  font-weight: 650;
}
.nwe-dossier > summary::-webkit-details-marker { display: none; }
.nwe-dossier > summary::before { content: "+"; color: var(--nwe-accent); font-size: 16px; line-height: 1; }
.nwe-dossier[open] > summary::before { content: "−"; }
.nwe-dossier-note { margin-left: auto; color: var(--nwe-muted); font-size: 11px; font-weight: 400; }
.nwe-dossier .nwe-section { margin-top: 12px; }
.nwe-dossier .nwe-section-head { display: none; }
.nwe-dossier .nwe-v6-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-border);
}
.nwe-dossier .nwe-v6-card { padding: 14px 16px; border: 0; border-radius: 0; background: var(--nwe-surface); }
.nwe-dossier .nwe-v6-card[open] { grid-column: span 3; }
.nwe-dossier .nwe-v6-card > summary { font-size: 12px; }
.nwe-footer {
  margin-top: 36px;
  padding-top: 13px;
  border-top: 1px solid var(--nwe-border);
  color: var(--nwe-muted);
  font-size: 11px;
}
.nwe-footer code { font-size: 11px; }
.nwe-empty { min-height: 0; padding: 24px; border-style: dashed; border-radius: 8px; background: color-mix(in srgb, var(--nwe-surface) 60%, transparent); }
.nwe-state { min-height: 320px; border: 0; background: color-mix(in srgb, var(--nwe-surface) 55%, transparent); }
.nwe-state-title { font-family: inherit; font-size: 20px; font-weight: 650; }
.nwe-state-icon { width: 38px; height: 38px; border-radius: 11px; background: var(--nwe-accent-soft); color: var(--nwe-accent); }
.nwe-modal { border-color: var(--nwe-border); border-radius: 14px; background: var(--nwe-surface); }
.nwe-modal-head { border-bottom-color: var(--nwe-border); background: var(--nwe-surface); }
.nwe-modal-title { font-family: inherit; font-size: 22px; font-weight: 650; letter-spacing: -.025em; }
.nwe-tutorial-block h3 { font-family: inherit; font-size: 15px; font-weight: 650; }
.nwe-step { border: 1px solid var(--nwe-border); border-left: 2px solid var(--nwe-accent); border-radius: 8px; background: transparent; }
.nwe-step-no, .nwe-step-tool { color: var(--nwe-accent); }
.nwe-tutorial-card { border-radius: 8px; background: color-mix(in srgb, var(--nwe-surface) 80%, var(--nwe-raised)); }
.nwe-tutorial-card strong { color: var(--nwe-accent); }
.nwe-tutorial-note strong { color: var(--nwe-accent); }
.nwe-copy-block .nwe-copy { border-radius: 6px; }
.nwe-chapter-toolbar, .nwe-section-search { border-radius: 7px; }
.nwe-chapter-toolbar input, .nwe-chapter-toolbar select, .nwe-section-search input { border-radius: 6px; }
.nwe-data-row { border-radius: 6px; background: transparent; }
.nwe-quality-summary { font-size: 11px; }
.nwe-dim { grid-template-columns: 68px minmax(0, 1fr) 52px; font-size: 11px; }
@media (max-width: 980px) {
  .nwe-desk { grid-template-columns: 1fr; gap: 0; }
  .nwe-desk-side { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .7fr); gap: 24px; padding-left: 0; border-left: 0; border-top: 1px solid var(--nwe-border); margin-top: 24px; padding-top: 20px; }
  .nwe-dossier .nwe-v6-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-dossier .nwe-v6-card[open] { grid-column: span 2; }
}
@media (max-width: 760px) {
  .nwe-root { padding: 16px 15px 24px; }
  .nwe-hero { align-items: flex-start; flex-direction: column; gap: 16px; padding-bottom: 17px; }
  .nwe-brand { gap: 11px; }
  .nwe-brand-mark { width: 34px; height: 34px; border-radius: 9px; font-size: 15px; }
  .nwe-title { font-size: 25px; }
  .nwe-revision { padding-left: 0; border-left: 0; }
  .nwe-actions { width: 100%; flex-wrap: wrap; min-width: 0; }
  .nwe-project { order: 0; flex: 1 0 100%; width: 100%; min-width: 0; }
  .nwe-project-select { flex: 1; max-width: none; min-width: 0; width: 100%; }
  .nwe-help, .nwe-refresh { flex: 1 1 0; min-width: 0; }
  .nwe-project-search { flex: 1 1 100%; width: auto; }
  .nwe-project-toggle { flex: 1 1 100%; }
  .nwe-refresh { flex: 1; justify-content: center; }
  .nwe-help { flex: 0 0 auto; }
  .nwe-next { grid-template-columns: 32px minmax(0, 1fr); gap: 11px; padding: 15px; }
  .nwe-next-icon { width: 32px; height: 32px; border-radius: 8px; }
  .nwe-next-title { font-size: 17px; }
  .nwe-next-tool { display: none; }
  .nwe-next-meta { display: none; }
  .nwe-next .nwe-copy { margin-top: 9px; }
  .nwe-tabs { gap: 20px; margin-top: 16px; }
  .nwe-tab { padding: 9px 0 10px; font-size: 12px; }
  .nwe-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px 0; padding-bottom: 15px; }
  .nwe-stat { padding: 0 14px; }
  .nwe-stat:nth-child(2) { border-right: 0; }
  .nwe-stat:nth-child(3) { padding-left: 0; }
  .nwe-stat:nth-child(4) { padding-right: 0; }
  .nwe-stat-value { font-size: 24px; }
  .nwe-desk-side { display: block; }
  .nwe-glance { padding: 14px; }
  .nwe-phases { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 13px; padding: 12px 0 8px; }
  .nwe-phase:nth-child(3n)::after { display: none; }
  .nwe-chapter summary { grid-template-columns: 40px minmax(0, 1fr) 14px; gap: 9px; padding: 12px 2px; }
  .nwe-chapter-meta { grid-column: 2 / 4; grid-row: 2; display: flex; justify-content: flex-start; flex-wrap: wrap; gap: 7px 12px; margin-top: 4px; }
  .nwe-chapter-meta > .nwe-badge { order: 4; }
  .nwe-score { width: 88px; }
  .nwe-chapter-extra { padding: 0 2px 11px 49px; }
  .nwe-chapter-detail { margin: 0 2px 9px 49px; }
  .nwe-dossier { margin-top: 25px; }
  .nwe-dossier-note { display: none; }
  .nwe-dossier .nwe-v6-grid { grid-template-columns: 1fr; }
  .nwe-dossier .nwe-v6-card[open] { grid-column: auto; }
  .nwe-footer { margin-top: 26px; flex-direction: column; }
}

/* v9 card wall: every read-model tab owns the full canvas. */
.nwe-root { max-width: 1460px; }
.nwe-tab-intro {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) auto;
  gap: 15px;
  align-items: start;
  margin: 24px 0 2px;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--nwe-border);
}
.nwe-tab-intro-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border: 1px solid color-mix(in srgb, var(--nwe-accent) 20%, var(--nwe-border));
  border-radius: 12px;
  background: var(--nwe-accent-soft);
  color: var(--nwe-accent);
}
.nwe-tab-intro-copy { min-width: 0; }
.nwe-tab-intro-desc { max-width: 76ch; margin: 0; color: var(--nwe-muted); font-size: 12.5px; line-height: 1.65; overflow-wrap: anywhere; }
.nwe-tab-intro-kicker { color: var(--nwe-muted); font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.nwe-tab-intro-title { margin: 2px 0 3px; font-size: 25px; font-weight: 700; line-height: 1.2; letter-spacing: -.035em; }
.nwe-tab-intro-desc { max-width: 76ch; margin: 0; color: var(--nwe-muted); font-size: 12.5px; line-height: 1.65; overflow-wrap: anywhere; }
.nwe-tab-intro-count {
  align-self: start;
  padding: 4px 8px;
  border: 1px solid var(--nwe-border);
  border-radius: 5px;
  color: var(--nwe-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.nwe-tab-panel { margin-top: 0; }
.nwe-desk-single { grid-template-columns: minmax(0, 1fr); }
.nwe-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
  align-items: start;
  margin-top: 9px;
}
.nwe-data-card {
  overflow: hidden;
  border: 1px solid var(--nwe-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--nwe-surface) 88%, var(--nwe-raised));
  transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
}
.nwe-data-card:hover { border-color: color-mix(in srgb, var(--nwe-accent) 30%, var(--nwe-border)); background: var(--nwe-surface); }
.nwe-data-card[open] {
  border-color: color-mix(in srgb, var(--nwe-accent) 38%, var(--nwe-border));
  background: var(--nwe-surface);
  box-shadow: 0 12px 28px -24px color-mix(in srgb, #000 55%, transparent);
}
.nwe-data-card-head {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 15px;
  gap: 11px;
  align-items: start;
  padding: 13px 14px;
  cursor: pointer;
  list-style: none;
}
.nwe-data-card-head::-webkit-details-marker { display: none; }
.nwe-data-card-head:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: -2px; }
.nwe-data-card-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--nwe-accent-soft);
  color: var(--nwe-accent);
}
.nwe-data-card-icon.is-seed, .nwe-data-card-icon.is-clock { background: color-mix(in srgb, var(--nwe-warn) 10%, transparent); color: var(--nwe-warn); }
.nwe-data-card-icon.is-link, .nwe-data-card-icon.is-check { background: color-mix(in srgb, var(--nwe-ok) 10%, transparent); color: var(--nwe-ok); }
.nwe-data-card-icon.is-alert { background: color-mix(in srgb, var(--nwe-bad) 10%, transparent); color: var(--nwe-bad); }
.nwe-data-card-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nwe-data-card-heading > strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 650; line-height: 1.4; }
.nwe-data-card-note {
  display: -webkit-box;
  overflow: hidden;
  color: var(--nwe-muted);
  font-size: 11.5px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.nwe-data-card-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.nwe-data-card-chips span {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--nwe-border) 80%, transparent);
  border-radius: 4px;
  color: var(--nwe-muted);
  font-size: 10.5px;
  line-height: 1.5;
}
.nwe-data-card-caret { color: var(--nwe-muted); font-size: 16px; line-height: 1; transition: transform .16s ease; }
.nwe-data-card[open] .nwe-data-card-caret { transform: rotate(45deg); color: var(--nwe-accent); }
.nwe-data-card-body {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--nwe-border);
  background: color-mix(in srgb, var(--nwe-raised) 42%, transparent);
}
.nwe-data-card-body .nwe-kv { grid-template-columns: 84px minmax(0, 1fr); padding: 0; font-size: 11.5px; gap: 5px 11px; }
.nwe-group-head { display: flex; align-items: center; gap: 8px; margin: 21px 0 8px; }
.nwe-group-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--nwe-border);
  border-radius: 7px;
  background: var(--nwe-surface);
  color: var(--nwe-accent);
}
.nwe-group-head h3 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -.01em; }
.nwe-subsection { margin: 0; }
.nwe-worldbook-layout, .nwe-leads-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 22px; align-items: start; }
.nwe-worldbook-layout > .nwe-subsection:first-child,
.nwe-leads-layout > .nwe-subsection:first-child { grid-column: 1 / -1; }
.nwe-worldbook-layout > .nwe-subsection .nwe-card-grid,
.nwe-leads-layout > .nwe-subsection .nwe-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.nwe-worldbook-layout > .nwe-subsection:first-child .nwe-card-grid,
.nwe-leads-layout > .nwe-subsection:first-child .nwe-card-grid { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.nwe-quality-layout { display: block; }
.nwe-quality-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  margin-top: 16px;
  border: 1px solid var(--nwe-border);
  border-radius: 11px;
  background: var(--nwe-surface);
}
.nwe-quality-kpi { padding: 15px 17px; border-right: 1px solid var(--nwe-border); }
.nwe-quality-kpi:last-child { border-right: 0; }
.nwe-quality-kpi-label { display: block; color: var(--nwe-muted); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; }
.nwe-quality-kpi-value { display: block; margin-top: 3px; font-size: 29px; font-weight: 650; line-height: 1.1; letter-spacing: -.045em; }
.nwe-quality-kpi-value small { margin-left: 3px; color: var(--nwe-muted); font-size: 10px; font-weight: 400; letter-spacing: 0; }
.nwe-quality-toolbar { display: flex; justify-content: flex-end; margin: 11px 0; }
.nwe-dim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; margin-top: 14px; }
.nwe-dim-card { padding: 12px 14px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-surface); }
.nwe-dim-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.nwe-dim-card-head span { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--nwe-muted); }
.nwe-dim-card-head strong { font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.nwe-dim-card .nwe-v6-bar { display: block; margin-top: 8px; }
.nwe-dim-card .nwe-v6-bar > span { display: block; height: 5px; border-radius: 99px; background: var(--nwe-border); }
.nwe-dim-card .nwe-v6-bar i { display: block; height: 100%; border-radius: inherit; background: var(--nwe-accent); }
.nwe-health-layout { display: block; }
.nwe-health-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 16px; }
.nwe-health-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  padding: 13px 14px;
  border: 1px solid var(--nwe-border);
  border-radius: 9px;
  background: var(--nwe-surface);
}
.nwe-health-card.is-ok { border-color: color-mix(in srgb, var(--nwe-ok) 25%, var(--nwe-border)); }
.nwe-health-card.is-bad { border-color: color-mix(in srgb, var(--nwe-bad) 28%, var(--nwe-border)); }
.nwe-health-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: color-mix(in srgb, var(--nwe-ok) 10%, transparent); color: var(--nwe-ok); }
.nwe-health-card.is-bad .nwe-health-icon { background: color-mix(in srgb, var(--nwe-bad) 10%, transparent); color: var(--nwe-bad); }
.nwe-health-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.nwe-health-copy strong { font-size: 12.5px; }
.nwe-health-copy span { color: var(--nwe-muted); font-size: 11px; line-height: 1.5; }
.nwe-health-state { color: var(--nwe-ok); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; letter-spacing: .08em; }
.nwe-health-card.is-bad .nwe-health-state { color: var(--nwe-bad); }
.nwe-effort-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.nwe-effort-card { padding: 12px 14px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-surface); }
.nwe-effort-card span { display: block; color: var(--nwe-muted); font-size: 10.5px; }
.nwe-effort-card strong { display: block; margin-top: 2px; font-size: 22px; font-weight: 650; line-height: 1.1; letter-spacing: -.035em; }
.nwe-section-search {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-start;
  margin: 14px 0 0;
  padding: 7px 9px;
  border: 1px solid var(--nwe-border);
  border-radius: 7px;
  background: var(--nwe-surface);
}
.nwe-search-icon { display: grid; place-items: center; width: 20px; color: var(--nwe-muted); }
.nwe-search-label { color: var(--nwe-muted); font-size: 11px; white-space: nowrap; }
.nwe-section-search input { flex: 1 1 auto; max-width: 360px; min-height: 28px; border: 0; background: transparent; }
.nwe-section-search input:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: 2px; }
.nwe-chapter-cards-mobile { display: none; }
.nwe-mobile-chapter {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  gap: 3px 9px;
  align-items: center;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-surface);
}
.nwe-mobile-chapter-num { grid-row: 1 / 3; color: var(--nwe-accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 650; }
.nwe-mobile-chapter-body { display: flex; grid-column: 2; grid-row: 1; flex-direction: column; gap: 2px; min-width: 0; }
.nwe-mobile-chapter-body strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.nwe-mobile-chapter-body span { overflow: hidden; color: var(--nwe-muted); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.nwe-mobile-chapter-score { grid-column: 3; grid-row: 1; color: var(--nwe-ink); font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.nwe-mobile-chapter .nwe-refresh { grid-column: 2 / 4; grid-row: 2; justify-self: start; min-height: 26px; margin-top: 2px; padding: 3px 9px; font-size: 11px; }
.nwe-chapter-table { border-collapse: separate; border-spacing: 0 6px; min-width: 720px; }
.nwe-chapter-table thead th { padding: 4px 11px 7px; border: 0; background: transparent; font-size: 10.5px; letter-spacing: .04em; }
.nwe-chapter-table tbody tr { background: var(--nwe-surface); box-shadow: 0 0 0 1px var(--nwe-border); }
.nwe-chapter-table tbody tr:hover { box-shadow: 0 0 0 1px color-mix(in srgb, var(--nwe-accent) 35%, var(--nwe-border)); }
.nwe-chapter-table tbody td { padding: 12px 11px; border: 0; }
.nwe-chapter-table tbody td:first-child { border-radius: 7px 0 0 7px; border-left: 2px solid var(--nwe-accent); font-weight: 650; }
.nwe-chapter-table tbody td:last-child { border-radius: 0 7px 7px 0; }
.nwe-chapter-table tbody td.is-num { font-size: 11px; }
@media (max-width: 980px) {
  .nwe-overview-charts { grid-template-columns: 1fr 1fr; }
  .nwe-tab-intro { grid-template-columns: 40px minmax(0, 1fr); }
  .nwe-tab-intro-icon { width: 40px; height: 40px; }
  .nwe-tab-intro-count { grid-column: 2; justify-self: start; }
  .nwe-quality-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-quality-kpi:nth-child(2) { border-right: 0; }
  .nwe-quality-kpi:nth-child(-n + 2) { border-bottom: 1px solid var(--nwe-border); }
  .nwe-health-grid { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .nwe-tab-intro { gap: 11px; margin-top: 19px; padding-bottom: 15px; }
  .nwe-tab-intro-title { font-size: 21px; }
  .nwe-tab-intro-desc { font-size: 12px; }
  .nwe-overview-charts { grid-template-columns: 1fr; }
  .nwe-trend-chart, .nwe-word-chart { height: 170px; }
  .nwe-viz-empty { min-height: 170px; }
  .nwe-word-track { flex-basis: 120px; height: 120px; }
  .nwe-card-grid { grid-template-columns: 1fr; }
  .nwe-quality-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-quality-kpi { padding: 13px 14px; }
  .nwe-quality-kpi-value { font-size: 25px; }
  .nwe-dim-grid { grid-template-columns: 1fr; }
  .nwe-effort-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .nwe-worldbook-layout, .nwe-leads-layout { grid-template-columns: 1fr; gap: 0; }
  .nwe-worldbook-layout > .nwe-subsection:first-child,
  .nwe-leads-layout > .nwe-subsection:first-child { grid-column: auto; }
  .nwe-worldbook-layout > .nwe-subsection .nwe-card-grid,
  .nwe-leads-layout > .nwe-subsection .nwe-card-grid,
  .nwe-worldbook-layout > .nwe-subsection:first-child .nwe-card-grid,
  .nwe-leads-layout > .nwe-subsection:first-child .nwe-card-grid { grid-template-columns: 1fr; }
  .nwe-chapter-table { border-spacing: 0 7px; min-width: 680px; }
  .nwe-chapters-section .nwe-table-wrap { display: none; }
  .nwe-chapter-cards-mobile { display: grid; gap: 8px; margin-top: 10px; }
}

/* v10 data surfaces: bounded canvas, one disclosure language, local scroll. */
.nwe-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.nwe-hero,
.nwe-damaged,
.nwe-next,
.nwe-tabs { flex: 0 0 auto; }
.nwe-workbench {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 2px;
  padding: 0 6px 2px 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.nwe-workbench:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: -3px; }
.nwe-workbench::-webkit-scrollbar { width: 10px; height: 10px; }
.nwe-workbench::-webkit-scrollbar-track {
  border-radius: 999px;
  background: color-mix(in srgb, var(--nwe-ink) 5%, transparent);
}
.nwe-workbench::-webkit-scrollbar-button { display: none; }
.nwe-workbench::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nwe-ink) 28%, transparent);
  background-clip: padding-box;
}
.nwe-workbench::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--nwe-ink) 42%, transparent);
  background-clip: padding-box;
}
.nwe-root details > summary { cursor: pointer; list-style: none; }
.nwe-root details > summary::-webkit-details-marker { display: none; }
.nwe-root details > summary::marker { content: ""; }
.nwe-root details > summary:focus-visible { outline: 2px solid var(--nwe-accent); outline-offset: -2px; }

.nwe-data-card[open] {
  grid-column: 1 / -1;
  background: var(--nwe-surface);
  box-shadow: 0 14px 34px -28px color-mix(in srgb, #000 62%, transparent);
}
.nwe-data-card-head { align-items: center; transition: background .16s ease; }
.nwe-data-card:hover .nwe-data-card-head { background: color-mix(in srgb, var(--nwe-accent) 4%, transparent); }
.nwe-data-card-body {
  max-height: min(42vh, 360px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.nwe-data-card-body:focus-visible,
.nwe-info-card-body:focus-visible,
.nwe-dossier-body:focus-visible,
.nwe-fold-body:focus-visible,
.nwe-table-wrap:focus-visible {
  outline: 2px solid var(--nwe-accent);
  outline-offset: -2px;
}
.nwe-data-card-body::-webkit-scrollbar,
.nwe-info-card-body::-webkit-scrollbar,
.nwe-dossier-body::-webkit-scrollbar,
.nwe-fold-body::-webkit-scrollbar,
.nwe-table-wrap::-webkit-scrollbar { width: 10px; height: 10px; }
.nwe-data-card-body::-webkit-scrollbar-track,
.nwe-info-card-body::-webkit-scrollbar-track,
.nwe-dossier-body::-webkit-scrollbar-track,
.nwe-fold-body::-webkit-scrollbar-track,
.nwe-table-wrap::-webkit-scrollbar-track {
  border-radius: 999px;
  background: color-mix(in srgb, var(--nwe-ink) 5%, transparent);
}
.nwe-data-card-body::-webkit-scrollbar-button,
.nwe-info-card-body::-webkit-scrollbar-button,
.nwe-dossier-body::-webkit-scrollbar-button,
.nwe-fold-body::-webkit-scrollbar-button,
.nwe-table-wrap::-webkit-scrollbar-button { display: none; }
.nwe-data-card-body::-webkit-scrollbar-thumb,
.nwe-info-card-body::-webkit-scrollbar-thumb,
.nwe-dossier-body::-webkit-scrollbar-thumb,
.nwe-fold-body::-webkit-scrollbar-thumb,
.nwe-table-wrap::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nwe-ink) 28%, transparent);
  background-clip: padding-box;
}
.nwe-data-card-body::-webkit-scrollbar-thumb:hover,
.nwe-info-card-body::-webkit-scrollbar-thumb:hover,
.nwe-dossier-body::-webkit-scrollbar-thumb:hover,
.nwe-fold-body::-webkit-scrollbar-thumb:hover,
.nwe-table-wrap::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--nwe-ink) 42%, transparent);
  background-clip: padding-box;
}

.nwe-info-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.nwe-info-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-surface);
  transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
}
.nwe-info-card:hover {
  border-color: color-mix(in srgb, var(--nwe-accent) 30%, var(--nwe-border));
  background: color-mix(in srgb, var(--nwe-accent) 3%, var(--nwe-surface));
}
.nwe-info-card[open] {
  grid-column: 1 / -1;
  border-color: color-mix(in srgb, var(--nwe-accent) 36%, var(--nwe-border));
  background: var(--nwe-surface);
  box-shadow: 0 14px 34px -30px color-mix(in srgb, #000 62%, transparent);
}
.nwe-info-card-head {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 14px;
  gap: 10px;
  align-items: center;
  padding: 13px 14px;
}
.nwe-info-card-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--nwe-accent-soft);
  color: var(--nwe-accent);
}
.nwe-info-card-title { overflow-wrap: anywhere; font-size: 12.5px; font-weight: 650; line-height: 1.4; }
.nwe-info-card-caret {
  color: var(--nwe-muted);
  font-size: 16px;
  line-height: 1;
  transition: transform .16s ease, color .16s ease;
}
.nwe-info-card[open] .nwe-info-card-caret { transform: rotate(45deg); color: var(--nwe-accent); }
.nwe-info-card-body {
  max-height: min(48vh, 460px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--nwe-border);
  background: color-mix(in srgb, var(--nwe-raised) 34%, transparent);
}
.nwe-info-card-body > :first-child { margin-top: 0; }
.nwe-info-card-body .nwe-v6-list { margin-top: 0; gap: 7px; }
.nwe-info-card-body .nwe-v6-list li { grid-template-columns: minmax(6.5em, max-content) minmax(0, 1fr); }
.nwe-info-card-body .nwe-v6-list b { font-weight: 600; }
.nwe-info-card-body .nwe-v6-bars { margin-top: 12px; }

.nwe-dossier {
  flex: 0 0 auto;
  margin-top: 28px;
  padding-top: 10px;
  border-top: 1px solid var(--nwe-border);
}
.nwe-dossier > summary {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 14px;
  gap: 10px;
  align-items: center;
  padding: 8px 0;
}
.nwe-dossier > summary::before { content: none; }
.nwe-dossier-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: var(--nwe-surface);
  color: var(--nwe-accent);
}
.nwe-dossier-copy { min-width: 0; }
.nwe-dossier-title { display: block; font-size: 14px; font-weight: 650; line-height: 1.35; }
.nwe-dossier-note { display: block; margin: 2px 0 0; color: var(--nwe-muted); font-size: 11px; font-weight: 400; }
.nwe-dossier-caret {
  color: var(--nwe-muted);
  font-size: 16px;
  line-height: 1;
  transition: transform .16s ease, color .16s ease;
}
.nwe-dossier[open] .nwe-dossier-caret { transform: rotate(45deg); color: var(--nwe-accent); }
.nwe-dossier-body {
  max-height: min(60vh, 620px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  margin-top: 8px;
  padding-right: 4px;
}
.nwe-dossier .nwe-section { margin-top: 12px; }
.nwe-dossier .nwe-section:first-child { margin-top: 0; }

.nwe-fold {
  overflow: hidden;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--nwe-surface) 86%, var(--nwe-raised));
  transition: border-color .16s ease, background .16s ease;
}
.nwe-fold + .nwe-fold { margin-top: 8px; }
.nwe-fold:hover { border-color: color-mix(in srgb, var(--nwe-accent) 28%, var(--nwe-border)); }
.nwe-fold[open] { border-color: color-mix(in srgb, var(--nwe-accent) 34%, var(--nwe-border)); background: var(--nwe-surface); }
.nwe-fold-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 14px;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
}
.nwe-fold-title { overflow-wrap: anywhere; color: var(--nwe-ink); font-size: 12px; font-weight: 650; line-height: 1.45; }
.nwe-fold-meta { color: var(--nwe-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nwe-fold-caret {
  color: var(--nwe-muted);
  font-size: 15px;
  line-height: 1;
  transition: transform .16s ease, color .16s ease;
}
.nwe-fold[open] .nwe-fold-caret { transform: rotate(45deg); color: var(--nwe-accent); }
.nwe-fold-body {
  max-height: min(46vh, 420px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--nwe-border);
  background: color-mix(in srgb, var(--nwe-raised) 28%, transparent);
}
.nwe-fold-body > :first-child { margin-top: 0; }
.nwe-fold-body .nwe-detail-text { max-height: none; overflow: visible; margin: 0; padding: 0; border: 0; background: transparent; }
.nwe-detail-fold .nwe-fold-body { max-height: min(38vh, 340px); }

.nwe-chapter[open] {
  border-color: color-mix(in srgb, var(--nwe-accent) 34%, var(--nwe-border));
  background: var(--nwe-surface);
}
.nwe-chapter[open] summary { background: color-mix(in srgb, var(--nwe-accent) 4%, transparent); }
.nwe-chapter-detail {
  max-height: min(36vh, 300px);
  overflow: auto;
  overscroll-behavior: contain;
  margin: 0 4px 12px 64px;
  padding: 10px 12px;
  border: 1px solid var(--nwe-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--nwe-raised) 30%, transparent);
  color: var(--nwe-muted);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.nwe-chapter-detail-panel {
  max-height: none;
  overflow: visible;
  margin: 12px 4px 0 64px;
  padding: 12px 14px;
  white-space: normal;
}
.nwe-chapter-detail-panel .nwe-section-head { margin-bottom: 10px; }

.nwe-table-wrap {
  max-height: min(58vh, 560px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.nwe-chapter-table thead th { position: sticky; top: 0; z-index: 2; background: var(--nwe-surface); }
.nwe-chapters { max-height: min(56vh, 460px); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.nwe-activity { max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }

@media (min-width: 900px) {
  .nwe-data-card[open] .nwe-kv {
    grid-template-columns: minmax(76px, max-content) minmax(0, 1fr) minmax(76px, max-content) minmax(0, 1fr);
    column-gap: 14px;
  }
}
@media (max-width: 980px) {
  .nwe-info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .nwe-workbench { padding-right: 2px; }
  .nwe-info-grid { grid-template-columns: 1fr; }
  .nwe-info-card[open] { grid-column: auto; }
  .nwe-info-card-body { max-height: min(44vh, 420px); }
  .nwe-dossier > summary { grid-template-columns: 26px minmax(0, 1fr) 14px; }
  .nwe-dossier-icon { width: 26px; height: 26px; }
  .nwe-dossier-caret { grid-column: 3; }
  .nwe-dossier-note { display: none; }
  .nwe-chapter-detail { margin: 0 2px 10px; padding: 10px 11px; }
  .nwe-chapter-detail-panel { margin: 10px 2px 0; }
  .nwe-data-card[open] .nwe-kv { grid-template-columns: 78px minmax(0, 1fr); }
  .nwe-table-wrap { max-height: 62vh; }
  .nwe-chapters { max-height: 58vh; }
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
const helpIcon = (): ReactElement =>
  createElement(
    'svg',
    { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('circle', {
      cx: 12,
      cy: 12,
      r: 8.6,
      stroke: 'currentColor',
      strokeWidth: 1.7,
    }),
    createElement('path', {
      d: 'M9.7 9.1a2.5 2.5 0 0 1 4.8.8c0 1.8-2.4 2-2.4 3.8M12 16.8v.1',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )

type SectionGlyph =
  | 'spark'
  | 'person'
  | 'seed'
  | 'clock'
  | 'link'
  | 'map'
  | 'book'
  | 'chart'
  | 'shield'
  | 'heart'
  | 'check'
  | 'alert'

const GLYPH_PATHS: Record<SectionGlyph, string> = {
  spark: 'M12 3.5l1.8 5.1 5.2 1.9-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.9L12 3.5Z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  seed: 'M12 21V9m0 0c0-3 2-5 5-5 0 3-2 5-5 5Zm0 4c0-2-2-4-5-4 0 3 2 4 5 4Z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Zm0 15A2.5 2.5 0 0 1 6.5 18H20',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z',
  heart:
    'M20.8 8.6c0 5-8.8 10.1-8.8 10.1S3.2 13.6 3.2 8.6A4.6 4.6 0 0 1 12 6a4.6 4.6 0 0 1 8.8 2.6ZM12 8v8m-4-4h8',
  check: 'm5 12 4 4L19 6',
  alert: 'M12 4 3 20h18L12 4Zm0 5v5m0 3h.01',
}

const sectionGlyph = (name: SectionGlyph, size = 18): ReactElement => icon(size, GLYPH_PATHS[name])

interface FoldOptions {
  className?: string
  meta?: string
  open?: boolean
  bodyClassName?: string
}

/** One disclosure language for every nested detail panel. */
const foldBlock = (
  key: string,
  title: string,
  body: ReactElement | ReactElement[] | null,
  options: FoldOptions = {},
): ReactElement =>
  createElement(
    'details',
    {
      className: `nwe-fold${options.className === undefined ? '' : ` ${options.className}`}`,
      key,
      ...(options.open === true ? { open: true } : {}),
    },
    createElement(
      'summary',
      { className: 'nwe-fold-head' },
      createElement('span', { className: 'nwe-fold-title' }, title),
      options.meta === undefined ? null : createElement('span', { className: 'nwe-fold-meta' }, options.meta),
      createElement('span', { className: 'nwe-fold-caret', 'aria-hidden': 'true' }, '+'),
    ),
    body === null
      ? null
      : createElement(
          'div',
          {
            className: `nwe-fold-body${options.bodyClassName === undefined ? '' : ` ${options.bodyClassName}`}`,
            role: 'region',
            'aria-label': `${title} 内容`,
            tabIndex: 0,
          },
          body,
        ),
  )

interface TutorialStep {
  title: string
  tool: string
  body: string
  note: string
}

const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    title: '建一本书的项目',
    tool: 'novel_init',
    body: '在对话里说清书名、类型、平台、作者、每章字数区间、总章数和项目根目录；模型会调用 novel_init。项目根目录建议用绝对路径，例如 /home/me/novels/星海。',
    note: '类型是固定的 12 类，平台只能是 fanqie / qidian / qimao / jinjiang。0.2.2 起显式 project_root 会绑定当前会话；多项目先用 /novel scan 发现，再用 /novel use 切换。',
  },
  {
    title: '写书级蓝图与卷结构',
    tool: 'novel_blueprint',
    body: '让模型先定 premise（故事前提）、logline（一句话卖点）、themes（主题）、tone（基调）、pov（视角）、audience（读者）、selling_points（卖点）、ending（结局方向）和 volumes（每卷起止章、目标、弧线、高潮）。',
    note: '蓝图不是正文，可以后补。首次提交章卡时 strict 默认开启；要宽松写作可在蓝图里显式 strict:false 关闭。strict 开启后每章必须先有章卡；章卡一旦存在，标题、场景、目标字数和 cast 仍会校验。',
  },
  {
    title: '排章卡，或导入现成大纲',
    tool: 'novel_outline / novel_outline_import',
    body: '逐章写卡：num、title、scene_type、goal、conflict、hook、cast、target_words。手里已有 Markdown、YAML 或 JSON 大纲时，先用 novel_outline_import 的 dry_run:true 预览，再正式导入。',
    note: '章卡是 P2/P3 的合同。卡被归档后不能直接改；要重写已归档章，先 novel_reopen 并给出 reason。',
  },
  {
    title: '建世界观设定集',
    tool: 'novel_worldbook',
    body: '写 setting（时代/地点）、rules（世界规则）、factions（势力）、locations（地点）、characters（角色）、glossary（术语）、backstory（前史）。可以按段增量更新，不必一次填满。',
    note: '人物名、地点名和规则名要前后一致。P1/P2 的角色卡与会话上下文会从这里取；不要手工改 state/ 里的台账。',
  },
  {
    title: 'P1：领取世界观任务书，写本章约束',
    tool: 'novel_brief {stage:"P1"} → novel_plan_world',
    body: '先领取 P1 任务书，再提交本章 objective（目标）、constraints（限制）、characters（候选角色）、locations（候选地点）、continuity_notes（连续性说明）。',
    note: '每个阶段提交前都要先领当前任务书；任务书 digest 过期时 PG-01 会挡住。不要跳过 brief 直接写。',
  },
  {
    title: 'P2：领取章节任务书，拆本章节拍',
    tool: 'novel_brief {stage:"P2"} → novel_plan_chapter',
    body: '写 title、scene_type、narrator、5–8 个 beats（节拍）、opening（开场）、ending（收束）、target_words（目标字数区间），可选 cast（1–8 人）。',
    note: 'beats 要能落到动作和冲突上，不要写“推进剧情”这类空话。章卡存在时，标题、场景、目标字数和 cast 会按卡校验。',
  },
  {
    title: 'P3：领取初稿任务书，写正文',
    tool: 'novel_brief {stage:"P3"} → novel_write_draft',
    body: '按任务书写正文，并提交 chapter_title、scene_type、narrator 和 summary。summary 要覆盖事件、出场人物、伏笔、新设定、资源变化、开头、衔接、钩子强度、爽点和推进度。',
    note: '正文只有 novel_write_draft 和 novel_revise 两个写入口；novel_amend 只修状态文档。字数以引擎返回为准，不要自己估算或复述旧数字。',
  },
  {
    title: 'P4：领取评审任务书，做十五维评审',
    tool: 'novel_brief {stage:"P4"} → novel_review',
    body: '按十五个维度打分，total 必须等于 150 减去全部扣分；issues 每条写清维度、具体段落、问题和修法；proof 提交开头、中段、结尾三段逐字引用。',
    note: '有 blocker 时不能进 P6，要先走 P5 修订；没有 blocker 才能继续。不要为了过关乱填总分或引用。',
  },
  {
    title: 'P5：只修 blocker 和有价值的意见',
    tool: 'novel_brief {stage:"P5"} → novel_revise',
    body: '按 P4 的问题清单修正文，保留 issue 的状态与证据，提交修订后的正文和三段新引用。修订后回到 P4 重新评审。',
    note: 'blocker 不能 waived 或降级；正文一改，旧评审和旧 check 就失效，必须重走 P4/P6。',
  },
  {
    title: 'P6：机检 + 五个语义项',
    tool: 'novel_brief {stage:"P6"} → novel_check',
    body: '引擎先跑格式/完整性机检，模型再提交五个语义项：L2-SCENE-ANCHOR、L2-CHARACTER-STATE、L2-CAUSALITY、L2-VOICE、L2-POV；每项都要有正文逐字证据。',
    note: '五条证据必须来自不同句子，不能共用同一段。只跑 content 或 integrity 一个 scope 不算完整通过，不能归档。',
  },
  {
    title: 'P8：领取终审任务书，一次事务归档',
    tool: 'novel_brief {stage:"P8"} → novel_archive',
    body: '归档必须带 state_delta：本章出现的每个角色、世界元素、伏笔、时间线事件和关系，都要声明 created、updated 或 no_change；no_change 也要有原因。',
    note: '归档是引擎的一次事务，成功后面板才会出现已归档章节。下一章仍从 P1 开始；total_chapters 全部归档后，全书才算完成。',
  },
  {
    title: '循环下一章，最后导出全书',
    tool: 'novel_report / novel_doctor / novel_export',
    body: '每章重复 P1→P8。随时用 /novel scan 发现项目（加 --register 只登记、不切换），/novel use 切换当前会话、/novel resume 或面板“复制续写指令”接续下一章；novel_report 看进度，novel_doctor 体检，novel_search 查正文/大纲/台账，最后导出 md、txt、epub、outline、worldbook 或 proposal。',
    note: '改已归档章要先 novel_reopen；项目坏了先 novel_state 看 raw，再按 next 用 novel_amend 修，不要手改 chapters/ 或 state/。项目目录被删时绑定会保留并报 missing，不会自动换书；选错书先用 /novel current 确认，再用 /novel use 切回，或 /novel unbind 清掉当前会话绑定。',
  },
]

const TUTORIAL_PROMPT = `请用「网文工坊」引擎写一本小说：
书名《星海旧梦》，都市现代，番茄平台，每章 2200–2800 字，共 120 章，项目根目录用绝对路径。
先做书级蓝图、第一卷章卡和世界观设定，再写第一章。
每章严格按 novel_brief P1 → plan_world → brief P2 → plan_chapter →
brief P3 → write_draft → brief P4 → review → 有 blocker 就修订 →
brief P6 → check → brief P8 → archive 的顺序推进。
正文只通过 write_draft/revise 写；不要直接改 state/、chapters/ 或 outline/。
每次提交前先领取当前阶段任务书，失败时按返回的 code 和 blocking 一次改完。`

const TUTORIAL_NEXT_PROMPT = `继续写当前项目的下一章。先调用 novel_pipeline（或 novel_status）确认当前阶段、项目根目录和下一步工具，不要猜阶段。
如果当前会话还没绑定或不确定是哪本书：先让用户执行 /novel current 或 /novel use（Agent 不执行 slash 命令），同时调用 novel_status 看 selection；不要靠 active 猜。
第一次带 project_root 的项目调用会成为当前会话的持久绑定；后续无 root 调用会继续这本书。纯文本的 novel_word_count 和 novel_diff 不读取项目，也不会建立绑定。

如果下一章还没有章卡：用 novel_outline 只提交下一章的卡（按 num upsert），省略的已有卡会保持不动；不要重交全量，也不要用空数组清空。要删卡必须显式传 remove。
如果 targets.total_chapters 已经写满：先用 novel_amend 把 total_chapters 调到至少包含下一章，不能低于已归档章数。

之后严格按：novel_brief P1 → novel_plan_world → brief P2 → novel_plan_chapter → brief P3 → novel_write_draft → brief P4 → novel_review →（有 blocker）brief P5 → novel_revise → 回 P4 → brief P6 → novel_check → brief P8 → novel_archive 的顺序推进。

归档前把完整的 state_delta 给我确认；正文只通过 write_draft/revise 写，不要直接改 state/、chapters/ 或 outline/，不要跳过 brief。`

const stat = (label: string, value: string, unit: string): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-stat', key: label },
    createElement('div', { className: 'nwe-stat-label' }, label),
    createElement(
      'div',
      { className: 'nwe-stat-value' },
      value,
      createElement('span', { className: `nwe-stat-unit${unit.length > 8 ? ' is-note' : ''}` }, unit),
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
          'span',
          null,
          createElement('span', { className: 'nwe-chapter-num' }, `CH ${row.num.padStart(2, '0')}`),
        ),
        createElement(
          'span',
          { style: { minWidth: 0 } },
          createElement('span', { className: 'nwe-chapter-title' }, row.title),
          createElement('span', { className: 'nwe-chapter-stage' }, row.stageLabel),
        ),
        createElement(
          'span',
          { className: 'nwe-chapter-meta' },
          createElement('span', null, `${row.words} 字`),
          createElement(
            'span',
            { className: 'nwe-score' },
            createElement(
              'span',
              { className: 'nwe-score-line' },
              createElement('span', { className: 'nwe-score-value' }, row.score),
              createElement(
                'span',
                { className: 'nwe-chapter-stage' },
                row.scorePercent === null ? '未评审' : `${row.scorePercent}%`,
              ),
            ),
            row.scoreValue === null
              ? null
              : createElement(
                  'span',
                  {
                    className: 'nwe-scorebar',
                    role: 'progressbar',
                    'aria-valuemin': 0,
                    'aria-valuemax': 150,
                    'aria-valuenow': row.scoreValue,
                    'aria-label': `${row.title} 评分`,
                  },
                  createElement('span', { style: { width: `${row.scorePercent ?? 0}%` } }),
                ),
          ),
          createElement('span', { className: `nwe-badge is-${row.tone}` }, row.badge),
        ),
        createElement('span', { className: 'nwe-chevron', 'aria-hidden': 'true' }, '›'),
      ),
      row.details === '' ? null : createElement('div', { className: 'nwe-chapter-detail' }, row.details),
      createElement(
        'div',
        { className: 'nwe-chapter-extra' },
        `${row.sceneType || '—'} · 对话 ${row.dialogueRatio === null ? '—' : `${Math.round(row.dialogueRatio * 100)}%`} · 钩子 ${row.hookStrength ?? '—'} · 终检 ${finalCheckLabel(row.finalCheck)} · 评 ${row.reviews} / 修 ${row.revisions} / 检 ${row.checks} / 回滚 ${row.rollbacks} · 归档 ${localTime(row.archivedAt)}`,
      ),
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

const bookSection = (view: PanelView): ReactElement => {
  const total = view.book.outlineTotal
  const target = view.book.target
  const denominator = target ?? total
  const percent =
    denominator === 0 ? 0 : Math.min(100, Math.round((view.book.archivedCards / denominator) * 100))
  const chips = [
    ['角色', view.book.worldbook.characters],
    ['地点', view.book.worldbook.locations],
    ['势力', view.book.worldbook.factions],
    ['规则', view.book.worldbook.rules],
    ['术语', view.book.worldbook.glossary],
    ['前史', view.book.worldbook.backstory],
    ['数值事实', view.book.worldbook.facts ?? 0],
  ] as const
  const bars = view.quality.scores.slice(-10)
  return createElement(
    'section',
    { className: 'nwe-section', 'aria-label': '全书规划与质量' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '全书规划'),
      createElement(
        'span',
        { className: 'nwe-section-note' },
        view.book.present
          ? `${view.book.strict ? '严格大纲' : '宽松大纲'} · 规划 ${view.book.plannedCoverage === null ? '—' : `${Math.round(view.book.plannedCoverage * 1000) / 10}%`} · 归档 ${view.book.archivedCoverage === null ? '—' : `${Math.round(view.book.archivedCoverage * 1000) / 10}%`}${view.book.missingCards > 0 ? ` · 缺卡 ${view.book.missingCards}` : ''}`
          : '还没有章卡',
      ),
    ),
    createElement(
      'div',
      { className: 'nwe-book-grid' },
      createElement(
        'div',
        { className: 'nwe-book-card' },
        createElement(
          'div',
          { className: 'nwe-book-head' },
          createElement(
            'span',
            { className: 'nwe-book-title' },
            view.book.premise === '' ? '全书进度' : view.book.premise,
          ),
          createElement(
            'span',
            { className: 'nwe-book-note' },
            `${view.book.planned} 计划 / ${view.book.archivedCards} 归档`,
          ),
        ),
        createElement('p', { className: 'nwe-v6-note' }, view.book.logline || '还没有 logline'),
        createElement(
          'div',
          {
            className: 'nwe-progress',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': percent,
            'aria-label': '全书归档进度',
          },
          createElement('span', { style: { width: `${percent}%` } }),
        ),
        createElement(
          'div',
          { className: 'nwe-progress-legend' },
          createElement(
            'span',
            null,
            target === null ? `目标未设置 · 共 ${total} 张章卡` : `目标 ${target} 章 · 共 ${total} 张章卡`,
          ),
          createElement('span', null, `${percent}% 已归档`),
        ),
        view.book.volumes.length === 0
          ? createElement('div', { className: 'nwe-volume' }, createElement('span', null, '还没有卷'))
          : createElement(
              'div',
              { className: 'nwe-volumes', 'aria-label': '卷列表' },
              ...view.book.volumes.map((volume, index) =>
                createElement(
                  'div',
                  {
                    className: `nwe-volume${view.volumeNumber === index + 1 ? ' is-current' : ''}`,
                    key: `${volume.title}-${volume.range}`,
                  },
                  createElement('strong', null, volume.title),
                  createElement(
                    'span',
                    null,
                    `${volume.range} · ${volume.planned} 计划 / ${volume.archived} 归档`,
                  ),
                ),
              ),
            ),
      ),
      createElement(
        'div',
        { className: 'nwe-book-card' },
        createElement(
          'div',
          { className: 'nwe-book-head' },
          createElement('span', { className: 'nwe-book-title' }, '世界观'),
          createElement(
            'span',
            { className: 'nwe-book-note' },
            `${chips.reduce((sum, [, value]) => sum + value, 0)} 条`,
          ),
        ),
        createElement(
          'div',
          { className: 'nwe-chips' },
          ...chips.map(([label, value]) =>
            createElement('span', { className: 'nwe-chip', key: label }, `${label} ${value}`),
          ),
        ),
        createElement(
          'div',
          { className: 'nwe-book-head', style: { marginTop: 12 } },
          createElement('span', { className: 'nwe-book-title' }, '质量趋势'),
          createElement(
            'span',
            { className: 'nwe-book-note' },
            bars.length === 0
              ? '—'
              : `${view.quality.lastTenAverage === null ? '—' : view.quality.lastTenAverage.toFixed(1)} 近十均分 · 趋势 ${view.quality.samples === 0 ? '见质量页' : view.quality.trendText} · ${
                  view.quality.samples === 0
                    ? '可读评审 —'
                    : `${view.quality.samples} 章 / ${view.quality.attempts} 评`
                }`,
          ),
        ),
        createElement(
          'div',
          { className: 'nwe-bars', role: 'img', 'aria-label': '最近十章评分' },
          ...bars.map((score, index) =>
            createElement('span', {
              key: `${index}-${score}`,
              className: 'nwe-bar',
              style: { height: `${Math.max(4, Math.round((score / 150) * 100))}%` },
              title: `${score}/150`,
            }),
          ),
        ),
        createElement(
          'div',
          { className: `nwe-health${view.health.ok ? '' : ' is-bad'}` },
          createElement('span', { 'aria-hidden': 'true' }, view.health.ok ? '✓' : '!'),
          createElement(
            'span',
            null,
            view.health.ok
              ? '项目健康：没有阻塞或损坏状态'
              : `需要处理：${view.health.blocking} 条门控 · ${view.health.stateErrors} 个损坏文档${view.health.pending ? ' · 有 pending 事务' : ''}`,
          ),
        ),
      ),
    ),
  )
}

const localTime = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}

const activitySection = (view: PanelView): ReactElement | null => {
  if (view.activity.length === 0) return null
  return createElement(
    'section',
    { className: 'nwe-section' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '最近活动'),
      createElement('span', { className: 'nwe-section-note' }, '来自事务日志'),
    ),
    createElement(
      'ul',
      { className: 'nwe-activity' },
      ...view.activity
        .slice(-5)
        .map((row, index) =>
          createElement(
            'li',
            { key: `${row.at}-${row.op}-${index}` },
            createElement('time', { dateTime: row.at }, localTime(row.at)),
            createElement('code', null, row.op),
            createElement(
              'span',
              null,
              row.chapter === 0
                ? statusLabel(row.status)
                : `第 ${row.chapter} 章 · ${statusLabel(row.status)}`,
            ),
          ),
        ),
    ),
  )
}

const advisoriesSection = (view: PanelView): ReactElement | null => {
  if (view.advisories.length === 0 && view.acknowledgedAdvisories === 0) return null
  const note =
    view.acknowledgedAdvisories === 0
      ? '不阻塞归档 · 可 acknowledge'
      : `已确认 ${view.acknowledgedAdvisories} 条 · 不阻塞归档`
  return createElement(
    'section',
    { className: 'nwe-section nwe-advisory-section', 'aria-label': '质量提示' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '提示'),
      createElement('span', { className: 'nwe-section-note' }, note),
    ),
    view.advisories.length === 0
      ? createElement('div', { className: 'nwe-advisory-empty' }, '本轮提示已全部确认。')
      : createElement(
          'ul',
          { className: 'nwe-advisories' },
          ...view.advisories.map((item) =>
            createElement(
              'li',
              { className: 'nwe-advisory', key: `${item.code}-${item.detail}` },
              createElement('code', { className: 'nwe-advisory-code' }, item.code),
              createElement('span', { className: 'nwe-advisory-detail' }, item.detail),
              item.hint === '' ? null : createElement('span', { className: 'nwe-advisory-hint' }, item.hint),
            ),
          ),
        ),
  )
}

const pendingSection = (view: PanelView): ReactElement | null => {
  if (view.pending === null) return null
  const partial = view.pending.state === 'partial'
  return createElement(
    'section',
    {
      className: `nwe-section nwe-pending-section${partial ? ' nwe-pending-error' : ''}`,
      'aria-label': '待恢复事务',
    },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, partial ? '事务部分完成' : '待恢复事务'),
      createElement('span', { className: 'nwe-section-note' }, partial ? '部分完成' : '待恢复'),
    ),
    createElement('p', { className: 'nwe-pending-detail' }, view.pending.detail),
    createElement(
      'p',
      { className: 'nwe-pending-hint' },
      partial
        ? `检查 backups 与 .staging/${view.pending.txid}/before/，不要整项目恢复。`
        : '下一次写操作会自动收尾；只读面不会改动事务。',
    ),
  )
}

const legacySection = (view: PanelView): ReactElement | null => {
  if (view.legacy.length === 0) return null
  return createElement(
    'section',
    { className: 'nwe-section nwe-legacy-section', 'aria-label': '旧数据提示' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '旧数据'),
      createElement('span', { className: 'nwe-section-note' }, '只读审计 · 不改历史'),
    ),
    createElement(
      'ul',
      { className: 'nwe-legacy-list' },
      ...view.legacy.map((item) =>
        createElement(
          'li',
          { className: 'nwe-legacy', key: `${item.code}-${item.detail}` },
          createElement('code', null, item.code),
          createElement('span', null, item.detail),
        ),
      ),
    ),
  )
}

const footer = (view: PanelView, onRefresh: () => void): ReactElement =>
  createElement(
    'footer',
    { className: 'nwe-footer' },
    createElement(
      'span',
      { role: 'status', 'aria-live': 'polite' },
      view.syncError !== undefined && view.syncError !== null && view.syncError !== ''
        ? `同步失败：${view.syncError}`
        : view.lastSync !== undefined && view.lastSync !== null
          ? `只读面板 · 数据来自引擎 · 更新于 ${new Date(view.lastSync).toLocaleTimeString('zh-CN')}`
          : '只读面板 · 数据来自引擎 · 等待首次同步',
    ),
    createElement(
      'span',
      { className: 'nwe-footer-actions' },
      view.syncError !== undefined && view.syncError !== null && view.syncError !== ''
        ? createElement('button', { type: 'button', className: 'nwe-copy', onClick: onRefresh }, '重试')
        : null,
      createElement('code', null, 'novel-workshop'),
    ),
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

const ProjectSelector = ({
  view,
  onSelect,
}: {
  view: PanelView
  onSelect: (root: string | null) => void
}): ReactElement | null => {
  const [query, setQuery] = useState('')
  const [showMissing, setShowMissing] = useState(false)
  const searchableCount = view.projects.filter(
    (project) => project.group !== 'missing' || showMissing || project.root === view.selectedRoot,
  ).length
  useEffect(() => {
    // The search box is unmounted when the list becomes small; a retained query
    // would keep filtering the select with no visible way to clear it.
    if (searchableCount <= 6 && query !== '') setQuery('')
  }, [searchableCount, query])
  if (view.projects.length === 0) return null
  const normalized = query.trim().toLowerCase()
  const selected = view.projects.find((project) => project.root === view.selectedRoot)
  const visible = view.projects.filter((project) => {
    const groupVisible = project.group !== 'missing' || showMissing || project.root === view.selectedRoot
    const queryVisible =
      normalized === '' ||
      project.title.toLowerCase().includes(normalized) ||
      project.root.toLowerCase().includes(normalized) ||
      project.label.toLowerCase().includes(normalized)
    return groupVisible && queryVisible
  })
  const groups: Array<{ key: PanelProject['group']; label: string; items: PanelProject[] }> = [
    {
      key: 'writing',
      label: `写作中 (${view.projects.filter((p) => p.group === 'writing').length})`,
      items: [],
    },
    {
      key: 'damaged',
      label: `待修复 (${view.projects.filter((p) => p.group === 'damaged').length})`,
      items: [],
    },
    {
      key: 'missing',
      label: `失效 (${view.projects.filter((p) => p.group === 'missing').length})`,
      items: [],
    },
  ]
  for (const project of visible) groups.find((group) => group.key === project.group)!.items.push(project)
  groups[0]!.label = `写作中 (${groups[0]!.items.length})`
  groups[1]!.label = `待修复 (${groups[1]!.items.length})`
  groups[2]!.label = `失效 (${groups[2]!.items.length})`
  const missingCount = view.projects.filter((project) => project.group === 'missing').length
  // Search is for the projects the user can actually see. Seven hidden stale
  // rows should not add a search box to a one-book header.
  return createElement(
    'div',
    { className: 'nwe-project' },
    searchableCount > 6
      ? createElement('input', {
          className: 'nwe-project-search',
          type: 'search',
          value: query,
          placeholder: '搜索项目',
          'aria-label': '搜索项目',
          onChange: (event: { target: { value: string } }): void => setQuery(event.target.value),
        })
      : null,
    createElement('label', { className: 'nwe-project-label', htmlFor: 'nwe-project-select' }, '项目'),
    createElement(
      'select',
      {
        id: 'nwe-project-select',
        className: 'nwe-project-select',
        'aria-label': '切换项目',
        value: view.selectedRoot ?? '',
        onChange: (event: { target: { value: string } }): void => {
          onSelect(event.target.value === '' ? null : event.target.value)
        },
      },
      createElement(
        'option',
        { value: '' },
        view.selectedRoot === null ? '跟随当前项目（自动）' : '跟随当前项目',
      ),
      ...groups
        .filter((group) => group.items.length > 0)
        .map((group) =>
          createElement(
            'optgroup',
            { key: group.key, label: group.label },
            ...group.items.map((project) =>
              createElement('option', { key: project.root, value: project.root }, project.label),
            ),
          ),
        ),
      selected !== undefined && !visible.some((project) => project.root === selected.root)
        ? createElement('option', { value: selected.root }, selected.label)
        : null,
    ),
    missingCount > 0
      ? createElement(
          'label',
          { className: 'nwe-project-toggle' },
          createElement('input', {
            type: 'checkbox',
            checked: showMissing,
            onChange: (event: { target: { checked: boolean } }): void => setShowMissing(event.target.checked),
          }),
          `显示失效 ${missingCount}`,
        )
      : null,
  )
}

const choosePanel = (view: PanelView, onSelect: (root: string | null) => void): ReactElement => {
  const preferred = view.projects.filter((project) => project.group !== 'missing')
  const shown = preferred.length > 0 ? preferred : view.projects
  return createElement(
    'div',
    { className: 'nwe-state' },
    createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
    createElement('div', { className: 'nwe-state-title' }, '发现多本书，先选一本'),
    createElement('div', { className: 'nwe-state-text', role: 'status' }, view.subtitle),
    createElement(
      'div',
      { className: 'nwe-project-choices' },
      ...shown.map((project) =>
        createElement(
          'button',
          {
            key: project.root,
            type: 'button',
            className: 'nwe-project-choice',
            onClick: (): void => onSelect(project.root),
          },
          project.label,
          createElement('span', null, project.root),
        ),
      ),
    ),
  )
}

const missingPanel = (view: PanelView): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-state', role: 'alert' },
    createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
    createElement(
      'div',
      { className: 'nwe-state-title' },
      view.missing?.reason === 'busy'
        ? '正在写入'
        : view.missing?.reason === 'unreadable'
          ? '项目不可读'
          : view.missing?.reason === 'not-project'
            ? '不是项目目录'
            : '项目不在了',
    ),
    createElement('div', { className: 'nwe-state-text' }, view.missing?.hint ?? view.subtitle),
    view.missing === undefined
      ? null
      : createElement(
          'div',
          { className: 'nwe-state-text' },
          createElement(
            'code',
            { className: 'nwe-command' },
            `${view.missing.code} · ${view.missing.reason}`,
          ),
          createElement('div', { className: 'nwe-rootline' }, view.missing.root),
        ),
  )

const CopyResumeButton = ({ text }: { text: string }): ReactElement | null => {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    setStatus('idle')
  }, [text])
  useEffect(() => {
    if (status !== 'copied') return
    const timer = setTimeout(() => setStatus('idle'), 2000)
    return () => clearTimeout(timer)
  }, [status])
  if (text === '') return null
  const copy = async (): Promise<void> => {
    try {
      const clipboard = (
        globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }
      ).navigator?.clipboard
      if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable')
      await clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'nwe-copy',
        'aria-label': '复制当前项目的续写指令',
        onClick: (): void => void copy(),
      },
      status === 'copied' ? '已复制' : '复制续写指令',
    ),
    status === 'failed' ? createElement('pre', { className: 'nwe-resume-fallback' }, text) : null,
  )
}

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
            onClick:
              state === 'outdated'
                ? (): void => {
                    const location = (globalThis as { location?: { reload?: () => void } }).location
                    location?.reload?.()
                  }
                : onRefresh,
            disabled: loading && state !== 'outdated',
          },
          refreshIcon(),
          state === 'outdated' ? '刷新页面' : loading ? '刷新中…' : '重新读取',
        ),
  )
}

const tutorialStep = (step: TutorialStep, index: number): ReactElement =>
  createElement(
    'li',
    { className: 'nwe-step', key: step.title },
    createElement(
      'div',
      { className: 'nwe-step-head' },
      createElement('span', { className: 'nwe-step-no' }, String(index + 1).padStart(2, '0')),
      createElement('h4', null, step.title),
      createElement('code', { className: 'nwe-step-tool' }, step.tool),
    ),
    createElement('p', null, step.body),
    createElement('p', null, createElement('strong', null, '注意：'), step.note),
  )

const CopyPrompt = ({ text, label }: { text: string; label: string }): ReactElement => {
  const [status, setStatus] = useState('')
  const copy = useCallback(async (): Promise<void> => {
    try {
      const clipboard = (
        globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }
      ).navigator?.clipboard
      if (clipboard?.writeText === undefined) throw new Error('clipboard unavailable')
      await clipboard.writeText(text)
      setStatus('已复制到剪贴板')
    } catch {
      setStatus('复制失败：请手动选择下方文本，或检查浏览器剪贴板权限')
    }
  }, [text])
  return createElement(
    'div',
    { className: 'nwe-copy-block' },
    createElement('pre', { className: 'nwe-prompt' }, text),
    createElement(
      'div',
      { className: 'nwe-copy-row' },
      createElement('button', { type: 'button', className: 'nwe-copy', onClick: () => void copy() }, label),
      createElement('span', { className: 'nwe-copy-status', role: 'status', 'aria-live': 'polite' }, status),
    ),
  )
}

const commandReferenceSection = (): ReactElement => {
  const groups = [
    { title: '入口命令', hint: '5 个：/novel 与 4 个短别名', items: COMMAND_ENTRY },
    ...COMMAND_GROUPS,
  ]
  return createElement(
    'section',
    { className: 'nwe-tutorial-block' },
    createElement('h3', null, '全部命令：入口、子命令与组合'),
    createElement(
      'p',
      null,
      `5 个入口命令、/novel 的 ${COMMAND_FORM_COUNT} 种带名写法、${ADMIN_OPERATION_COUNT} 个 admin 操作。短命令只是别名；斜杠命令由你在输入框执行，Agent 不能代跑。`,
    ),
    createElement(
      'div',
      { className: 'nwe-command-groups' },
      ...groups.map((group) =>
        createElement(
          'div',
          { className: 'nwe-command-group', key: group.title },
          createElement(
            'div',
            { className: 'nwe-command-group-head' },
            createElement('h4', null, group.title),
            createElement('span', null, group.hint),
          ),
          createElement(
            'div',
            { className: 'nwe-command-rows' },
            ...group.items.map((item) =>
              createElement(
                'div',
                { className: 'nwe-command-row', key: item.form },
                createElement('code', { className: 'nwe-command-form' }, item.form),
                createElement('span', { className: 'nwe-command-desc' }, item.summary),
              ),
            ),
          ),
        ),
      ),
    ),
    createElement(
      'h4',
      { className: 'nwe-command-subhead' },
      `${ADMIN_OPERATION_COUNT} 个 admin 操作（/novel admin <op> <json>）`,
    ),
    createElement(
      'div',
      { className: 'nwe-admin-groups' },
      ...ADMIN_OPERATION_GROUPS.map((group) =>
        createElement(
          'div',
          { className: 'nwe-admin-group', key: group.title },
          createElement('h5', null, group.title),
          createElement('p', null, group.hint),
          createElement(
            'ul',
            { className: 'nwe-admin-list' },
            ...group.items.map((operation) =>
              createElement(
                'li',
                { key: operation.name },
                createElement('code', { title: operation.summary }, operation.name),
              ),
            ),
          ),
        ),
      ),
    ),
    createElement(
      'p',
      { className: 'nwe-tutorial-note' },
      createElement('strong', null, 'admin 示例：'),
      createElement('code', null, '/novel admin novel_state {"kind":"pipeline"}'),
      '、',
      createElement('code', null, '/novel admin novel_registry_register {"root":"/abs/book"}'),
      '。参数与同名工具一致；JSON 必须是对象，不能传数组或裸字符串。',
    ),
    createElement('h4', { className: 'nwe-command-subhead' }, '常用组合'),
    createElement(
      'ol',
      { className: 'nwe-command-combos' },
      ...COMMAND_COMBINATIONS.map((combination) =>
        createElement(
          'li',
          { key: combination.title },
          createElement('strong', null, combination.title),
          createElement('code', { className: 'nwe-command-steps' }, combination.steps.join('  →  ')),
          createElement('p', null, combination.note),
        ),
      ),
    ),
    createElement(
      'p',
      { className: 'nwe-tutorial-note' },
      createElement('strong', null, '边界：'),
      ' /novel 不带参数等于 status；/novel projects --yes 必须和 --prune 一起用；/novel scan 不选书，--register 只登记；/novel resume 只读。短命令不会改变能力，只是 /novel 子命令的别名。',
    ),
  )
}

const tutorialDialog = (onClose: () => void, closeRef: RefObject<HTMLButtonElement | null>): ReactElement =>
  createElement(
    'div',
    {
      className: 'nwe-modal-backdrop',
      onMouseDown: (event: ReactMouseEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget) onClose()
      },
    },
    createElement(
      'div',
      {
        className: 'nwe-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'nwe-help-title',
        'aria-describedby': 'nwe-help-sub',
        tabIndex: -1,
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>): void => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
          )
          if (focusable.length === 0) return
          const first = focusable[0]!
          const last = focusable[focusable.length - 1]!
          if (event.shiftKey && globalThis.document?.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && globalThis.document?.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        },
      },
      createElement(
        'div',
        { className: 'nwe-modal-head' },
        createElement(
          'div',
          { className: 'nwe-modal-heading' },
          createElement('div', { className: 'nwe-eyebrow' }, 'USER GUIDE · 插件教程'),
          createElement(
            'h2',
            { className: 'nwe-modal-title', id: 'nwe-help-title' },
            '从开书到导出：完整走一遍',
          ),
          createElement(
            'p',
            { className: 'nwe-modal-sub', id: 'nwe-help-sub' },
            '这是网文工坊的状态机教程。照着做，不需要记文件名，也不需要自己维护状态。',
          ),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'nwe-modal-close',
            ref: closeRef,
            onClick: onClose,
            'aria-label': '关闭使用教程',
          },
          createElement('span', { 'aria-hidden': 'true' }, '×'),
        ),
      ),
      createElement(
        'div',
        { className: 'nwe-modal-body' },
        createElement(
          'div',
          { className: 'nwe-tutorial-intro' },
          createElement(
            'p',
            null,
            '网文工坊不是一个“帮你想剧情”的按钮，而是一台有状态的写作引擎：你提供内容，引擎负责阶段、字数、门控、评审、归档和文件。',
          ),
          createElement(
            'p',
            null,
            '每一步都先领取当前阶段的任务书，再提交；提交后看引擎返回的 blocking 与下一步。面板只读，真正的写操作都在对话里的工具调用中。',
          ),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '开始前：记住三件事'),
          createElement(
            'div',
            { className: 'nwe-tutorial-cards' },
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '只用引擎入口写'),
              createElement(
                'span',
                null,
                '正文只走 novel_write_draft / novel_revise；状态只走工具。手改 chapters/、state/、outline/ 会破坏事务与校验。',
              ),
            ),
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '每一步先领 brief'),
              createElement(
                'span',
                null,
                '任务书携带当前上下文和 digest；跳过它会撞 PG-01。任务书过期就重新领取，不要复用旧上下文。',
              ),
            ),
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '失败先读 code'),
              createElement(
                'span',
                null,
                '参数错改参数，门控没过改正文，系统故障查目录/稍后重试。blocking 会一次列全，一次改完再交。',
              ),
            ),
          ),
          createElement(
            'p',
            { className: 'nwe-tutorial-note' },
            createElement('strong', null, '用哪个会话：'),
            ' 想获得完整的引擎保证，请新开一个「网文工坊」预设会话；普通会话里模型可能还挂着文件工具，能绕过引擎直接改稿。',
          ),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '一本书的完整流程'),
          createElement(
            'p',
            null,
            '前四步是开书准备，后面是每章循环。第一次先按顺序走完一章，熟悉后再批量推进整本。',
          ),
          createElement(
            'ol',
            { className: 'nwe-steps' },
            ...TUTORIAL_STEPS.map((step, index) => tutorialStep(step, index)),
          ),
        ),
        commandReferenceSection(),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '面板怎么看'),
          createElement(
            'div',
            { className: 'nwe-tutorial-cards' },
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '顶部统计'),
              createElement(
                'span',
                null,
                '已归档章、总字数、平均分、待处理门控。数字来自引擎，不是正文估算。',
              ),
            ),
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '九阶段轨与下一步'),
              createElement('span', null, '亮起的阶段是当前进度，“下一步”卡会直接给出该调用的工具名。'),
            ),
            createElement(
              'div',
              { className: 'nwe-tutorial-card' },
              createElement('strong', null, '章节与门控'),
              createElement(
                'span',
                null,
                '章节卡展开可看字数、评分与状态；门控区按 code/detail/hint 列出所有阻塞。',
              ),
            ),
          ),
          createElement(
            'p',
            { className: 'nwe-tutorial-note' },
            createElement('strong', null, '刷新：'),
            ' 面板每 15 秒静默同步一次，也可以点右上角刷新。它是只读投影；不会替你改稿、归档或修状态。',
          ),
          createElement(
            'p',
            { className: 'nwe-tutorial-note' },
            createElement('strong', null, '项目状态：'),
            '选择器里 choose 表示发现多本书、还没选；项目不在了表示目录缺失，绑定仍会保留；不是项目表示目录还在但没有 novel.yaml 或项目状态；项目不可读表示权限或 IO 错误，先修权限或换一本。面板选择只影响查看，不改变任何会话的写作绑定。',
          ),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '卡住时先看这里'),
          createElement(
            'ul',
            { className: 'nwe-faq' },
            createElement(
              'li',
              null,
              createElement('strong', null, '为什么一直让我先领 brief？'),
              createElement(
                'p',
                null,
                '这是正常门控。任务书决定当前阶段可用的字段与上下文 digest；先按返回值调用 novel_brief，再继续。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '门控失败，改一条还是全改？'),
              createElement(
                'p',
                null,
                '一次看完所有 blocking，再一起改。逐条试会反复烧掉阶段轮次；错误里的 code 会告诉你属于参数、门控还是系统故障。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '字数和评分为什么对不上？'),
              createElement(
                'p',
                null,
                '字数以 engine 返回为准，可用 novel_word_count 核对；review 的 total 必须等于 150 减全部扣分，不能另算一套。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, 'P4/P6 过不去怎么办？'),
              createElement(
                'p',
                null,
                'P4 有 blocker 就领 P5 任务书修订，再回 P4 重评；P6 失败同样回修订。不要 waive blocker，也不要只跑半个 scope 就归档。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '想改已经归档的章节？'),
              createElement(
                'p',
                null,
                '先 novel_reopen，带非空 reason。它会从归档备份恢复，重开后重新走 P3→P8；不要直接编辑归档卡或正文文件。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '状态文档坏了能手工修吗？'),
              createElement(
                'p',
                null,
                '先用 novel_state 看 raw 和 next；需要修复时用 novel_amend，并在 reason 写清原因。手改 YAML 会丢失事务保护。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '有多个项目，面板看的是哪本？'),
              createElement(
                'p',
                null,
                '面板用顶部项目选择器切换查看对象；选择只改 ?root= 和浏览器 localStorage，不调用 activate、不写会话绑定。写作项目请用 /novel use 或显式 project_root。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '选错书、想清掉绑定怎么办？'),
              createElement(
                'p',
                null,
                '先用 /novel current 看当前会话绑定；要换书用 /novel use <路径|书名|.>，要清掉只影响当前会话的绑定用 /novel unbind。不要靠 active 猜，也不要手改 state/session-bindings.yaml。',
              ),
            ),
            createElement(
              'li',
              null,
              createElement('strong', null, '扫描到了，为什么还没切过去？'),
              createElement(
                'p',
                null,
                'scan 只读发现；scan --register 只登记项目，不选择、不改 active、不绑会话。真正切换写作项目要用 /novel use，或第一次调用显式传 project_root。',
              ),
            ),
          ),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '可以直接复制给模型的起手话术'),
          createElement(CopyPrompt, { text: TUTORIAL_PROMPT, label: '复制起手话术' }),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '续写下一章时，直接复制这段给 Agent'),
          createElement(
            'p',
            null,
            '这段会先确认状态，再处理缺章卡和目标章数已满，最后按 P1→P8 推进；归档前会要求你确认 state_delta。',
          ),
          createElement(CopyPrompt, { text: TUTORIAL_NEXT_PROMPT, label: '复制续写指令' }),
        ),
        createElement(
          'section',
          { className: 'nwe-tutorial-block' },
          createElement('h3', null, '一章完成检查清单'),
          createElement(
            'ul',
            { className: 'nwe-checklist' },
            createElement('li', null, '本章 P1/P2 计划已提交，P3 正文已通过格式与字数门控。'),
            createElement('li', null, 'P4 评审 total 对账无误，没有未修 blocker。'),
            createElement('li', null, 'P6 五个语义项都有不同句子的正文引用，完整 scope 通过。'),
            createElement('li', null, 'P8 任务书当前，novel_archive 带完整 state_delta 成功。'),
            createElement('li', null, '面板出现已归档章节，门控区没有新的阻塞。'),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'nwe-modal-foot' },
        `教程基于 ${PANEL_VERSION} · 具体字段以当前任务书和工具返回为准 · 面板只读`,
      ),
    ),
  )

const NovelHelp = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(false)
  const close = useCallback((): void => setOpen(false), [])

  useEffect(() => {
    const doc = globalThis.document
    if (doc === undefined) return
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false
        triggerRef.current?.focus()
      }
      return
    }
    wasOpen.current = true
    const previousOverflow = doc.body.style.overflow
    doc.body.style.overflow = 'hidden'
    const panelRoot =
      triggerRef.current?.closest('[data-plugin="dsh-novel-write-engine"]') ??
      doc.querySelector('[data-plugin="dsh-novel-write-engine"]')
    const inerted: Array<{ element: Element; inert: string | null; aria: string | null }> = []
    if (panelRoot !== null) {
      for (const child of Array.from(panelRoot.children)) {
        if (child.classList.contains('nwe-modal-backdrop')) continue
        inerted.push({
          element: child,
          inert: child.getAttribute('inert'),
          aria: child.getAttribute('aria-hidden'),
        })
        child.setAttribute('inert', '')
        child.setAttribute('aria-hidden', 'true')
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    doc.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => {
      doc.removeEventListener('keydown', onKeyDown)
      doc.body.style.overflow = previousOverflow
      for (const item of inerted) {
        if (item.inert === null) item.element.removeAttribute('inert')
        else item.element.setAttribute('inert', item.inert)
        if (item.aria === null) item.element.removeAttribute('aria-hidden')
        else item.element.setAttribute('aria-hidden', item.aria)
      }
    }
  }, [open])

  const doc = (globalThis as { document?: Document }).document
  const panelRoot =
    triggerRef.current?.closest('[data-plugin="dsh-novel-write-engine"]') ??
    doc?.querySelector('[data-plugin="dsh-novel-write-engine"]') ??
    null
  const dialog = open ? tutorialDialog(close, closeRef) : null
  const overlay = dialog !== null && panelRoot !== null ? createPortal(dialog, panelRoot) : dialog
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'nwe-help',
        ref: triggerRef,
        onClick: (): void => setOpen(true),
        'aria-label': '打开插件使用教程',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: '插件使用教程',
      },
      helpIcon(),
      createElement('span', { className: 'nwe-help-label' }, '教程'),
    ),
    overlay,
  )
}

const trendChart = (view: PanelView): ReactElement => {
  const values = view.quality.scores.filter((score) => Number.isFinite(score)).slice(-10)
  const width = 720
  const height = 196
  const left = 38
  const right = 16
  const top = 16
  const bottom = 30
  const innerWidth = width - left - right
  const innerHeight = height - top - bottom
  const max = 150
  const x = (index: number): number =>
    values.length <= 1 ? left + innerWidth / 2 : left + (index / (values.length - 1)) * innerWidth
  const y = (score: number): number =>
    top + innerHeight - (Math.max(0, Math.min(max, score)) / max) * innerHeight
  const points = values.map((score, index) => ({ x: x(index), y: y(score), score }))
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const area =
    points.length === 0
      ? ''
      : `M ${points[0]!.x.toFixed(1)} ${(top + innerHeight).toFixed(1)} L ${line.replaceAll(' ', ' L ')} L ${points[points.length - 1]!.x.toFixed(1)} ${(top + innerHeight).toFixed(1)} Z`
  return createElement(
    'section',
    { className: 'nwe-viz-card nwe-viz-trend', 'aria-label': '章节评分趋势' },
    createElement(
      'div',
      { className: 'nwe-viz-head' },
      createElement(
        'div',
        { className: 'nwe-viz-title' },
        sectionGlyph('chart', 16),
        createElement('span', null, '评分趋势'),
      ),
      createElement(
        'span',
        { className: 'nwe-viz-note' },
        values.length === 0 ? '还没有评审' : `最近 ${values.length} 章 · 满分 ${max}`,
      ),
    ),
    values.length === 0
      ? createElement('div', { className: 'nwe-viz-empty' }, '完成 P4 评审后，这里会出现逐章评分曲线。')
      : createElement(
          'div',
          { className: 'nwe-trend-wrap' },
          createElement(
            'svg',
            {
              className: 'nwe-trend-chart',
              viewBox: `0 0 ${width} ${height}`,
              role: 'img',
              'aria-label': `最近 ${values.length} 章评分趋势，最低 ${Math.min(...values)}，最高 ${Math.max(...values)}，满分 150`,
            },
            createElement(
              'defs',
              null,
              createElement(
                'linearGradient',
                { id: 'nwe-trend-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
                createElement('stop', {
                  offset: '0%',
                  style: { stopColor: 'var(--nwe-gold)', stopOpacity: 0.3 },
                }),
                createElement('stop', {
                  offset: '100%',
                  style: { stopColor: 'var(--nwe-gold)', stopOpacity: 0 },
                }),
              ),
            ),
            ...[0, 0.5, 1].map((ratio) => {
              const gridY = top + innerHeight - ratio * innerHeight
              return createElement(
                'g',
                { key: `grid-${ratio}` },
                createElement('line', {
                  x1: left,
                  x2: width - right,
                  y1: gridY,
                  y2: gridY,
                  style: { stroke: 'var(--nwe-border)', strokeDasharray: ratio === 0 ? undefined : '3 5' },
                }),
                createElement(
                  'text',
                  {
                    x: left - 9,
                    y: gridY + 4,
                    textAnchor: 'end',
                    style: { fill: 'var(--nwe-muted)', fontSize: 10 },
                  },
                  String(Math.round(max * ratio)),
                ),
              )
            }),
            createElement('path', { d: area, style: { fill: 'url(#nwe-trend-fill)' } }),
            createElement('polyline', {
              points: line,
              style: {
                fill: 'none',
                stroke: 'var(--nwe-gold)',
                strokeWidth: 2.4,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
              },
            }),
            ...points.map((point, index) =>
              createElement(
                'g',
                { key: `point-${index}` },
                createElement('circle', {
                  cx: point.x,
                  cy: point.y,
                  r: 3.5,
                  style: { fill: 'var(--nwe-surface)', stroke: 'var(--nwe-gold)', strokeWidth: 2 },
                }),
                createElement('title', null, `第 ${index + 1} 个样本 · ${point.score} / 150`),
              ),
            ),
            createElement(
              'text',
              {
                x: left,
                y: height - 8,
                style: { fill: 'var(--nwe-muted)', fontSize: 10 },
              },
              `最近 ${values.length} 章`,
            ),
          ),
        ),
  )
}

const wordChart = (view: PanelView): ReactElement => {
  const rows = view.rows.slice(-8)
  const max = Math.max(1, ...rows.map((row) => row.wordCount))
  return createElement(
    'section',
    { className: 'nwe-viz-card nwe-viz-words', 'aria-label': '章节字数分布' },
    createElement(
      'div',
      { className: 'nwe-viz-head' },
      createElement(
        'div',
        { className: 'nwe-viz-title' },
        sectionGlyph('book', 16),
        createElement('span', null, '章节字数'),
      ),
      createElement(
        'span',
        { className: 'nwe-viz-note' },
        rows.length === 0 ? '还没有章节' : `最近 ${rows.length} 章 · 峰值 ${max.toLocaleString('zh-CN')}`,
      ),
    ),
    rows.length === 0
      ? createElement('div', { className: 'nwe-viz-empty' }, '归档第一章后，这里会出现字数柱状图。')
      : createElement(
          'div',
          {
            className: 'nwe-word-chart',
            role: 'img',
            'aria-label': `最近 ${rows.length} 章字数分布，峰值 ${max.toLocaleString('zh-CN')} 字`,
          },
          ...rows.map((row) => {
            return createElement(
              'div',
              { className: 'nwe-word-col', key: `word-${row.num}` },
              createElement('span', { className: 'nwe-word-value' }, row.wordCount.toLocaleString('zh-CN')),
              createElement(
                'div',
                {
                  className: 'nwe-word-track',
                  title: `第 ${row.num} 章 · ${row.wordCount.toLocaleString('zh-CN')} 字`,
                },
                createElement('span', {
                  style: {
                    display: 'block',
                    flex: '0 0 auto',
                    width: '24px',
                    height: `${Math.max(4, Math.round((row.wordCount / max) * 142))}px`,
                    maxHeight: '100%',
                    backgroundColor: 'var(--nwe-gold)',
                    borderRadius: '4px 4px 2px 2px',
                  },
                }),
              ),
              createElement('span', { className: 'nwe-word-label' }, `第${row.num}章`),
            )
          }),
        ),
  )
}

const overviewCharts = (view: PanelView): ReactElement =>
  createElement('div', { className: 'nwe-overview-charts' }, trendChart(view), wordChart(view))

const bookGlance = (view: PanelView): ReactElement => {
  const target = view.book.target ?? view.book.outlineTotal
  const percent =
    view.book.archivedCoverage === null
      ? target === 0
        ? 0
        : Math.round((view.book.archivedCards / target) * 100)
      : Math.round(view.book.archivedCoverage * 100)
  return createElement(
    'section',
    { className: 'nwe-glance', 'aria-label': '全书概览' },
    createElement(
      'div',
      { className: 'nwe-glance-head' },
      createElement('span', { className: 'nwe-desk-kicker' }, '全书'),
      createElement('span', { className: 'nwe-desk-note' }, view.book.present ? '已规划' : '未规划'),
    ),
    createElement('h2', { className: 'nwe-glance-title' }, view.book.premise || '这本书还没有蓝图'),
    createElement(
      'p',
      { className: 'nwe-glance-text' },
      view.book.logline || '补全书级蓝图、卷卡和世界观后，写作会更稳定。',
    ),
    createElement(
      'div',
      {
        className: 'nwe-glance-bar',
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.min(100, Math.max(0, percent)),
        'aria-label': '全书归档进度',
      },
      createElement('span', { style: { width: `${Math.min(100, Math.max(0, percent))}%` } }),
    ),
    createElement(
      'div',
      { className: 'nwe-glance-legend' },
      createElement('span', null, `${view.book.archivedCards} / ${target === 0 ? '—' : target} 章`),
      createElement('span', null, `${percent}% 已归档`),
    ),
    createElement(
      'dl',
      { className: 'nwe-glance-facts' },
      createElement(
        'div',
        null,
        createElement('dt', null, '计划卡'),
        createElement('dd', null, String(view.book.planned)),
      ),
      createElement(
        'div',
        null,
        createElement('dt', null, '卷'),
        createElement('dd', null, String(view.book.volumes.length)),
      ),
      createElement(
        'div',
        null,
        createElement('dt', null, '待处理'),
        createElement('dd', null, String(view.health.blocking)),
      ),
    ),
  )
}

const nextCard = (view: PanelView): ReactElement =>
  createElement(
    'section',
    { className: 'nwe-next', 'aria-label': '下一步' },
    createElement('div', { className: 'nwe-next-icon' }, arrowIcon()),
    createElement(
      'div',
      { className: 'nwe-next-body' },
      createElement('div', { className: 'nwe-next-kicker' }, '当前阶段 · 下一步'),
      createElement('div', { className: 'nwe-next-title' }, view.nextTitle),
      createElement('div', { className: 'nwe-next-detail' }, view.nextDetail),
      createElement(CopyResumeButton, { text: view.resumeText }),
    ),
    createElement(
      'div',
      { className: 'nwe-next-meta' },
      createElement('span', null, view.chapter > 0 ? `第 ${view.chapter} 章` : '未开始'),
      createElement('span', null, view.stageLabel),
      view.nextTool === '' ? null : createElement('code', { className: 'nwe-next-tool' }, view.nextTool),
    ),
  )

const blockingSection = (view: PanelView): ReactElement =>
  createElement(
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
              { className: 'nwe-block', key: `${item.code}-${item.scope}-${item.detail}` },
              createElement('span', { className: 'nwe-block-icon', 'aria-hidden': 'true' }, '!'),
              createElement(
                'div',
                null,
                createElement('div', { className: 'nwe-block-code' }, item.code),
                createElement('div', { className: 'nwe-block-detail' }, item.detail),
                item.hint === '' ? null : createElement('div', { className: 'nwe-block-hint' }, item.hint),
              ),
            ),
          ),
        ),
  )

const chaptersSection = (view: PanelView): ReactElement =>
  createElement(
    'section',
    { className: 'nwe-section nwe-chapters-section' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '章节'),
      createElement(
        'span',
        { className: 'nwe-section-note' },
        `${view.stats.chapters} 已归档 · 显示 ${view.rows.length} 条${
          view.stats.chapters > view.rows.filter((row) => row.tone === 'ok').length
            ? `（最近 ${view.rows.length} 条）`
            : ''
        }`,
      ),
    ),
    view.rows.length === 0
      ? createElement(
          'div',
          { className: 'nwe-empty', style: { marginTop: 12, minHeight: 170 } },
          createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
          createElement('div', { className: 'nwe-state-title' }, '书架还是空的'),
          createElement('div', { className: 'nwe-state-text' }, '完成第一次归档后，章节会出现在这里。'),
        )
      : createElement(
          'ul',
          { className: 'nwe-chapters' },
          ...view.rows.slice(-PANEL_CHAPTER_LIMIT).map(chapterCard),
        ),
  )

const v6Kv = (entries: Array<[string, string]>): ReactElement =>
  createElement(
    'ul',
    { className: 'nwe-v6-list' },
    ...entries.map(([key, value]) =>
      createElement('li', { key }, createElement('b', null, key), createElement('span', null, value)),
    ),
  )

const INFO_GLYPHS: Record<string, SectionGlyph> = {
  bp: 'map',
  progress: 'chart',
  volumes: 'book',
  cast: 'person',
  world: 'map',
  foreshadow: 'seed',
  quality: 'chart',
  health: 'shield',
}

const infoCard = (
  key: string,
  title: string,
  children: Array<ReactElement | null>,
  open = false,
): ReactElement =>
  createElement(
    'details',
    { className: 'nwe-info-card', key, ...(open ? { open: true } : {}) },
    createElement(
      'summary',
      { className: 'nwe-info-card-head' },
      createElement(
        'span',
        { className: 'nwe-info-card-icon', 'aria-hidden': 'true' },
        sectionGlyph(INFO_GLYPHS[key] ?? 'book', 16),
      ),
      createElement('strong', { className: 'nwe-info-card-title' }, title),
      createElement('span', { className: 'nwe-info-card-caret', 'aria-hidden': 'true' }, '+'),
    ),
    createElement(
      'div',
      {
        className: 'nwe-info-card-body',
        role: 'region',
        'aria-label': `${title} 内容`,
        tabIndex: 0,
      },
      ...children,
    ),
  )

const bookDataSection = (view: PanelView): ReactElement | null => {
  const data = view.bookData
  if (data === null) return null
  const currentLabel =
    data.current.stage === 'done'
      ? data.progress.target !== null && data.progress.archived >= data.progress.target
        ? '全书完成'
        : `下一章 ${data.current.chapter} · 未开始`
      : `${data.current.chapter} · ${data.current.stage}`
  const dims = data.quality.dimensions.map((dimension) =>
    createElement(
      'div',
      { className: 'nwe-v6-bar', key: dimension.id },
      createElement('span', null, dimension.id),
      createElement(
        'span',
        {
          role: 'progressbar',
          'aria-label': `${dimension.id} 得分`,
          'aria-valuemin': 0,
          'aria-valuemax': dimension.max === undefined || dimension.max <= 0 ? 10 : dimension.max,
          'aria-valuenow': dimension.average,
        },
        createElement('i', {
          style: {
            width: `${Math.min(
              100,
              Math.max(
                0,
                (dimension.average /
                  (dimension.max === undefined || dimension.max <= 0 ? 10 : dimension.max)) *
                  100,
              ),
            )}%`,
          },
        }),
      ),
      createElement('span', null, dimension.samples === 0 ? '—' : dimension.average.toFixed(1)),
    ),
  )
  const worldEntries = (
    entries: Array<{ name: string; description: string; anchors?: string[] }>,
  ): ReactElement[] =>
    entries.map((entry) =>
      createElement(
        'li',
        { key: entry.name },
        createElement('b', null, entry.name),
        createElement('span', null, entry.description),
        entry.anchors === undefined || entry.anchors.length === 0
          ? null
          : createElement('span', { className: 'nwe-v6-note' }, `锚点：${entry.anchors.join(' / ')}`),
      ),
    )
  return createElement(
    'section',
    { className: 'nwe-section', 'aria-label': '书籍数据' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '这本书'),
      createElement('span', { className: 'nwe-section-note' }, '只读投影 · 不含正文'),
    ),
    createElement(
      'div',
      { className: 'nwe-info-grid' },
      infoCard(
        'bp',
        '书脊与蓝图',
        [
          v6Kv([
            ['作者', data.identity.author || '未填写'],
            ['简介', data.identity.description || '未填写'],
            ['创建', localTime(data.identity.created_at)],
            [
              '目标',
              `${data.identity.targets.words_per_chapter[0]}–${data.identity.targets.words_per_chapter[1]} 字 / 章 · ${data.identity.targets.total_chapters ?? '不限'} 章`,
            ],
            ['主题', data.blueprint.themes.join(' / ') || '—'],
            ['基调 / POV', `${data.blueprint.tone || '—'} / ${data.blueprint.pov || '—'}`],
            [
              '读者 / 卖点',
              `${data.blueprint.audience || '—'} / ${data.blueprint.selling_points.join(' / ') || '—'}`,
            ],
            ['结局', data.blueprint.ending || '—'],
          ]),
          createElement(
            'p',
            { className: 'nwe-v6-note' },
            data.blueprint.logline || data.blueprint.premise || '还没有蓝图摘要',
          ),
        ],
        true,
      ),
      infoCard('progress', '进度与当前章', [
        v6Kv([
          ['已归档', `${data.progress.archived} / ${data.progress.target ?? '不限'} 章`],
          ['字数', `归档 ${data.progress.words_archived} · 含草稿 ${data.progress.words_with_draft}`],
          [
            '剩余',
            data.progress.remaining_words === null
              ? '—'
              : `${data.progress.remaining_words} 字（${remainingBasisLabel(data.progress.remaining_words_basis)}）`,
          ],
          ['当前章', `${currentLabel} · ${data.current.card?.title ?? '无章卡'}`],
          [
            '轮次',
            `评 ${data.current.rounds.review} / 修 ${data.current.rounds.revise} / 检 ${data.current.rounds.check}`,
          ],
          ['正文 hash', data.current.manuscript_hash ?? '—'],
          ['当前字数', data.current.metrics === null ? '—' : String(data.current.metrics.total_word_count)],
        ]),
        data.current.card === null
          ? null
          : createElement(
              'div',
              { className: 'nwe-v6-tags' },
              ...data.current.card.cast.map((name) => createElement('span', { key: name }, name)),
            ),
      ]),
      infoCard('volumes', '卷进度', [
        view.book.volumes.length === 0
          ? createElement('p', { className: 'nwe-v6-note' }, '还没有卷')
          : createElement(
              'ul',
              { className: 'nwe-v6-list' },
              ...view.book.volumes.map((volume) =>
                createElement(
                  'li',
                  { key: `${volume.title}-${volume.range}` },
                  createElement('b', null, volume.title),
                  createElement(
                    'span',
                    null,
                    `${volume.range} · ${volume.planned} 计划 / ${volume.archived} 归档`,
                  ),
                ),
              ),
            ),
      ]),
      infoCard('cast', '人物与关系', [
        v6Kv([
          ['角色总数', String(data.cast.total)],
          [
            '关系',
            `${data.relationships.total} 条 · ${
              Object.entries(data.relationships.types)
                .map(([type, count]) => `${type} ${count}`)
                .join(' / ') || '—'
            }`,
          ],
        ]),
        createElement(
          'ul',
          { className: 'nwe-v6-list' },
          ...data.cast.top.map((person) =>
            createElement(
              'li',
              { key: person.name },
              createElement('b', null, person.name),
              createElement(
                'span',
                null,
                `${person.role} · 出场 ${person.appearances} · 最近第 ${person.last_seen} 章`,
              ),
            ),
          ),
        ),
      ]),
      infoCard('world', '世界与设定', [
        v6Kv([
          ['地点 / 势力', `${data.worldbook.counts.locations} / ${data.worldbook.counts.factions}`],
          ['规则 / 术语', `${data.worldbook.counts.rules} / ${data.worldbook.counts.glossary}`],
          ['前史 / 数值事实', `${data.worldbook.counts.backstory} / ${data.worldbook.counts.facts ?? 0}`],
        ]),
        createElement('ul', { className: 'nwe-v6-list' }, ...worldEntries(data.worldbook.locations)),
        createElement('ul', { className: 'nwe-v6-list' }, ...worldEntries(data.worldbook.factions)),
        createElement('ul', { className: 'nwe-v6-list' }, ...worldEntries(data.worldbook.rules)),
        ...data.worldbook.facts.map((fact) =>
          createElement(
            'p',
            { className: 'nwe-v6-note', key: fact.alias },
            `${fact.alias} = ${fact.value} ${fact.unit}`,
          ),
        ),
      ]),
      infoCard('foreshadow', '伏笔与时间线', [
        v6Kv([
          [
            '伏笔',
            `未解 ${data.foreshadows.open} · 休眠 ${data.foreshadows.dormant} · 逾期 ${data.foreshadows.overdue} · 已解 ${data.foreshadows.resolved}`,
          ],
          [
            '时间线',
            `${data.timeline.events} 个事件 · 第 ${data.timeline.first_chapter ?? '—'}–${data.timeline.last_chapter ?? '—'} 章`,
          ],
        ]),
        createElement(
          'ul',
          { className: 'nwe-v6-list' },
          ...data.foreshadows.oldest.map((item) =>
            createElement(
              'li',
              { key: item.id },
              createElement('b', null, item.id),
              createElement('span', null, `${item.title} · 已 ${item.age} 章`),
            ),
          ),
        ),
      ]),
      infoCard('quality', '质量与节奏', [
        v6Kv([
          [
            '全书均分',
            `${data.quality.average.toFixed(1)} · 中位 ${data.quality.median.toFixed(1)} · ${data.quality.min}–${data.quality.max}`,
          ],
          [
            '近十均分',
            data.quality.last_ten_average === null ? '—' : data.quality.last_ten_average.toFixed(1),
          ],
          [
            '样本 / 评审',
            data.quality.samples === 0 ? '见质量页' : `${data.quality.samples} / ${data.quality.attempts}`,
          ],
          [
            '趋势',
            data.quality.trend === null
              ? data.quality.samples === 0
                ? '见质量页'
                : data.quality.trend_basis === 'insufficient_samples'
                  ? '样本不足'
                  : data.quality.trend_basis === 'insufficient_history'
                    ? '历史不足'
                    : '最近五章对比前五章'
              : `${data.quality.trend >= 0 ? '+' : ''}${data.quality.trend}`,
          ],
          ['节奏', countsText(data.pacing.scene_types)],
          [
            '钩子 / 推进',
            `${countsText(data.pacing.hook_strength, hookLabel)} / ${countsText(data.pacing.plot_advancement, plotLabel)}`,
          ],
          [
            '最长 / 最短',
            data.pacing.longest === null
              ? '—'
              : `第 ${data.pacing.longest.chapter} 章 ${data.pacing.longest.words} 字 / 第 ${data.pacing.shortest?.chapter ?? '—'} 章 ${data.pacing.shortest?.words ?? '—'} 字`,
          ],
          [
            '返工',
            `评 ${data.effort.reviews} · 修 ${data.effort.revisions} · 检 ${data.effort.checks} · 回滚 ${data.effort.rollbacks}`,
          ],
        ]),
        dims.length === 0
          ? createElement(
              'div',
              { className: 'nwe-v6-note' },
              '质量维度请切换到「质量」页查看；概览只取轻量摘要。',
            )
          : createElement('div', { className: 'nwe-v6-bars', 'aria-label': '十五维质量' }, ...dims),
        foldBlock(
          'effort',
          '逐章 effort',
          createElement(
            'ul',
            { className: 'nwe-v6-list' },
            ...data.effort.chapters.map((chapter) =>
              createElement(
                'li',
                { key: chapter.num },
                createElement('b', null, `第 ${chapter.num} 章`),
                createElement(
                  'span',
                  null,
                  `评 ${chapter.reviews} / 修 ${chapter.revisions} / 检 ${chapter.checks} / 回滚 ${chapter.rollbacks} · ${finalCheckLabel(chapter.final_check)}`,
                ),
              ),
            ),
          ),
          { meta: `${data.effort.chapters.length} 章` },
        ),
      ]),
      infoCard('health', '健康与恢复', [
        v6Kv([
          [
            '大纲',
            data.health.outline.present ? '可读' : data.health.outline.error === null ? '还没有大纲' : '损坏',
          ],
          [
            '世界观',
            data.health.worldbook.present
              ? '可读'
              : data.health.worldbook.error === null
                ? '还没有设定'
                : '损坏',
          ],
          [
            'pending',
            data.health.pending === null
              ? '无'
              : `${statusLabel(data.health.pending.state)} · ${data.health.pending.detail}`,
          ],
        ]),
        data.health.outline.error === null
          ? null
          : createElement('p', { className: 'nwe-v6-note' }, data.health.outline.error),
        data.health.worldbook.error === null
          ? null
          : createElement('p', { className: 'nwe-v6-note' }, data.health.worldbook.error),
        createElement(
          'ul',
          { className: 'nwe-v6-list' },
          ...data.health.state_errors.map((error) =>
            createElement(
              'li',
              { key: `${error.path}:${error.code}` },
              createElement('b', null, error.code),
              createElement('span', null, `${error.path}: ${error.message}`),
            ),
          ),
        ),
      ]),
    ),
  )
}

const bookDossier = (view: PanelView): ReactElement | null => {
  const body = bookDataSection(view) ?? bookSection(view)
  if (body === null) return null
  return createElement(
    'details',
    { className: 'nwe-dossier', id: 'nwe-dossier' },
    createElement(
      'summary',
      null,
      createElement(
        'span',
        { className: 'nwe-dossier-icon', 'aria-hidden': 'true' },
        sectionGlyph('book', 16),
      ),
      createElement(
        'span',
        { className: 'nwe-dossier-copy' },
        createElement('strong', { className: 'nwe-dossier-title' }, '全书资料'),
        createElement('span', { className: 'nwe-dossier-note' }, '蓝图 · 卷卡 · 世界 · 质量 · 健康'),
      ),
      createElement('span', { className: 'nwe-dossier-caret', 'aria-hidden': 'true' }, '+'),
    ),
    createElement(
      'div',
      {
        className: 'nwe-dossier-body',
        role: 'region',
        'aria-label': '全书资料内容',
        tabIndex: 0,
      },
      body,
    ),
  )
}

export type PanelTab =
  'overview' | 'chapters' | 'characters' | 'foreshadows' | 'worldbook' | 'quality' | 'health'

const PANEL_TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'chapters', label: '章节' },
  { id: 'characters', label: '人物' },
  { id: 'foreshadows', label: '线索' },
  { id: 'worldbook', label: '设定' },
  { id: 'quality', label: '质量' },
  { id: 'health', label: '健康' },
]

export interface PanelSectionState {
  loading: boolean
  error: string | null
  payload: PanelPayloadDto | null
}

export interface ChapterQuery {
  search: string
  status: 'all' | 'archived' | 'draft'
  scene: string
  sort: 'num_asc' | 'num_desc'
  cursor: string
}

export interface ChapterDetailState {
  chapter: number
  section: PanelSectionState
}

const EMPTY_CHAPTER_QUERY: ChapterQuery = {
  search: '',
  status: 'all',
  scene: '',
  sort: 'num_desc',
  cursor: '',
}

type SectionTab = Exclude<PanelTab, 'overview'>

const TAB_META: Record<SectionTab, { title: string; desc: string; glyph: SectionGlyph }> = {
  chapters: {
    title: '章节台账',
    desc: '按章查看状态、字数、评分与归档结果；点开详情可读正文和归档 plan。',
    glyph: 'book',
  },
  characters: {
    title: '人物档案',
    desc: '在场人物、首次出场、最近状态与成长轨迹，按档案卡分组呈现。',
    glyph: 'person',
  },
  foreshadows: {
    title: '线索网络',
    desc: '伏笔、时间线与人物关系同屏对照，避免线索在长书里失联。',
    glyph: 'seed',
  },
  worldbook: {
    title: '世界设定',
    desc: '蓝图、地点、势力、规则与数值事实的统一索引，所有条目可展开。',
    glyph: 'map',
  },
  quality: {
    title: '质量剖面',
    desc: '全书评分、可读评审、十五维得分与节奏数据，定位需要返工的章节。',
    glyph: 'chart',
  },
  health: {
    title: '项目健康',
    desc: '大纲、设定与状态文件的完整性检查，把可修复的问题前置。',
    glyph: 'shield',
  },
}

const sectionItemCount = (section: PanelSectionState | null): number | undefined => {
  const payload = section?.payload
  if (payload === null || payload === undefined) return undefined
  if (Array.isArray(payload.items)) return payload.items.length
  const row = asRow(payload.items)
  if (row !== null) {
    const count = Object.values(row).reduce<number>(
      (total, value) => total + (Array.isArray(value) ? value.length : 1),
      0,
    )
    if (count > 0) return count
  }
  return payload.total ?? payload.returned
}

const tabIntro = (tab: SectionTab, view: PanelView, section: PanelSectionState | null): ReactElement => {
  const meta = TAB_META[tab]
  const total = tab === 'chapters' ? view.stats.chapters : sectionItemCount(section)
  const note = total === undefined ? '只读投影' : tab === 'chapters' ? `${total} 章` : `${total} 条记录`
  return createElement(
    'header',
    { className: 'nwe-tab-intro' },
    createElement(
      'span',
      { className: 'nwe-tab-intro-icon', 'aria-hidden': 'true' },
      sectionGlyph(meta.glyph, 22),
    ),
    createElement(
      'div',
      { className: 'nwe-tab-intro-copy' },
      createElement('span', { className: 'nwe-tab-intro-kicker' }, 'WORKBENCH / READ MODEL'),
      createElement('h2', { className: 'nwe-tab-intro-title' }, meta.title),
      createElement('p', { className: 'nwe-tab-intro-desc' }, meta.desc),
    ),
    createElement('span', { className: 'nwe-tab-intro-count' }, note),
  )
}

const tabBar = (tab: PanelTab, onTab: (tab: PanelTab) => void): ReactElement =>
  createElement(
    'nav',
    { className: 'nwe-tabs', role: 'tablist', 'aria-label': '网文工坊栏目' },
    ...PANEL_TABS.map((item) =>
      createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'tab',
          id: `nwe-tab-${item.id}`,
          'aria-controls': `nwe-panel-${item.id}`,
          'aria-selected': tab === item.id,
          className: `nwe-tab${tab === item.id ? ' is-active' : ''}`,
          onClick: () => onTab(item.id),
        },
        item.label,
      ),
    ),
  )

const asRow = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const textOf = (value: unknown, fallback = '—'): string =>
  typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : fallback

const roleLabel = (value: unknown): string =>
  value === 'protagonist'
    ? '主角'
    : value === 'supporting'
      ? '配角'
      : value === 'extra'
        ? '龙套'
        : textOf(value)

const STATUS_LABELS: Record<string, string> = {
  planted: '已埋',
  advanced: '已推进',
  resolved: '已回收',
  archived: '已归档',
  draft: '草稿',
  dormant: '休眠',
  active: '在场',
  planned: '计划',
  writing: '写作中',
  done: '完成',
  open: '待处理',
  fixed: '已修复',
  waived: '已豁免',
  committed: '已提交',
  partial: '不完整',
  complete: '已完成',
  untouched: '未开始',
  recoverable: '可恢复',
  abortable: '可中止',
}

const statusLabel = (value: unknown): string =>
  typeof value === 'string' ? (STATUS_LABELS[value] ?? value) : textOf(value)

const finalCheckLabel = (value: unknown): string =>
  value === 'pass' ? '通过' : value === 'fail' ? '未过' : '—'

const remainingBasisLabel = (value: string): string =>
  value === 'actual_average'
    ? '按已归档章均字'
    : value === 'minimum_target'
      ? '按最低目标'
      : value === 'none'
        ? '无'
        : value

const countsText = (value: unknown, label: (key: string) => string = (key) => key): string => {
  const row = asRow(value)
  if (row === null) return textOf(value)
  const entries = Object.entries(row).filter(([, count]) => typeof count === 'number')
  return entries.length === 0 ? '—' : entries.map(([key, count]) => `${label(key)} ${count}`).join(' · ')
}

const hookLabel = (key: string): string =>
  key === '1'
    ? '弱'
    : key === '2'
      ? '较弱'
      : key === '3'
        ? '中'
        : key === '4'
          ? '较强'
          : key === '5'
            ? '强'
            : key

const plotLabel = (key: string): string =>
  key === 'high' ? '高' : key === 'mid' ? '中' : key === 'low' ? '低' : key

const sectionKv = (row: Record<string, unknown>): ReactElement => {
  const fields: Array<[string, string]> = [
    ['角色', roleLabel(row.role)],
    ['状态', statusLabel(row.status)],
    ['首次出场', textOf(row.first_appearance ?? row.first)],
    ['最近出场', textOf(row.last)],
    ['出场次数', textOf(row.appearances)],
    ['类型', textOf(row.type)],
    ['地点', textOf(row.location)],
    ['双方', row.a === undefined ? '—' : `${textOf(row.a)} ↔ ${textOf(row.b)}`],
    ['别名', textOf(row.alias)],
    ['数值', textOf(row.value)],
    ['单位', textOf(row.unit)],
    ['描述', textOf(row.description)],
    ['锚点', textOf(row.anchor)],
    ['容忍', textOf(row.tolerance)],
    ['备注', textOf(row.note)],
    ['推进记录', Array.isArray(row.advance_log) ? `${row.advance_log.length} 条` : '—'],
    ['成长', Array.isArray(row.growth) ? `${row.growth.length} 条` : '—'],
    ['当前状态', textOf(row.current_state)],
    ['人物档案', textOf(row.profile)],
    ['章龄', textOf(row.age)],
    ['术语', textOf(row.term)],
    ['释义', textOf(row.definition)],
    ['时间', textOf(row.time)],
    ['事件', textOf(row.event)],
  ]
  const used = new Set([
    'role',
    'status',
    'first_appearance',
    'first',
    'last',
    'appearances',
    'type',
    'location',
    'a',
    'b',
    'alias',
    'value',
    'unit',
    'description',
    'anchor',
    'tolerance',
    'note',
    'advance_log',
    'growth',
  ])
  const extraLabels: Record<string, string> = {
    average: '平均',
    samples: '可读评审',
    median: '中位',
    min: '最小',
    max: '最大',
    trend: '趋势',
    attempts: '评审轮次',
    reviews: '评',
    revisions: '修',
    checks: '检',
    rollbacks: '回滚',
    chapters: '章节',
    words: '字数',
    total: '总数',
    present: '存在',
    error: '错误',
    path: '路径',
    code: '代码',
    message: '信息',
    chapter: '章',
    field: '字段',
    planned: '计划',
    actual: '实际',
    state: '状态',
    detail: '详情',
    txid: '事务',
    num: '章号',
    scene_type: '场景',
    goal: '目标',
    conflict: '冲突',
    hook: '钩子',
    notes: '备注',
    story_time: '故事时间',
    since: '始于',
    word_count: '字数',
    score: '评分',
    archived_at: '归档时间',
    characters: '人物',
    evolution: '演变',
  }
  for (const [key, value] of Object.entries(row)) {
    if (used.has(key) || key === 'title' || key === 'name' || key === 'id') continue
    const label = extraLabels[key]
    if (key === 'archived_at') {
      fields.push([label, localTime(typeof value === 'string' ? value : null)])
      continue
    }
    if (
      label !== undefined &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    ) {
      fields.push([label, textOf(value)])
    }
  }
  const visible = fields.filter(([, value]) => value !== '—')
  return createElement(
    'dl',
    { className: 'nwe-kv' },
    ...visible.flatMap(([label, value]) => [
      createElement('dt', { key: `dt-${label}` }, label),
      createElement('dd', { key: `dd-${label}` }, value),
    ]),
  )
}

const SECTION_GLYPHS: Record<string, SectionGlyph> = {
  characters: 'person',
  foreshadows: 'seed',
  timeline: 'clock',
  relationships: 'link',
  rules: 'book',
  factions: 'shield',
  locations: 'map',
  glossary: 'book',
  backstory: 'clock',
  facts: 'chart',
  themes: 'spark',
  outline_cards: 'book',
  drift: 'alert',
  blueprint: 'map',
  'state-errors': 'alert',
  effort: 'heart',
  pacing: 'chart',
}

const sectionList = (title: string, items: unknown, kind: SectionGlyph = 'spark'): ReactElement => {
  if (!Array.isArray(items) || items.length === 0) {
    return createElement('div', { className: 'nwe-empty' }, `${title}：暂无数据`)
  }
  return createElement(
    'div',
    { className: 'nwe-card-grid' },
    ...items.map((item, index) => {
      const row = asRow(item)
      const explicitLabel =
        row === null
          ? undefined
          : row.a !== undefined && row.b !== undefined
            ? `${textOf(row.a)} ↔ ${textOf(row.b)}`
            : (row.title ?? row.name ?? row.id ?? row.alias ?? row.term ?? row.event ?? row.a)
      const label =
        row === null
          ? String(item)
          : textOf(
              row.chapter === undefined
                ? explicitLabel
                : `第 ${textOf(row.chapter)} 章${row.time === undefined ? '' : ` · ${textOf(row.time)}`}`,
              explicitLabel === undefined ? title : textOf(explicitLabel),
            )
      const note =
        row === null
          ? ''
          : textOf(
              row.current_state ??
                row.profile ??
                row.description ??
                row.definition ??
                row.layout ??
                row.goal ??
                row.note ??
                (row.value === undefined
                  ? row.event !== undefined && row.time !== undefined
                    ? row.time
                    : undefined
                  : `${textOf(row.value)}${row.unit === undefined ? '' : ` ${textOf(row.unit)}`}`),
              '',
            )
      const chips =
        row === null
          ? []
          : [
              row.role === undefined ? '' : roleLabel(row.role),
              row.status === undefined ? '' : statusLabel(row.status),
              row.first_appearance === undefined ? '' : `首次 ${textOf(row.first_appearance)}`,
              row.last === undefined ? '' : `最近 ${textOf(row.last)}`,
              row.appearances === undefined ? '' : `${textOf(row.appearances)} 次登场`,
              row.type === undefined ? '' : textOf(row.type),
            ].filter((value) => value !== '')
      return createElement(
        'details',
        { className: 'nwe-data-card', key: `${label}-${index}` },
        createElement(
          'summary',
          { className: 'nwe-data-card-head' },
          createElement(
            'span',
            { className: `nwe-data-card-icon is-${kind}`, 'aria-hidden': 'true' },
            sectionGlyph(kind),
          ),
          createElement(
            'span',
            { className: 'nwe-data-card-heading' },
            createElement('strong', null, label),
            note === '' ? null : createElement('span', { className: 'nwe-data-card-note' }, note),
            chips.length === 0
              ? null
              : createElement(
                  'span',
                  { className: 'nwe-data-card-chips' },
                  ...chips.map((chip) => createElement('span', { key: chip }, chip)),
                ),
          ),
          createElement('span', { className: 'nwe-data-card-caret', 'aria-hidden': 'true' }, '+'),
        ),
        row === null
          ? createElement(
              'div',
              {
                className: 'nwe-data-card-body',
                role: 'region',
                'aria-label': `${label} 内容`,
                tabIndex: 0,
              },
              String(item),
            )
          : createElement(
              'div',
              {
                className: 'nwe-data-card-body',
                role: 'region',
                'aria-label': `${label} 内容`,
                tabIndex: 0,
              },
              sectionKv(row),
            ),
      )
    }),
  )
}

const sectionBlock = (title: string, items: unknown, key: string): ReactElement | null => {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null
  const glyph = SECTION_GLYPHS[key] ?? 'spark'
  return createElement(
    'section',
    { className: 'nwe-subsection', key },
    createElement(
      'div',
      { className: 'nwe-group-head' },
      createElement(
        'span',
        { className: `nwe-group-icon is-${glyph}`, 'aria-hidden': 'true' },
        sectionGlyph(glyph, 16),
      ),
      createElement('h3', null, `${title}（${list.length}）`),
    ),
    sectionList(title, list, glyph),
  )
}

const worldbookSection = (items: unknown): ReactElement => {
  const row = asRow(items)
  if (row === null) return sectionList('设定', items)
  const groups: Array<[string, string]> = [
    ['rules', '规则'],
    ['factions', '势力'],
    ['locations', '地点'],
    ['characters', '人物小传'],
    ['glossary', '术语'],
    ['backstory', '背景'],
    ['facts', '数值事实'],
    ['themes', '主题'],
    ['outline_cards', '章卡'],
    ['drift', '大纲漂移'],
  ]
  const ledger = asRow(row.ledger)
  const blueprint = asRow(row.blueprint)
  const volumes = Array.isArray(row.volumes) ? row.volumes : []
  const intro = [
    typeof row.premise === 'string' && row.premise !== ''
      ? { title: '前提', description: row.premise }
      : null,
    typeof row.setting === 'string' && row.setting !== ''
      ? { title: '设定', description: row.setting }
      : null,
    blueprint === null
      ? null
      : {
          title: '蓝图',
          description: [
            Array.isArray(blueprint.themes) ? `主题 ${blueprint.themes.join(' / ')}` : '',
            typeof blueprint.tone === 'string' ? `基调 ${blueprint.tone}` : '',
            typeof blueprint.pov === 'string' ? `POV ${blueprint.pov}` : '',
            typeof blueprint.ending === 'string' ? `结局 ${blueprint.ending}` : '',
          ]
            .filter((part) => part !== '')
            .join(' · '),
        },
    volumes.length === 0
      ? null
      : {
          title: '卷',
          description: volumes
            .map((volume) => {
              const item = asRow(volume)
              return item === null
                ? ''
                : `${textOf(item.title)} ${textOf(item.start_chapter)}–${textOf(item.end_chapter)}`
            })
            .filter((part) => part !== '')
            .join(' / '),
        },
  ].filter((entry): entry is { title: string; description: string } => entry !== null)
  const ledgerGroups: Array<[string, string]> = [
    ['locations', '台账地点'],
    ['abilities', '台账能力'],
    ['artifacts', '台账物品'],
    ['factions', '台账势力'],
    ['rules', '台账规则'],
  ]
  const blocks = [
    ...(intro.length === 0 ? [] : [sectionBlock('蓝图', intro, 'blueprint')]),
    ...groups.map(([key, label]) => sectionBlock(label, row[key], key)),
    ...ledgerGroups.map(([key, label]) => sectionBlock(label, ledger?.[key], `ledger-${key}`)),
  ].filter((block): block is ReactElement => block !== null)
  return blocks.length === 0
    ? createElement('div', { className: 'nwe-empty' }, '设定：暂无数据')
    : createElement('div', { className: 'nwe-worldbook-layout' }, ...blocks)
}

const qualitySection = (
  items: unknown,
  chapter = 0,
  detail: ChapterDetailState | null = null,
  onDetail: (chapter: number | null) => void = () => undefined,
): ReactElement => {
  const row = asRow(items)
  if (row === null) return sectionList('质量', items)
  const quality = asRow(row.quality)
  const dimensions = Array.isArray(row.dimensions) ? row.dimensions : []
  const summary =
    quality === null || Number(quality.samples ?? 0) === 0
      ? createElement('div', { className: 'nwe-empty' }, '质量：暂无评审')
      : createElement(
          'div',
          { className: 'nwe-quality-kpis' },
          ...(
            [
              ['全书均分', textOf(quality.average), '/ 150'],
              ['可读评审', textOf(quality.samples), '章'],
              ['中位分', textOf(quality.median), ''],
              ['评分区间', `${textOf(quality.min)}–${textOf(quality.max)}`, ''],
            ] as const
          ).map(([label, value, unit]) =>
            createElement(
              'article',
              { className: 'nwe-quality-kpi', key: label },
              createElement('span', { className: 'nwe-quality-kpi-label' }, label),
              createElement(
                'strong',
                { className: 'nwe-quality-kpi-value' },
                value,
                unit === '' ? null : createElement('small', null, unit),
              ),
            ),
          ),
        )
  const bars = dimensions.map((entry, index) => {
    const dimension = asRow(entry)
    if (dimension === null) return null
    const average = Number(dimension.average)
    const max = Number(dimension.max)
    const id = textOf(dimension.id, `维度 ${index + 1}`)
    const percent = max > 0 ? Math.max(0, Math.min(100, (average / max) * 100)) : 0
    return createElement(
      'article',
      { className: 'nwe-dim-card', key: id },
      createElement(
        'div',
        { className: 'nwe-dim-card-head' },
        createElement('span', null, id),
        createElement('strong', null, `${Number.isFinite(average) ? average : '—'} / ${max > 0 ? max : '—'}`),
      ),
      createElement(
        'div',
        {
          className: 'nwe-v6-bar',
          role: 'progressbar',
          'aria-label': `${id} 得分`,
          'aria-valuemin': 0,
          'aria-valuemax': max,
          'aria-valuenow': Number.isFinite(average) ? average : 0,
        },
        createElement('span', null, createElement('i', { style: { width: `${percent}%` } })),
      ),
    )
  })
  const pacing = asRow(row.pacing)
  const longest = asRow(pacing?.longest)
  const shortest = asRow(pacing?.shortest)
  const pacingRows =
    pacing === null
      ? []
      : [
          { title: '节奏', description: countsText(pacing.scene_types) },
          {
            title: '钩子 / 推进',
            description: `${countsText(pacing.hook_strength, hookLabel)} / ${countsText(pacing.plot_advancement, plotLabel)}`,
          },
          {
            title: '最长 / 最短',
            description:
              pacing.longest === null
                ? '—'
                : `第 ${textOf(longest?.chapter)} 章 ${textOf(longest?.words)} 字 / 第 ${textOf(shortest?.chapter)} 章 ${textOf(shortest?.words)} 字`,
          },
        ]
  const effort = asRow(row.effort)
  const effortBlock =
    effort === null
      ? null
      : createElement(
          'section',
          { className: 'nwe-subsection' },
          createElement(
            'div',
            { className: 'nwe-group-head' },
            createElement(
              'span',
              { className: 'nwe-group-icon is-heart', 'aria-hidden': 'true' },
              sectionGlyph('heart', 16),
            ),
            createElement('h3', null, '返工投入'),
          ),
          createElement(
            'div',
            { className: 'nwe-effort-grid' },
            ...(
              [
                ['评审', effort.reviews],
                ['修订', effort.revisions],
                ['校验', effort.checks],
                ['回滚', effort.rollbacks],
              ] as const
            ).map(([label, value]) =>
              createElement(
                'article',
                { className: 'nwe-effort-card', key: label },
                createElement('span', null, label),
                createElement('strong', null, textOf(value)),
              ),
            ),
          ),
        )
  const extras = [
    pacingRows.length === 0 ? null : sectionBlock('节奏', pacingRows, 'pacing'),
    effortBlock,
  ].filter((block): block is ReactElement => block !== null)
  return createElement(
    'div',
    { className: 'nwe-quality-layout' },
    summary,
    chapter > 0
      ? createElement(
          'div',
          { className: 'nwe-quality-toolbar' },
          createElement(
            'button',
            { type: 'button', className: 'nwe-refresh', onClick: () => onDetail(chapter) },
            '查看本章质量详情',
          ),
        )
      : null,
    createElement('div', { className: 'nwe-dim-grid' }, ...bars),
    ...extras,
    qualityDetailPanel(detail, onDetail),
  )
}

const healthSection = (items: unknown): ReactElement => {
  const row = asRow(items)
  if (row === null) return sectionList('健康', items)
  const flags = (['outline', 'worldbook'] as const).map((key) => {
    const value = asRow(row[key])
    const present = value?.present === true
    const existed = value?.file_existed === true
    const label = key === 'outline' ? '大纲' : '设定'
    return createElement(
      'article',
      { className: `nwe-health-card ${present ? 'is-ok' : 'is-bad'}`, key },
      createElement(
        'span',
        { className: 'nwe-health-icon', 'aria-hidden': 'true' },
        sectionGlyph(present ? 'check' : 'alert', 18),
      ),
      createElement(
        'div',
        { className: 'nwe-health-copy' },
        createElement('strong', null, `${label}：${present ? '可读' : existed ? '损坏' : '缺失'}`),
        createElement(
          'span',
          null,
          present ? '结构完整，可安全读取' : existed ? '文件存在但解析失败' : '尚未生成该文件',
        ),
      ),
      createElement('span', { className: 'nwe-health-state' }, present ? 'PASS' : 'CHECK'),
    )
  })
  const stateErrors = Array.isArray(row.state_errors) ? row.state_errors : []
  const drift = Array.isArray(row.drift) ? row.drift : []
  const blocks = [
    sectionBlock('状态错误', stateErrors, 'state-errors'),
    sectionBlock('大纲漂移', drift, 'drift'),
  ].filter((block): block is ReactElement => block !== null)
  return createElement(
    'div',
    { className: 'nwe-health-layout' },
    createElement('div', { className: 'nwe-health-grid' }, ...flags),
    ...blocks,
  )
}

const chapterToolbar = (
  query: ChapterQuery,
  onQuery: (patch: Partial<ChapterQuery>) => void,
): ReactElement => {
  const scenes = ['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章']
  return createElement(
    'div',
    { className: 'nwe-chapter-toolbar', role: 'search', 'aria-label': '筛选章节' },
    createElement(
      'label',
      null,
      '搜索标题',
      createElement('input', {
        type: 'search',
        value: query.search,
        placeholder: '输入章节标题',
        onChange: (event: { target: { value: string } }) =>
          onQuery({ search: event.target.value, cursor: '' }),
      }),
    ),
    createElement(
      'label',
      null,
      '状态',
      createElement(
        'select',
        {
          value: query.status,
          onChange: (event: { target: { value: string } }) =>
            onQuery({ status: event.target.value as ChapterQuery['status'], cursor: '' }),
        },
        createElement('option', { value: 'all' }, '全部'),
        createElement('option', { value: 'archived' }, '已归档'),
        createElement('option', { value: 'draft' }, '草稿'),
      ),
    ),
    createElement(
      'label',
      null,
      '场景',
      createElement(
        'select',
        {
          value: query.scene,
          onChange: (event: { target: { value: string } }) =>
            onQuery({ scene: event.target.value, cursor: '' }),
        },
        createElement('option', { value: '' }, '全部'),
        ...scenes.map((scene) => createElement('option', { value: scene, key: scene }, scene)),
      ),
    ),
    createElement(
      'label',
      null,
      '排序',
      createElement(
        'select',
        {
          value: query.sort,
          onChange: (event: { target: { value: string } }) =>
            onQuery({ sort: event.target.value as ChapterQuery['sort'], cursor: '' }),
        },
        createElement('option', { value: 'num_desc' }, '章号倒序'),
        createElement('option', { value: 'num_asc' }, '章号正序'),
      ),
    ),
  )
}

const chapterDetailPanel = (
  detail: ChapterDetailState | null,
  onClose: (chapter: number | null) => void,
): ReactElement | null => {
  if (detail === null) return null
  const payload = detail.section.payload
  const items = asRow(payload?.items)
  const manuscript = typeof items?.manuscript === 'string' ? items.manuscript : null
  const plan = typeof items?.plan === 'string' ? items.plan : null
  const worldPlan = typeof items?.world_plan === 'string' ? items.world_plan : null
  const detailRow = asRow(items?.row)
  const rawSummaryEvents = items?.summary_events ?? detailRow?.summary_events
  const summaryEvents = Array.isArray(rawSummaryEvents)
    ? rawSummaryEvents.filter((event): event is string => typeof event === 'string')
    : []
  return createElement(
    'section',
    {
      className: 'nwe-chapter-detail nwe-chapter-detail-panel',
      'aria-label': `第 ${detail.chapter} 章详情`,
    },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h3', { className: 'nwe-section-title' }, `第 ${detail.chapter} 章详情`),
      createElement(
        'button',
        { type: 'button', className: 'nwe-refresh', onClick: () => onClose(null) },
        '收起',
      ),
    ),
    detail.section.loading && payload === null
      ? createElement('div', { className: 'nwe-section-note' }, '正在读取章节详情…')
      : detail.section.error !== null
        ? createElement('div', { className: 'nwe-empty' }, `章节详情读取失败：${detail.section.error}`)
        : createElement(
            Fragment,
            null,
            manuscript === null
              ? createElement('div', { className: 'nwe-empty' }, '正文尚未写入。')
              : foldBlock(
                  'manuscript',
                  '正文',
                  createElement('pre', { className: 'nwe-detail-text' }, manuscript),
                  { meta: `${Array.from(manuscript).length} 字`, open: true, className: 'nwe-detail-fold' },
                ),
            plan === null
              ? null
              : foldBlock('plan', '归档 plan', createElement('pre', { className: 'nwe-detail-text' }, plan), {
                  className: 'nwe-detail-fold',
                }),
            worldPlan === null
              ? null
              : foldBlock(
                  'world',
                  '世界计划',
                  createElement('pre', { className: 'nwe-detail-text' }, worldPlan),
                  { className: 'nwe-detail-fold' },
                ),
            summaryEvents.length === 0
              ? null
              : foldBlock(
                  'summary-events',
                  '本章摘要',
                  createElement(
                    'ul',
                    { className: 'nwe-v6-list' },
                    ...summaryEvents.map((event, index) =>
                      createElement('li', { key: `${index}-${event}` }, event),
                    ),
                  ),
                  { meta: `${summaryEvents.length} 条`, className: 'nwe-detail-fold' },
                ),
          ),
  )
}

const qualityDetailPanel = (
  detail: ChapterDetailState | null,
  onClose: (chapter: number | null) => void,
): ReactElement | null => {
  if (detail === null) return null
  const payload = detail.section.payload
  const items = asRow(payload?.items)
  const review = typeof items?.review === 'string' ? items.review : null
  const check = typeof items?.check === 'string' ? items.check : null
  return createElement(
    'section',
    {
      className: 'nwe-chapter-detail nwe-chapter-detail-panel',
      'aria-label': `第 ${detail.chapter} 章质量详情`,
    },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h3', { className: 'nwe-section-title' }, `第 ${detail.chapter} 章质量详情`),
      createElement(
        'button',
        { type: 'button', className: 'nwe-refresh', onClick: () => onClose(null) },
        '收起',
      ),
    ),
    detail.section.loading && payload === null
      ? createElement('div', { className: 'nwe-section-note' }, '正在读取质量详情…')
      : detail.section.error !== null
        ? createElement('div', { className: 'nwe-empty' }, `质量详情读取失败：${detail.section.error}`)
        : review === null && check === null
          ? createElement('div', { className: 'nwe-empty' }, '还没有评审或检查文档。')
          : createElement(
              Fragment,
              null,
              review === null
                ? null
                : foldBlock(
                    'review',
                    '评审 review',
                    createElement('pre', { className: 'nwe-detail-text' }, review),
                    { open: true, className: 'nwe-detail-fold' },
                  ),
              check === null
                ? null
                : foldBlock(
                    'check',
                    '检查 check',
                    createElement('pre', { className: 'nwe-detail-text' }, check),
                    { className: 'nwe-detail-fold' },
                  ),
            ),
  )
}

const chapterTable = (
  section: PanelSectionState | null,
  view: PanelView,
  query: ChapterQuery,
  onQuery: (patch: Partial<ChapterQuery>) => void,
  detail: ChapterDetailState | null = null,
  onDetail: (chapter: number | null) => void = () => undefined,
): ReactElement => {
  if (section === null || (section.loading && section.payload === null)) return chaptersSection(view)
  if (section.error !== null && section.payload === null) {
    return createElement(
      Fragment,
      null,
      createElement('div', { className: 'nwe-empty' }, `章节读取失败：${section.error}`),
      chaptersSection(view),
    )
  }
  const payload = section.payload
  const items = payload?.items
  if (!Array.isArray(items)) return chaptersSection(view)
  const rows = items.map(asRow).filter((row): row is Record<string, unknown> => row !== null)
  const total = payload?.total ?? rows.length
  const cursor = query.cursor
  const mobileCards =
    rows.length === 0
      ? null
      : createElement(
          'div',
          { className: 'nwe-chapter-cards-mobile' },
          ...rows.map((row, index) => {
            const num = textOf(row.num, String(index + 1))
            const score = typeof row.score === 'number' ? String(row.score) : '—'
            return createElement(
              'article',
              { className: 'nwe-mobile-chapter', key: `${num}-${index}` },
              createElement('span', { className: 'nwe-mobile-chapter-num' }, `CH ${num.padStart(2, '0')}`),
              createElement(
                'div',
                { className: 'nwe-mobile-chapter-body' },
                createElement('strong', null, textOf(row.title)),
                createElement(
                  'span',
                  null,
                  `${row.status === 'draft' ? '草稿' : '已归档'} · ${textOf(row.word_count)} 字 · ${textOf(row.scene_type)}`,
                ),
              ),
              createElement('span', { className: 'nwe-mobile-chapter-score' }, score),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'nwe-refresh',
                  onClick: () => onDetail(Number(num) || index + 1),
                },
                '详情',
              ),
            )
          }),
        )
  return createElement(
    'section',
    { className: 'nwe-chapters-section', 'aria-label': '章节表' },
    createElement(
      'div',
      { className: 'nwe-section-head' },
      createElement('h2', { className: 'nwe-section-title' }, '章节'),
      createElement(
        'span',
        { className: 'nwe-section-note' },
        payload?.truncated === true && rows.length < total
          ? `显示 ${rows.length} / 共 ${total}`
          : payload?.truncated === true
            ? `共 ${total} 章 · 部分文本已截断`
            : `共 ${total} 章`,
      ),
    ),
    rows.length === 0
      ? createElement('div', { className: 'nwe-empty' }, '没有匹配的章节。')
      : createElement(
          'div',
          {
            className: 'nwe-table-wrap',
            role: 'region',
            'aria-label': '章节表，可滚动',
            tabIndex: 0,
          },
          createElement(
            'table',
            { className: 'nwe-chapter-table' },
            createElement(
              'thead',
              null,
              createElement(
                'tr',
                null,
                ...['章', '标题', '状态', '字数', '评分', '场景', '终检', '归档', '详情'].map((label) =>
                  createElement('th', { key: label, scope: 'col' }, label),
                ),
              ),
            ),
            createElement(
              'tbody',
              null,
              ...rows.map((row, index) => {
                const num = textOf(row.num, String(index + 1))
                const score = typeof row.score === 'number' ? String(row.score) : '—'
                return createElement(
                  'tr',
                  { key: `${num}-${index}` },
                  createElement('td', { className: 'is-num' }, `第 ${num} 章`),
                  createElement('td', { className: 'nwe-table-title' }, textOf(row.title)),
                  createElement('td', null, row.status === 'draft' ? '草稿' : '已归档'),
                  createElement('td', null, textOf(row.word_count)),
                  createElement('td', null, score),
                  createElement('td', null, textOf(row.scene_type)),
                  createElement('td', null, finalCheckLabel(row.final_check)),
                  createElement(
                    'td',
                    null,
                    localTime(typeof row.archived_at === 'string' ? row.archived_at : null),
                  ),
                  createElement(
                    'td',
                    null,
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'nwe-refresh',
                        onClick: () => onDetail(Number(num) || index + 1),
                      },
                      '详情',
                    ),
                  ),
                )
              }),
            ),
          ),
        ),
    mobileCards,
    createElement(
      'div',
      { className: 'nwe-pager' },
      createElement(
        'span',
        null,
        payload?.next_cursor !== null && payload?.next_cursor !== undefined
          ? '已截断，可继续翻页'
          : payload?.truncated === true
            ? '部分文本已截断'
            : '已显示全部',
      ),
      createElement(
        'span',
        null,
        cursor === ''
          ? null
          : createElement(
              'button',
              {
                type: 'button',
                className: 'nwe-refresh',
                onClick: () => onQuery({ cursor: '' }),
              },
              '回到第一页',
            ),
        payload?.next_cursor === null || payload?.next_cursor === undefined
          ? null
          : createElement(
              'button',
              {
                type: 'button',
                className: 'nwe-refresh',
                onClick: () => onQuery({ cursor: String(payload.next_cursor) }),
              },
              '下一页',
            ),
      ),
    ),
    chapterDetailPanel(detail, onDetail),
  )
}

const leadsSection = (items: unknown): ReactElement => {
  const row = asRow(items)
  if (row === null) return sectionList('线索', items)
  const blocks = [
    sectionBlock('伏笔', row.foreshadows, 'foreshadows'),
    sectionBlock('时间线', row.timeline, 'timeline'),
    sectionBlock('关系', row.relationships, 'relationships'),
  ].filter((block): block is ReactElement => block !== null)
  return blocks.length === 0
    ? createElement('div', { className: 'nwe-empty' }, '线索：暂无数据')
    : createElement('div', { className: 'nwe-leads-layout' }, ...blocks)
}

const sectionMeta = (section: PanelSectionState): ReactElement | null => {
  const payload = section.payload
  if (payload === null || payload.total === undefined) return null
  const returned = payload.returned ?? 0
  const text =
    payload.truncated !== true
      ? `共 ${payload.total}`
      : returned < payload.total
        ? `显示 ${returned} / 共 ${payload.total}`
        : `共 ${payload.total} · 部分文本已截断`
  return createElement('div', { className: 'nwe-section-note', role: 'status' }, text)
}

const sectionPanel = (
  tab: PanelTab,
  section: PanelSectionState | null,
  search = '',
  onSearch: (value: string) => void = () => undefined,
  chapter = 0,
  qualityDetail: ChapterDetailState | null = null,
  onQualityDetail: (chapter: number | null) => void = () => undefined,
): ReactElement => {
  if (section === null || (section.loading && section.payload === null)) {
    return createElement('div', { className: 'nwe-section-note' }, '正在读取栏目…')
  }
  if (section.error !== null && section.payload === null) {
    return createElement('div', { className: 'nwe-empty' }, `栏目读取失败：${section.error}`)
  }
  const items = section.payload?.items
  const searchLabel =
    tab === 'characters'
      ? '搜索人物'
      : tab === 'foreshadows'
        ? '搜索线索'
        : tab === 'worldbook'
          ? '搜索设定'
          : ''
  const withSearch = (content: ReactElement): ReactElement => {
    const searchGlyph: SectionGlyph = tab === 'characters' ? 'person' : tab === 'foreshadows' ? 'seed' : 'map'
    return createElement(
      Fragment,
      null,
      createElement(
        'label',
        { className: 'nwe-section-search' },
        createElement(
          'span',
          { className: 'nwe-search-icon', 'aria-hidden': 'true' },
          sectionGlyph(searchGlyph, 16),
        ),
        createElement('span', { className: 'nwe-search-label' }, searchLabel),
        createElement('input', {
          type: 'search',
          value: search,
          placeholder: '输入关键词',
          onChange: (event: { target: { value: string } }) => onSearch(event.target.value),
        }),
      ),
      sectionMeta(section),
      content,
    )
  }
  if (tab === 'characters') return withSearch(sectionList('人物', items, 'person'))
  if (tab === 'foreshadows') return withSearch(leadsSection(items))
  if (tab === 'worldbook') return withSearch(worldbookSection(items))
  if (tab === 'quality') return qualitySection(items, chapter, qualityDetail, onQualityDetail)
  if (tab === 'health') return healthSection(items)
  return sectionList('数据', Array.isArray(items) ? items : [items])
}

/**
 * Pure view: given a view model, return the element tree. Keeping the hooks in
 * `NovelPanel` makes every visual state renderable without a browser.
 */
export function panelElement(
  view: PanelView,
  loading: boolean,
  onRefresh: () => void,
  onSelectProject: (root: string | null) => void = () => undefined,
  tab: PanelTab = 'overview',
  onTab: (tab: PanelTab) => void = () => undefined,
  section: PanelSectionState | null = null,
  chapterQuery: ChapterQuery = EMPTY_CHAPTER_QUERY,
  onChapterQuery: (patch: Partial<ChapterQuery>) => void = () => undefined,
  sectionSearch = '',
  onSectionSearch: (value: string) => void = () => undefined,
  chapterDetail: ChapterDetailState | null = null,
  onChapterDetail: (chapter: number | null) => void = () => undefined,
  qualityDetail: ChapterDetailState | null = null,
  onQualityDetail: (chapter: number | null) => void = () => undefined,
): ReactElement {
  const ready = view.state === 'ready'
  const selectable =
    view.projects.length > 0 ||
    ready ||
    view.state === 'choose' ||
    view.state === 'missing' ||
    view.state === 'error' ||
    view.state === 'outdated' ||
    view.state === 'empty'
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
        { className: 'nwe-brand' },
        createElement('span', { className: 'nwe-brand-mark', 'aria-hidden': 'true' }, '文'),
        createElement(
          'div',
          { className: 'nwe-hero-title' },
          createElement('div', { className: 'nwe-eyebrow' }, '网文工坊 · NOVEL WORKBENCH'),
          createElement('h1', { className: 'nwe-title' }, view.title),
          createElement(
            'div',
            { className: 'nwe-meta' },
            createElement(
              'span',
              { className: `nwe-stage${view.finished ? ' is-done' : ''}` },
              view.stageLabel,
            ),
            ready ? createElement('span', null, view.subtitle) : null,
            ready ? createElement('span', { className: 'nwe-revision' }, view.revisionLabel) : null,
            view.state === 'choose' || view.state === 'missing' || view.state === 'loading'
              ? createElement('span', null, view.subtitle)
              : null,
          ),
          ready && view.root !== '' ? createElement('div', { className: 'nwe-rootline' }, view.root) : null,
        ),
      ),
      createElement(
        'div',
        { className: 'nwe-actions' },
        selectable ? createElement(ProjectSelector, { view, onSelect: onSelectProject }) : null,
        createElement(NovelHelp),
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
    ),
    ready && view.damaged
      ? createElement(
          'div',
          { className: 'nwe-damaged', role: 'status' },
          '项目定义不可读；先用 novel_state 查看，再用 novel_amend 按 next 修复。面板不会把它伪装成正常项目。',
        )
      : null,
    ready && view.nextTitle !== '' ? nextCard(view) : null,
    ready ? tabBar(tab, onTab) : null,
    createElement(
      'div',
      {
        className: 'nwe-workbench',
        role: 'region',
        'aria-label': '网文工坊内容',
        tabIndex: 0,
      },
      ready && tab === 'overview'
        ? createElement(
            'div',
            { className: 'nwe-stats', role: 'group', 'aria-label': '项目统计' },
            stat('已归档', String(view.stats.chapters), '章'),
            stat(
              '总字数',
              view.stats.words.toLocaleString('zh-CN'),
              (view.stats.draftWords ?? 0) > 0
                ? `字（归档 ${(view.stats.archivedWords ?? 0).toLocaleString('zh-CN')} + 草稿 ${view.stats.draftWords!.toLocaleString('zh-CN')}）`
                : '字',
            ),
            stat('全书均分', view.stats.chapters === 0 ? '—' : String(view.stats.averageScore), '/150'),
            stat('待处理', String(view.stats.blocking), '项'),
          )
        : null,
      ready && tab === 'overview' ? overviewCharts(view) : null,
      view.state === 'loading' ? loadingState() : null,
      view.state === 'choose' ? choosePanel(view, onSelectProject) : null,
      view.state === 'missing' ? missingPanel(view) : null,
      view.state === 'error' || view.state === 'empty' || view.state === 'outdated'
        ? statePanel(view.state, view, loading, onRefresh)
        : null,
      ready && tab === 'overview'
        ? createElement(
            'div',
            {
              className: 'nwe-desk',
              role: 'tabpanel',
              id: 'nwe-panel-overview',
              'aria-labelledby': 'nwe-tab-overview',
            },
            createElement(
              'div',
              { className: 'nwe-desk-main' },
              createElement(
                'div',
                { className: 'nwe-desk-heading' },
                createElement('span', { className: 'nwe-desk-kicker' }, '当前一章'),
                createElement('span', { className: 'nwe-desk-note' }, view.stageLabel),
              ),
              phases(view),
              blockingSection(view),
              advisoriesSection(view),
              pendingSection(view),
              legacySection(view),
              chaptersSection(view),
            ),
            createElement(
              'aside',
              { className: 'nwe-desk-side', 'aria-label': '全书与活动' },
              bookGlance(view),
              activitySection(view),
            ),
          )
        : null,
      ready && tab === 'overview' ? bookDossier(view) : null,
      ready && tab === 'chapters'
        ? createElement(
            'div',
            {
              className: 'nwe-desk nwe-desk-single',
              role: 'tabpanel',
              id: 'nwe-panel-chapters',
              'aria-labelledby': 'nwe-tab-chapters',
            },
            createElement(
              'div',
              { className: 'nwe-desk-main' },
              tabIntro('chapters', view, section),
              blockingSection(view),
              chapterToolbar(chapterQuery, onChapterQuery),
              chapterTable(section, view, chapterQuery, onChapterQuery, chapterDetail, onChapterDetail),
            ),
          )
        : null,
      ready && tab !== 'overview' && tab !== 'chapters'
        ? createElement(
            'section',
            {
              className: 'nwe-section nwe-tab-panel',
              role: 'tabpanel',
              id: `nwe-panel-${tab}`,
              'aria-labelledby': `nwe-tab-${tab}`,
            },
            tabIntro(tab as SectionTab, view, section),
            tab === 'health'
              ? createElement(
                  Fragment,
                  null,
                  blockingSection(view),
                  advisoriesSection(view),
                  pendingSection(view),
                  legacySection(view),
                )
              : null,
            sectionPanel(
              tab,
              section,
              sectionSearch,
              onSectionSearch,
              view.chapter,
              qualityDetail,
              onQualityDetail,
            ),
          )
        : null,
      footer(view, onRefresh),
    ),
  )
}

const PANEL_ROOT_KEY = 'nwe.panel-root.v1'

interface PanelStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const storage = (): PanelStorage | undefined => (globalThis as { localStorage?: PanelStorage }).localStorage

const readStoredRoot = (): string | null => {
  try {
    const value = storage()?.getItem(PANEL_ROOT_KEY)
    return value === undefined || value === null || value === '' ? null : value
  } catch {
    return null
  }
}

const storeRoot = (root: string | null): void => {
  try {
    const target = storage()
    if (target === undefined) return
    if (root === null) target.removeItem(PANEL_ROOT_KEY)
    else target.setItem(PANEL_ROOT_KEY, root)
  } catch {
    // Private mode/quota: the panel still works without persistence.
  }
}

const panelPath = (root: string | null): string => {
  const base = PANEL_ROUTE.replace(/^\/+/, '')
  return root === null ? `${base}?lean=1` : `${base}?root=${encodeURIComponent(root)}&lean=1`
}

/** Stateful wrapper: fetch once, refresh on demand and after returning to the tab. */
export function NovelPanel(): ReactElement {
  const [view, setView] = useState<PanelView>(() => buildView(null))
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [sync, setSync] = useState<{ lastSync: string | null; syncError: string | null }>({
    lastSync: null,
    syncError: null,
  })
  const [tab, setTab] = useState<PanelTab>('overview')
  const [section, setSection] = useState<PanelSectionState | null>(null)
  const [chapterQuery, setChapterQuery] = useState<ChapterQuery>(EMPTY_CHAPTER_QUERY)
  const [sectionSearch, setSectionSearch] = useState('')
  const [chapterDetail, setChapterDetail] = useState<ChapterDetailState | null>(null)
  const [qualityDetail, setQualityDetail] = useState<ChapterDetailState | null>(null)
  const detailController = useRef<AbortController | null>(null)
  const [revisionTick, setRevisionTick] = useState(0)
  const syncFailures = useRef(0)
  const nextSyncAt = useRef(0)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(() => readStoredRoot())
  const alive = useRef(true)
  const requestId = useRef(0)
  const visibleRequest = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const queryRootRef = useRef<string | null>(selectedRoot)
  const sectionEtagRef = useRef<{ key: string; etag: string } | null>(null)
  const bundleEtagRef = useRef<{ root: string; etag: string } | null>(null)
  const lastSilentAt = useRef(0)
  const quietPolls = useRef(0)
  const loadRef = useRef<(silent?: boolean, root?: string | null) => Promise<void>>(async () => undefined)

  const load = useCallback(async (silent = false, root = queryRootRef.current) => {
    // A background poll/focus must never abort a user-visible refresh and leave
    // the loading state owned by a request that will be discarded.
    if (silent && visibleRequest.current !== 0) return
    if (silent && Date.now() - lastSilentAt.current < 1_000) return
    if (silent) lastSilentAt.current = Date.now()
    const id = ++requestId.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (!silent) {
      visibleRequest.current = id
      setLoading(true)
    }
    const timeout =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(10_000)
        : undefined
    const any =
      typeof AbortSignal === 'undefined'
        ? undefined
        : (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any?.bind(AbortSignal)
    const anySignal =
      timeout === undefined
        ? controller.signal
        : typeof any === 'function'
          ? any([controller.signal, timeout])
          : controller.signal
    // AbortSignal.any() is newer than AbortSignal.timeout(). If only timeout()
    // exists, do not silently lose the deadline; a hung fetch would otherwise
    // keep visibleRequest non-zero forever and disable every later refresh.
    const timeoutTimer =
      timeout === undefined || typeof any !== 'function'
        ? setTimeout(() => controller.abort(), 10_000)
        : undefined
    try {
      const rootKey = root ?? ''
      const cachedBundleEtag =
        bundleEtagRef.current?.root === rootKey ? bundleEtagRef.current.etag : undefined
      const result = await fetchPanel(fetch, panelPath(root), anySignal, cachedBundleEtag)
      if (!alive.current || id !== requestId.current) return
      if (result.notModified === true) {
        syncFailures.current = 0
        quietPolls.current += 1
        nextSyncAt.current = Date.now() + (quietPolls.current >= 2 ? 60_000 : 30_000)
        setSync({ lastSync: new Date().toISOString(), syncError: null })
        return
      }
      if (result.error === null) {
        syncFailures.current = 0
        quietPolls.current = 0
        nextSyncAt.current = 0
        setSync({ lastSync: new Date().toISOString(), syncError: null })
      } else {
        syncFailures.current += 1
        nextSyncAt.current = Date.now() + (syncFailures.current === 1 ? 30_000 : 60_000)
        setSync((previous) => ({ ...previous, syncError: result.error }))
      }
      const payload = result.payload as PanelPayloadDto | null
      if (payload !== null && payload.missing?.reason === 'not_registered' && root !== null) {
        // A stale localStorage preference must not wedge the panel. Clear it and
        // retry once without a query root; the same response's projects remain
        // available for the selector.
        queryRootRef.current = null
        storeRoot(null)
        setSelectedRoot(null)
        await loadRef.current(false, null)
        return
      }
      if (payload !== null) {
        if (payload.etag !== undefined) bundleEtagRef.current = { root: rootKey, etag: payload.etag }
        setSelectedRoot(payload.selection.root)
        setRevisionTick((tick) => tick + 1)
      }
      setView((previous) => {
        const next = buildView(payload, result.error)
        // A brief background failure must not wipe a readable panel or the
        // choose/missing view. Keep the last view whenever its selector still
        // has projects; a user-visible refresh may still replace it.
        if (silent && result.error !== null && previous.projects.length > 0) return previous
        return next
      })
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (!silent && visibleRequest.current === id) visibleRequest.current = 0
      if (id === requestId.current && !silent && alive.current) {
        setLoading(false)
        setSwitching(false)
      }
    }
  }, [])
  loadRef.current = load

  useEffect(() => {
    if (tab === 'overview' || view.state !== 'ready') {
      setSection(null)
      return
    }
    const root = queryRootRef.current
    const base = panelPath(root)
    const params = new URLSearchParams({ section: tab })
    if (tab === 'chapters') {
      if (chapterQuery.search !== '') params.set('search', chapterQuery.search)
      if (chapterQuery.status !== 'all') params.set('status', chapterQuery.status)
      if (chapterQuery.scene !== '') params.set('scene', chapterQuery.scene)
      params.set('sort', chapterQuery.sort)
      if (chapterQuery.cursor !== '') params.set('cursor', chapterQuery.cursor)
    } else if (tab === 'characters' || tab === 'foreshadows' || tab === 'worldbook') {
      if (sectionSearch.trim() !== '') params.set('search', sectionSearch.trim())
    }
    const path = `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`
    const queryKey = `${tab}|${root ?? ''}|${JSON.stringify(chapterQuery)}|${sectionSearch}`
    const cachedEtag = sectionEtagRef.current?.key === queryKey ? sectionEtagRef.current.etag : undefined
    const controller = new AbortController()
    setSection((previous) =>
      previous === null
        ? { loading: true, error: null, payload: null }
        : { ...previous, loading: true, error: null },
    )
    void fetchPanel(fetch, path, controller.signal, cachedEtag).then((result) => {
      if (controller.signal.aborted) return
      if (result.notModified === true) {
        setSection((previous) =>
          previous === null
            ? { loading: false, error: null, payload: null }
            : { ...previous, loading: false, error: null },
        )
        return
      }
      if (result.payload?.etag !== undefined) {
        sectionEtagRef.current = { key: queryKey, etag: result.payload.etag }
      }
      setSection({ loading: false, error: result.error, payload: result.payload as PanelPayloadDto | null })
    })
    return () => controller.abort()
  }, [tab, view.state, selectedRoot, chapterQuery, revisionTick, sectionSearch])

  const selectProject = useCallback(
    (root: string | null): void => {
      queryRootRef.current = root
      storeRoot(root)
      setSelectedRoot(root)
      setChapterDetail(null)
      setQualityDetail(null)
      detailController.current?.abort()
      setSwitching(true)
      setChapterQuery((previous) => ({ ...previous, cursor: '' }))
      // Do not keep A's ready data under B's selector while the request is in
      // flight. Preserve the project list so the selector stays usable.
      setView((previous) => ({
        ...previous,
        state: 'loading',
        title: '切换项目…',
        subtitle: root === null ? '正在读取默认项目…' : `正在读取 ${root}…`,
        stageLabel: '读取中',
        selectedRoot: root,
        selection: { root, source: 'query' },
        resumeText: '',
        damaged: false,
        finished: false,
      }))
      void load(false, root)
    },
    [load],
  )

  useEffect(() => {
    alive.current = true
    void load()
    const win = (globalThis as { window?: NweWindow }).window
    const doc = (globalThis as { document?: NweDocument }).document
    if (win === undefined || doc === undefined) return
    const refreshWhenVisible = (): void => {
      if (doc.visibilityState === 'hidden') return
      if (Date.now() < nextSyncAt.current) return
      void load(true)
    }
    const timer = win.setInterval(refreshWhenVisible, 15_000)
    win.addEventListener('focus', refreshWhenVisible)
    doc.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      alive.current = false
      controllerRef.current?.abort()
      detailController.current?.abort()
      win.clearInterval(timer)
      win.removeEventListener('focus', refreshWhenVisible)
      doc.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [load])

  const loadDetail = (
    section: 'chapter_detail' | 'quality_detail',
    chapter: number | null,
    setter: (value: ChapterDetailState | null) => void,
  ): void => {
    detailController.current?.abort()
    if (chapter === null) {
      setter(null)
      return
    }
    const root = queryRootRef.current
    const controller = new AbortController()
    detailController.current = controller
    const path = `${panelPath(root)}&section=${section}&chapter=${encodeURIComponent(String(chapter))}`
    setter({ chapter, section: { loading: true, error: null, payload: null } })
    void fetchPanel(fetch, path, controller.signal).then((result) => {
      if (!alive.current || controller.signal.aborted || queryRootRef.current !== root) return
      setter({
        chapter,
        section: {
          loading: false,
          error: result.error,
          payload: result.payload as PanelPayloadDto | null,
        },
      })
    })
  }

  const openChapterDetail = (chapter: number | null): void =>
    loadDetail('chapter_detail', chapter, setChapterDetail)
  const openQualityDetail = (chapter: number | null): void =>
    loadDetail('quality_detail', chapter, setQualityDetail)

  return panelElement(
    { ...view, selectedRoot, ...sync },
    loading || switching,
    () => {
      nextSyncAt.current = 0
      void load(false, queryRootRef.current)
    },
    selectProject,
    tab,
    setTab,
    section,
    chapterQuery,
    (patch) => setChapterQuery((previous) => ({ ...previous, ...patch })),
    sectionSearch,
    setSectionSearch,
    chapterDetail,
    openChapterDetail,
    qualityDetail,
    openQualityDetail,
  )
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
