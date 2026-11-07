export const STUDIO_CSS = `
.nwe-root {
  --nwe-ink: var(--dsw-alias-label-primary, #e9e6df);
  --nwe-muted: var(--dsw-alias-label-secondary, #98a2b3);
  --nwe-surface: var(--dsw-alias-bg-layer-1, #15181e);
  --nwe-raised: var(--dsw-alias-bg-layer-2, #1d222b);
  --nwe-border: var(--dsw-alias-border-l1, rgba(255,255,255,.09));
  --nwe-accent: var(--dsw-alias-label-accent, #c8a96a);
  --nwe-blue: #5b9dff;
  --nwe-green: #53b483;
  --nwe-amber: #d6a84f;
  --nwe-red: #d46a6a;
  --nwe-font: var(--dsw-font-family, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  --nwe-serif: "Noto Serif SC", "Songti SC", "SimSun", serif;
  --nwe-radius: 10px;
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--nwe-ink);
  background: var(--nwe-surface);
  font-family: var(--nwe-font);
  font-size: 14px;
  line-height: 1.5;
}
.nwe-root *, .nwe-root *::before, .nwe-root *::after { box-sizing: border-box; }
.nwe-root button, .nwe-root input, .nwe-root textarea, .nwe-root select { font: inherit; color: inherit; }
.nwe-root button { cursor: pointer; }
.nwe-root a { color: var(--nwe-accent); }
.nwe-topbar {
  display: flex; align-items: center; gap: 14px; min-height: 54px; padding: 0 18px;
  border-bottom: 1px solid var(--nwe-border); background: color-mix(in srgb, var(--nwe-raised) 78%, transparent);
  backdrop-filter: blur(12px); z-index: 5;
}
.nwe-brand { display: flex; align-items: center; gap: 10px; min-width: 200px; }
.nwe-brand-mark { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--nwe-accent) 45%, transparent); color: var(--nwe-accent); }
.nwe-brand-title { font-weight: 650; letter-spacing: .02em; }
.nwe-brand-sub { color: var(--nwe-muted); font-size: 12px; }
.nwe-project-switch { width: 150px; min-height: 30px; padding: 4px 8px; font-size: 12px; }
.nwe-topbar-spacer { flex: 1; }
.nwe-inspector-toggle { display: none !important; }
.nwe-search {
  display: flex; align-items: center; gap: 8px; min-width: 250px; max-width: 420px; flex: 1;
  border: 1px solid var(--nwe-border); background: var(--nwe-surface); border-radius: 8px; padding: 7px 10px;
}
.nwe-search input { border: 0; outline: 0; background: transparent; width: 100%; }
.nwe-pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 3px 9px; font-size: 12px; border: 1px solid var(--nwe-border); color: var(--nwe-muted); white-space: nowrap; }
.nwe-pill.is-run { color: var(--nwe-blue); border-color: color-mix(in srgb, var(--nwe-blue) 40%, transparent); }
.nwe-pill.is-warn { color: var(--nwe-amber); border-color: color-mix(in srgb, var(--nwe-amber) 40%, transparent); }
.nwe-pill.is-ok { color: var(--nwe-green); border-color: color-mix(in srgb, var(--nwe-green) 40%, transparent); }
.nwe-pill.is-bad { color: var(--nwe-red); border-color: color-mix(in srgb, var(--nwe-red) 40%, transparent); }
.nwe-main { display: grid; grid-template-columns: 208px minmax(0, 1fr) 300px; min-height: 0; }
.nwe-leftrail { border-right: 1px solid var(--nwe-border); padding: 12px 8px; display: flex; flex-direction: column; gap: 3px; overflow: auto; background: color-mix(in srgb, var(--nwe-raised) 35%, transparent); }
.nwe-nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 11px; border: 0; border-radius: 8px; background: transparent; color: var(--nwe-muted); text-align: left; }
.nwe-nav-item:hover { background: color-mix(in srgb, var(--nwe-ink) 6%, transparent); color: var(--nwe-ink); }
.nwe-nav-item.is-active { background: color-mix(in srgb, var(--nwe-accent) 13%, transparent); color: var(--nwe-ink); box-shadow: inset 2px 0 0 var(--nwe-accent); }
.nwe-nav-badge { margin-left: auto; min-width: 18px; height: 18px; border-radius: 999px; display: grid; place-items: center; padding: 0 5px; background: var(--nwe-red); color: #fff; font-size: 11px; }
.nwe-rail-label { padding: 12px 11px 5px; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--nwe-muted); }
.nwe-center { min-width: 0; min-height: 0; overflow: auto; padding: 18px 20px 28px; }
.nwe-rightrail { border-left: 1px solid var(--nwe-border); padding: 16px; overflow: auto; background: color-mix(in srgb, var(--nwe-raised) 26%, transparent); }
.nwe-statusbar { display: flex; align-items: center; gap: 16px; min-height: 30px; padding: 0 18px; border-top: 1px solid var(--nwe-border); color: var(--nwe-muted); font-size: 12px; background: color-mix(in srgb, var(--nwe-raised) 55%, transparent); overflow: auto; white-space: nowrap; }
.nwe-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--nwe-muted); display: inline-block; }
.nwe-dot.is-ok { background: var(--nwe-green); }
.nwe-dot.is-bad { background: var(--nwe-red); }
.nwe-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.nwe-h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.01em; }
.nwe-h2 { margin: 0 0 10px; font-size: 15px; font-weight: 620; }
.nwe-sub { color: var(--nwe-muted); font-size: 13px; }
.nwe-grid { display: grid; gap: 12px; }
.nwe-grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.nwe-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.nwe-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.nwe-manuscript-grid { grid-template-columns: 240px minmax(0,1fr); gap: 12px; }
.nwe-kanban.nwe-kanban-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.nwe-card { border: 1px solid var(--nwe-border); background: color-mix(in srgb, var(--nwe-raised) 72%, transparent); border-radius: var(--nwe-radius); padding: 14px; min-width: 0; }
.nwe-card.is-selected { border-color: color-mix(in srgb, var(--nwe-accent) 55%, transparent); }
.nwe-card-title { font-size: 12px; color: var(--nwe-muted); letter-spacing: .04em; }
.nwe-stat { font-size: 24px; font-weight: 650; margin: 4px 0 2px; }
.nwe-stat.is-text { font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; }
.nwe-stat-unit { font-size: 12px; color: var(--nwe-muted); font-weight: 400; }
.nwe-row { display: flex; align-items: center; gap: 8px; }
.nwe-col { display: flex; flex-direction: column; gap: 8px; }
.nwe-wrap { flex-wrap: wrap; }
.nwe-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--nwe-border); background: var(--nwe-raised); border-radius: 7px; padding: 6px 11px; color: var(--nwe-ink); }
.nwe-btn:hover { border-color: color-mix(in srgb, var(--nwe-accent) 45%, transparent); }
.nwe-btn.is-primary { background: color-mix(in srgb, var(--nwe-accent) 82%, #000 18%); color: #16130d; border-color: transparent; font-weight: 620; }
.nwe-btn.is-danger { color: var(--nwe-red); }
.nwe-btn.is-ghost { background: transparent; }
.nwe-btn:disabled { opacity: .5; cursor: not-allowed; }
.nwe-input, .nwe-select, .nwe-textarea { width: 100%; border: 1px solid var(--nwe-border); background: var(--nwe-surface); border-radius: 7px; padding: 7px 9px; outline: 0; }
.nwe-input:focus, .nwe-select:focus, .nwe-textarea:focus { border-color: color-mix(in srgb, var(--nwe-accent) 55%, transparent); }
.nwe-textarea { min-height: 90px; resize: vertical; }
.nwe-list { display: flex; flex-direction: column; gap: 1px; }
.nwe-list-row { display: grid; grid-template-columns: 58px minmax(0,1fr) 78px 68px 72px; gap: 10px; align-items: center; padding: 9px 10px; border-radius: 7px; border: 1px solid transparent; background: transparent; text-align: left; }
.nwe-list-row:hover { background: color-mix(in srgb, var(--nwe-ink) 5%, transparent); }
.nwe-list-row.is-active { background: color-mix(in srgb, var(--nwe-accent) 11%, transparent); border-color: color-mix(in srgb, var(--nwe-accent) 28%, transparent); }
.nwe-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.nwe-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nwe-editor-wrap { border: 1px solid var(--nwe-border); border-radius: var(--nwe-radius); overflow: hidden; background: var(--nwe-surface); }
.nwe-editor { min-height: 420px; max-height: calc(100vh - 320px); overflow: auto; }
.nwe-editor .cm-editor { min-height: 420px; background: transparent; color: var(--nwe-ink); font-family: var(--nwe-serif); font-size: 16px; line-height: 1.9; }
.nwe-editor .cm-scroller { padding: 18px 22px; font-family: inherit; }
.nwe-editor .cm-gutters { background: transparent; border-right: 1px solid var(--nwe-border); color: var(--nwe-muted); }
.nwe-editor .cm-activeLine { background: color-mix(in srgb, var(--nwe-accent) 5%, transparent); }
.nwe-editor .cm-selectionBackground { background: color-mix(in srgb, var(--nwe-accent) 24%, transparent) !important; }
.nwe-editor .nwe-review-mark { background: color-mix(in srgb, var(--nwe-amber) 22%, transparent); border-bottom: 1px dashed color-mix(in srgb, var(--nwe-amber) 70%, transparent); }
.nwe-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--nwe-border); margin-bottom: 14px; overflow: auto; }
.nwe-tab { border: 0; background: transparent; padding: 8px 12px; color: var(--nwe-muted); border-bottom: 2px solid transparent; }
.nwe-tab.is-active { color: var(--nwe-ink); border-bottom-color: var(--nwe-accent); }
.nwe-kanban { display: grid; grid-template-columns: repeat(7, minmax(150px, 1fr)); gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.nwe-kanban-col { min-width: 0; border: 1px solid var(--nwe-border); border-radius: 9px; background: color-mix(in srgb, var(--nwe-raised) 40%, transparent); min-height: 220px; padding: 8px; }
.nwe-kanban-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--nwe-muted); padding: 2px 2px 8px; }
.nwe-task { border: 1px solid var(--nwe-border); border-radius: 7px; padding: 8px; margin-bottom: 7px; background: var(--nwe-surface); overflow: hidden; }
.nwe-task-title { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; flex-wrap: wrap; }
.nwe-task-title .nwe-pill { font-size: 10px; padding: 2px 6px; }
.nwe-task-meta { color: var(--nwe-muted); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
.nwe-sev { border-radius: 4px; padding: 1px 6px; font-size: 11px; border: 1px solid var(--nwe-border); }
.nwe-sev.is-blocker { color: var(--nwe-red); border-color: color-mix(in srgb, var(--nwe-red) 45%, transparent); }
.nwe-sev.is-advisory { color: var(--nwe-amber); border-color: color-mix(in srgb, var(--nwe-amber) 45%, transparent); }
.nwe-finding { border: 1px solid var(--nwe-border); border-radius: 8px; padding: 10px; background: var(--nwe-surface); }
.nwe-finding.is-selected { border-color: color-mix(in srgb, var(--nwe-accent) 55%, transparent); }
.nwe-evidence { margin-top: 6px; padding: 7px 9px; border-left: 2px solid var(--nwe-accent); background: color-mix(in srgb, var(--nwe-accent) 7%, transparent); color: var(--nwe-muted); font-family: var(--nwe-serif); }
.nwe-chart { width: 100%; height: 240px; }
.nwe-diff { max-height: 260px; overflow: auto; padding: 10px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-surface); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; }
.nwe-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.nwe-table-wrap { overflow-x: auto; }
.nwe-table th, .nwe-table td { text-align: left; padding: 8px 8px; border-bottom: 1px solid var(--nwe-border); }
.nwe-table th { color: var(--nwe-muted); font-weight: 500; }
.nwe-preview { max-height: 420px; overflow: auto; margin-top: 8px; padding: 14px 16px; border: 1px solid var(--nwe-border); border-radius: 8px; background: var(--nwe-surface); font-family: var(--nwe-serif); font-size: 15px; line-height: 1.9; white-space: pre-wrap; }
.react-flow__pane { z-index: 1; }
.react-flow__viewport { transform-origin: 0 0; z-index: 2; pointer-events: none; }
.react-flow__renderer { z-index: 4; }
.react-flow__nodes { pointer-events: none; transform-origin: 0 0; }
.react-flow .react-flow__edges { position: absolute; }
.react-flow .react-flow__edges svg { overflow: visible; position: absolute; pointer-events: none; }
.react-flow__node { position: absolute; pointer-events: all; transform-origin: 0 0; box-sizing: border-box; font-size: 12px; }
.react-flow__attribution { display: none; }
.react-flow__edge-path { stroke: var(--nwe-border); }
.nwe-empty { display: grid; place-items: center; min-height: 220px; text-align: center; color: var(--nwe-muted); border: 1px dashed var(--nwe-border); border-radius: var(--nwe-radius); padding: 24px; }
.nwe-inspector-label { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--nwe-muted); margin: 16px 0 6px; }
.nwe-kv { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 6px 8px; font-size: 12px; }
.nwe-kv dt { color: var(--nwe-muted); } .nwe-kv dd { margin: 0; overflow-wrap: anywhere; }
.nwe-dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 60; }
.nwe-dialog-content { position: fixed; left: 50%; top: 18%; transform: translateX(-50%); width: min(640px, calc(100vw - 32px)); max-height: 70vh; overflow: auto; z-index: 61; border: 1px solid var(--nwe-border); border-radius: 12px; background: var(--nwe-raised); padding: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.45); }
.nwe-cmd-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 7px; color: var(--nwe-muted); cursor: pointer; }
.nwe-cmd-item[data-selected='true'] { background: color-mix(in srgb, var(--nwe-accent) 12%, transparent); color: var(--nwe-ink); }
.nwe-flow { height: 360px; border: 1px solid var(--nwe-border); border-radius: var(--nwe-radius); overflow: hidden; }
.react-flow { position: relative; width: 100%; height: 100%; overflow: hidden; }
.react-flow__renderer, .react-flow__pane { position: absolute; inset: 0; }
.react-flow__node { position: absolute; transform-origin: 0 0; }
.react-flow__edge-path { stroke: var(--nwe-muted); stroke-width: 1.5; }
.react-flow__handle { width: 7px; height: 7px; background: var(--nwe-accent); }
.nwe-flow-node { border: 1px solid var(--nwe-border); border-radius: 7px; padding: 8px 10px; background: var(--nwe-surface); min-width: 120px; font-size: 12px; }
.nwe-skeleton { height: 12px; border-radius: 5px; background: linear-gradient(90deg, var(--nwe-border), color-mix(in srgb, var(--nwe-border) 40%, transparent), var(--nwe-border)); background-size: 200% 100%; animation: nwe-shimmer 1.4s ease-in-out infinite; }
@keyframes nwe-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .nwe-root *, .nwe-root *::before, .nwe-root *::after { animation: none !important; transition: none !important; } }
@media (max-width: 1279px) { .nwe-main { grid-template-columns: 180px minmax(0,1fr); } .nwe-rightrail { display: none; } .nwe-inspector-toggle { display: inline-flex !important; } .nwe-root.is-inspector-open .nwe-rightrail { display: block; position: fixed; top: 54px; right: 0; bottom: 30px; width: min(320px, 90vw); z-index: 40; background: var(--nwe-raised); box-shadow: -18px 0 50px rgba(0,0,0,.35); } }
@media (max-width: 767px) { .nwe-main { grid-template-columns: minmax(0,1fr); } .nwe-leftrail { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--nwe-border); } .nwe-rail-label { display: none; } .nwe-nav-item span { display: none; } .nwe-topbar { flex-wrap: wrap; } .nwe-search { min-width: 100%; order: 5; } .nwe-grid.cols-2, .nwe-grid.cols-3, .nwe-grid.cols-4, .nwe-manuscript-grid { grid-template-columns: minmax(0,1fr); } .nwe-kanban.nwe-kanban-3 { grid-template-columns: minmax(0,1fr); } .nwe-kanban { grid-template-columns: repeat(2, minmax(0,1fr)); } .nwe-nav-item, .nwe-btn { min-height: 44px; } .nwe-table { display: block; overflow-x: auto; white-space: nowrap; } }
`
