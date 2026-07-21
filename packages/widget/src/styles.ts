export const WIDGET_STYLES = /* css */ `
:host {
  --bl-accent: #6d28d9;
  --bl-accent-hover: #5b21b6;
  --bl-accent-fg: white;
  --bl-bg: #ffffff;
  --bl-fg: #16151a;
  --bl-muted: #6b7280;
  --bl-border: #e5e7eb;
  --bl-input-bg: #f9fafb;
  --bl-danger: #b91c1c;
  --bl-danger-bg: #fef2f2;
  --bl-warn: #92400e;
  --bl-warn-bg: #fffbeb;
  --bl-radius: 14px;
  /* Caps the widget's own width; a host page that wants it to fill a wider
     container (rather than stay a fixed-width card) overrides this to a
     larger value or "none". */
  --bl-max-width: 380px;
  --bl-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  all: initial;
  display: inline-block;
  width: 100%;
  max-width: var(--bl-max-width);
  font-family: var(--bl-font-family);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bl-bg: #17151f;
    --bl-fg: #f4f2f8;
    --bl-muted: #9a94ab;
    --bl-border: #322d40;
    --bl-input-bg: #201d2b;
    --bl-danger: #fca5a5;
    --bl-danger-bg: #3a1414;
    --bl-warn: #fcd34d;
    --bl-warn-bg: #3a2a0a;
  }
}
:host([data-theme="dark"]) {
  --bl-bg: #17151f;
  --bl-fg: #f4f2f8;
  --bl-muted: #9a94ab;
  --bl-border: #322d40;
  --bl-input-bg: #201d2b;
}
:host([data-theme="light"]) {
  --bl-bg: #ffffff;
  --bl-fg: #16151a;
  --bl-muted: #6b7280;
  --bl-border: #e5e7eb;
  --bl-input-bg: #f9fafb;
}
* { box-sizing: border-box; }
.card {
  position: relative;
  width: 100%;
  background: var(--bl-bg);
  color: var(--bl-fg);
  border: 1px solid var(--bl-border);
  border-radius: var(--bl-radius);
  padding: 24px;
  font-size: 14px;
  line-height: 1.5;
}
h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 4px;
}
/* One fixed SVG (icon + wordmark, same file as the marketing site's assets/lockup.svg)
   with the relative size and spacing between them baked in -- only the overall height
   is ever set here, so the lockup can never end up looking different in one place than
   another the way independently-sized icon + text elements could drift apart. */
.brand-lockup {
  display: block;
  height: 20px;
  width: auto;
  margin: 0 0 6px;
  color: var(--bl-fg);
}
/* Brief confirmation stamp shown over the destination screen right after a real
   security-relevant success (see flashSuccess() in element.ts) -- the same brass ring
   and checkmark as the brand mark, so a successful sign-in/create/recover/rotate reads
   as "sealed," not just a silent screen change. Never blocks interaction, and fades out
   on its own; the JS timer that removes it entirely doesn't depend on the animation. */
.success-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bl-bg);
  border-radius: var(--bl-radius);
  pointer-events: none;
  animation: bl-overlay-fade-out 0.4s ease 0.7s both;
}
.success-stamp svg {
  width: 56px;
  height: 56px;
  animation: bl-stamp-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.success-label {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--bl-fg);
  opacity: 0;
  animation: bl-label-in 0.3s ease 0.35s both;
}
@keyframes bl-stamp-in {
  0% { transform: scale(0.5); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes bl-label-in {
  to { opacity: 1; }
}
@keyframes bl-overlay-fade-out {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .success-overlay { animation: none; }
  .success-stamp svg { animation: none; }
  .success-label { animation: none; opacity: 1; }
}
p.sub {
  color: var(--bl-muted);
  margin: 0 0 18px;
  font-size: 13px;
}
label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin: 14px 0 6px;
}
input[type="text"], input[type="password"] {
  width: 100%;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid var(--bl-border);
  background: var(--bl-input-bg);
  color: var(--bl-fg);
  font-size: 14px;
  font-family: inherit;
}
input:focus { outline: 2px solid var(--bl-accent); outline-offset: 1px; }
.credential-box {
  background: var(--bl-input-bg);
  border: 1px solid var(--bl-border);
  border-radius: 9px;
  padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13.5px;
  word-break: break-word;
  margin: 6px 0 2px;
  user-select: all;
}
.phrase-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin: 10px 0;
}
.phrase-word {
  background: var(--bl-input-bg);
  border: 1px solid var(--bl-border);
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  display: flex;
  gap: 4px;
}
.phrase-word span { color: var(--bl-muted); }
button {
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  border-radius: 9px;
  border: none;
  padding: 11px 14px;
  cursor: pointer;
  width: 100%;
  margin-top: 14px;
}
button.primary { background: var(--bl-accent); color: var(--bl-accent-fg); }
button.primary:hover { background: var(--bl-accent-hover); }
button.primary:disabled { opacity: 0.55; cursor: default; }
button.secondary { background: transparent; color: var(--bl-fg); border: 1px solid var(--bl-border); }
button.secondary:hover { background: var(--bl-input-bg); }
button.link {
  display: block;
  background: none;
  color: var(--bl-accent);
  width: auto;
  padding: 0;
  margin: 12px 0 0;
  font-weight: 500;
  font-size: 13px;
}
.row { display: flex; gap: 8px; }
.row > * { flex: 1; }
.notice {
  border-radius: 9px;
  padding: 10px 12px;
  font-size: 13px;
  margin: 12px 0;
}
.notice.warn { background: var(--bl-warn-bg); color: var(--bl-warn); }
.notice.error { background: var(--bl-danger-bg); color: var(--bl-danger); }
.notice.info { background: var(--bl-input-bg); color: var(--bl-fg); border: 1px solid var(--bl-border); }
.pubkey {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--bl-muted);
  word-break: break-all;
}
.divider { border-top: 1px solid var(--bl-border); margin: 18px 0; }
.small { font-size: 12px; color: var(--bl-muted); }
.checkbox-row { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0; font-size: 13px; }
.checkbox-row input { margin-top: 3px; }
.spinner {
  display: inline-block;
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: bl-spin 0.7s linear infinite;
  vertical-align: -2px;
  margin-right: 6px;
}
@keyframes bl-spin { to { transform: rotate(360deg); } }
`;
