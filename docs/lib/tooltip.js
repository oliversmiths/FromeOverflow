/**
 * One shared tooltip for anything carrying a `data-tip*` attribute.
 *
 *   initTooltips();                 // once, after the page has rendered
 *
 * Plain — a single line:
 *   <span data-tip="5 Aug 2026 — no discharge">
 *
 * Structured — up to three separately styled rows, any subset:
 *   <span data-tip-date="1 Sept 2026"
 *         data-tip-status="No discharge" data-tip-state="dry"
 *         data-tip-note="Recording began part-way through this day">
 * `data-tip-state` adds a colour dot (`.tip-dot--{state}`) to the status row.
 *
 * Replaces the native `title`, which takes about half a second to appear, can't
 * be styled, and never shows on touch. This appears at once, in the site's own
 * type, and is positioned so it can't leave the viewport — which matters here
 * because the 90-day bars are ~4px wide and sit hard against both edges of a
 * 500px panel.
 *
 * `position: fixed` keeps it clear of the panel's own scrolling; it hides on
 * scroll rather than trying to track the target.
 */

const EDGE = 14;   // clearance from the viewport edge
const GAP = 14;    // between the target and the tooltip — tune for how the
                   // now-tall tooltip sits against the strip and the card above

let tip = null;
let showing = null;

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function place(target) {
  const el = ensure();
  const t = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  // Centred over the target, then pulled back inside the viewport. A bar at the
  // far left or right of the strip would otherwise hang off the screen.
  let left = t.left + t.width / 2 - w / 2;
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE));

  // Above by preference; below when there isn't room, so it never covers the
  // thing being described.
  let top = t.top - GAP - h;
  if (top < EDGE) top = t.bottom + GAP;
  top = Math.min(top, Math.max(EDGE, window.innerHeight - h - EDGE));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function build(el, d) {
  el.replaceChildren();

  const rows = [];
  if (d.tipDate) rows.push(['tip-date', d.tipDate]);
  if (d.tipStatus) rows.push(['tip-status', d.tipStatus, d.tipState]);
  if (d.tipNote) rows.push(['tip-note', d.tipNote]);

  if (rows.length) {
    el.classList.add('tip--rows');
    for (const [cls, text, state] of rows) {
      const row = document.createElement('div');
      // `tip-status--dry` etc. colours the whole row; the dot rides on
      // currentColor, so text and dot always match.
      row.className = state ? `${cls} ${cls}--${state}` : cls;
      if (state) {
        const dot = document.createElement('span');
        dot.className = 'tip-dot';
        row.append(dot);
      }
      row.append(text);
      el.append(row);
    }
    return true;
  }

  el.classList.remove('tip--rows');
  if (d.tip) { el.textContent = d.tip; return true; }
  return false;
}

function show(target) {
  const el = ensure();
  if (!build(el, target.dataset)) return;
  el.hidden = false;
  showing = target;
  place(target);           // measured only once it has content and is visible
}

function hide() {
  if (!tip) return;
  tip.hidden = true;
  showing = null;
}

export function initTooltips(root = document) {
  const find = (e) => e.target.closest?.('[data-tip], [data-tip-date], [data-tip-status]');

  root.addEventListener('pointerover', (e) => {
    const t = find(e);
    if (t && t !== showing) show(t);
    else if (!t && showing) hide();
  });

  root.addEventListener('pointerdown', (e) => {
    // Touch: a tap shows it, a tap anywhere else dismisses it.
    const t = find(e);
    if (t) show(t);
    else hide();
  });

  // Keyboard parity — a focused bar describes itself too.
  root.addEventListener('focusin', (e) => {
    const t = find(e);
    if (t) show(t);
  });
  root.addEventListener('focusout', hide);

  // Anchored to a rect taken when it opened, so stop rather than drift.
  addEventListener('scroll', hide, { capture: true, passive: true });
  addEventListener('resize', hide, { passive: true });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
