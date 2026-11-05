// Account card (sign in / create account / restaurant tools) and the admin screen.
// Receives `ctx` from app.js so it can reuse the app's helpers without importing the whole app.
import * as cloud from './cloud.js';
import { copyText } from './ui.js';
import * as photos from './photos.js';

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
/** A round profile photo, or the person's initials when they have none. */
export function avatarEl(path, name, small = false) {
  if (path) return photos.photoImg(path, { class: small ? 'avatar sm' : 'avatar', alt: '' });
  const el = document.createElement('span');
  el.className = small ? 'avatar sm empty' : 'avatar empty';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = initials(name);
  return el;
}

const STATUSES = ['inactive', 'trialing', 'active', 'past_due', 'canceled'];
const STATUS_LABEL = { inactive: 'Not subscribed', trialing: 'Trial', active: 'Active', past_due: 'Payment overdue', canceled: 'Canceled' };

function shareText(code) {
  const url = `${location.origin}${location.pathname}#/settings`;
  return `Join Jones Ridge Recipes: open ${url}, choose New account, and enter this invite code: ${code}`;
}

function codeBox(ctx, code) {
  const { h, toast } = ctx;
  return h('div', { class: 'codebox' },
    h('strong', { class: 'code' }, code),
    h('button', { type: 'button', onclick: async () => {
      toast(await copyText(shareText(code)) ? 'Invite message copied' : 'Could not copy. Press and hold the code to copy it.', 3000);
    } }, 'Copy invite message'));
}

// ------------------------------------------------------------------ account card

export function accountCard(ctx) {
  const { h, fill, toast, lib } = ctx;
  const card = h('section', { class: 'card stack', 'aria-label': 'Account' });
  let mode = 'in';   // 'in' | 'up' while signed out

  function paint() {
    if (!cloud.isSignedIn()) return paintSignedOut();
    return paintSignedIn();
  }

  function paintSignedOut() {
    const email = h('input', { type: 'email', class: 'full', autocomplete: 'email', 'aria-label': 'Email', placeholder: 'Email' });
    const pass = h('input', { type: 'password', class: 'full', autocomplete: mode === 'in' ? 'current-password' : 'new-password', 'aria-label': 'Password', placeholder: mode === 'in' ? 'Password' : 'Password (at least 8 characters)' });
    const name = h('input', { class: 'full', autocomplete: 'given-name', 'aria-label': 'Your name', placeholder: 'Your first name (shown on shared recipes)' });
    const code = h('input', { class: 'full', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Invite code', placeholder: 'Invite code' });
    const msg = h('p', { class: 'note', role: 'status' });
    const forgot = h('button', { type: 'button', class: 'linkish', onclick: async () => {
      if (!email.value.trim()) { msg.textContent = 'Type your email above first, then tap “Forgot password?”.'; email.focus(); return; }
      msg.textContent = 'Sending…';
      try { await cloud.requestPasswordReset(email.value.trim()); msg.textContent = 'If that email has an account, a reset link is on its way. Check your spam folder too.'; }
      catch (err) { msg.textContent = err.message; }
    } }, 'Forgot password?');
    const go = h('button', { class: 'primary', type: 'submit' }, mode === 'in' ? 'Sign in' : 'Create account');

    const form = h('form', { class: 'stack', novalidate: true },
      mode === 'up' && name, email, pass, mode === 'up' && code, go, mode === 'in' && forgot, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (!email.value.trim() || !pass.value) { msg.textContent = 'Enter your email and password.'; return; }
      if (mode === 'up') {
        if (pass.value.length < 8) { msg.textContent = 'Use a password of at least 8 characters.'; return; }
        if (!code.value.trim()) { msg.textContent = 'Enter the invite code you were given.'; return; }
      }
      go.disabled = true;
      msg.textContent = mode === 'in' ? 'Signing in…' : 'Creating your account…';
      try {
        if (mode === 'in') {
          await cloud.signIn(email.value.trim(), pass.value);
        } else {
          const r = await cloud.signUp({ email: email.value.trim(), password: pass.value, displayName: name.value.trim(), inviteCode: code.value.trim() });
          if (r === 'confirm-email') { msg.textContent = 'Account created. We emailed you a link. Open it to confirm, then come back and sign in. Check your spam folder if it does not arrive.'; go.disabled = false; return; }
        }
        toast('Signed in');
        await ctx.refreshCloud();
        ctx.rerender();
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = false;
      }
    });

    fill(card,
      h('strong', null, 'Account'),
      h('p', { class: 'muted small' }, 'Sign in to keep recipes in your account, share with the Community, and open your restaurant’s collection. The built-in library works without an account.'),
      h('div', { class: 'seg2', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String(mode === 'in'), onclick: () => { mode = 'in'; paint(); } }, 'Sign in'),
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String(mode === 'up'), onclick: () => { mode = 'up'; paint(); } }, 'New account')),
      form);
  }

  function paintSignedIn() {
    const me = lib.me;
    const user = cloud.currentUser();
    const owned = (me?.memberships || []).filter((m) => m.member_role === 'owner' && m.restaurant);
    const pw = h('div');
    const inviteOut = h('div');

    const changePw = () => {
      const a = h('input', { type: 'password', class: 'full', autocomplete: 'new-password', 'aria-label': 'New password', placeholder: 'New password (at least 8 characters)' });
      const m = h('p', { class: 'note', role: 'status' });
      fill(pw, h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        if (a.value.length < 8) { m.textContent = 'Use at least 8 characters.'; return; }
        try { await cloud.changePassword(a.value); ctx.recovery = false; toast('Password changed'); fill(pw); } catch (err) { m.textContent = err.message; }
      } }, a, h('div', { class: 'row grow' }, h('button', { class: 'primary', type: 'submit' }, 'Save password'), h('button', { type: 'button', onclick: () => { ctx.recovery = false; fill(pw); } }, 'Cancel')), m));
      a.focus();
    };

    const changeAvatar = async () => {
      const file = await photos.pickPhoto();
      if (!file) return;
      toast('Saving photo…', 1500);
      try {
        const old = me.avatar;
        const path = await photos.upload('avatars', file, 400);
        try { await cloud.setAvatar(path); } catch (err) { await photos.discard([path]); throw err; }
        if (old) await photos.discard([old]);
        await ctx.refreshCloud(); toast('Profile photo saved'); paint();
      } catch (err) { toast(err.message, 4500); }
    };
    const removeAvatar = async () => {
      if (!await ctx.confirmDialog('Remove your profile photo?', 'Remove', true)) return;
      try { const old = me.avatar; await cloud.setAvatar(null); await photos.discard([old]); await ctx.refreshCloud(); toast('Profile photo removed'); paint(); }
      catch (err) { toast(err.message, 4500); }
    };
    fill(card,
      h('strong', null, 'Account'),
      me && h('div', { class: 'row' },
        avatarEl(me.avatar, me.displayName || user?.email),
        h('button', { type: 'button', onclick: changeAvatar }, me.avatar ? 'Change photo' : 'Add a profile photo'),
        me.avatar && h('button', { type: 'button', class: 'danger', onclick: removeAvatar }, 'Remove')),
      h('div', { class: 'stat' }, h('span', null, me?.displayName || 'Signed in'), h('strong', null, me ? ({ admin: 'Admin', client: 'Restaurant', student: 'Student' }[me.role] || me.role) : '')),
      h('p', { class: 'muted small' }, user?.email || ''),
      (me?.memberships || []).filter((m) => m.restaurant).map((m) => h('div', { class: 'stat' },
        h('span', null, m.restaurant.name, m.member_role === 'owner' ? ' (owner)' : ''),
        h('strong', null, STATUS_LABEL[m.restaurant.subscription_status] || m.restaurant.subscription_status))),
      h('div', { class: 'stat' }, h('span', null, 'Starred recipes sync'), h('strong', null, lib.syncError ? 'Problem' : 'On')),
      lib.syncError && h('p', { class: 'note' }, `Stars are only saved on this device right now: ${lib.syncError}`),
      h('button', { type: 'button', onclick: async () => { toast('Syncing…', 1200); await ctx.refreshCloud(); ctx.rerender(); } }, 'Sync now'),
      !me && h('p', { class: 'note' }, 'You are signed in, but account details could not be loaded. Connect to the internet to refresh.'),
      owned.length > 0 && h('div', { class: 'stack' },
        owned.map((m) => h('button', { type: 'button', onclick: async () => {
          try { fill(inviteOut, codeBox(ctx, await cloud.createInvite('restaurant', m.restaurant.id))); } catch (err) { toast(err.message, 4000); }
        } }, `Invite a staff member to ${m.restaurant.name}`)),
        inviteOut),
      h('div', { class: 'row grow' },
        me?.role === 'admin' && h('a', { class: 'btnlink primary', href: '#/admin' }, 'Admin tools'),
        h('button', { type: 'button', onclick: changePw }, 'Change password'),
        h('button', { type: 'button', onclick: async () => { await cloud.signOut(); ctx.clearCloud(); toast('Signed out'); ctx.rerender(); } }, 'Sign out')),
      pw);
    if (ctx.recovery) changePw();      // stays open across re-draws until saved or cancelled
  }

  paint();
  return card;
}

// ------------------------------------------------------------------ admin: codes and people

const DAY = 86400000;
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const STATUS_TEXT = { active: 'Active', 'used up': 'Used up', expired: 'Expired', cancelled: 'Cancelled' };
const ROLE_TEXT = { admin: 'Admin', student: 'Student', client: 'Restaurant' };

function whenText(iso) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return shortDate(iso);
}

// The list of invite codes. Returns { el, reload } so making a new code can refresh it.
function codesSection(ctx) {
  const { h, fill, toast } = ctx;
  const el = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading codes…'));

  const codeCard = (c, reload) => {
    const who = c.kind === 'student'
      ? (c.max_uses === 1 ? 'Student code for one person' : `Student code for up to ${c.max_uses} people`)
      : `${c.restaurant_name || 'Restaurant'} · ${c.member_role === 'owner' ? 'Owner' : 'Staff'}`;
    const facts = [`Used ${c.uses} of ${c.max_uses}`, `made ${shortDate(c.created_at)}`];
    if (c.status === 'active' && c.expires_at) {
      const left = Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / DAY);
      facts.push(left <= 1 ? 'expires within a day' : `expires in ${left} days`);
    } else if (c.status === 'expired') facts.push(`expired ${shortDate(c.expires_at)}`);
    else if (c.status === 'cancelled') facts.push(`cancelled ${shortDate(c.cancelled_at)}`);

    const actions = c.status === 'active' ? h('div', { class: 'row' },
      h('button', { type: 'button', onclick: async () => {
        toast(await copyText(shareText(c.code)) ? 'Invite message copied' : 'Could not copy. Press and hold the code to copy it.', 3000);
      } }, 'Copy invite message'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!await ctx.confirmDialog(`Cancel code ${c.code}? Nobody new can sign up with it. ${c.uses ? 'People who already joined keep their accounts.' : ''}`, 'Cancel code', true)) return;
        try { await cloud.cancelInvite(c.code); toast('Code cancelled'); reload(); } catch (err) { toast(err.message, 4000); }
      } }, 'Cancel code')) : null;

    return h('div', { class: 'card stack' },
      h('div', null, h('strong', { class: 'code' }, c.code), h('span', { class: 'badge' }, STATUS_TEXT[c.status] || c.status)),
      h('p', { class: 'small' }, who),
      h('p', { class: 'muted small' }, facts.join(' · ')),
      c.used_by.length ? h('p', { class: 'small' }, `Joined with this code: ${c.used_by.join(', ')}`) : null,
      actions);
  };

  const reload = async () => {
    let codes;
    try { codes = await cloud.listInvites(); } catch (err) {
      fill(el, h('p', { class: 'muted small' }, `Could not load codes: ${err.message}`));
      return;
    }
    if (!codes.length) { fill(el, h('p', { class: 'muted' }, 'No codes yet. Make one above.')); return; }
    const live = codes.filter((c) => c.status === 'active');
    const done = codes.filter((c) => c.status !== 'active');
    fill(el,
      live.length ? live.map((c) => codeCard(c, reload)) : h('p', { class: 'muted' }, 'No active codes. Make one above.'),
      done.length ? h('details', null,
        h('summary', { class: 'muted small' }, `Used up, expired and cancelled codes (${done.length})`),
        h('div', { class: 'stack', style: 'margin-top:.6rem' }, done.map((c) => codeCard(c, reload)))) : null);
  };
  reload();
  return { el, reload };
}

// Everyone with an account, with a filter, a search box and a Remove button.
function peopleSection(ctx) {
  const { h, fill, toast } = ctx;
  const el = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading people…'));
  let people = [];
  let avatars = {};

  const kind = h('select', { 'aria-label': 'Show' },
    h('option', { value: 'student' }, 'Students'), h('option', { value: 'client' }, 'Restaurant staff'), h('option', { value: 'all' }, 'Everyone'));
  const search = h('input', { class: 'full', type: 'search', placeholder: 'Search by name or email', 'aria-label': 'Search people' });
  const list = h('div', { class: 'stack' });
  const count = h('p', { class: 'muted small' });

  const personCard = (p) => {
    const facts = [`Joined ${whenText(p.joined_at)}${p.invite_code ? ` with code ${p.invite_code}` : ''}`];
    facts.push(p.last_sign_in_at ? `last signed in ${whenText(p.last_sign_in_at)}` : 'has not signed in yet');
    facts.push(plural(Number(p.private_recipes) || 0, 'private recipe'));
    const remove = p.role === 'admin' ? null : h('button', { type: 'button', class: 'danger', onclick: async () => {
      const n = Number(p.private_recipes) || 0;
      const msg = `Remove ${p.display_name || p.email} (${p.email})? Their account${n ? ` and ${plural(n, 'private recipe')}` : ''} will be deleted. Recipes of theirs already in Community stay there. This cannot be undone.`;
      if (!await ctx.confirmDialog(msg, 'Remove', true)) return;
      try { await cloud.removePerson(p.id); toast('Removed'); } catch (err) { toast(err.message, 5000); return; }
      await reload();
      try {   // tidy their photo files, keeping any that an approved Community recipe still shows
        const keep = new Set((await cloud.listRecipes()).map((x) => x.photo).filter(Boolean));
        const files = (await Promise.all(['avatars', 'library', 'recipes'].map((f) => cloud.listPhotos(`${f}/${p.id}`).catch(() => [])))).flat();
        await photos.discard(files.filter((f) => !keep.has(f)));
      } catch { /* a leftover file only costs a little storage */ }
    } }, 'Remove');
    return h('div', { class: 'card stack' },
      h('div', { class: 'row' }, avatarEl(avatars[p.id], p.display_name || p.email, true),
        h('strong', null, p.display_name || p.email), h('span', { class: 'badge', style: 'margin-left:0' }, ROLE_TEXT[p.role] || p.role)),
      h('p', { class: 'small', style: 'overflow-wrap:anywhere' }, p.email),
      p.restaurants.length ? h('p', { class: 'small' }, p.restaurants.join(', ')) : null,
      p.email_confirmed ? null : h('p', { class: 'small', style: 'color:var(--danger)' }, 'Has not confirmed their email yet. Ask them to check spam for the email from Jones Ridge Kitchen.'),
      h('p', { class: 'muted small' }, facts.join(' · ')),
      remove);
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = people.filter((p) => (kind.value === 'all' || p.role === kind.value)
      && (!q || `${p.display_name} ${p.email}`.toLowerCase().includes(q)));
    count.textContent = `${plural(shown.length, kind.value === 'student' ? 'student' : 'person').replace(/persons$/, 'people')}`;
    fill(list, shown.length ? shown.map(personCard) : h('p', { class: 'muted' }, q ? 'Nobody matches that search.' : 'Nobody here yet.'));
  };
  kind.addEventListener('change', paint);
  search.addEventListener('input', paint);

  const reload = async () => {
    try { avatars = Object.fromEntries((await cloud.listAvatars()).map((a) => [a.id, a.avatar])); } catch { avatars = {}; }
    try { people = await cloud.listPeople(); } catch (err) {
      fill(el, h('p', { class: 'muted small' }, `Could not load people: ${err.message}`));
      return;
    }
    fill(el, h('div', { class: 'row' }, kind, count), search, list);
    paint();
  };
  reload();
  return { el, reload };
}

// ------------------------------------------------------------------ admin screen

export async function viewAdmin(ctx) {
  const { h, fill, toast, lib, icon } = ctx;
  ctx.setView('settings', 'settings');
  if (!lib.me && cloud.isSignedIn()) { try { await ctx.refreshCloud(); } catch { /* checked below */ } }   // opened straight from a link
  if (!lib.me || lib.me.role !== 'admin') {
    fill(ctx.$app, h('h1', null, 'Admin tools'), h('p', { class: 'muted' }, 'This page is for the administrator. Sign in with the admin account in Settings.'),
      h('p', null, h('a', { href: '#/settings' }, 'Go to Settings')));
    return;
  }
  let restaurants = [];
  try { await ctx.refreshCloud(); } catch { /* use what we have */ }
  try { restaurants = await cloud.listRestaurants(); lib.restaurants = restaurants; } catch (err) { toast(err.message, 4000); }

  const pending = lib.cloud.filter((r) => r.scope === 'community' && r.status === 'pending');
  const inviteOut = h('div');
  const codes = codesSection(ctx);
  const people = peopleSection(ctx);
  const note = new Map();

  const review = async (row, approve) => {
    try {
      await cloud.reviewRecipe(row.id, approve, (note.get(row.id)?.value || '').trim());
      toast(approve ? 'Approved. It is now in Community.' : 'Declined');
      await ctx.refreshCloud();
      viewAdmin(ctx);
    } catch (err) { toast(err.message, 4000); }
  };

  const approvals = pending.length === 0
    ? h('p', { class: 'muted' }, 'Nothing is waiting for approval.')
    : h('div', { class: 'stack' }, pending.map((row) => {
      const n = h('input', { class: 'full', placeholder: 'Note for the author (optional)', 'aria-label': `Note for ${row.title}` });
      note.set(row.id, n);
      return h('div', { class: 'card stack' },
        h('a', { href: `#/r/${row.id}` }, h('strong', null, row.title)),
        h('p', { class: 'muted small' }, `Shared by ${row.author_name || 'a chef'}`),
        n,
        h('div', { class: 'row grow' },
          h('button', { class: 'primary', type: 'button', onclick: () => review(row, true) }, 'Approve'),
          h('button', { type: 'button', onclick: () => review(row, false) }, 'Decline')));
    }));

  // invites
  const maxUses = h('select', { 'aria-label': 'Number of people who can use the code' },
    [1, 5, 10, 25, 50].map((n) => h('option', { value: n }, n === 1 ? 'One person' : `Up to ${n} people`)));
  const studentBtn = h('button', { type: 'button', onclick: async () => {
    try { fill(inviteOut, codeBox(ctx, await cloud.createInvite('student', null, 'staff', Number(maxUses.value), 30))); codes.reload(); } catch (err) { toast(err.message, 4000); }
  } }, 'Make a student code');
  const rSel = h('select', { 'aria-label': 'Restaurant' }, restaurants.map((r) => h('option', { value: r.id }, r.name)));
  const roleSel = h('select', { 'aria-label': 'Role' }, h('option', { value: 'owner' }, 'Owner'), h('option', { value: 'staff' }, 'Staff'));
  const restBtn = h('button', { type: 'button', disabled: restaurants.length === 0, onclick: async () => {
    try { fill(inviteOut, codeBox(ctx, await cloud.createInvite('restaurant', rSel.value, roleSel.value, 1, 14))); codes.reload(); } catch (err) { toast(err.message, 4000); }
  } }, 'Make a restaurant code');

  // restaurants
  const nameIn = h('input', { class: 'full', placeholder: 'Restaurant name', 'aria-label': 'New restaurant name' });
  const addRest = async (e) => {
    e.preventDefault();
    if (!nameIn.value.trim()) return;
    try { await cloud.createRestaurant(nameIn.value.trim()); toast('Restaurant added'); viewAdmin(ctx); } catch (err) { toast(err.message, 4000); }
  };
  const restRows = restaurants.map((r) => {
    const status = h('select', { 'aria-label': `Subscription for ${r.name}` },
      STATUSES.map((s) => h('option', { value: s, selected: s === r.subscription_status }, STATUS_LABEL[s])));
    status.value = r.subscription_status;
    const seats = h('input', { type: 'number', min: '1', max: '50', value: String(r.seat_limit), 'aria-label': `Logins allowed for ${r.name}`, style: 'width:5rem' });
    const save = async () => {
      try { await cloud.updateRestaurant(r.id, { subscription_status: status.value, seat_limit: Math.max(1, Number(seats.value) || 1) }); toast('Saved'); await ctx.refreshCloud(); } catch (err) { toast(err.message, 4000); }
    };
    status.addEventListener('change', save);
    seats.addEventListener('change', save);
    return h('div', { class: 'card stack' }, h('strong', null, r.name),
      h('div', { class: 'row' }, h('label', { class: 'row' }, 'Plan', status), h('label', { class: 'row' }, 'Logins', seats)));
  });

  fill(ctx.$app,
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => ctx.goBack('#/settings') }, icon('back'))),
    h('h1', null, 'Admin tools'),
    h('h2', null, `Waiting for approval${pending.length ? ` (${pending.length})` : ''}`),
    approvals,
    h('h2', null, 'Invite someone'),
    h('section', { class: 'card stack' },
      h('p', { class: 'muted small' }, 'Codes are needed to create an account. Share the copied message with the person.'),
      h('div', { class: 'row' }, maxUses, studentBtn),
      h('div', { class: 'row' }, rSel, roleSel, restBtn),
      inviteOut),
    h('h2', null, 'Invite codes'),
    codes.el,
    h('h2', null, 'People'),
    people.el,
    h('h2', null, 'Restaurants'),
    h('div', { class: 'stack' }, restRows,
      h('form', { class: 'card stack', onsubmit: addRest }, nameIn, h('button', { type: 'submit' }, 'Add restaurant'))),
    h('p', { class: 'muted small', style: 'margin-top:1.4rem' }, 'Until billing is connected, set a restaurant’s plan to Active by hand. Setting it to anything else hides its collection and returns its staff to the free plan.'));
  window.scrollTo(0, 0);
}
