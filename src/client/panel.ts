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
import { PANEL_CHAPTER_LIMIT, PANEL_ROUTE } from '../constants.js'
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
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
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
.nwe-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; }
.nwe-project { display: flex; align-items: center; gap: 6px; min-width: 0; }
.nwe-project-label { color: var(--nwe-muted); font-size: 11px; white-space: nowrap; }
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
.nwe-rootline { margin-top: 5px; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; overflow-wrap: anywhere; }
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
  background: color-mix(in srgb, #080a0d 76%, transparent);
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
.nwe-tutorial-card span { display: block; margin-top: 4px; color: var(--nwe-muted); font-size: 11px; line-height: 1.65; }
.nwe-steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.nwe-step { padding: 12px 14px; border: 1px solid var(--nwe-border); border-left: 2px solid color-mix(in srgb, var(--nwe-gold) 58%, var(--nwe-border)); border-radius: 11px; background: color-mix(in srgb, var(--nwe-surface) 86%, var(--nwe-raised) 14%); }
.nwe-step-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.nwe-step-no { color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: .06em; }
.nwe-step h4 { margin: 0; font-size: 13px; font-weight: 600; }
.nwe-step-tool { margin-left: auto; padding: 2px 6px; border: 1px solid var(--nwe-border); border-radius: 5px; color: var(--nwe-gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; white-space: nowrap; }
.nwe-step p { margin: 6px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.7; }
.nwe-step p strong { color: var(--nwe-ink); font-weight: 600; }
.nwe-tutorial-note { margin: 12px 0 0; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--nwe-gold) 8%, transparent); color: var(--nwe-muted); font-size: 11px; line-height: 1.7; }
.nwe-tutorial-note strong { color: var(--nwe-gold); }
.nwe-faq { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.nwe-faq li { padding: 10px 12px; border: 1px solid var(--nwe-border); border-radius: 10px; }
.nwe-faq strong { display: block; color: var(--nwe-ink); font-size: 12px; }
.nwe-faq p { margin: 4px 0 0; color: var(--nwe-muted); font-size: 12px; line-height: 1.65; }
.nwe-prompt { overflow-x: auto; margin: 0; padding: 12px 14px; border: 1px solid var(--nwe-border); border-radius: 10px; background: color-mix(in srgb, #080a0d 24%, var(--nwe-surface)); color: var(--nwe-ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.75; white-space: pre-wrap; }
.nwe-checklist { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.nwe-checklist li { display: flex; gap: 7px; color: var(--nwe-muted); font-size: 12px; line-height: 1.6; }
.nwe-checklist li::before { content: "✓"; color: var(--nwe-jade); font-weight: 700; }
.nwe-modal-foot { flex: 0 0 auto; padding: 10px 24px; border-top: 1px solid var(--nwe-border); color: var(--nwe-muted); font-size: 10px; }
.nwe-help-label { white-space: nowrap; }
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
.nwe-book-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
.nwe-book-card { padding: 14px 16px; border: 1px solid var(--nwe-border); border-radius: 14px; background: color-mix(in srgb, var(--nwe-surface) 92%, transparent); }
.nwe-book-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.nwe-book-title { font-family: "Noto Serif SC", "Songti SC", Georgia, serif; font-size: 14px; font-weight: 600; }
.nwe-book-note { color: var(--nwe-muted); font-size: 10px; }
.nwe-progress { overflow: hidden; height: 7px; margin-top: 10px; border-radius: 99px; background: var(--nwe-border); }
.nwe-progress > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--nwe-jade), var(--nwe-gold)); }
.nwe-progress-legend { display: flex; justify-content: space-between; margin-top: 5px; color: var(--nwe-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.nwe-volumes { max-height: 190px; overflow-y: auto; overscroll-behavior: contain; padding-right: 3px; }
.nwe-volume { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; color: var(--nwe-muted); font-size: 11px; }
.nwe-volume strong { overflow: hidden; color: var(--nwe-ink); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.nwe-volume.is-current strong { color: var(--nwe-gold); }
.nwe-copy { margin-top: 8px; padding: 6px 10px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-raised); color: var(--nwe-muted); font: inherit; font-size: 11px; cursor: pointer; }
.nwe-copy:hover { border-color: color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-border)); color: var(--nwe-ink); }
.nwe-resume-fallback { margin-top: 6px; padding: 8px 10px; border: 1px solid var(--nwe-border); border-radius: 8px; background: color-mix(in srgb, #080a0d 24%, var(--nwe-surface)); color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.6; white-space: pre-wrap; }
.nwe-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.nwe-chip { padding: 3px 8px; border: 1px solid var(--nwe-border); border-radius: 999px; color: var(--nwe-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.nwe-bars { display: flex; align-items: flex-end; gap: 5px; height: 54px; margin-top: 10px; }
.nwe-bar { flex: 1 1 0; min-width: 4px; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, var(--nwe-gold), color-mix(in srgb, var(--nwe-gold) 35%, transparent)); }
.nwe-health { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--nwe-muted); font-size: 11px; }
.nwe-health.is-bad { color: var(--nwe-rose); }
.nwe-activity { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 0; padding: 0; list-style: none; }
.nwe-activity li { display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; gap: 8px; color: var(--nwe-muted); font-size: 11px; }
.nwe-activity code { color: var(--nwe-ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
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
.nwe-project-choices { display: flex; flex-direction: column; gap: 8px; width: min(560px, 100%); margin-top: 16px; }
.nwe-project-choice { display: flex; flex-direction: column; gap: 3px; padding: 10px 13px; border: 1px solid var(--nwe-border); border-radius: 10px; background: var(--nwe-raised); color: var(--nwe-ink); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.nwe-project-choice:hover { border-color: color-mix(in srgb, var(--nwe-gold) 65%, var(--nwe-border)); }
.nwe-project-choice span { overflow-wrap: anywhere; color: var(--nwe-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
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
    note: '蓝图不是正文，可以后补。严格大纲是可选开关：strict:true 时每章必须先有章卡；不开启也能先写，但章卡一旦存在，标题、场景、目标字数和 cast 仍会校验。',
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
如果当前会话还没绑定或不确定是哪本书：先用 /novel current 看会话绑定，再调用 novel_status 看 selection；需要切换时用 /novel use <路径|书名|.>，不要靠 active 猜。
第一次调用带 project_root 时，它会成为当前会话的持久绑定；后续无 root 调用会继续这本书。

如果下一章还没有章卡：先用 novel_state {kind:"outline"} 取出全部章卡，再在末尾加上下一章的卡，用 novel_outline 整体提交；不要只提交新卡，也不要把已有 planned 卡丢掉。
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
            bars.length === 0 ? '—' : `${view.quality.averageScore.toFixed(1)} 均分`,
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
              : `需要处理：${view.health.blocking} 条门控 · ${view.health.stateErrors} 个损坏文档`,
          ),
        ),
      ),
    ),
  )
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
            createElement('span', null, row.at.slice(0, 16).replace('T', ' ')),
            createElement('code', null, row.op),
            createElement(
              'span',
              null,
              row.chapter === 0 ? row.status : `第 ${row.chapter} 章 · ${row.status}`,
            ),
          ),
        ),
    ),
  )
}

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

const projectSelector = (view: PanelView, onSelect: (root: string | null) => void): ReactElement | null => {
  if (view.projects.length === 0) return null
  return createElement(
    'div',
    { className: 'nwe-project' },
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
      view.selectedRoot === null ? createElement('option', { value: '' }, '选择项目…') : null,
      ...view.projects.map((project) =>
        createElement('option', { key: project.root, value: project.root }, project.label),
      ),
    ),
  )
}

const choosePanel = (view: PanelView, onSelect: (root: string | null) => void): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-state', role: 'status' },
    createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
    createElement('div', { className: 'nwe-state-title' }, '发现多本书，先选一本'),
    createElement('div', { className: 'nwe-state-text' }, view.subtitle),
    createElement(
      'div',
      { className: 'nwe-project-choices' },
      ...view.projects.map((project) =>
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

const missingPanel = (view: PanelView): ReactElement =>
  createElement(
    'div',
    { className: 'nwe-state', role: 'alert' },
    createElement('div', { className: 'nwe-state-icon' }, stateIcon()),
    createElement(
      'div',
      { className: 'nwe-state-title' },
      view.missing?.reason === 'unreadable' ? '项目不可读' : '项目不在了',
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
            '选择器里 choose 表示发现多本书、还没选；项目不在了表示目录缺失，绑定仍会保留；项目不可读表示权限或 IO 错误，先修权限或换一本。面板选择只影响查看，不改变任何会话的写作绑定。',
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
          createElement('pre', { className: 'nwe-prompt' }, TUTORIAL_PROMPT),
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
          createElement('pre', { className: 'nwe-prompt' }, TUTORIAL_NEXT_PROMPT),
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
        '教程基于 0.2.2 · 具体字段以当前任务书和工具返回为准 · 面板只读',
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
    }
  }, [open])

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
    open ? tutorialDialog(close, closeRef) : null,
  )
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
): ReactElement {
  const ready = view.state === 'ready'
  const selectable =
    ready ||
    view.state === 'choose' ||
    view.state === 'missing' ||
    (view.state === 'loading' && view.projects.length > 0)
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
            { className: `nwe-stage${view.finished ? ' is-done' : ''}` },
            view.stageLabel,
          ),
          ready ? createElement('span', null, view.subtitle) : null,
          ready ? createElement('span', { 'aria-hidden': 'true' }, '·') : null,
          ready ? createElement('span', null, view.revisionLabel) : null,
          view.state === 'choose' || view.state === 'missing' || view.state === 'loading'
            ? createElement('span', null, view.subtitle)
            : null,
        ),
        ready && view.root !== '' ? createElement('div', { className: 'nwe-rootline' }, view.root) : null,
      ),
      createElement(
        'div',
        { className: 'nwe-actions' },
        selectable ? projectSelector(view, onSelectProject) : null,
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
    ready
      ? createElement(
          'div',
          { className: 'nwe-stats', role: 'group', 'aria-label': '项目统计' },
          stat('已归档', String(view.stats.chapters), '章'),
          stat('总字数', view.stats.words.toLocaleString('zh-CN'), '字'),
          stat('平均评分', view.stats.chapters === 0 ? '—' : String(view.stats.averageScore), '/150'),
          stat('待处理', String(view.stats.blocking), '项'),
        )
      : null,
    view.state === 'loading' ? loadingState() : null,
    view.state === 'choose' ? choosePanel(view, onSelectProject) : null,
    view.state === 'missing' ? missingPanel(view) : null,
    view.state === 'error' || view.state === 'empty' || view.state === 'outdated'
      ? statePanel(view.state, view, loading, onRefresh)
      : null,
    ready ? bookSection(view) : null,
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
            createElement(CopyResumeButton, { text: view.resumeText }),
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
            createElement(
              'span',
              { className: 'nwe-section-note' },
              `${view.stats.chapters} 条记录${
                view.stats.chapters > view.rows.filter((row) => row.tone === 'ok').length
                  ? ` · 显示最近 ${view.rows.length} 条`
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
                    { className: 'nwe-block', key: `${item.code}-${item.scope}-${item.detail}` },
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
    ready ? activitySection(view) : null,
    footer(),
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
  return root === null ? base : `${base}?root=${encodeURIComponent(root)}`
}

/** Stateful wrapper: fetch once, refresh on demand and after returning to the tab. */
export function NovelPanel(): ReactElement {
  const [view, setView] = useState<PanelView>(() => buildView(null))
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(() => readStoredRoot())
  const alive = useRef(true)
  const requestId = useRef(0)
  const visibleRequest = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const queryRootRef = useRef<string | null>(selectedRoot)
  const loadRef = useRef<(silent?: boolean, root?: string | null) => Promise<void>>(async () => undefined)

  const load = useCallback(async (silent = false, root = queryRootRef.current) => {
    // A background poll/focus must never abort a user-visible refresh and leave
    // the loading state owned by a request that will be discarded.
    if (silent && visibleRequest.current !== 0) return
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
      const result = await fetchPanel(fetch, panelPath(root), anySignal)
      if (!alive.current || id !== requestId.current) return
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
        setSelectedRoot(payload.selection.root)
      }
      setView((previous) => {
        const next = buildView(payload, result.error)
        // A brief background failure must not wipe a readable panel.
        if (silent && result.error !== null && previous.state === 'ready') return previous
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

  const selectProject = useCallback(
    (root: string | null): void => {
      queryRootRef.current = root
      storeRoot(root)
      setSelectedRoot(root)
      setSwitching(true)
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
      if (doc.visibilityState !== 'hidden') void load(true)
    }
    const timer = win.setInterval(refreshWhenVisible, 15_000)
    win.addEventListener('focus', refreshWhenVisible)
    doc.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      alive.current = false
      controllerRef.current?.abort()
      win.clearInterval(timer)
      win.removeEventListener('focus', refreshWhenVisible)
      doc.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [load])

  return panelElement(
    { ...view, selectedRoot },
    loading || switching,
    () => void load(false, queryRootRef.current),
    selectProject,
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
