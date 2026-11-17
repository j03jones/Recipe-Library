// The client portal: jonesridgekitchen.com/my-meals/ (and, as a plain fallback, /portal/ here).
// One login page for both kinds of client; after sign-in each person sees what their login is for,
// with a switcher when it is for more than one.
//
// Restaurant clients (owners and staff) get their restaurant's kitchen: recipes (the chef's, read-only, and the
// team's own), costing with a shared price book, help, and for owners the team. That is kitchen.js.
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
import { askText, busy, field, fill, h, screen, star, toast } from './ui.js';
import * as kitchen from './kitchen.js';
import { macroDetails } from '../js/nutritionui.js';

const root = document.getElementById('jrk-portal');
const CONTACT = 'https://jonesridgekitchen.com/contact/?service=meal-prep';
const CONTACT_ANY = 'https://jonesridgekitchen.com/contact/';
const JOIN = new URLSearchParams(location.search).get('join') || '';   // a restaurant invite link: …/my-meals/?join=CODE
// the admin's "View their portal" (Admin tools > Restaurants): …/my-meals/?preview=<restaurant id> shows that restaurant's
// page as its team sees it, to the admin only; anyone else just gets their own page
const PREVIEW = new URLSearchParams(location.search).get('preview') || '';
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const weekLabel = (iso) => `Week of ${SHORT.format(parseDate(iso))}`;
const here = () => `${location.origin}${location.pathname}`;

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
    PREVIEW && h('p', { class: 'jrk-preview' }, h('strong', null, 'Admin preview. '), 'Sign in with your admin account to see this restaurant’s page as its team does.'),
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
  const preview = areas.find((a) => a.preview);
  return [signOutBar(),
    preview && h('p', { class: 'jrk-preview', role: 'note' }, h('strong', null, 'Preview. '),
      `This is ${preview.label}’s page as their team sees it. You can change their prices and plates under Costing; everything else is look-only. `,
      h('a', { href: 'https://recipes.jonesridgekitchen.com/#/admin/restaurants' }, 'Back to Admin tools')),
    areas.length > 1 && h('nav', { class: 'jrk-switch', 'aria-label': 'Your client areas' },
    areas.map((a) => h('a', { href: `#${a.key}`, 'aria-current': a.key === current ? 'page' : null }, a.label)))];
}

function macroLine(n) {
  if (!n || !n.kcal) return h('p', { class: 'note' }, 'Nutrition not available for this dish.');
  return h('div', { class: 'jrk-macros' }, MACROS.map(([key, label, unit]) =>
    h('span', null, h('b', null, `${n[key] ?? 0}${unit}`), ` ${label.toLowerCase()}`)), h('span', { class: 'note' }, 'per serving'));
}

// which dishes have their Macronutrients open, so a refresh after approving or rating keeps them open
const macrosOpen = new Set();
/** A dish's Macronutrients: the split of its calories, and a per-serving table with % Daily Value. The client sees
 *  the dish's totals only, never what each ingredient adds (that would give away the amounts). */
function dishMacros(meal) {
  if (!meal.nutrition || !meal.nutrition.kcal) return null;
  return macroDetails(h, { per: meal.nutrition, quiet: 'note', cls: 'jrk-macrodetails', open: macrosOpen.has(meal.id),
    onToggle: (o) => { if (o) macrosOpen.add(meal.id); else macrosOpen.delete(meal.id); } });
}

async function viewMeals(client) {
  const mine = screen.next();
  fill(root, h('p', { class: 'note' }, 'Loading your meals…'));
  let menus, favorites, requests;
  const load = async () => { [menus, favorites, requests] = await Promise.all([cloud.myMenus(client.id), cloud.listFavorites(client.id), cloud.listRequests(client.id)]); };
  try { await load(); } catch (err) { if (mine !== screen.id) return; fill(root, ...top('meals'), h('p', { class: 'jrk-msg' }, `Could not load your meals: ${err.message}`)); return; }

  const refresh = async (msg) => { try { await load(); paint(); if (msg) toast(msg); } catch (err) { toast(err.message); } };

  function paint() {
    if (mine !== screen.id) return;   // they have moved to another area meanwhile
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
        dishMacros(meal),
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

// ------------------------------------------------------------------ start

function route() {
  if (!areas.length) return;
  const [kind, id, recipe, ...rest] = location.hash.replace(/^#/, '').split('/').map((x) => decodeURIComponent(x || ''));
  if (kind === 'kitchen') {
    const area = areas.find((a) => a.membership?.restaurant.id === id);
    if (area) return kitchen.show(area.membership, recipe, rest[0] || '', rest[1] || '');
  }
  if (kind === 'meals') {
    const area = areas.find((a) => a.client);
    if (area) return viewMeals(area.client);
  }
  const first = areas[0];
  return first.client ? viewMeals(first.client) : kitchen.show(first.membership);
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
  kitchen.reset();
  kitchen.setup({ root, top, preview: false, me: { id: cloud.currentUser()?.id, email: cloud.currentUser()?.email || '', displayName: me.displayName || '' } });
  if (PREVIEW && me.role === 'admin') {
    let r = null;
    try { r = await cloud.getRestaurant(PREVIEW); } catch { /* shown below */ }
    if (!r) { fill(root, signOutBar(), h('div', { class: 'jrk-card' }, h('h2', null, 'Restaurant not found'), h('p', null, 'It may have been deleted. Open the preview again from Admin tools.'))); return; }
    areas = [{ key: `kitchen/${r.id}`, label: r.name, membership: { member_role: 'staff', restaurant: r }, preview: true }];
    kitchen.setup({ root, top, preview: true, me: { id: cloud.currentUser()?.id, email: cloud.currentUser()?.email || '', displayName: me.displayName || '' } });
    if (!location.hash.startsWith(`#kitchen/${r.id}`)) history.replaceState(history.state, '', `${location.pathname}${location.search}#kitchen/${r.id}`);
    return route();
  }
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
