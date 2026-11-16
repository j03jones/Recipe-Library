// Motion and touch: the things that make the app feel native on a phone.
//   - page transitions: pages slide forward and back, and a recipe's tile flies from the list into its page
//   - a compact title bar that fades in once the big page title has scrolled away
//   - dialogs become bottom sheets on phones and can be swiped down to close
//   - in the iPhone app, swiping in from the left edge goes back (as in every iPhone app)
//   - pull to refresh, and rows you can swipe (shopping list: right to tick, left to remove)
// Everything respects "reduce motion".

const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const TAB_ROOTS = new Set(['', 'starred', 'plan', 'shop', 'new', 'settings']);
const rootOf = (hash) => hash.replace(/^#\/?/, '').split('/')[0];

// ------------------------------------------------------------------ page transitions
let lastHash = location.hash;
/** Runs `render` inside a view transition. forward/back is worked out from the history index; moving
 *  between tabs cross-fades instead of sliding. Resolves (with render's result) once the new page is drawn. */
export function transition(render, { back = false } = {}) {
  const from = rootOf(lastHash); const to = rootOf(location.hash);
  lastHash = location.hash;
  if (!document.startViewTransition || reduced() || document.visibilityState !== 'visible') return render();
  document.documentElement.dataset.nav = TAB_ROOTS.has(from) && TAB_ROOTS.has(to) && from !== to ? 'tab' : back ? 'back' : 'forward';
  let out;
  const t = document.startViewTransition(() => { out = render(); return out; });
  const drawn = t.updateCallbackDone.catch(() => {}).then(() => out);     // the new page is on screen
  // a quick second tap skips the first transition; that's expected, not an error
  t.ready.catch(() => {});
  t.finished.catch(() => {}).finally(() => {
    delete document.documentElement.dataset.nav;
    for (const el of document.querySelectorAll('[data-vt]')) { el.style.viewTransitionName = ''; delete el.dataset.vt; }
  });
  return drawn;
}

/** Tapping a recipe card or row names its tile, so the transition can fly it to the recipe page's tile. */
export function flyingTiles() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.rc, a.fcard');
    const tile = a?.querySelector('.tile');
    if (!tile || reduced()) return;
    tile.style.viewTransitionName = 'rtile'; tile.dataset.vt = '1';
  }, true);
}

// ------------------------------------------------------------------ compact title bar
let bar = null; let watcher = null;
/** Call after each page is drawn: watches the page's big title and shows it small at the top once it's gone. */
export function compactTitle() {
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'minibar'; bar.setAttribute('aria-hidden', 'true');
    document.body.append(bar);
  }
  watcher?.disconnect();
  bar.classList.remove('on');
  const h1 = document.querySelector('#app .band h1, #app .pagehead h1, #app > h1');
  if (!h1 || !('IntersectionObserver' in globalThis)) return;
  bar.textContent = h1.textContent;
  watcher = new IntersectionObserver(([e]) => bar.classList.toggle('on', !e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
  watcher.observe(h1);
}

// ------------------------------------------------------------------ bottom sheets you can swipe down
export function swipeableSheets() {
  let dlg = null; let y0 = 0; let dy = 0;
  document.addEventListener('touchstart', (e) => {
    const d = e.target.closest?.('dialog[open]');
    if (!d || !matchMedia('(max-width: 599px)').matches) return;
    // only from the top strip of the sheet, or anywhere when its content isn't scrolled
    const fromTop = e.touches[0].clientY - d.getBoundingClientRect().top < 56;
    if (!fromTop && d.scrollTop > 0) return;
    dlg = d; y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!dlg) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    dlg.style.transform = `translateY(${dy}px)`; dlg.style.transition = 'none';
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!dlg) return;
    const d = dlg; dlg = null;
    d.style.transition = 'transform .22s ease';
    if (dy > 110) { d.style.transform = 'translateY(100%)'; setTimeout(() => { d.close(); d.style.transform = ''; d.style.transition = ''; }, 200); }
    else d.style.transform = '';
  });
}

// ------------------------------------------------------------------ iPhone app: swipe from the left edge to go back
export function edgeSwipeBack(goBack) {
  let x0 = -1; let y0 = 0; let page = null;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX < 22 && !document.querySelector('dialog[open], .cook') ? t.clientX : -1;
    y0 = t.clientY; page = document.getElementById('app');
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (x0 < 0) return;
    const dx = e.touches[0].clientX - x0;
    if (Math.abs(e.touches[0].clientY - y0) > Math.abs(dx)) { x0 = -1; page.style.transform = ''; return; }
    page.style.transition = 'none'; page.style.transform = `translateX(${Math.max(0, dx * 0.6)}px)`;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (x0 < 0) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = -1;
    page.style.transition = 'transform .2s ease'; page.style.transform = '';
    if (dx > 90 && location.hash && location.hash !== '#/') goBack();
  });
}

// ------------------------------------------------------------------ pull to refresh
/** Pulling down at the top of the page shows a spinner and runs onRefresh (a promise). */
export function pullToRefresh(onRefresh) {
  const spin = document.createElement('div');
  spin.className = 'ptr'; spin.setAttribute('aria-hidden', 'true');
  document.body.append(spin);
  let y0 = -1; let dy = 0; let busy = false;
  const start = (e) => { y0 = !busy && scrollY <= 0 && !document.querySelector('dialog[open], .cook') ? e.touches[0].clientY : -1; dy = 0; };
  const move = (e) => {
    if (y0 < 0) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    const p = Math.min(1, dy / 90);
    spin.style.opacity = String(p); spin.style.transform = `translate(-50%, ${dy * 0.5}px) rotate(${p * 270}deg)`;
  };
  const end = async () => {
    if (y0 < 0) return;
    y0 = -1;
    if (dy < 90) { spin.style.opacity = '0'; spin.style.transform = ''; return; }
    busy = true; spin.classList.add('busy');
    try { await onRefresh(); } finally {
      busy = false; spin.classList.remove('busy'); spin.style.opacity = '0'; spin.style.transform = '';
    }
  };
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: true });
  document.addEventListener('touchend', end);
  return () => { document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); spin.remove(); };
}

// ------------------------------------------------------------------ swipeable rows
/** Lets a list row be swiped: right runs onRight (e.g. tick it off), left runs onLeft (e.g. remove it).
 *  The row follows the finger and shows a coloured label underneath. */
export function swipeRow(li, { onRight, rightLabel = 'Done', onLeft, leftLabel = 'Remove' }) {
  const face = li.firstElementChild;
  if (!face) return li;
  li.classList.add('swipe');
  let x0 = -1; let y0 = 0; let dx = 0; let locked = false;
  li.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; locked = false; }, { passive: true });
  li.addEventListener('touchmove', (e) => {
    if (x0 < 0) return;
    const mx = e.touches[0].clientX - x0; const my = e.touches[0].clientY - y0;
    if (!locked) { if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { x0 = -1; return; } if (Math.abs(mx) > 10) locked = true; }
    if (!locked) return;
    dx = mx < 0 && !onLeft ? 0 : mx > 0 && !onRight ? 0 : mx;
    li.dataset.swipe = dx > 0 ? rightLabel : dx < 0 ? leftLabel : '';
    li.classList.toggle('left', dx < 0);
    face.style.transition = 'none'; face.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  li.addEventListener('touchend', () => {
    if (x0 < 0) return;
    x0 = -1;
    face.style.transition = 'transform .2s ease';
    const go = Math.abs(dx) > Math.min(110, li.offsetWidth * 0.33);
    if (go && dx < 0) { face.style.transform = 'translateX(-100%)'; setTimeout(onLeft, 160); return; }
    face.style.transform = '';
    if (go && dx > 0) onRight();
  });
  return li;
}

// ------------------------------------------------------------------ drag and drop
/**
 * Lets `item` be picked up and dropped on one of `targets()` (meal plan: move a meal to another day).
 * A finger presses and holds first (so scrolling still works); a mouse just drags.
 * onDrop(target) runs when it's let go over a target other than `home`.
 */
export function draggable(item, { home, targets, onDrop }) {
  let ghost = null; let timer = null; let start = null; let over = null;
  const at = (x, y) => targets().find((t) => { const r = t.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
  const lift = (e) => {
    const r = item.getBoundingClientRect();
    ghost = item.cloneNode(true);
    ghost.className = `${item.className} dragghost`;
    Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
    ghost.dataset.dx = String(e.clientX - r.left); ghost.dataset.dy = String(e.clientY - r.top);
    document.body.append(ghost);
    item.classList.add('dragging');
    globalThis.navigator?.vibrate?.(10);
  };
  const end = () => {
    clearTimeout(timer); timer = null; start = null;
    document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('pointercancel', end);
    over?.classList.remove('dropover');
    const target = over; over = null;
    if (ghost) { ghost.remove(); ghost = null; item.classList.remove('dragging'); if (target && target !== home) onDrop(target); }
  };
  const onMove = (e) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { if (e.pointerType === 'mouse') lift(e); else end(); }
      return;
    }
    e.preventDefault();
    ghost.style.left = `${e.clientX - Number(ghost.dataset.dx)}px`; ghost.style.top = `${e.clientY - Number(ghost.dataset.dy)}px`;
    const t = at(e.clientX, e.clientY);
    if (t !== over) { over?.classList.remove('dropover'); over = t; over?.classList.add('dropover'); }
    // near the top or bottom of the screen, scroll so far-away days can be reached
    if (e.clientY < 80) scrollBy(0, -12); else if (e.clientY > innerHeight - 80) scrollBy(0, 12);
  };
  const onUp = () => end();
  item.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('button, a')) return;
    start = { x: e.clientX, y: e.clientY };
    document.addEventListener('pointermove', onMove, { passive: false }); document.addEventListener('pointerup', onUp); document.addEventListener('pointercancel', end);
    if (e.pointerType !== 'mouse') timer = setTimeout(() => { if (start) lift(e); }, 350);
  });
  // a held finger shouldn't open the phone's own menu or select text
  item.addEventListener('contextmenu', (e) => { if (ghost || timer) e.preventDefault(); });
  return item;
}
