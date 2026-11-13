/* 卡片 UI：渲染、事件委托、弹窗与自动锁定。所有用户输入均转义后写入 DOM。 */

import { cryptoAvailable } from './crypto.js';
import {
  webAuthnState, platformAuthenticatorAvailable, localWraps,
  registerCredential, authenticate, removeLocalWrap,
} from './unlock.js';
import { normalizeItems } from './vault.js';

const IDLE_MS = 5 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const ICONS = {
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 12h9M18 12v4M15 12v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export const STYLES = `
:host { display: block; }
* { box-sizing: border-box; }
.card {
  width: 100%;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  color: var(--primary-text-color, #212121);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10));
}
.head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10)); flex-wrap: wrap; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; padding: 0; border: 1px solid transparent; background: transparent; color: var(--pw-text, var(--primary-text-color, #212121)); border-radius: 12px; cursor: pointer; transition: background .16s, border-color .16s, color .16s; }
.icon-btn:hover { background: var(--pw-hover, rgba(0,0,0,.06)); border-color: var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.10))); }
.icon-btn svg { width: 18px; height: 18px; }
.title { font-size: 18px; font-weight: 600; line-height: 1.3; }
.subtitle { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 2px; }
.head-main { flex: 1 1 auto; min-width: 0; }
.list-bar {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px; padding: 10px 20px;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10));
}
.list-bar input { flex: 1; width: 100%; min-width: 0; }
.list-bar select { width: 150px; flex: 0 0 150px; }
.head-actions, .actions, .foot, .dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--secondary-background-color, rgba(0,0,0,.06)); color: var(--secondary-text-color, #666); }
.body { padding: 20px; }
.hint { font-size: 13px; line-height: 1.6; color: var(--secondary-text-color, #777); margin: 0 0 16px; }
.field { display: block; margin: 0 0 14px; }
.field > span { display: block; font-size: 13px; margin-bottom: 6px; color: var(--secondary-text-color, #666); }
input, textarea, select {
  width: 100%; padding: 11px 14px; font: inherit; font-size: 14px;
  color: var(--pw-text, var(--primary-text-color, #212121));
  background: var(--pw-glass-strong, var(--ha-card-background, #fff));
  border: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.25)));
  border-radius: 12px; outline: none;
  transition: border-color .16s, box-shadow .16s;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--pw-accent, var(--primary-color, #03a9f4));
  box-shadow: 0 0 0 3px var(--pw-selected);
}
textarea { resize: vertical; min-height: 68px; }
button {
  font: inherit; font-size: 14px; padding: 10px 18px; border-radius: 12px; cursor: pointer;
  color: var(--pw-text, var(--primary-text-color, #212121));
  background: var(--pw-glass, transparent);
  border: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.22)));
  transition: background .16s, border-color .16s, transform .16s, filter .16s;
}
button:hover { background: var(--pw-hover, rgba(0,0,0,.05)); }
button:active { transform: translateY(1px); }
button.primary {
  background: var(--pw-accent, var(--primary-color, #03a9f4));
  color: var(--pw-on-accent, var(--text-primary-color, #fff)); border-color: transparent;
  box-shadow: 0 6px 18px rgba(0,0,0,.16);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--pw-accent) 35%, transparent);
}
button.primary:hover { filter: brightness(1.08); }
button.danger { color: var(--error-color, #d32f2f); }
.message { min-height: 20px; margin-top: 14px; font-size: 13px; color: var(--secondary-text-color, #777); word-break: break-word; }
.list { max-height: calc(100vh - 200px); overflow-y: auto; }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 20px; cursor: pointer; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.07)); }
.row:last-child { border-bottom: none; }
.row:hover { background: var(--secondary-background-color, rgba(0,0,0,.04)); }
.row-main { flex: 1; min-width: 0; }
.row-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-cat { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--secondary-background-color, rgba(0,0,0,.06)); color: var(--secondary-text-color, #666); }
.empty { padding: 40px 20px; text-align: center; color: var(--secondary-text-color, #777); font-size: 14px; }
.menu { position: relative; }
.menu summary {
  list-style: none; cursor: pointer; padding: 8px 14px; border-radius: 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.22)); font-size: 13px; white-space: nowrap;
}
.menu summary::-webkit-details-marker { display: none; }
.menu-list {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 50;
  min-width: 190px; padding: 8px; border-radius: 16px;
  background: var(--pw-glass-strong, var(--ha-card-background, #fff));
  border: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.12)));
  box-shadow: 0 18px 44px rgba(0,0,0,.20);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
}
.menu-list button {
  display: block; width: 100%; text-align: left; font-size: 13px;
  border: none; background: transparent; padding: 10px 12px; border-radius: 10px;
}
.menu-list button.menu-add { display: none; }
dialog {
  max-width: 560px; width: calc(100% - 32px); padding: 0; border-radius: 20px;
  color: var(--pw-text, var(--primary-text-color, #212121));
  background: var(--pw-glass-strong, var(--ha-card-background, #fff));
  border: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.12)));
  box-shadow: 0 28px 80px rgba(0,0,0,.28);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
}
dialog::backdrop {
  background: rgba(0,0,0,.38);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.dialog-head { padding: 22px 24px 16px; font-size: 19px; font-weight: 600; }
.dialog-body { padding: 4px 24px 20px; max-height: 65vh; overflow-y: auto; }
.dialog-actions {
  padding: 16px 24px 22px; justify-content: flex-end;
  border-top: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.10)));
}
.cred-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08)); font-size: 13px; }
.cred-row .cred-main { flex: 1; }
.cred-row .cred-sub { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 2px; }
@media (max-width: 768px) {
  .head { gap: 8px; padding: 10px 12px; }
  .list-bar { padding: 10px 12px; }
  .list-bar select { flex: 1 1 120px; width: auto; }
}

/* ===== 应用外壳：沉浸式渐变背景 + 玻璃质感面板 ===== */
:host {
  --pw-text: var(--primary-text-color, #212121);
  --pw-sub: var(--secondary-text-color, #727272);
  --pw-bg: var(--primary-background-color, #fafafa);
  --pw-surface: var(--ha-card-background, var(--card-background-color, #fff));
  --pw-sidebar: var(--sidebar-background-color, var(--pw-surface));
  --pw-line: var(--divider-color, rgba(0,0,0,.10));
  --pw-accent: var(--primary-color, #03a9f4);
  --pw-on-accent: var(--text-primary-color, #fff);
  --pw-hover: var(--secondary-background-color, rgba(0,0,0,.06));
  --pw-selected: var(--sidebar-selected-background-color, rgba(3,169,244,.14));
  --pw-radius-card: var(--ha-card-border-radius, 12px);
  --pw-radius-ctrl: 8px;
  --pw-card-border: 1px solid var(--ha-card-border-color, var(--pw-line));
  --pw-card-shadow: var(--ha-card-box-shadow, none);
  --pw-scrim: rgba(0,0,0,.32);
  --pw-header-h: 64px;
  --pw-backdrop:
    radial-gradient(70vw 70vw at 14% 8%, var(--pw-selected), transparent 68%),
    radial-gradient(65vw 65vw at 88% 92%, var(--pw-selected), transparent 70%),
    linear-gradient(140deg, transparent 45%, var(--pw-selected)),
    var(--pw-bg);
  --pw-glass: var(--pw-surface);
  --pw-glass-strong: var(--pw-surface);
  --pw-glass-line: var(--pw-line);
  --pw-glass-shadow: 0 14px 40px rgba(0,0,0,.10);
  --pw-blur: none;
  height: 100%;
  min-height: 360px;
  color: var(--pw-text);
  font-family: var(--ha-font-family-body, "Roboto", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
  font-size: var(--ha-font-size-m, 14px);
  line-height: 1.5;
  accent-color: var(--pw-accent);
}
@supports (background: color-mix(in srgb, red 50%, transparent)) {
  :host {
    --pw-glass: color-mix(in srgb, var(--pw-surface) 70%, transparent);
    --pw-glass-strong: color-mix(in srgb, var(--pw-surface) 88%, transparent);
    --pw-glass-line: color-mix(in srgb, var(--pw-text) 12%, transparent);
  }
}
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  :host { --pw-blur: blur(20px) saturate(150%); }
}
#root { height: 100%; }
.app {
  position: relative; display: flex; flex-direction: column;
  height: 100vh; height: 100dvh;
  min-height: max(360px, 100%); max-height: 100%;
  background: var(--pw-backdrop); overflow: hidden;
}
@supports (overflow: clip) { .app { overflow: clip; } }
.topbar {
  display: flex; align-items: center; gap: 12px; flex: none;
  height: var(--pw-header-h); padding: 0 20px; box-sizing: border-box;
  background: var(--pw-glass); color: var(--pw-text);
  border-bottom: 1px solid var(--pw-glass-line);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
  box-shadow: 0 6px 24px rgba(0,0,0,.06);
  position: relative; z-index: 15;
}
.brand {
  font-size: 16px; font-weight: 650; letter-spacing: .3px; flex: none;
  max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.icon-btn { width: 38px; height: 38px; border-radius: 12px; }
.icon-btn svg { width: 18px; height: 18px; }
.search {
  position: relative; display: flex; align-items: center; gap: 8px;
  flex: 1; min-width: 0; max-width: 460px; height: 40px; padding: 0 14px;
  border: 1px solid var(--pw-glass-line); border-radius: 999px;
  background: var(--pw-glass); color: var(--pw-text);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
  transition: border-color .16s, box-shadow .16s;
}
.search:focus-within { border-color: var(--pw-accent); box-shadow: 0 0 0 3px var(--pw-selected); }
.search svg { width: 16px; height: 16px; flex: none; color: var(--pw-sub); }
.search input {
  flex: 1; width: auto; min-width: 0; height: 100%; padding: 0;
  border: none; background: transparent; outline: none; color: inherit; font-size: 14px;
}
.search input:focus { box-shadow: none; }
.search-clear { border: none; background: transparent; padding: 0 2px; font-size: 18px; line-height: 1; color: var(--pw-sub); }
.search-clear[hidden] { display: none; }
.topbar .actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none; flex-wrap: nowrap; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 16px;
  border: 1px solid var(--pw-glass-line); border-radius: 999px;
  background: var(--pw-glass); color: inherit; font-size: 13px; white-space: nowrap;
}
.btn svg { width: 16px; height: 16px; }
.btn.primary { background: var(--pw-accent); color: var(--pw-on-accent); border-color: transparent; }
.topbar .menu summary {
  width: 40px; height: 40px; padding: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 12px; border: 1px solid var(--pw-glass-line); background: var(--pw-glass);
}
.topbar .menu summary svg { width: 18px; height: 18px; }
.layout { display: flex; flex: 1; min-height: 0; }
.sidebar {
  display: flex; flex-direction: column; width: 248px; flex: none; min-height: 0;
  background: var(--pw-glass); border-right: 1px solid var(--pw-glass-line);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
  overflow: hidden; transition: width .2s, opacity .2s;
}
.app.sidebar-collapsed .sidebar { width: 0; border-right-width: 0; opacity: 0; }
.sidebar-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 18px 10px; flex: none; font-size: 12px; font-weight: 600;
  letter-spacing: .12em; color: var(--pw-sub);
}
.tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 10px 16px; scrollbar-width: thin; }
.tree-row {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 42px;
  padding: 0 12px; margin: 2px 0; border: none; border-radius: 12px;
  background: transparent; color: var(--sidebar-text-color, var(--pw-text));
  font-size: 13px; text-align: left; cursor: pointer;
  transition: background .16s, color .16s;
}
.tree-row:hover { background: var(--pw-hover); }
.tree-row.active { background: var(--pw-selected); color: var(--pw-accent); font-weight: 600; box-shadow: inset 3px 0 0 var(--pw-accent); }
.tree-row svg { width: 16px; height: 16px; flex: none; color: var(--sidebar-icon-color, var(--pw-sub)); }
.tree-row.active svg { color: var(--pw-accent); }
.tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-count { flex: none; min-width: 24px; text-align: center; font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--pw-hover); color: var(--pw-sub); }
.sidebar-foot { flex: none; padding: 14px 18px; border-top: 1px solid var(--pw-glass-line); font-size: 11px; line-height: 1.6; color: var(--pw-sub); }
.main-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.confirm-box { padding: 4px 0 8px; }
.head-ico { display: inline-flex; width: 20px; height: 20px; margin-right: 8px; vertical-align: -4px; align-items: center; justify-content: center; color: var(--error-color, #d32f2f); }
.head-ico svg { width: 20px; height: 20px; }
.confirm-text { margin: 0; font-size: 14px; line-height: 1.6; }
.confirm-sub { margin: 6px 0 0; font-size: 12px; color: var(--pw-sub); }
.list-card {
  flex: 1; min-height: 0; overflow: auto; padding: 8px 0 16px;
  background: transparent;
  scrollbar-width: thin; overscroll-behavior: contain;
}
.entry {
  display: flex; align-items: center; gap: 14px; min-height: 62px; padding: 8px 28px;
  border-bottom: 1px solid var(--pw-glass-line); cursor: pointer;
  transition: background .16s;
}
.entry:hover { background: var(--pw-hover); }
.entry-ico { width: 38px; height: 38px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--pw-selected); color: var(--pw-accent); }
.entry-ico svg { width: 19px; height: 19px; }
.entry-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.entry-name { font-size: 14.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-sub { font-size: 12px; color: var(--pw-sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.entry-action {
  padding: 6px 10px; font-size: 12px; line-height: 1.2; white-space: nowrap;
  border: 1px solid transparent; border-radius: 9px;
  background: transparent; color: var(--pw-sub); cursor: pointer;
  transition: background .16s, color .16s, border-color .16s;
}
.entry-action:hover { background: var(--pw-hover); color: var(--pw-text); border-color: var(--pw-glass-line); }
.entry-action.danger:hover { background: transparent; color: var(--error-color, #d32f2f); }
.entry-action-mobile {
  display: none; align-items: center; justify-content: center;
  width: 32px; height: 32px; padding: 0; border: none; background: transparent;
  border-radius: 50%; color: var(--pw-sub); cursor: pointer;
}
.entry-action-mobile:hover { background: var(--pw-hover); }
.entry-action-mobile svg { width: 18px; height: 18px; }
.detail-row { padding: 10px 0; border-bottom: 1px solid var(--pw-glass-line, var(--divider-color, rgba(0,0,0,.08))); }
.detail-row:last-child { border-bottom: none; }
.detail-label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--pw-sub, var(--secondary-text-color, #777)); }
.detail-value { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.detail-link { display: inline-block; margin: 0 10px 4px 0; color: var(--pw-accent, var(--primary-color, #03a9f4)); text-decoration: none; border-bottom: 1px solid currentColor; word-break: break-all; }
.detail-link:hover { filter: brightness(1.15); }
.detail-plain { display: inline-block; margin-right: 10px; }
.empty-state { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--pw-sub); font-size: 14px; }
.empty-ico { width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; border-radius: 18px; background: var(--pw-glass); border: 1px solid var(--pw-glass-line); color: var(--pw-accent); }
.empty-ico svg { width: 26px; height: 26px; }
.empty-state small { font-size: 12px; opacity: .8; }
.center-pane { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 24px; overflow: auto; }
.center-pane .card {
  width: min(440px, 100%); border: 1px solid var(--pw-glass-line);
  border-radius: 20px; box-shadow: var(--pw-glass-shadow); overflow: hidden;
  background: var(--pw-glass-strong);
  -webkit-backdrop-filter: var(--pw-blur); backdrop-filter: var(--pw-blur);
}
.scrim { display: none; }
.tree::-webkit-scrollbar, .list-card::-webkit-scrollbar, .dialog-body::-webkit-scrollbar { width: 8px; }
.tree::-webkit-scrollbar-thumb, .list-card::-webkit-scrollbar-thumb, .dialog-body::-webkit-scrollbar-thumb { background: var(--pw-glass-line); border-radius: 999px; }
@media (max-width: 870px) {
  .sidebar {
    position: absolute; top: var(--pw-header-h); bottom: 0; left: 0; z-index: 12;
    width: min(272px, 84vw); transform: translateX(-100%);
    transition: transform .2s, opacity .2s; box-shadow: 0 20px 50px rgba(0,0,0,.24);
  }
  .app.sidebar-open .sidebar { transform: none; }
  .app.sidebar-collapsed .sidebar { width: min(272px, 84vw); border-right-width: 1px; opacity: 1; }
  .app.sidebar-open .scrim {
    display: block; position: absolute; inset: var(--pw-header-h) 0 0 0; z-index: 11;
    background: var(--pw-scrim); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  }
  .topbar { padding: 0 12px; gap: 8px; }
  .add-topbar { display: none; }
  .menu-list button.menu-add { display: block; }
  .btn-label { display: none; }
  .btn { padding: 0 10px; min-width: 40px; }
  .search { max-width: none; }
  .search:focus-within ~ .actions { display: none; }
  .entry { padding-left: 16px; padding-right: 16px; }
  .entry-action { display: none; padding: 6px; font-size: 11px; }
  .entry-action-mobile { display: inline-flex; }
  .entry.actions-open .entry-action { display: inline-flex; }
  .entry.actions-open .entry-action-mobile { display: none; }
}
@media (max-width: 600px) { .brand { max-width: 96px; font-size: 14px; } }
@media (hover: none) {
  .search input { font-size: 16px; }
}

/* ===== 全屏授权页：沉浸式背景，内容直接置于背景之上（Windows 登录风格） ===== */
.app.auth-mode .topbar { display: none; }
.auth-pane {
  position: relative; flex: 1; min-width: 0; min-height: 0; overflow: auto;
  display: flex; align-items: center; justify-content: center;
  padding: 32px 24px 12vh;
  background: var(--pw-backdrop);
}
.auth-menu { position: absolute; top: 16px; left: 16px; z-index: 2; }
.auth-inner {
  width: min(400px, 100%); margin: auto; padding: 0;
  color: var(--pw-text); animation: auth-in .28s ease-out both;
}
@keyframes auth-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .auth-inner { animation: none; } }
.auth-icon {
  display: flex; align-items: center; justify-content: center;
  width: 96px; height: 96px; margin: 0 auto 20px; border-radius: 50%;
  background: var(--pw-surface);
  background: color-mix(in srgb, var(--pw-surface) 70%, transparent);
  border: 1px solid var(--pw-line); color: var(--pw-accent);
  box-shadow: 0 8px 32px rgba(0,0,0,.10); backdrop-filter: blur(18px);
}
.auth-icon svg { width: 44px; height: 44px; }
.auth-title { margin: 0; text-align: center; font-size: 30px; font-weight: 500; letter-spacing: .5px; }
.auth-sub { margin: 6px 0 32px; text-align: center; font-size: 14px; color: var(--pw-sub); }
.auth-inner .field { position: relative; margin: 0 0 16px; }
.auth-inner .field > span {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.auth-inner input {
  height: 48px; padding: 0 16px; font-size: 15px; color: var(--pw-text);
  background: var(--pw-surface);
  background: color-mix(in srgb, var(--pw-surface) 68%, transparent);
  border: 1px solid var(--pw-line); border-bottom: 2px solid var(--pw-accent);
  border-radius: 4px; backdrop-filter: blur(12px);
}
.auth-inner input::placeholder { color: var(--pw-sub); }
.auth-inner input:focus {
  border-color: var(--pw-accent); outline: none;
  box-shadow: 0 0 0 3px var(--pw-selected);
}
.auth-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.auth-actions button {
  flex: 1 1 160px; min-height: 46px; border-radius: 4px;
  color: var(--pw-text); border: 1px solid var(--pw-line);
  background: var(--pw-surface);
  background: color-mix(in srgb, var(--pw-surface) 68%, transparent);
  backdrop-filter: blur(12px);
}
.auth-actions button:not(.primary):hover { border-color: var(--pw-accent); background: var(--pw-hover); }
.auth-actions button.primary {
  background: var(--pw-accent); color: var(--pw-on-accent); border-color: transparent;
}
.auth-actions button.primary:hover { filter: brightness(1.08); }
.auth-hint { margin: 24px 0 0; text-align: center; font-size: 12px; color: var(--pw-sub); }
.auth-inner .message { text-align: center; }
.auth-foot {
  position: absolute; left: 0; right: 0; bottom: 18px; z-index: 1;
  text-align: center; font-size: 12px; letter-spacing: .08em;
  color: var(--pw-sub); opacity: .8; pointer-events: none;
}
@media (max-width: 600px) {
  .auth-pane { padding: 24px 20px 8vh; }
  .auth-icon { width: 76px; height: 76px; }
  .auth-icon svg { width: 34px; height: 34px; }
  .auth-title { font-size: 26px; }
  .auth-foot { bottom: 10px; }
}

/* HA 侧边栏可见时不需要汉堡按钮；隐藏（窄屏或 always_hidden）时才出现 */
.sidebar-menu { display: none; }
.app.sidebar-hidden .sidebar-menu { display: inline-flex; }
`;

export class VaultView {
  constructor(root, api, vault) {
    this.root = root;
    this.api = api;
    this.vault = vault;
    this.screen = 'loading';
    this.message = '';
    this.dialog = null;
    this.editing = null;
    this.confirm = null;
    this.credentials = [];
    this.search = '';
    this.category = '';
    this.sidebarCollapsed = false;
    this.sidebarHidden = false;
    this.fingerprint = { available: false, platform: false, reason: '' };
    this.idle = null;
    this.hiddenAt = null;

    this.root.addEventListener('click', (event) => {
      this.resetIdle();
      this.onClick(event);
    });
    this.root.addEventListener('input', (event) => {
      this.resetIdle();
      this.onInput(event);
    });
    this.root.addEventListener('change', (event) => {
      this.resetIdle();
      this.onChange(event);
    });
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const field = event.target.dataset ? event.target.dataset.field : '';
      if (field === 'password') this.unlockWithPassword();
    });
    this.root.addEventListener('scroll', () => this.closeEntryActions(), true);
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        this.clearIdle();
      } else {
        if (this.hiddenAt && Date.now() - this.hiddenAt > IDLE_MS && this.vault.unlocked) {
          this.lock();
        }
        this.hiddenAt = null;
        this.resetIdle();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  destroy() {
    this.clearIdle();
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  clearIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  resetIdle() {
    this.clearIdle();
    if (!this.vault.unlocked) return;
    this.idle = setTimeout(() => this.lock(), IDLE_MS);
  }

  async start() {
    this.screen = 'loading';
    this.render();
    if (!cryptoAvailable()) {
      this.screen = 'error';
      this.message = '当前页面不是安全上下文，WebCrypto 不可用。请通过 HTTPS 或 localhost 访问 HomeAssistant。';
      this.render();
      return;
    }
    try {
      await this.vault.load();
      this.screen = 'locked';
    } catch (err) {
      this.screen = 'error';
      this.message = err.message;
      this.render();
      return;
    }
    this.fingerprint = webAuthnState();
    if (this.fingerprint.available) {
      this.fingerprint.platform = await platformAuthenticatorAvailable();
      if (!this.fingerprint.platform) {
        this.fingerprint.reason = '当前设备没有可用的平台指纹/生物识别认证器';
      }
    }
    this.render();
  }

  // ------------------------------------------------------------------ 渲染

  setSidebarHidden(hidden) {
    const value = Boolean(hidden);
    this.sidebarHidden = value;
    // 只切 class，不重建 DOM，避免解锁页正在输入时被清掉
    const app = this.root.querySelector('.app');
    if (app) app.classList.toggle('sidebar-hidden', value);
  }

  render() {
    this.root.innerHTML = this.template();
    const dialog = this.root.querySelector('dialog[data-dialog]');
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch (err) {
        dialog.setAttribute('open', '');
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        this.cancel();
      });
    }
  }

  messageBox() {
    return `<div class="message" data-message>${esc(this.message)}</div>`;
  }

  cardHead(title, subtitle, badge, actions = '') {
    return `<div class="head">
      <div class="head-main"><div class="title">${esc(title)}</div><div class="subtitle">${subtitle}</div></div>
      ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}${actions}
    </div>`;
  }

  template() {
    const locked = this.screen === 'locked';
    let pane;
    if (this.screen === 'loading') {
      pane = `<div class="center-pane"><div class="card"><div class="body"><div class="empty">正在加载密码库…</div></div></div></div>`;
    } else if (this.screen === 'error') {
      pane = `<div class="center-pane"><div class="card">${this.cardHead('我的密码', '无法启动', '异常')}
        <div class="body"><p class="hint">${esc(this.message)}</p>${this.messageBox()}</div></div></div>`;
    } else if (locked) {
      pane = this.lockedTemplate();
    } else {
      pane = this.sidebarTemplate() + this.mainTemplate();
    }
    return `<div class="app${this.sidebarCollapsed ? ' sidebar-collapsed' : ''}${locked ? ' auth-mode' : ''}${this.sidebarHidden ? ' sidebar-hidden' : ''}">
      ${locked ? '' : this.topbarTemplate()}
      <div class="layout">${pane}</div>
      <div class="scrim" data-act="close-sidebar"></div>
      <input type="file" accept="application/json,.json" data-field="import-file" hidden>
    </div>
    ${this.editDialogTemplate()}
    ${this.viewDialogTemplate()}
    ${this.confirmDialogTemplate()}
    ${this.credentialsDialogTemplate()}
    ${this.passwordDialogTemplate()}`;
  }

  lockedTemplate() {
    const ready = this.fingerprint.available && this.fingerprint.platform
      && Object.keys(localWraps()).length > 0;
    const reason = this.fingerprint.available
      ? (this.fingerprint.platform ? '本设备已注册指纹' : this.fingerprint.reason)
      : this.fingerprint.reason;
    return `<section class="auth-pane">
      <button class="icon-btn auth-menu sidebar-menu" data-action="toggle-menu" aria-label="打开 HomeAssistant 侧边栏" title="打开 HomeAssistant 侧边栏">${ICONS.menu}</button>
      <div class="auth-inner">
        <div class="auth-icon">${ICONS.lock}</div>
        <h1 class="auth-title">我的密码</h1>
        <p class="auth-sub">请输入主密码解锁</p>
        <label class="field"><span>主密码</span><input type="password" autocomplete="current-password" placeholder="主密码" aria-label="主密码" data-field="password" autofocus></label>
        <div class="auth-actions">
          <button class="primary" data-act="unlock">密码解锁</button>
          ${ready ? '<button data-act="fingerprint">指纹解锁</button>' : ''}
        </div>
        <p class="auth-hint">${esc(reason || '')}</p>
        ${this.messageBox()}
      </div>
      <div class="auth-foot">HOME ASSISTANT · 我的密码</div>
    </section>`;
  }

  itemName(item) {
    const first = String(item.notes || '').split('\n')[0].trim();
    return first || (item.origins || [])[0] || '未命名记录';
  }

  visibleItems() {
    const query = this.search.trim().toLowerCase();
    return this.vault.items.filter((item) => {
      if (this.category && item.category !== this.category) return false;
      if (!query) return true;
      return [item.category, item.notes, ...(item.origins || [])]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  listTemplate() {
    const items = this.visibleItems();
    if (!items.length) return `<div class="empty-state"><span class="empty-ico">${ICONS.key}</span><div>没有匹配的记录</div><small>换个关键词，或点右上角「新增」添加一条</small></div>`;
    return items.map((item) => {
      const sub = [item.category, (item.origins || [])[0]]
        .filter(Boolean).join(' · ').replace(/\s+/g, ' ');
      const id = esc(item.id);
      return `<div class="entry" data-act="view" data-id="${id}">
        <span class="entry-ico">${ICONS.key}</span>
        <div class="entry-main">
          <div class="entry-name">${esc(this.itemName(item))}</div>
          <div class="entry-sub">${esc(sub || '无附加信息')}</div>
        </div>
        <div class="entry-actions" data-act="noop">
          <button class="entry-action" data-act="edit" data-id="${id}">编辑</button>
          <button class="entry-action danger" data-act="delete" data-id="${id}">删除</button>
          <button class="entry-action-mobile" data-act="entry-actions-toggle" data-id="${id}" aria-label="展开操作" title="展开操作">${ICONS.more}</button>
        </div>
      </div>`;
    }).join('');
  }

  topbarTemplate() {
    const unlocked = this.screen === 'unlocked';
    const haMenu = `<button class="icon-btn sidebar-menu" data-action="toggle-menu" aria-label="打开侧边栏" title="打开 HomeAssistant 侧边栏">${ICONS.menu}</button>`;
    const sideToggle = `<button class="icon-btn" data-act="toggle-sidebar" aria-label="显示或隐藏分类栏" title="显示或隐藏分类栏">${ICONS.folder}</button>`;
    const current = this.category || '全部分类';
    const brand = `<div class="brand" title="${esc(current)}">${esc(current)}</div>`;
    const search = `<div class="search">${ICONS.search}
        <input type="search" data-field="search" placeholder="搜索分类 / 域名 / 备注" value="${esc(this.search)}" aria-label="搜索">
        <button class="search-clear" data-act="clear-search" aria-label="清空搜索"${this.search ? '' : ' hidden'}>&times;</button>
      </div>`;
    const menu = `<details class="menu">
        <summary aria-label="更多操作" title="更多操作">${ICONS.more}</summary>
        <div class="menu-list">
          <button class="menu-add" data-act="add">新增密码</button>
          <button data-act="import">导入备份</button>
          <button data-act="export">导出备份</button>
          <button data-act="credentials">指纹与凭据</button>
          <button data-act="password">修改主密码</button>
          <button data-act="lock">锁定</button>
        </div>
      </details>`;
    const actions = `<div class="actions">
        <button class="btn primary add-topbar" data-act="add" title="新增">${ICONS.plus}<span class="btn-label">新增</span></button>
        ${menu}
      </div>`;
    return `<header class="topbar">${haMenu}${sideToggle}${brand}${unlocked ? search + actions : ''}</header>`;
  }

  sidebarTemplate() {
    const total = this.vault.items.length;
    const row = (value, label, count) => `<button class="tree-row${this.category === value ? ' active' : ''}" data-act="category" data-category="${esc(value)}" title="${esc(label)}">
        ${ICONS.folder}<span class="tree-label">${esc(label)}</span><span class="tree-count">${count}</span>
      </button>`;
    const categories = this.vault.categories.map((name) => row(
      name, name, this.vault.items.filter((item) => item.category === name).length
    )).join('');
    return `<aside class="sidebar">
      <div class="sidebar-head"><span>分类</span><span class="tree-count">${total}</span></div>
      <div class="tree">${row('', '全部分类', total)}${categories}</div>
      <div class="sidebar-foot">点击分类筛选 · 点击条目查看 · 右侧按钮可编辑或删除 · 空闲 5 分钟自动锁定</div>
    </aside>`;
  }

  mainTemplate() {
    return `<main class="main-pane">
      <div class="list-card" data-list>${this.listTemplate()}</div>
    </main>`;
  }

  refreshList() {
    const list = this.root.querySelector('[data-list]');
    if (list) list.innerHTML = this.listTemplate();
    const clear = this.root.querySelector('[data-act="clear-search"]');
    if (clear) clear.hidden = !this.search;
  }

  toggleSidebar() {
    const app = this.root.querySelector('.app');
    if (!app) return;
    if (window.matchMedia('(max-width: 870px)').matches) {
      app.classList.toggle('sidebar-open');
      return;
    }
    this.sidebarCollapsed = !this.sidebarCollapsed;
    app.classList.toggle('sidebar-collapsed', this.sidebarCollapsed);
  }

  closeSidebar() {
    const app = this.root.querySelector('.app');
    if (app) app.classList.remove('sidebar-open');
  }

  closeEntryActions() {
    this.root.querySelectorAll('.entry.actions-open').forEach((node) => {
      node.classList.remove('actions-open');
    });
  }

  toggleEntryActions(button) {
    const entry = button.closest('.entry');
    const wasOpen = entry && entry.classList.contains('actions-open');
    this.closeEntryActions();
    if (entry && !wasOpen) entry.classList.add('actions-open');
  }

  editDialogTemplate() {
    if (this.dialog !== 'edit' || !this.editing) return '';
    const item = this.editing;
    const origins = (item.origins || []).join('\n');
    return `<dialog data-dialog="edit">
      <div class="dialog-head">${item.id ? '密码信息' : '新增密码'}</div>
      <div class="dialog-body">
        <label class="field"><span>密码分类</span><input name="category" list="category-options" value="${esc(item.category)}">
          <datalist id="category-options">${this.vault.categories.map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>
        </label>
        <label class="field"><span>备注（第一行作为列表显示名）</span><textarea name="notes" rows="4">${esc(item.notes)}</textarea></label>
        <label class="field"><span>用户名</span><input name="username" value="${esc(item.username)}" autocomplete="off"></label>
        <label class="field"><span>密码</span><input name="password" type="password" value="${esc(item.password)}" autocomplete="new-password"></label>
        <label class="field"><span>TOTP 密钥（可选）</span><input name="totp" value="${esc(item.totp)}" autocomplete="off"></label>
        <label class="field"><span>网站地址（可选，每行一个）</span><textarea name="origins" rows="2" placeholder="https://example.com">${esc(origins)}</textarea></label>
      </div>
      <div class="dialog-actions">
        <button data-act="cancel">取消</button>
        <button class="primary" data-act="save">保存</button>
      </div>
    </dialog>`;
  }

  originLinks(origins) {
    return (origins || []).map((value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      let href = '';
      try {
        const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const url = new URL(candidate, location.href);
        if (['http:', 'https:'].includes(url.protocol)) href = url.href;
      } catch (err) {
        href = '';
      }
      return href
        ? `<a class="detail-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="在新页面打开">${esc(raw)}</a>`
        : `<span class="detail-plain">${esc(raw)}</span>`;
    }).join('');
  }

  viewDialogTemplate() {
    if (this.dialog !== 'view' || !this.editing) return '';
    const item = this.editing;
    const rows = [
      ['密码分类', esc(item.category)],
      ['备注', esc(item.notes)],
      ['用户名', esc(item.username)],
      ['密码', esc(item.password)],
      ['TOTP 密钥', esc(item.totp)],
      ['网站地址', this.originLinks(item.origins)],
    ].filter(([, value]) => value);
    return `<dialog data-dialog="view">
      <div class="dialog-head">密码详情</div>
      <div class="dialog-body">
        ${rows.map(([label, value]) => `<div class="detail-row"><span class="detail-label">${label}</span><div class="detail-value">${value}</div></div>`).join('')}
      </div>
      <div class="dialog-actions"><button class="primary" data-act="cancel">关闭</button></div>
    </dialog>`;
  }

  confirmDialogTemplate() {
    if (this.dialog !== 'confirm' || !this.confirm) return '';
    const { title, text, sub, confirmText } = this.confirm;
    return `<dialog data-dialog="confirm">
      <div class="dialog-head"><span class="head-ico">${ICONS.trash}</span>${esc(title)}</div>
      <div class="dialog-body">
        <div class="confirm-box">
          <p class="confirm-text">${esc(text)}</p>
          ${sub ? `<p class="confirm-sub">${esc(sub)}</p>` : ''}
        </div>
      </div>
      <div class="dialog-actions">
        <button data-act="cancel">取消</button>
        <button class="danger" data-act="confirm">${esc(confirmText || '删除')}</button>
      </div>
    </dialog>`;
  }

  openConfirm(options) {
    this.confirm = options;
    this.dialog = 'confirm';
    this.editing = null;
    this.render();
  }

  credentialsDialogTemplate() {
    if (this.dialog !== 'credentials') return '';
    const wraps = localWraps();
    const rows = this.credentials.length
      ? this.credentials.map((item) => `<div class="cred-row">
          <div class="cred-main"><div>${esc(item.name || '未命名设备')}</div>
            <div class="cred-sub">${esc(item.created || '')} · 本设备${wraps[item.id] ? '可用' : '无本地数据'}</div></div>
          <button class="danger" data-act="revoke" data-id="${esc(item.id)}">撤销</button>
        </div>`).join('')
      : '<div class="empty">尚未注册任何指纹凭据</div>';
    return `<dialog data-dialog="credentials">
      <div class="dialog-head">指纹与凭据</div>
      <div class="dialog-body">
        <p class="hint">指纹解锁仅在本设备有效；更换设备后需用主密码解锁再重新注册。${esc(this.fingerprint.available ? '' : this.fingerprint.reason)}</p>
        <label class="field"><span>设备名称</span><input data-field="device-name" value="本设备"></label>
        <button class="primary" data-act="register"${this.fingerprint.platform ? '' : ' disabled'}>注册本设备指纹</button>
        <div style="margin-top:16px">${rows}</div>
      </div>
      <div class="dialog-actions"><button data-act="cancel">关闭</button></div>
    </dialog>`;
  }

  passwordDialogTemplate() {
    if (this.dialog !== 'password') return '';
    return `<dialog data-dialog="password">
      <div class="dialog-head">修改主密码</div>
      <div class="dialog-body">
        <p class="hint">数据密钥不变，已注册的指纹仍可继续解锁。</p>
        <label class="field"><span>新主密码（至少 8 位）</span><input type="password" data-field="new-password" autocomplete="new-password"></label>
        <label class="field"><span>确认新主密码</span><input type="password" data-field="new-password2" autocomplete="new-password"></label>
      </div>
      <div class="dialog-actions">
        <button data-act="cancel">取消</button>
        <button class="primary" data-act="password-save">保存</button>
      </div>
    </dialog>`;
  }

  // ------------------------------------------------------------------ 事件

  onInput(event) {
    const field = event.target.dataset ? event.target.dataset.field : '';
    if (field === 'search') {
      this.search = event.target.value;
      this.refreshList();
    }
  }

  async onChange(event) {
    const field = event.target.dataset ? event.target.dataset.field : '';
    if (field === 'import-file' && event.target.files[0]) {
      try {
        const items = normalizeItems(JSON.parse(await event.target.files[0].text()));
        await this.vault.importItems(items);
        await this.vault.save();
        this.render();
        this.toast(`已导入 ${items.length} 条记录`);
      } catch (err) {
        this.toast(`导入失败：${err.message}`);
      }
    }
  }

  async onClick(event) {
    if (!event.target.closest('[data-act="entry-actions-toggle"]')) this.closeEntryActions();
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const menu = this.root.querySelector('details.menu[open]');
    if (menu) menu.open = false;
    const action = target.dataset.act;
    try {
      switch (action) {
        case 'unlock': await this.unlockWithPassword(); break;
        case 'fingerprint': await this.unlockWithFingerprint(); break;
        case 'category': this.category = target.dataset.category || ''; this.render(); break;
        case 'toggle-sidebar': this.toggleSidebar(); break;
        case 'close-sidebar': this.closeSidebar(); break;
        case 'clear-search': this.search = ''; this.render(); break;
        case 'lock': this.lock(); break;
        case 'add': await this.openEdit(null); break;
        case 'view': await this.openView(target.dataset.id); break;
        case 'entry-actions-toggle': this.toggleEntryActions(target); break;
        case 'edit': await this.openEdit(target.dataset.id); break;
        case 'delete': await this.removeItem(target.dataset.id); break;
        case 'save': await this.saveItem(); break;
        case 'confirm': await this.confirmAction(); break;
        case 'cancel': this.cancel(); break;
        case 'export': await this.exportBackup(); break;
        case 'import': this.root.querySelector('[data-field="import-file"]').click(); break;
        case 'credentials': await this.openCredentials(); break;
        case 'register': await this.register(); break;
        case 'revoke': await this.revoke(target.dataset.id); break;
        case 'password': this.dialog = 'password'; this.render(); break;
        case 'password-save': await this.changePassword(); break;
        default: break;
      }
    } catch (err) {
      this.toast(err.message || '操作失败');
    }
  }

  toast(text) {
    this.message = text;
    const box = this.root.querySelector('[data-message]');
    if (box) box.textContent = text;
    this.root.dispatchEvent(new CustomEvent('hass-notification', {
      bubbles: true, composed: true, detail: { message: text },
    }));
  }

  cancel() {
    this.dialog = null;
    this.editing = null;
    this.confirm = null;
    this.render();
  }

  // ------------------------------------------------------------------ 业务

  async unlockWithPassword() {
    const input = this.root.querySelector('[data-field="password"]');
    const password = input ? input.value : '';
    if (!password) return this.toast('请输入主密码');
    await this.vault.unlockWithPassword(password);
    this.screen = 'unlocked';
    this.message = '已解锁';
    this.render();
    this.resetIdle();
  }

  async unlockWithFingerprint() {
    this.toast('请验证指纹…');
    const result = await authenticate(this.api);
    await this.vault.unlockWithCredential(result.credSecret, result.wrapped);
    this.screen = 'unlocked';
    this.message = '指纹解锁成功';
    this.render();
    this.resetIdle();
  }

  lock() {
    this.vault.lock();
    this.dialog = null;
    this.editing = null;
    this.confirm = null;
    this.search = '';
    this.category = '';
    this.screen = 'locked';
    this.clearIdle();
    this.render();
    this.toast('已锁定');
  }

  async openView(id) {
    const item = await this.vault.reveal(id);
    if (!item) return;
    this.editing = item;
    this.dialog = 'view';
    this.render();
  }

  async openEdit(id) {
    const item = id ? await this.vault.reveal(id) : null;
    this.editing = item || {
      id: '', type: 'login', category: '', origins: [],
      notes: '', username: '', password: '', totp: '', updatedAt: '',
    };
    this.dialog = 'edit';
    this.render();
  }

  dialogFields(name) {
    const dialog = this.root.querySelector(`[data-dialog="${name}"]`);
    if (!dialog) return null;
    return {
      dialog,
      value: (field) => {
        const element = dialog.querySelector(`[name="${field}"]`);
        return element ? element.value.trim() : '';
      },
    };
  }

  async saveItem() {
    const form = this.dialogFields('edit');
    if (!form) return;
    const item = {
      id: this.editing.id,
      type: this.editing.type || 'login',
      category: form.value('category'),
      origins: form.value('origins').split('\n').map((value) => value.trim()).filter(Boolean),
      notes: form.value('notes'),
      username: form.value('username'),
      password: form.value('password'),
      totp: form.value('totp'),
    };
    await this.vault.upsert(item);
    await this.vault.save();
    this.dialog = null;
    this.editing = null;
    this.render();
    this.toast('已保存');
  }

  removeItem(id) {
    if (!id) return;
    const item = this.vault.items.find((entry) => entry.id === id);
    this.openConfirm({
      title: '删除记录',
      text: `「${item ? this.itemName(item) : '这条记录'}」将被永久删除。`,
      sub: '此操作无法撤销，建议先导出备份。',
      confirmText: '删除',
      action: 'delete-item',
      id,
    });
  }

  async confirmAction() {
    const options = this.confirm;
    if (!options || !['delete-item', 'revoke-credential'].includes(options.action)) return;
    if (options.action === 'delete-item') {
      this.vault.remove(options.id);
      await this.vault.save();
    } else {
      await this.api.deleteCredential(options.id, this.vault.proof);
      removeLocalWrap(options.id);
      this.credentials = await this.api.listCredentials();
    }
    this.dialog = options.action === 'revoke-credential' ? 'credentials' : null;
    this.editing = null;
    this.confirm = null;
    this.render();
    this.toast(options.action === 'delete-item' ? '已删除' : '凭据已撤销');
  }

  async exportBackup() {
    const blob = new Blob([await this.vault.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `password-backup-${today()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast('已导出明文备份，请妥善保管并尽快删除');
  }

  async openCredentials() {
    this.credentials = await this.api.listCredentials();
    this.dialog = 'credentials';
    this.render();
  }

  async register() {
    if (!this.fingerprint.platform) return this.toast('当前环境不支持指纹解锁');
    const input = this.root.querySelector('[data-field="device-name"]');
    const name = (input && input.value.trim()) || '本设备';
    this.toast('请在设备上完成指纹验证…');
    await registerCredential(this.api, this.vault.key, name, this.vault.proof);
    this.credentials = await this.api.listCredentials();
    this.render();
    this.toast('指纹注册成功');
  }

  revoke(id) {
    const credential = this.credentials.find((item) => item.id === id);
    this.openConfirm({
      title: '撤销指纹凭据',
      text: `「${credential ? credential.name || '未命名设备' : '该凭据'}」将无法再用于指纹解锁。`,
      sub: '本设备需要重新注册才能继续使用。',
      confirmText: '撤销',
      action: 'revoke-credential',
      id,
    });
  }

  async changePassword() {
    const dialog = this.root.querySelector('[data-dialog="password"]');
    const first = dialog.querySelector('[data-field="new-password"]').value.trim();
    const second = dialog.querySelector('[data-field="new-password2"]').value.trim();
    if (first.length < 8) return this.toast('新主密码至少需要 8 位');
    if (first !== second) return this.toast('两次输入的新主密码不一致');
    await this.vault.changePassword(first);
    this.dialog = null;
    this.render();
    this.toast('主密码已更新，指纹凭据仍可继续使用');
  }
}
