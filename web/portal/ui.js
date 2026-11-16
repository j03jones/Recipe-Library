// Small DOM helpers shared by the client portal's pages (portal.js: sign-in and meal prep; kitchen.js: restaurants).
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
export const star = (on) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.8l5.9-.8z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  return s;
};

let toastTimer;
export function toast(msg) {
  let t = document.getElementById('jrk-toast');
  if (!t) { t = h('div', { id: 'jrk-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/** A line of text in the page's own dialog. Resolves to the text, or null if cancelled. */
export function askText(message, { value = '', placeholder = '', ok = 'OK', optional = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(v); };
    const input = h('input', { type: 'text', maxlength: '500', value, placeholder, 'aria-label': message });
    const dlg = h('dialog', { class: 'jrk-dialog' }, h('form', { onsubmit: (e) => { e.preventDefault(); if (input.value.trim() || optional) done(input.value.trim()); } },
      h('p', null, message), input,
      h('div', { class: 'jrk-row end' }, h('button', { class: 'btn line', type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn', type: 'submit' }, ok))));
    dlg.addEventListener('close', () => done(null));
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

export const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label, hint && h('span', { class: 'hint' }, ` ${hint}`)), input);
export const busy = (btn, on) => { btn.disabled = on; btn.setAttribute('aria-busy', String(on)); };


/** Which screen is showing: bumped on every change, so a slow load never paints over the screen they moved to. */
export const screen = { id: 0, next() { return ++this.id; } };

/** A yes/no question in the page's own dialog. Resolves to true or false. */
export function confirmBox(message, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog', { class: 'jrk-dialog' }, h('p', null, message),
      h('div', { class: 'jrk-row end' }, h('button', { class: 'btn line', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: danger ? 'btn danger' : 'btn', type: 'button', onclick: () => done(true) }, ok)));
    dlg.addEventListener('close', () => done(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}
