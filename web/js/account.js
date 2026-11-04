// Account card (sign in / create account / restaurant tools) and the admin screen.
// Receives `ctx` from app.js so it can reuse the app's helpers without importing the whole app.
import * as cloud from './cloud.js';
import { copyText } from './ui.js';

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
        try { await cloud.changePassword(a.value); toast('Password changed'); fill(pw); } catch (err) { m.textContent = err.message; }
      } }, a, h('div', { class: 'row grow' }, h('button', { class: 'primary', type: 'submit' }, 'Save password'), h('button', { type: 'button', onclick: () => fill(pw) }, 'Cancel')), m));
      a.focus();
    };

    fill(card,
      h('strong', null, 'Account'),
      h('div', { class: 'stat' }, h('span', null, me?.displayName || 'Signed in'), h('strong', null, me ? ({ admin: 'Admin', client: 'Restaurant', student: 'Student' }[me.role] || me.role) : '')),
      h('p', { class: 'muted small' }, user?.email || ''),
      (me?.memberships || []).filter((m) => m.restaurant).map((m) => h('div', { class: 'stat' },
        h('span', null, m.restaurant.name, m.member_role === 'owner' ? ' (owner)' : ''),
        h('strong', null, STATUS_LABEL[m.restaurant.subscription_status] || m.restaurant.subscription_status))),
      me && h('div', { class: 'stat' }, h('span', null, 'Starred recipes sync'), h('strong', null, lib.syncError ? 'Problem' : 'On')),
      me && lib.syncError && h('p', { class: 'note' }, `Stars are only saved on this device right now: ${lib.syncError}`),
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
    if (ctx.recovery) { ctx.recovery = false; changePw(); }
  }

  paint();
  return card;
}

// ------------------------------------------------------------------ admin screen

export async function viewAdmin(ctx) {
  const { h, fill, toast, lib, icon } = ctx;
  ctx.setView('settings', 'settings');
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
    try { fill(inviteOut, codeBox(ctx, await cloud.createInvite('student', null, 'staff', Number(maxUses.value), 30))); } catch (err) { toast(err.message, 4000); }
  } }, 'Make a student code');
  const rSel = h('select', { 'aria-label': 'Restaurant' }, restaurants.map((r) => h('option', { value: r.id }, r.name)));
  const roleSel = h('select', { 'aria-label': 'Role' }, h('option', { value: 'owner' }, 'Owner'), h('option', { value: 'staff' }, 'Staff'));
  const restBtn = h('button', { type: 'button', disabled: restaurants.length === 0, onclick: async () => {
    try { fill(inviteOut, codeBox(ctx, await cloud.createInvite('restaurant', rSel.value, roleSel.value, 1, 14))); } catch (err) { toast(err.message, 4000); }
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
    h('h2', null, 'Restaurants'),
    h('div', { class: 'stack' }, restRows,
      h('form', { class: 'card stack', onsubmit: addRest }, nameIn, h('button', { type: 'submit' }, 'Add restaurant'))),
    h('p', { class: 'muted small', style: 'margin-top:1.4rem' }, 'Until billing is connected, set a restaurant’s plan to Active by hand. Setting it to anything else hides its collection and returns its staff to the free plan.'));
  window.scrollTo(0, 0);
}
