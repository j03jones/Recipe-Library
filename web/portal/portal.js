// The client portal: jonesridgekitchen.com/my-meals/ (and, as a plain fallback, /portal/ here).
// One login page for both kinds of client; after sign-in each person sees what their login is for,
// with a switcher when it is for more than one.
//
// Restaurant clients (owners and staff) see their restaurant's recipe collection: search, the full
// recipe, scaling and printing; owners can invite staff. The database only returns a collection to
// its members while the restaurant's plan is active (supabase/schema.sql, recipes_read).
//
// Meal prep clients see only their own plan: this week's menu to approve dish by dish (name, description,
// ingredients, nutrition, allergens; never amounts or the method), what they have had, favourites,
// requests and their own allergies. They never see the recipe library. The chef manages everything
// from the recipe app (Settings > Meal prep clients); the database decides who sees what
// (supabase/add_clients.sql, add_client_signup.sql).
//
// The page that loads this only needs <div id="jrk-portal"></div>. Everything else comes from here,
// so the website and this repository never drift apart.
import * as cloud from '../js/cloud.js';
import { ALLERGENS, clean as cleanAllergens, conflicts } from '../js/allergens.js';
import { MACROS, history as dishHistory, nutritionSummary, planOf, tally } from '../js/clientcore.js';
import { Frac, adaptedLine, creditLine, formatIngredient, formatYield, scaleRecipe } from '../js/units.js';
import { fromRecord } from '../js/model.js';

const root = document.getElementById('jrk-portal');
const CONTACT = 'https://jonesridgekitchen.com/contact/?service=meal-prep';
const CONTACT_ANY = 'https://jonesridgekitchen.com/contact/';
const APP = 'https://recipes.jonesridgekitchen.com/';
const JOIN = new URLSearchParams(location.search).get('join') || '';   // a restaurant invite link: …/my-meals/?join=CODE
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const weekLabel = (iso) => `Week of ${SHORT.format(parseDate(iso))}`;
const here = () => `${location.origin}${location.pathname}`;

// ------------------------------------------------------------------ tiny DOM helpers
function h(tag, attrs, ...kids) {
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
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
const star = (on) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.8l5.9-.8z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  return s;
};

let toastTimer;
function toast(msg) {
  let t = document.getElementById('jrk-toast');
  if (!t) { t = h('div', { id: 'jrk-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/** A line of text in the page's own dialog. Resolves to the text, or null if cancelled. */
function askText(message, { value = '', placeholder = '', ok = 'OK', optional = false } = {}) {
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

const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label, hint && h('span', { class: 'hint' }, ` ${hint}`)), input);
const busy = (btn, on) => { btn.disabled = on; btn.setAttribute('aria-busy', String(on)); };

// ------------------------------------------------------------------ signed out

function viewSignedOut(mode = JOIN ? 'up' : 'in', message = '') {
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, 'aria-label': 'Email' });
  const password = h('input', { type: 'password', autocomplete: mode === 'up' ? 'new-password' : 'current-password', minlength: '8', required: true, 'aria-label': 'Password' });
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: '80', 'aria-label': 'Your name' });
  const code = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: '40', value: JOIN, 'aria-label': 'Invite code' });
  const note = h('p', { class: 'jrk-msg', role: 'alert' }, message);
  const submit = h('button', { class: 'btn', type: 'submit' }, mode === 'up' ? 'Create my login' : 'Sign in');
  const tabs = h('div', { class: 'jrk-tabs', role: 'tablist' },
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'in'), onclick: () => viewSignedOut('in') }, 'Sign in'),
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === 'up'), onclick: () => viewSignedOut('up') }, 'First time here'));

  const form = h('form', { class: 'form jrk-auth', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    note.textContent = '';
    if (!email.value.trim() || !password.value) { note.textContent = 'Please enter your email and a password.'; return; }
    busy(submit, true);
    try {
      if (mode === 'in') {
        await cloud.signIn(email.value.trim(), password.value);
        return start();
      }
      if (password.value.length < 8) { note.textContent = 'Please choose a password of at least 8 characters.'; return; }
      const invite = code.value.trim().toUpperCase();
      // With a code it is a restaurant login (the database checks the code); without one, the email
      // must be on a meal prep client record. "portal" makes the emails say meal prep.
      const r = await cloud.signUp({ email: email.value.trim().toLowerCase(), password: password.value, displayName: name.value.trim(),
        inviteCode: invite, data: invite ? {} : { portal: 'meal-prep' }, redirectTo: here() });
      if (r === 'signed-in') return start();
      fill(root, h('div', { class: 'jrk-card' }, h('h2', null, 'Check your email'),
        h('p', null, `We sent a link to ${email.value.trim()}. Open it to confirm your address, and you will come straight back here, signed in.`),
        h('p', { class: 'note' }, 'Nothing there? Look in spam, or ', h('button', { class: 'jrk-link', type: 'button', onclick: async () => {
          try { await cloud.resendConfirmation(email.value.trim()); toast('Sent again'); } catch (err) { toast(err.message); }
        } }, 'send it again'), '.')));
    } catch (err) {
      if (mode === 'up' && code.value.trim() && (err.status >= 500 || /invite/i.test(err.message))) {
        note.replaceChildren('That invite code is not valid, has been used, or your restaurant has no free seats. Ask your restaurant for a new one, or ',
          h('a', { href: CONTACT_ANY }, 'get in touch'), '.');
      } else if (mode === 'up' && (err.status >= 500 || /invite/i.test(err.message))) {
        note.replaceChildren('We don’t have a meal prep plan for that email address yet. Use the address you gave Joseph, or ',
          h('a', { href: CONTACT }, 'get in touch'), '.');
      } else note.textContent = err.message;
    } finally { busy(submit, false); }
  } },
  mode === 'up' && h('p', { class: 'full note' }, 'Meal prep clients: use the email address Joseph has for you. Restaurant teams: enter the invite code your restaurant gave you.'),
  mode === 'up' && h('div', { class: 'full' }, field('Your name', name)),
  h('div', { class: 'full' }, field('Email', email)),
  h('div', { class: 'full' }, field('Password', password, mode === 'up' ? '(at least 8 characters)' : '')),
  mode === 'up' && h('div', { class: 'full' }, field('Invite code', code, '(restaurant teams only)')),
  h('div', { class: 'full' }, note),
  h('div', { class: 'full jrk-row' }, submit,
    mode === 'in' && h('button', { class: 'jrk-link', type: 'button', onclick: async () => {
      if (!email.value.trim()) { note.textContent = 'Type your email above first, then choose “Forgot password?”.'; return; }
      try { await cloud.requestPasswordReset(email.value.trim()); note.textContent = 'If that address has a login, a reset link is on its way.'; } catch (err) { note.textContent = err.message; }
    } }, 'Forgot password?')));

  fill(root, h('div', { class: 'jrk-card' },
    h('h2', null, 'Client login'),
    h('p', null, 'Meal prep clients: approve your week and see what is in every dish. Restaurant clients: your recipe collection, ready for the line.'),
    tabs, form),
  h('p', { class: 'note' }, 'Not a client yet? See ', h('a', { href: '/meal-prep/' }, 'meal prep plans'), ' or ', h('a', { href: '/consulting/' }, 'restaurant consulting'), '.'));
}

function viewNewPassword() {
  const password = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8', 'aria-label': 'New password' });
  const note = h('p', { class: 'jrk-msg', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save my new password');
  fill(root, h('div', { class: 'jrk-card' }, h('h2', null, 'Choose a new password'),
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      if (password.value.length < 8) { note.textContent = 'Please choose at least 8 characters.'; return; }
      busy(btn, true);
      try { await cloud.changePassword(password.value); toast('Password saved'); start(); } catch (err) { note.textContent = err.message; } finally { busy(btn, false); }
    } }, h('div', { class: 'full' }, field('New password', password, '(at least 8 characters)')), h('div', { class: 'full' }, note), h('div', { class: 'full' }, btn))));
  password.focus();
}

// ------------------------------------------------------------------ signed in

const signOutBar = () => h('p', { class: 'jrk-who note' }, `Signed in as ${cloud.currentUser()?.email || ''} · `,
  h('button', { class: 'jrk-link', type: 'button', onclick: async () => { await cloud.signOut(); areas = []; history.replaceState(history.state, '', location.pathname); viewSignedOut('in'); } }, 'Sign out'));

// What this login is for: [{ key: 'meals', label, client } | { key: 'kitchen/<id>', label, membership }].
let areas = [];
/** The sign-out line, plus a switcher when the login is for more than one thing. */
function top(current) {
  return [signOutBar(), areas.length > 1 && h('nav', { class: 'jrk-switch', 'aria-label': 'Your client areas' },
    areas.map((a) => h('a', { href: `#${a.key}`, 'aria-current': a.key === current ? 'page' : null }, a.label)))];
}

function macroLine(n) {
  if (!n || !n.kcal) return h('p', { class: 'note' }, 'Nutrition not available for this dish.');
  return h('div', { class: 'jrk-macros' }, MACROS.map(([key, label, unit]) =>
    h('span', null, h('b', null, `${n[key] ?? 0}${unit}`), ` ${label.toLowerCase()}`)), h('span', { class: 'note' }, 'per serving'));
}

async function viewMeals(client) {
  const mine = ++viewId;
  fill(root, h('p', { class: 'note' }, 'Loading your meals…'));
  let menus, favorites, requests;
  const load = async () => { [menus, favorites, requests] = await Promise.all([cloud.myMenus(client.id), cloud.listFavorites(client.id), cloud.listRequests(client.id)]); };
  try { await load(); } catch (err) { if (mine !== viewId) return; fill(root, ...top('meals'), h('p', { class: 'jrk-msg' }, `Could not load your meals: ${err.message}`)); return; }

  const refresh = async (msg) => { try { await load(); paint(); if (msg) toast(msg); } catch (err) { toast(err.message); } };

  function paint() {
    if (mine !== viewId) return;   // they have moved to another area meanwhile
    const current = menus.find((m) => m.status === 'sent');
    const fav = new Set(favorites.map((x) => x.dish));
    const past = dishHistory(menus.filter((m) => m.status === 'closed'));   // only weeks that have been cooked
    const openAsks = requests.filter((r) => r.status === 'open');
    const plan = planOf(client);

    const answer = async (meal, approve) => {
      let note = '';
      if (!approve) {
        note = await askText(`What would you like instead of “${meal.title}”, or what should change?`, { value: meal.client_note || '', placeholder: 'No fish this week, something with chicken…', ok: 'Ask for a swap', optional: true });
        if (note === null) return;
      }
      try { await cloud.respondToMeal(meal.id, approve, note); refresh(approve ? 'Approved' : 'Joseph will swap it'); } catch (err) { toast(err.message); }
    };
    const heart = (title) => {
      const on = fav.has(title.trim().toLowerCase());
      return h('button', { class: 'jrk-heart', type: 'button', 'aria-pressed': String(on), 'aria-label': on ? `Remove ${title} from favorites` : `Add ${title} to favorites`,
        onclick: async () => { try { await cloud.setFavorite(client.id, title, !on); refresh(); } catch (err) { toast(err.message); } } }, on ? '♥' : '♡');
    };
    const again = (title) => h('button', { class: 'btn line small', type: 'button', onclick: async () => {
      const note = await askText(`Ask for “${title}” again. Anything to add?`, { placeholder: 'Optional', ok: 'Send request', optional: true });
      if (note === null) return;
      try { await cloud.requestMeal(client.id, title, note); refresh('Request sent to Joseph'); } catch (err) { toast(err.message); }
    } }, 'Have this again');
    const stars = (meal) => h('div', { class: 'jrk-stars', role: 'group', 'aria-label': `Rate ${meal.title}` }, [1, 2, 3, 4, 5].map((n) =>
      h('button', { type: 'button', 'aria-pressed': String((meal.rating || 0) >= n), 'aria-label': `${n} ${n === 1 ? 'star' : 'stars'}`, onclick: async () => {
        const feedback = meal.rating ? meal.feedback : (await askText('Anything to tell Joseph about it?', { placeholder: 'Optional', ok: 'Send', optional: true }) ?? '');
        try { await cloud.rateMeal(meal.id, n, feedback); refresh('Thanks for the rating'); } catch (err) { toast(err.message); }
      } }, star((meal.rating || 0) >= n))));

    const dish = (meal, open) => {
      const bad = conflicts(meal.allergens, client.allergens);
      const a = cleanAllergens(meal.allergens);
      return h('li', { class: `jrk-dish ${meal.status}` },
        h('div', { class: 'jrk-row' }, h('h3', null, meal.title), heart(meal.title)),
        meal.description && h('p', null, meal.description),
        bad.length > 0 && h('p', { class: 'jrk-warn' }, h('strong', null, `Contains ${bad.join(', ')}, which is on your allergy list. Ask for a swap.`)),
        h('p', { class: 'jrk-ings' }, h('strong', null, 'Ingredients: '), meal.ingredients.join(', ') || 'Ask Joseph'),
        macroLine(meal.nutrition),
        h('div', { class: 'jrk-tags' }, a.length ? a.map((x) => h('span', { class: bad.includes(x) ? 'danger' : '' }, x)) : h('span', { class: 'plain' }, 'No major allergens listed')),
        (meal.reheat || meal.storage || meal.use_by) && h('p', { class: 'note' }, [meal.reheat && `Reheat: ${meal.reheat}`, meal.storage && `Keep: ${meal.storage}`, meal.use_by && `Use by ${SHORT.format(parseDate(meal.use_by))}`].filter(Boolean).join(' · ')),
        h('p', { class: 'note' }, `${meal.servings} ${meal.servings === 1 ? 'serving' : 'servings'}`),
        open
          ? h('div', { class: 'jrk-row jrk-answer' },
            h('button', { class: meal.status === 'approved' ? 'btn' : 'btn line', type: 'button', 'aria-pressed': String(meal.status === 'approved'), onclick: () => answer(meal, true) }, meal.status === 'approved' ? '✓ Approved' : 'Approve'),
            h('button', { class: 'btn line', type: 'button', 'aria-pressed': String(meal.status === 'swap'), onclick: () => answer(meal, false) }, meal.status === 'swap' ? 'Swap requested' : 'Swap this'))
          : h('div', { class: 'jrk-row' }, stars(meal), again(meal.title)),
        meal.status === 'swap' && meal.client_note && h('p', { class: 'note' }, `You asked: ${meal.client_note}`));
    };

    const t = current ? tally(current.meals) : null;
    const summary = current ? nutritionSummary(current.meals, client.targets) : null;
    const boxes = ALLERGENS.map((a) => [a, h('input', { type: 'checkbox', checked: client.allergens.includes(a) })]);
    const allergyNotes = h('input', { type: 'text', maxlength: '1000', value: client.allergy_notes || '', placeholder: 'How severe, and anything else we should know', 'aria-label': 'Allergy notes' });
    const avoid = h('input', { type: 'text', maxlength: '1000', value: client.dislikes || '', placeholder: 'Diets and foods to avoid', 'aria-label': 'Foods to avoid' });
    const ask = h('input', { type: 'text', maxlength: '200', placeholder: 'Shrimp and grits, something with salmon…', 'aria-label': 'Ask for a dish' });

    fill(root,
      ...top('meals'),
      h('h2', null, `Hello, ${client.name.split(' ')[0]}`),
      h('p', { class: 'note' }, `${plan.label} · ${plan.blurb}`),
      current
        ? h('div', { class: 'jrk-week' },
          h('h2', null, weekLabel(current.week_start)),
          current.note && h('p', { class: 'jrk-chefnote' }, current.note),
          h('p', { role: 'status' }, t.proposed
            ? `${t.proposed} of ${t.total} ${t.total === 1 ? 'dish is' : 'dishes are'} waiting for your answer${current.approve_by ? `. Please answer by ${WHEN.format(new Date(current.approve_by))}` : ''}.`
            : t.swap ? `Thank you. ${t.swap} ${t.swap === 1 ? 'swap is' : 'swaps are'} with Joseph.` : 'All approved. Thank you!'),
          t.proposed > 1 && h('button', { class: 'btn', type: 'button', onclick: async () => {
            try { for (const m of current.meals.filter((x) => x.status === 'proposed')) await cloud.respondToMeal(m.id, true, ''); refresh('All approved'); } catch (err) { toast(err.message); }
          } }, `Approve all ${t.proposed} waiting`),
          summary && h('p', { class: 'note' }, `On average each serving is about ${summary.avg.kcal} calories, ${summary.avg.protein}g protein, ${summary.avg.carbs}g carbs and ${summary.avg.fat}g fat`,
            summary.share.kcal ? ` (${summary.share.kcal}% of your daily calorie target)` : '', '. These are estimates from typical values.'),
          h('ul', { class: 'jrk-dishes' }, current.meals.map((m) => dish(m, true))))
        : h('div', { class: 'jrk-card' }, h('h2', null, 'No menu waiting'),
          h('p', null, 'When Joseph plans your next week it will appear here for you to approve, dish by dish.')),

      h('div', { class: 'jrk-card' }, h('h2', null, 'Ask for something'),
        h('form', { class: 'jrk-row jrk-ask', onsubmit: async (e) => {
          e.preventDefault();
          if (!ask.value.trim()) return;
          try { await cloud.requestMeal(client.id, ask.value.trim(), ''); ask.value = ''; refresh('Request sent to Joseph'); } catch (err) { toast(err.message); }
        } }, ask, h('button', { class: 'btn', type: 'submit' }, 'Ask')),
        openAsks.length > 0 && h('ul', { class: 'jrk-list' }, openAsks.map((r) => h('li', null, h('span', null, r.title, r.note && h('span', { class: 'note' }, ` — ${r.note}`)), h('span', { class: 'note' }, 'with Joseph'))))),

      past.length > 0 && h('div', { class: 'jrk-history' }, h('h2', null, 'What you have had'),
        h('ul', { class: 'jrk-dishes' }, menus.filter((m) => m.status === 'closed').slice(0, 8).flatMap((m) => [
          h('li', { class: 'jrk-weekhead' }, weekLabel(m.week_start)),
          ...m.meals.filter((x) => x.status !== 'swap').map((x) => dish(x, false))])),
        h('h3', null, 'Every dish so far'),
        h('ul', { class: 'jrk-list' }, past.map((d) => h('li', null,
          h('span', null, heart(d.title), ' ', d.title),
          h('span', { class: 'jrk-row' }, h('span', { class: 'note' }, `${d.times === 1 ? 'once' : `${d.times} times`}${d.rating ? ` · ${d.rating}★` : ''}`), again(d.title)))))),

      h('div', { class: 'jrk-card' }, h('h2', null, 'Allergies and foods to avoid'),
        h('p', { class: 'note' }, 'Keep this up to date. Joseph checks every dish against it.'),
        h('div', { class: 'jrk-checks' }, boxes.map(([a, box]) => h('label', null, box, ` ${a}`))),
        field('Allergy notes', allergyNotes), field('Foods to avoid', avoid),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            await cloud.updateMyPreferences(client.id, boxes.filter(([, b]) => b.checked).map(([a]) => a), allergyNotes.value, avoid.value);
            [client] = await cloud.myClients();
            toast('Saved. Joseph will see it.'); paint();
          } catch (err) { toast(err.message); }
        } }, 'Save')),
      h('p', { class: 'note' }, 'Questions about your plan? ', h('a', { href: CONTACT }, 'Contact Jones Ridge Kitchen'), '.'));
  }
  paint();
}

// ------------------------------------------------------------------ restaurant clients

let viewId = 0;   // bumped on every screen change, so a slow load never paints over the screen they moved to
const recipeCache = new Map();   // restaurant id -> rows, for this visit

/** A database row as the app's recipe object (same reading as the recipe app), or null if unreadable. */
function toRecipe(row) {
  try {
    const rec = row.body && typeof row.body === 'object' ? row.body : {};
    return fromRecord({ ...rec, id: row.id, title: row.title, categories: (row.categories || []).filter((c) => typeof c === 'string'),
      tags: (Array.isArray(rec.tags) ? rec.tags : []).filter((t) => typeof t === 'string'),
      yu: String(rec.yu ?? ''), yr: String(rec.yr ?? ''), dir: String(rec.dir ?? ''),
      ings: (Array.isArray(rec.ings) ? rec.ings : []).filter(Array.isArray)
        .map(([q, raw, unit, item, group]) => [q, String(raw ?? ''), String(unit ?? ''), String(item ?? ''), String(group ?? '')])
        .filter(([q, raw, , item]) => q || raw || item) }, 'restaurant');
  } catch { return null; }
}

async function kitchenRecipes(restaurantId, fresh = false) {
  if (!fresh && recipeCache.has(restaurantId)) return recipeCache.get(restaurantId);
  const rows = await cloud.restaurantRecipes(restaurantId);
  const list = rows.filter((r) => r.scope === 'restaurant' && r.restaurant_id === restaurantId).map((r) => {
    const recipe = toRecipe(r);
    if (recipe) { recipe.photo = r.photo || null; recipe._hay = [r.title, recipe.categories.join(' '), recipe.ings.map((x) => x.item).join(' ')].join('\n').toLowerCase(); }
    return recipe;
  }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  recipeCache.set(restaurantId, list);
  return list;
}

const ACTIVE = ['active', 'trialing'];

async function viewKitchen(m) {
  const mine = ++viewId;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  if (!ACTIVE.includes(r.subscription_status)) {
    fill(root, ...top(key), h('h2', null, r.name), h('div', { class: 'jrk-card' }, h('h2', null, 'Your recipe collection is paused'),
      h('p', null, `${r.name}’s plan with Jones Ridge Kitchen is not active right now, so the recipes are hidden. They are kept safe and come back as soon as the plan is renewed.`),
      h('p', null, h('a', { href: CONTACT_ANY }, 'Contact Jones Ridge Kitchen'), ' about the plan.')));
    return;
  }
  fill(root, ...top(key), h('h2', null, r.name), h('p', { class: 'note' }, 'Loading your recipes…'));
  let list;
  try { list = await kitchenRecipes(r.id); } catch (err) {
    if (mine !== viewId) return;
    fill(root, ...top(key), h('h2', null, r.name), h('p', { class: 'jrk-msg' }, `Could not load your recipes: ${err.message}`),
      h('button', { class: 'btn', type: 'button', onclick: () => viewKitchen(m) }, 'Try again'));
    return;
  }
  if (mine !== viewId) return;

  const cats = [...new Set(list.flatMap((x) => x.categories))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const search = h('input', { type: 'search', placeholder: 'Search by name or ingredient', 'aria-label': 'Search recipes', value: sessionStorage.getItem(`jrk-q-${r.id}`) || '' });
  const cat = cats.length > 1 && h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c }, c)));
  const out = h('ul', { class: 'jrk-recipes' });
  const count = h('p', { class: 'note', role: 'status' });
  const show = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const c = cat ? cat.value : '';
    try { sessionStorage.setItem(`jrk-q-${r.id}`, search.value); } catch { /* private mode */ }
    const hits = list.filter((x) => words.every((w) => x._hay.includes(w)) && (!c || x.categories.includes(c)));
    count.textContent = hits.length === list.length ? `${list.length} ${list.length === 1 ? 'recipe' : 'recipes'}` : `${hits.length} of ${list.length} recipes`;
    fill(out, hits.length ? hits.map((x) => h('li', null, h('a', { href: `#${key}/${encodeURIComponent(x.id)}` },
      h('span', { class: 'jrk-rtitle' }, x.title),
      x.categories.length > 0 && h('span', { class: 'note' }, x.categories.join(' · ')))))
      : h('li', { class: 'note' }, 'No recipes match that search.'));
  };
  search.addEventListener('input', show);
  if (cat) cat.addEventListener('change', show);
  show();

  fill(root, ...top(key),
    h('h2', null, r.name),
    list.length
      ? [h('div', { class: 'jrk-row jrk-find' }, search, cat), count, out]
      : h('div', { class: 'jrk-card' }, h('h2', null, 'No recipes yet'), h('p', null, 'Joseph is building your collection. Recipes appear here as soon as they are added.')),
    m.member_role === 'owner' && teamCard(r),
    h('p', { class: 'note' }, 'Cooking from a phone or tablet? The ', h('a', { href: APP }, 'recipe app'),
      ' has the same collection with cook mode and timers, using this login.'));
}

function teamCard(r) {
  const out = h('div', { 'aria-live': 'polite' });
  const seats = h('p', { class: 'note' });
  cloud.restaurantMembers(r.id).then((rows) => { seats.textContent = `${rows.length} of ${r.seat_limit} logins in use.`; }).catch(() => {});
  const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    busy(btn, true);
    try {
      const code = await cloud.createInvite('restaurant', r.id, 'staff', 1, 14);
      const link = `${here()}?join=${encodeURIComponent(code)}`;
      const subject = `Your ${r.name} recipe login`;
      const body = `Hi,\n\nHere is your login for the ${r.name} recipe collection from Jones Ridge Kitchen:\n${link}\n\nChoose "First time here", use your own email and a password. Your invite code is ${code} (it works once, for 14 days).\n`;
      fill(out, h('div', { class: 'jrk-invite' },
        h('p', null, 'Send this link to one person. It works once, for 14 days.'),
        h('p', null, h('code', null, link)),
        h('p', { class: 'note' }, `Invite code: ${code}`),
        h('div', { class: 'jrk-row' },
          h('button', { class: 'btn line small', type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Select the link and copy it'); }
          } }, 'Copy link'),
          h('a', { class: 'btn line small', href: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` }, 'Email it'))));
    } catch (err) { toast(err.message); } finally { busy(btn, false); }
  } }, 'Invite someone');
  return h('div', { class: 'jrk-card' }, h('h2', null, 'Your team'),
    h('p', null, 'Give a cook or manager their own login. They see the same recipes; only owners can invite.'), seats, btn, out);
}

async function viewRecipe(m, recipeId) {
  const mine = ++viewId;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  fill(root, ...top(key), h('p', { class: 'note' }, 'Loading…'));
  let list;
  try { list = ACTIVE.includes(r.subscription_status) ? await kitchenRecipes(r.id) : []; } catch (err) {
    if (mine !== viewId) return;
    fill(root, ...top(key), h('p', { class: 'jrk-msg' }, `Could not load the recipe: ${err.message}`), h('a', { href: `#${key}` }, '← All recipes'));
    return;
  }
  if (mine !== viewId) return;
  const base = list.find((x) => x.id === recipeId);
  const back = h('p', { class: 'jrk-back jrk-noprint' }, h('a', { href: `#${key}` }, `← All ${r.name} recipes`));
  if (!base) { fill(root, ...top(key), back, h('div', { class: 'jrk-card' }, h('h2', null, 'Recipe not found'), h('p', null, 'It may have been removed from your collection.'))); return; }

  const factorIn = h('input', { type: 'text', inputmode: 'decimal', value: '1', size: '4', 'aria-label': 'Multiplier' });
  const yieldLine = h('p', { class: 'jrk-yield' });
  const ingsBox = h('div', { class: 'jrk-ings-list' });
  const warn = h('p', { class: 'note' });
  const quick = h('div', { class: 'jrk-row jrk-scale jrk-noprint', role: 'group', 'aria-label': 'Scale the recipe' },
    h('span', { class: 'note' }, 'Scale'),
    ['1/2', '1', '2', '3', '4'].map((f) => h('button', { type: 'button', class: 'btn line small', onclick: () => { factorIn.value = f; paint(); } }, f === '1/2' ? '½×' : `${f}×`)),
    h('label', { class: 'jrk-row' }, '×', factorIn));
  factorIn.addEventListener('input', () => paint());

  function paint() {
    let f = Frac.parse(factorIn.value.trim().replace(/×|x$/i, ''));
    if (!f || f.n <= 0n) f = Frac.parse('1');
    let shown = base, warnings = [];
    try { ({ recipe: shown, warnings } = scaleRecipe(base, f)); } catch { /* leave it unscaled */ }
    const y = formatYield(shown);
    yieldLine.textContent = y ? `Makes ${y}${factorIn.value.trim() && factorIn.value.trim() !== '1' ? ` (${factorIn.value.trim()}×)` : ''}` : '';
    const groups = [];
    for (const ing of shown.ings) {
      if (!groups.length || groups[groups.length - 1].name !== ing.group) groups.push({ name: ing.group, items: [] });
      groups[groups.length - 1].items.push(ing);
    }
    fill(ingsBox, groups.map((g) => [g.name && h('h4', null, g.name), h('ul', null, g.items.map((ing) => h('li', null, formatIngredient(ing))))]));
    warn.textContent = warnings.join(' ');
  }
  paint();

  const steps = base.dir ? base.dir.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  const photo = h('div', { class: 'jrk-photo' });
  if (base.photo) {
    cloud.downloadPhoto(base.photo).then((blob) => { if (mine === viewId) fill(photo, h('img', { src: URL.createObjectURL(blob), alt: base.title })); }).catch(() => {});
  }
  const credit = [creditLine(base), adaptedLine(base)].filter(Boolean).join(' · ');

  fill(root, ...top(key), back,
    h('article', { class: 'jrk-recipe' },
      h('h2', null, base.title),
      base.categories.length > 0 && h('p', { class: 'note' }, base.categories.join(' · ')),
      credit && h('p', { class: 'note' }, credit),
      photo,
      yieldLine, quick, warn,
      h('h3', null, 'Ingredients'), ingsBox,
      steps.length > 0 && [h('h3', null, 'Method'), h('ol', { class: 'jrk-steps' }, steps.map((x) => h('li', null, x)))],
      h('p', { class: 'note jrk-printnote' }, `${r.name} · Jones Ridge Kitchen recipe collection`),
      h('div', { class: 'jrk-row jrk-noprint' },
        h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'),
        h('a', { class: 'btn line', href: `#${key}` }, 'Back to the list'))));
  root.scrollIntoView({ block: 'start' });
}

// ------------------------------------------------------------------ start

function route() {
  if (!areas.length) return;
  const [kind, id, recipe] = location.hash.replace(/^#/, '').split('/').map((x) => decodeURIComponent(x || ''));
  if (kind === 'kitchen') {
    const area = areas.find((a) => a.membership?.restaurant.id === id);
    if (area) return recipe ? viewRecipe(area.membership, recipe) : viewKitchen(area.membership);
  }
  if (kind === 'meals') {
    const area = areas.find((a) => a.client);
    if (area) return viewMeals(area.client);
  }
  const first = areas[0];
  return first.client ? viewMeals(first.client) : viewKitchen(first.membership);
}
window.addEventListener('hashchange', () => { if (cloud.isSignedIn()) route(); });

async function start() {
  if (!cloud.isSignedIn()) return viewSignedOut();
  fill(root, h('p', { class: 'note' }, 'Loading…'));
  let clients, me;
  try { [clients, me] = await Promise.all([cloud.myClients(), cloud.loadMe()]); } catch (err) {
    if (err.status === 401) { await cloud.signOut(); return viewSignedOut('in', 'Please sign in again.'); }
    fill(root, h('p', { class: 'jrk-msg' }, `Could not reach the server: ${err.message}`), h('button', { class: 'btn', type: 'button', onclick: start }, 'Try again'));
    return;
  }
  if (JOIN) history.replaceState(history.state, '', location.pathname + location.hash);   // the invite has been used
  recipeCache.clear();
  areas = [
    ...clients.slice(0, 1).map((client) => ({ key: 'meals', label: 'My meals', client })),
    ...(me.memberships || []).filter((m) => m.restaurant).map((m) => ({ key: `kitchen/${m.restaurant.id}`, label: m.restaurant.name, membership: m })),
  ];
  if (!areas.length) {
    fill(root, signOutBar(), h('div', { class: 'jrk-card' }, h('h2', null, 'No client account found'),
      h('p', null, `We couldn’t find a meal prep plan or a restaurant collection for ${cloud.currentUser()?.email || 'this email address'}. Meal prep clients: sign in with the address you gave Joseph. Restaurant teams: ask your restaurant for an invite code. Or `,
        h('a', { href: CONTACT_ANY }, 'get in touch'), '.')));
    return;
  }
  route();
}

const link = cloud.takeSessionFromHash();       // coming back from a confirmation or password-reset email
if (link) window.history.replaceState(window.history.state, '', location.pathname + location.search);
if (link?.startsWith('error:')) viewSignedOut('in', `${link.slice(6)} Sign in, or use “Forgot password?” for a new link.`);
else if (link === 'recovery') viewNewPassword();
else start();
