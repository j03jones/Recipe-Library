// Account card (sign in / create account / restaurant tools) and the admin screen.
// Receives `ctx` from app.js so it can reuse the app's helpers without importing the whole app.
import * as cloud from './cloud.js';
import { canShare, share } from './native.js';
import { copyText } from './ui.js';
import * as photos from './photos.js';
import { qrSvg } from './qr.js';
import { PACKAGES, packageOf, restaurantPlan } from './clientcore.js';
import { toRecord } from './model.js';

/** What the admin needs to check on a submission that credits someone else: the original link. */
function reviewCredit(h, body) {
  const link = (who, url, label) => h('p', { class: 'small' }, who, ' ',
    /^https?:\/\//i.test(url || '') && h('a', { href: url, target: '_blank', rel: 'noopener' }, label));
  const name = (c) => [c?.author, c?.name].filter(Boolean).join(', ') || 'another website';
  if (body?.kind === 'link') return link(`Link card: ${name(body.src)}.`, body.src?.url, 'Check the original ↗');
  if (body?.adapted) return link(`Adapted from ${name(body.adapted)}. Check the method is in their own words:`, body.adapted.url, 'compare with the original ↗');
  return null;
}

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

/** The client portal on the website (web/portal/), where restaurant teams see their collection. */
const PORTAL = 'https://jonesridgekitchen.com/my-meals/';
const STATUSES = ['inactive', 'trialing', 'active', 'past_due', 'canceled'];
const STATUS_LABEL = { inactive: 'Not subscribed', trialing: 'Trial', active: 'Active', past_due: 'Payment overdue', canceled: 'Canceled' };
/** "Active", "Trial until Nov 30", "Trial ended"... for a restaurant (add_restaurant_trials.sql). */
const planText = (r) => {
  const p = restaurantPlan(r);
  if (p.project) return 'Keeps access';
  if (p.trial && p.ended) return 'Trial ended';
  if (p.trial && p.ends) return `Trial until ${p.ends.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return STATUS_LABEL[r.subscription_status] || r.subscription_status;
};

const APP_NAME = 'Jones Ridge Recipes';
function inviteMessage(link, what = '') {
  return `You're invited to ${APP_NAME}${what ? ` ${what}` : ''}. Open this link on your phone to create your account: ${link}`;
}

/** A password box with a Show/Hide button. Returns { el, input }. */
export function passwordField(h, { placeholder, autocomplete, label = 'Password' }) {
  const input = h('input', { type: 'password', class: 'full', autocomplete, 'aria-label': label, placeholder });
  const btn = h('button', { type: 'button', class: 'linkish showpw', 'aria-label': 'Show password', onclick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  } }, 'Show');
  return { el: h('div', { class: 'pwfield' }, input, btn), input };
}

/** Big QR code in a dialog, for a room of people to scan from one screen. */
function showQrDialog(ctx, link, title) {
  const { h } = ctx;
  const box = h('div', { class: 'qr big' });
  box.innerHTML = qrSvg(link, { label: `QR code for ${title}` });
  const dlg = h('dialog', { class: 'qrdialog' },
    h('h2', null, title),
    box,
    h('p', { class: 'muted small' }, 'Point a phone camera at the code, then tap the link that pops up.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => dlg.close() }, 'Done')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** Everything for sharing one invite code: QR code, the link, copy / share / email / full screen. */
function inviteShare(ctx, code, what = '') {
  const { h, toast } = ctx;
  const link = cloud.inviteLink(code);
  const qr = h('div', { class: 'qr' });
  qr.innerHTML = qrSvg(link, { label: 'QR code for the invite link' });
  const msg = inviteMessage(link, what);
  const mail = `mailto:?subject=${encodeURIComponent(`Your invite to ${APP_NAME}`)}&body=${encodeURIComponent(msg)}`;
  return h('div', { class: 'invite-share' },
    qr,
    h('div', { class: 'stack' },
      h('p', { class: 'small' }, 'Scan the QR code, or send the link. It opens the app with the invite filled in.'),
      h('input', { class: 'full link', readonly: true, value: link, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: async () => toast(await copyText(link) ? 'Invite link copied' : 'Could not copy. Press and hold the link to copy it.', 3000) }, 'Copy link'),
        canShare() && h('button', { type: 'button', onclick: () => share({ title: `Join ${APP_NAME}`, text: msg }) }, 'Share…'),
        h('a', { class: 'btnlink', href: mail }, 'Email it'),
        h('button', { type: 'button', onclick: () => showQrDialog(ctx, link, `Join ${APP_NAME}`) }, 'Show big QR'))));
}

/** Name + email, and Supabase emails them a one-person invite. */
function emailInviteForm(ctx, opts, onSent) {
  const { h, toast } = ctx;
  const name = h('input', { class: 'full', autocomplete: 'off', 'aria-label': 'Their name', placeholder: 'Their first name' });
  const email = h('input', { class: 'full', type: 'email', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Their email', placeholder: 'Their email' });
  const msg = h('p', { class: 'note', role: 'status' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Send invite email');
  return h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { msg.textContent = 'Enter their email address.'; email.focus(); return; }
    const who = opts();
    if (!who) return;
    go.disabled = true; msg.textContent = 'Sending…';
    try {
      await cloud.sendInvite({ ...who, email: email.value.trim(), name: name.value.trim() });
      toast(`Invite sent to ${email.value.trim()}`, 3500);
      msg.textContent = `Sent. ${name.value.trim() || 'They'} will get an email from Jones Ridge Kitchen with a button to join (check spam if it doesn't arrive).`;
      name.value = ''; email.value = '';
      onSent?.();
    } catch (err) { msg.textContent = err.message; }
    go.disabled = false;
  } }, name, email, go, msg);
}

/** "Ask for an invite" form for people without an account. */
export function requestInviteForm(ctx, { compact = false } = {}) {
  const { h, fill } = ctx;
  const box = h('div', { class: 'stack' });
  const name = h('input', { class: 'full', autocomplete: 'given-name', 'aria-label': 'Your name', placeholder: 'Your name' });
  const email = h('input', { class: 'full', type: 'email', autocomplete: 'email', autocapitalize: 'off', 'aria-label': 'Your email', placeholder: 'Your email' });
  const about = h('select', { class: 'full', 'aria-label': 'I am' },
    h('option', { value: 'student' }, 'A culinary student'),
    h('option', { value: 'restaurant' }, 'From a restaurant'),
    h('option', { value: 'other' }, 'Something else'));
  const note = h('textarea', { class: 'full', rows: 2, maxlength: 500, 'aria-label': 'Note', placeholder: 'Anything Chef Joseph should know (optional)' });
  const msg = h('p', { class: 'note', role: 'status' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Ask for an invite');
  fill(box,
    !compact && h('p', { class: 'muted small' }, 'No invite yet? Send a request. When it’s approved you’ll get an email with a link to join.'),
    h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { msg.textContent = 'Enter your name.'; name.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { msg.textContent = 'Enter your email address.'; email.focus(); return; }
      go.disabled = true; msg.textContent = 'Sending…';
      try {
        await cloud.requestInvite({ name: name.value.trim(), email: email.value.trim(), about: about.value, note: note.value.trim() });
        await ctx.infoDialog('Request sent', `Thanks, ${name.value.trim()}! When your request is approved, an invite will be emailed to ${email.value.trim()}.`);
        fill(box, h('p', { class: 'note' }, `Request sent. Watch ${email.value.trim()} for your invite (and check spam).`));
      } catch (err) { msg.textContent = err.message; go.disabled = false; }
    } }, name, email, about, note, go, msg));
  return box;
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
    if (ctx.signupOpen === undefined) {    // ask once whether sign-up needs an invite code
      ctx.signupOpen = false;
      cloud.signupOpen().then((open) => {
        if (!open) return;
        ctx.signupOpen = true;
        // repaint to drop the invite-code field, unless the person has already started typing (it would wipe that)
        const typed = [...card.querySelectorAll('input')].some((i) => i.value);
        if (!cloud.isSignedIn() && card.isConnected && !typed) paint();
      }).catch(() => {});
    }
    const open = ctx.signupOpen === true;
    if (open && mode === 'ask') mode = 'up';
    if (ctx.joinCode && mode === 'in' && !paintSignedOut.seen) { mode = 'up'; paintSignedOut.seen = true; }
    const email = h('input', { type: 'email', class: 'full', autocomplete: 'email', autocapitalize: 'off', 'aria-label': 'Email', placeholder: 'Email' });
    const pw = passwordField(h, { placeholder: mode === 'in' ? 'Password' : 'Password (8+ characters)', autocomplete: mode === 'in' ? 'current-password' : 'new-password' });
    const pass = pw.input;
    const name = h('input', { class: 'full', autocomplete: 'given-name', 'aria-label': 'Your name', placeholder: 'Your first name' });
    const code = h('input', { class: 'full', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Invite code', placeholder: open ? 'Invite code (optional, for a restaurant)' : 'Invite code', value: ctx.joinCode || '' });
    const msg = h('p', { class: 'note', role: 'status' });
    const extra = h('div');
    const forgot = h('button', { type: 'button', class: 'linkish', onclick: async () => {
      if (!email.value.trim()) { msg.textContent = 'Type your email above first, then tap “Forgot password?”.'; email.focus(); return; }
      msg.textContent = 'Sending…';
      try { await cloud.requestPasswordReset(email.value.trim()); msg.textContent = ''; await ctx.infoDialog('Check your email', `If ${email.value.trim()} has an account, a link to reset your password is on its way. Check your spam folder too.`); }
      catch (err) { msg.textContent = err.message; }
    } }, 'Forgot password?');
    const resend = () => h('button', { type: 'button', onclick: async () => {
      try { await cloud.resendConfirmation(email.value.trim()); await ctx.infoDialog('Email sent again', `We sent a new confirmation link to ${email.value.trim()}. Open it on this phone to finish.`); }
      catch (err) { msg.textContent = err.message; }
    } }, 'Send the confirmation email again');
    const go = h('button', { class: 'primary', type: 'submit' }, mode === 'in' ? 'Sign in' : 'Create account');

    const form = h('form', { class: 'stack', novalidate: true },
      mode === 'up' && name, email, pw.el, mode === 'up' && !ctx.joinCode && code,
      mode === 'up' && ctx.joinCode && h('p', { class: 'small okline' }, '✓ Invite code ', h('strong', null, ctx.joinCode), ' is filled in for you.'),
      go, msg, extra, mode === 'in' && h('p', { class: 'forgot-row' }, forgot));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      fill(extra);
      if (!email.value.trim() || !pass.value) { msg.textContent = 'Enter your email and password.'; return; }
      if (mode === 'up') {
        if (!name.value.trim()) { msg.textContent = 'Enter your first name.'; name.focus(); return; }
        if (pass.value.length < 8) { msg.textContent = 'Use a password of at least 8 characters.'; return; }
        if (!open && !(ctx.joinCode || code.value.trim())) { msg.textContent = 'Enter the invite code you were given, or ask for one below.'; return; }
      }
      go.disabled = true;
      msg.textContent = mode === 'in' ? 'Signing in…' : 'Creating your account…';
      try {
        if (mode === 'in') {
          await cloud.signIn(email.value.trim(), pass.value);
          msg.textContent = '';
          await ctx.refreshCloud();
          await ctx.infoDialog(`Welcome back${lib.me?.displayName ? `, ${lib.me.displayName}` : ''}!`, 'You’re signed in. Your recipes and stars are synced on this device.');
        } else {
          const r = await cloud.signUp({ email: email.value.trim(), password: pass.value, displayName: name.value.trim(), inviteCode: (ctx.joinCode || code.value).trim() });
          msg.textContent = '';
          ctx.joinCode = '';
          if (r === 'confirm-email') {
            go.disabled = false;
            await ctx.infoDialog('Check your email', `Your account is almost ready. We sent a link to ${email.value.trim()}. Open it on this phone to finish. It can take a minute to arrive, so check spam too.`);
            mode = 'in'; paint();
            return;
          }
          await ctx.refreshCloud();
          await ctx.infoDialog(`Welcome, ${name.value.trim()}!`, 'Your account is ready. You can now save your own recipes, star favourites on every device and share with the Community.');
        }
        if (location.hash.startsWith('#/join')) location.replace(`${location.pathname}${location.search}#/settings`);
        else ctx.rerender();
      } catch (err) {
        msg.textContent = err.message;
        if (err.code === 'email_not_confirmed') fill(extra, resend());
        if (err.code === 'user_already_exists') fill(extra, h('button', { type: 'button', onclick: () => { mode = 'in'; paint(); } }, 'Go to Sign in'));
        go.disabled = false;
      }
    });

    fill(card,
      h('strong', null, 'Account'),
      h('p', { class: 'muted small' }, 'Sign in to keep recipes in your account, share with the Community, and open your restaurant’s collection. The built-in library works without an account.'),
      h('div', { class: 'seg2', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String(mode === 'in'), onclick: () => { mode = 'in'; paint(); } }, 'Sign in'),
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String(mode === 'up'), onclick: () => { mode = 'up'; paint(); } }, 'New account'),
        !open && h('button', { type: 'button', role: 'tab', 'aria-pressed': String(mode === 'ask'), onclick: () => { mode = 'ask'; paint(); } }, 'Request')),
      mode === 'ask' ? requestInviteForm(ctx) : form,
      mode === 'up' && (open
        ? h('p', { class: 'muted small' }, 'Anyone can create a free student account. Restaurant staff: enter the code your restaurant gave you.')
        : h('p', { class: 'muted small' }, 'Accounts are by invitation. No code? ', h('button', { type: 'button', class: 'linkish', onclick: () => { mode = 'ask'; paint(); } }, 'Ask for an invite'))));
    if (mode === 'up' && !ctx.joinCode) setTimeout(() => name.focus(), 0);
  }

  function paintSignedIn() {
    const me = lib.me;
    const user = cloud.currentUser();
    const owned = (me?.memberships || []).filter((m) => m.member_role === 'owner' && m.restaurant);
    const pw = h('div');

    const changePw = () => {
      const welcome = ctx.recovery === 'invite';
      const f = passwordField(h, { placeholder: welcome ? 'Choose a password (at least 8 characters)' : 'New password (at least 8 characters)', autocomplete: 'new-password', label: 'New password' });
      const a = f.input;
      const m = h('p', { class: 'note', role: 'status' });
      fill(pw, h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        if (a.value.length < 8) { m.textContent = 'Use at least 8 characters.'; return; }
        try {
          await cloud.changePassword(a.value); ctx.recovery = false; fill(pw);
          await ctx.infoDialog(welcome ? 'You’re all set' : 'Password changed', welcome ? `Next time, sign in with ${user?.email || 'your email'} and this password.` : 'Use your new password next time you sign in.');
        } catch (err) { m.textContent = err.message; }
      } },
      welcome && h('p', null, h('strong', null, 'Choose a password'), ' so you can sign in on other devices.'),
      f.el, h('div', { class: 'row grow' }, h('button', { class: 'primary', type: 'submit' }, 'Save password'), !welcome && h('button', { type: 'button', onclick: () => { ctx.recovery = false; fill(pw); } }, 'Cancel')), m));
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
        h('strong', null, planText(m.restaurant)))),
      lib.syncError && !/\boffline\b/i.test(lib.syncError) && h('p', { class: 'note' }, `Your stars are only saved on this device right now: ${lib.syncError}`),
      !me && h('p', { class: 'note' }, 'You are signed in, but account details could not be loaded. Connect to the internet to refresh.'),
      owned.length > 0 && h('div', { class: 'stack' },
        owned.map((m) => { const inviteOut = h('div'); return h('details', { class: 'card stack invitebox' },
          h('summary', null, `Invite staff to ${m.restaurant.name}`),
          h('p', { class: 'muted small' }, 'Each invite is for one person and lasts 14 days.'),
          emailInviteForm(ctx, () => ({ kind: 'restaurant', restaurantId: m.restaurant.id, memberRole: 'staff' })),
          h('button', { type: 'button', onclick: async () => {
            try { fill(inviteOut, inviteShare(ctx, await cloud.createInvite('restaurant', m.restaurant.id), `as staff at ${m.restaurant.name}`)); } catch (err) { toast(err.message, 4000); }
          } }, 'Or make a link / QR code'),
          inviteOut); })),
      h('div', { class: 'row grow' },
        me?.role === 'admin' && h('a', { class: 'btnlink primary', href: '#/admin' }, 'Admin tools'),
        me?.role === 'admin' && h('a', { class: 'btnlink primary', href: '#/clients' }, 'Meal prep clients'),
        h('button', { type: 'button', onclick: changePw }, 'Change password'),
        h('button', { type: 'button', onclick: async () => { await cloud.signOut(); ctx.clearCloud(); toast('Signed out'); ctx.rerender(); } }, 'Sign out')),
      pw,
      me && me.role !== 'admin' && h('details', { class: 'dangerzone' },
        h('summary', null, 'Delete my account'),
        h('p', { class: 'muted small' }, 'This permanently deletes your Jones Ridge Recipes account and everything saved with it: your own recipes '
          + '(including any you shared to Community), your photos, stars, notes, meal plan and shopping list. It can’t be undone. '
          + 'The built-in recipes stay on this device.'),
        h('button', { type: 'button', class: 'danger', onclick: deleteAccount }, 'Delete my account')));
    if (ctx.recovery) changePw();      // stays open across re-draws until saved or cancelled
  }

  async function deleteAccount() {
    const email = cloud.currentUser()?.email || 'this account';
    if (!await ctx.confirmDialog(`Delete ${email} and everything saved with it? This can’t be undone.`, 'Delete account', true)) return;
    try { await cloud.deleteMyAccount(); } catch (err) { toast(err.message, 6000); return; }
    ctx.clearCloud();
    await ctx.infoDialog('Account deleted', 'Your account and everything saved with it have been deleted. Thanks for cooking with us.');
    ctx.rerender();
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

    const shareOut = h('div');
    const what = c.kind === 'restaurant' ? `as ${c.member_role === 'owner' ? 'an owner' : 'staff'} at ${c.restaurant_name || 'a restaurant'}` : '';
    const actions = c.status === 'active' ? h('div', { class: 'row' },
      !c.email && h('button', { type: 'button', onclick: () => fill(shareOut, shareOut.firstChild ? null : inviteShare(ctx, c.code, what)) }, 'QR code & link'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!await ctx.confirmDialog(`Cancel code ${c.code}? Nobody new can sign up with it. ${c.uses ? 'People who already joined keep their accounts.' : ''}`, 'Cancel code', true)) return;
        try { await cloud.cancelInvite(c.code); toast('Code cancelled'); reload(); } catch (err) { toast(err.message, 4000); }
      } }, 'Cancel code')) : null;

    return h('div', { class: 'card stack' },
      h('div', null, h('strong', { class: 'code' }, c.code), h('span', { class: 'badge' }, STATUS_TEXT[c.status] || c.status)),
      h('p', { class: 'small' }, who),
      h('p', { class: 'muted small' }, facts.join(' · ')),
      c.email ? h('p', { class: 'small' }, `Emailed to ${c.email}`) : null,
      c.used_by.length ? h('p', { class: 'small' }, `Joined with this code: ${c.used_by.join(', ')}`) : null,
      actions, shareOut);
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
  const label = () => {   // "Students (24)" in the menu
    for (const o of kind.options) {
      const n = o.value === 'all' ? people.length : people.filter((p) => p.role === o.value).length;
      o.textContent = `${{ student: 'Students', client: 'Restaurant staff', all: 'Everyone' }[o.value]} (${n})`;
    }
  };
  const search = h('input', { type: 'search', placeholder: 'Search by name or email', 'aria-label': 'Search people' });
  const list = h('div', { class: 'peoplelist' });
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
    // one line each (name, role, email); open it for the details and Remove
    return h('details', { class: 'person' },
      h('summary', null, avatarEl(avatars[p.id], p.display_name || p.email, true),
        h('span', { class: 'who' }, h('strong', null, p.display_name || p.email), h('span', { class: 'muted small' }, p.email)),
        h('span', { class: 'badge' }, ROLE_TEXT[p.role] || p.role),
        !p.email_confirmed && h('span', { class: 'badge warn', title: 'Has not confirmed their email' }, 'Unconfirmed')),
      h('div', { class: 'stack' },
        p.restaurants.length ? h('p', { class: 'small' }, p.restaurants.join(', ')) : null,
        p.email_confirmed ? null : h('p', { class: 'small', style: 'color:var(--danger)' }, 'Has not confirmed their email yet. Ask them to check spam for the email from Jones Ridge Kitchen.'),
        h('p', { class: 'muted small' }, facts.join(' · ')),
        remove));
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
    label();
    fill(el, h('div', { class: 'row peoplefind' }, kind, search), count, list);
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
    fill(ctx.$app, ctx.pageHead('Admin tools'), h('p', { class: 'muted' }, 'This page is for the administrator. Sign in with the admin account in Settings.'),
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
        reviewCredit(h, row.body),
        n,
        h('div', { class: 'row grow' },
          h('button', { class: 'primary', type: 'button', onclick: () => review(row, true) }, 'Approve'),
          h('button', { type: 'button', onclick: () => review(row, false) }, 'Decline')));
    }));

  // invites: who, then email or link/QR
  const whoSel = h('select', { class: 'full', 'aria-label': 'Who are you inviting' },
    h('option', { value: 'student' }, 'A student'),
    h('option', { value: 'owner', disabled: restaurants.length === 0 }, 'A restaurant owner'),
    h('option', { value: 'staff', disabled: restaurants.length === 0 }, 'Restaurant staff'));
  const rSel = h('select', { class: 'full', 'aria-label': 'Restaurant' }, restaurants.map((r) => h('option', { value: r.id }, r.name)));
  const rRow = h('label', { class: 'field', hidden: true }, h('span', null, 'Restaurant'), rSel);
  const maxUses = h('select', { 'aria-label': 'How many people can use the link' },
    [1, 5, 10, 25, 50].map((n) => h('option', { value: n }, n === 1 ? 'One person' : `Up to ${n} people`)));
  maxUses.value = '25';
  const usesRow = h('label', { class: 'row' }, h('span', { class: 'small' }, 'Link works for'), maxUses);
  whoSel.addEventListener('change', () => { rRow.hidden = whoSel.value === 'student'; usesRow.hidden = whoSel.value !== 'student'; fill(inviteOut); });
  const who = () => (whoSel.value === 'student'
    ? { kind: 'student' }
    : { kind: 'restaurant', restaurantId: rSel.value, memberRole: whoSel.value });
  const linkBtn = h('button', { type: 'button', onclick: async () => {
    const w = who();
    try {
      const code = w.kind === 'student'
        ? await cloud.createInvite('student', null, 'staff', Number(maxUses.value), 30)
        : await cloud.createInvite('restaurant', w.restaurantId, w.memberRole, 1, 14);
      const rName = restaurants.find((r) => r.id === w.restaurantId)?.name;
      fill(inviteOut, inviteShare(ctx, code, w.kind === 'restaurant' ? `as ${w.memberRole === 'owner' ? 'an owner' : 'staff'} at ${rName}` : ''));
      codes.reload();
    } catch (err) { toast(err.message, 4000); }
  } }, 'Make a link & QR code');

  // open sign-up switch
  const signupBox = h('section', { class: 'card stack' }, h('p', { class: 'muted small' }, 'Loading…'));
  const paintSignup = (open) => {
    const sw = h('input', { type: 'checkbox', role: 'switch', checked: open, 'aria-label': 'Open sign-up' });
    sw.addEventListener('change', async () => {
      const want = sw.checked;
      const ok = await ctx.confirmDialog(want
        ? 'Open sign-up? Anyone who finds the app can create a free student account without an invite. They still confirm their email, and you can remove people in Admin tools. Restaurant staff still need a code from their restaurant.'
        : 'Close sign-up? New people will need an invite code again. Everyone who already has an account keeps it.', want ? 'Open sign-up' : 'Close sign-up');
      if (!ok) { sw.checked = !want; return; }
      try { await cloud.setSignupOpen(want); ctx.signupOpen = want; toast(want ? 'Sign-up is open' : 'Sign-up is invite-only again'); paintSignup(want); }
      catch (err) { sw.checked = !want; toast(err.message, 4000); }
    });
    fill(signupBox,
      h('label', { class: 'check' }, sw, h('strong', null, 'Open sign-up')),
      h('p', { class: 'small' }, open
        ? 'On: anyone can create a free student account. The Request form is hidden, and invite links still work.'
        : 'Off: people need an invite (link, QR code or email) or can send a request.'));
  };
  cloud.signupOpen().then(paintSignup).catch((err) => fill(signupBox, h('p', { class: 'muted small' }, `Could not load: ${err.message}`)));

  // invite requests
  const requestsEl = h('div', { class: 'stack' });
  const loadRequests = async () => {
    let reqs = [];
    try { reqs = await cloud.listInviteRequests(); } catch (err) { fill(requestsEl, h('p', { class: 'muted small' }, `Could not load requests: ${err.message}`)); return; }
    requestsHead.textContent = `Invite requests${reqs.length ? ` (${reqs.length})` : ''}`;
    ctx.adminInviteCount?.(reqs.length);
    const ABOUT = { student: 'Culinary student', restaurant: 'From a restaurant', other: 'Other' };
    fill(requestsEl, reqs.length === 0 ? h('p', { class: 'muted' }, 'Nobody is waiting for an invite.') : reqs.map((r) => {
      const out = h('p', { class: 'note', role: 'status' });
      const send = h('button', { class: 'primary', type: 'button', onclick: async () => {
        send.disabled = true; out.textContent = 'Sending…';
        try { await cloud.sendInvite({ email: r.email, name: r.name, kind: 'student', requestId: r.id }); toast(`Invite sent to ${r.email}`, 3500); loadRequests(); codes.reload(); }
        catch (err) { out.textContent = err.message; send.disabled = false; }
      } }, 'Send student invite');
      return h('div', { class: 'card stack' },
        h('div', null, h('strong', null, r.name), h('span', { class: 'badge' }, ABOUT[r.about] || r.about)),
        h('p', { class: 'small', style: 'overflow-wrap:anywhere' }, r.email),
        r.note && h('p', { class: 'small' }, `“${r.note}”`),
        h('p', { class: 'muted small' }, `Asked ${whenText(r.created_at)}`),
        r.about === 'restaurant' && h('p', { class: 'muted small' }, 'For a restaurant owner: on the Restaurants tab, use Add a restaurant with their email (it invites them as the owner), then dismiss this request.'),
        h('div', { class: 'row grow' }, send,
          h('button', { type: 'button', onclick: async () => {
            try { await cloud.dismissInviteRequest(r.id); toast('Dismissed'); loadRequests(); } catch (err) { toast(err.message, 4000); }
          } }, 'Dismiss')),
        out);
    }));
  };
  const requestsHead = h('h2', null, 'Invite requests');
  loadRequests();

  // restaurants: add one (on a free trial, with its owner invited), set its plan, fill its collection
  const DAY = 86400000;
  const LONG = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const trialEnd = (days, from = Date.now()) => new Date(Math.max(from, Date.now()) + days * DAY).toISOString();
  const restBox = h('div', { class: 'stack' });

  const addForm = (() => {
    const nameIn = h('input', { class: 'full', maxlength: '200', placeholder: 'Restaurant name', 'aria-label': 'New restaurant name' });
    const planSel = h('select', { class: 'full', 'aria-label': 'Plan for the new restaurant' },
      h('option', { value: 'trial14' }, 'Free trial: 14 days'), h('option', { value: 'trial30' }, 'Free trial: 30 days'),
      h('option', { value: 'active' }, 'Active'), h('option', { value: 'inactive' }, 'Not subscribed yet'));
    const pkgSel = h('select', { class: 'full', 'aria-label': 'Package for the new restaurant' },
      Object.entries(PACKAGES).map(([k, p]) => h('option', { value: k }, `${p.label}: ${p.fee}${p.seats ? `, ${p.seats} logins` : ''}`)));
    pkgSel.value = 'self_service';
    const seatsIn = h('input', { type: 'number', min: '1', max: '50', value: String(PACKAGES.self_service.seats), 'aria-label': 'Logins allowed', style: 'width:5rem' });
    pkgSel.addEventListener('change', () => { if (PACKAGES[pkgSel.value].seats) seatsIn.value = String(PACKAGES[pkgSel.value].seats); });
    const emailIn = h('input', { type: 'email', class: 'full', autocomplete: 'off', placeholder: 'owner@restaurant.com (optional)', 'aria-label': 'Owner’s email' });
    const ownerIn = h('input', { type: 'text', class: 'full', maxlength: '80', placeholder: 'Owner’s name (optional)', 'aria-label': 'Owner’s name' });
    const out = h('p', { class: 'note', role: 'status', hidden: true });
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Add restaurant');
    return h('details', { class: 'card addrest', open: !restaurants.length || null }, h('summary', null, h('strong', null, '+ Add a restaurant')), h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); return; }
      const plan = planSel.value;
      const fields = plan.startsWith('trial')
        ? { subscription_status: 'trialing', trial_ends_at: trialEnd(plan === 'trial30' ? 30 : 14) }
        : { subscription_status: plan };
      btn.disabled = true;
      try {
        const r = await cloud.createRestaurant(name, Math.max(1, Number(seatsIn.value) || 3), { ...fields, package: pkgSel.value });
        let msg = `${name} added`;
        if (emailIn.value.trim()) {
          try {
            await cloud.sendInvite({ email: emailIn.value.trim(), name: ownerIn.value.trim(), kind: 'restaurant', restaurantId: r.id, memberRole: 'owner' });
            msg += `, and ${emailIn.value.trim()} has an email to set up their owner login`;
            codes.reload();
          } catch (err) { msg += `, but the invite was not sent: ${err.message}`; }
        }
        out.hidden = false; out.textContent = `${msg}.`;
        nameIn.value = ''; emailIn.value = ''; ownerIn.value = '';
        restaurants = await cloud.listRestaurants(); lib.restaurants = restaurants;
        paintRestaurants();
      } catch (err) { out.hidden = false; out.textContent = err.message; }
      finally { btn.disabled = false; }
    } },
    nameIn,
    h('label', { class: 'row' }, 'Package', pkgSel),
    h('div', { class: 'row' }, h('label', { class: 'row grow' }, 'Plan', planSel), h('label', { class: 'row' }, 'Logins', seatsIn)),
    h('p', { class: 'muted small' }, 'A trial shows the restaurant its collection until the end date, then hides it again (nothing is deleted). You can extend it or mark it Active any time.'),
    ownerIn, emailIn,
    h('p', { class: 'muted small' }, 'With an email, the owner gets an invite to set up their login. To try the restaurant side yourself, use a second address of yours (with Gmail, you+test@gmail.com works).'),
    btn, out));
  })();

  function planLine(r) {
    const p = restaurantPlan(r);
    if (p.trial && p.ended) return h('p', { class: 'note danger' }, `Trial ended ${LONG.format(p.ends)}: the collection is hidden from its staff.`);
    if (p.trial && p.ends) return h('p', { class: 'muted small' }, `Free trial: ${plural(p.daysLeft, 'day')} left (until ${LONG.format(p.ends)}).`);
    if (p.trial) return h('p', { class: 'muted small' }, 'Free trial with no end date.');
    if (p.project) return h('p', { class: 'muted small' }, 'Project client: the team reads its recipes and costing as they are, with no monthly plan. Nothing can be added or changed until they choose a monthly package.');
    return null;
  }

  /** A restaurant's team: who is on it and what each staff member may do with the costing (the owner's to share;
   *  the admin can change it too). Loaded when opened. */
  function teamBox(r) {
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading…'));
    const COST = { none: 'No costing', view: 'Can view costing', edit: 'Can edit costing' };
    const paint = async () => {
      let team;
      try { team = await cloud.restaurantTeam(r.id); } catch (err) { fill(body, h('p', { class: 'muted small' }, `Could not load the team: ${err.message}`)); return; }
      fill(body, team.length ? h('ul', { class: 'asks' }, team.map((p) => {
        const sel = p.member_role === 'owner' ? null : h('select', { 'aria-label': `Costing for ${p.display_name || p.email}` },
          Object.entries(COST).map(([v, t]) => h('option', { value: v, selected: v === p.costing }, t)));
        if (sel) {
          sel.value = p.costing;
          sel.addEventListener('change', async () => { try { await cloud.setMemberCosting(r.id, p.user_id, sel.value); toast('Saved'); } catch (err) { toast(err.message, 4000); sel.value = p.costing; } });
        }
        return h('li', null, h('span', null, h('strong', null, p.display_name || p.email), h('br'), h('span', { class: 'muted small' }, p.email)),
          h('span', { class: 'row' }, p.member_role === 'owner' ? h('span', { class: 'badge' }, 'Owner') : sel,
            p.member_role !== 'owner' && h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${p.display_name || p.email} from ${r.name}`, onclick: async () => {
              if (!await ctx.confirmDialog(`Remove ${p.display_name || p.email} from ${r.name}? Their login stays, as a free account.`, 'Remove', true)) return;
              try { await cloud.removeMember(r.id, p.user_id); toast('Removed'); paint(); } catch (err) { toast(err.message, 4000); }
            } }, ctx.icon('close', { size: 18 }))));
      })) : h('p', { class: 'muted small' }, 'Nobody has joined yet. Invite the owner from Add a restaurant, or from the Invites tab.'),
      h('p', { class: 'muted small' }, 'Owners always see and change the costing and decide it for their staff; new staff start with none.'));
    };
    const box = h('details', { class: 'collection team' }, h('summary', null, 'Team and costing access'), body);
    box.addEventListener('toggle', () => { if (box.open) paint(); }, { once: true });
    return box;
  }

  function collectionBox(r) {
    const recipes = lib.cloud.filter((x) => x.scope === 'restaurant' && x.restaurant_id === r.id)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const add = h('button', { type: 'button', onclick: async () => {
      const pick = await ctx.pickRecipe(`${r.name}’s collection`);
      if (!pick?.id) return;
      add.disabled = true;
      try {
        const missing = await ctx.ensureFull([pick.id]);
        const recipe = lib.byId.get(pick.id);
        if (!recipe || missing?.length) { toast('That recipe needs a connection the first time', 4000); return; }
        if (recipes.some((x) => x.title.toLowerCase() === recipe.title.toLowerCase())
          && !await ctx.confirmDialog(`${r.name} already has a recipe called “${recipe.title}”. Add another copy?`, 'Add it')) return;
        const { id, updated, ...record } = toRecord(recipe);
        // one of the admin's own account recipes: keep the copy linked, so edits can be passed on to it
        const source = recipe.cloud && recipe.row?.scope === 'private' && recipe.row.owner_id === lib.me?.id ? recipe.id : null;
        await cloud.addToCollection(record, r.id, source);
        await ctx.refreshCloud();
        toast(`Added to ${r.name}`);
        paintRestaurants(r.id);
      } catch (err) { toast(err.message, 5000); } finally { add.disabled = false; }
    } }, ctx.icon('plus', { size: 18 }), 'Add a recipe');
    return h('details', { class: 'collection', open: openRest === r.id || null },
      h('summary', null, `Collection: ${plural(recipes.length, 'recipe')}`),
      recipes.length
        ? h('ul', { class: 'asks' }, recipes.map((x) => h('li', null,
          h('a', { href: `#/r/${x.id}` }, x.title, x.owner_id !== lib.me?.id && h('span', { class: 'badge', title: 'Added by the restaurant’s team' }, 'Theirs')),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Take ${x.title} out of ${r.name}’s collection`, onclick: async () => {
            if (!await ctx.confirmDialog(`Take “${x.title}” out of ${r.name}’s collection? Its staff will no longer see it.`, 'Take it out', true)) return;
            try {
              await cloud.deleteRecipe(x.id);
              await ctx.refreshCloud();
              const keep = new Set(lib.cloud.map((y) => y.photo).filter(Boolean));
              if (x.photo && !keep.has(x.photo)) await photos.discard([x.photo]);
              paintRestaurants(r.id);
            } catch (err) { toast(err.message, 4000); }
          } }, ctx.icon('close', { size: 18 })))))
        : h('p', { class: 'muted small' }, 'No recipes yet. Add copies from the library or your own recipes; the restaurant’s copy stays as it is if you change yours later.'),
      add);
  }

  let openRest = null;
  const openCards = new Set();
  function paintRestaurants(keepOpen = openRest) {
    openRest = keepOpen;
    if (keepOpen) openCards.add(keepOpen);
    const rows = restaurants.map((r) => {
      const status = h('select', { 'aria-label': `Subscription for ${r.name}` },
        STATUSES.map((st) => h('option', { value: st, selected: st === r.subscription_status }, STATUS_LABEL[st])));
      status.value = r.subscription_status;
      const seats = h('input', { type: 'number', min: '1', max: '50', value: String(r.seat_limit), 'aria-label': `Logins allowed for ${r.name}`, style: 'width:5rem' });
      const save = async (extra = {}) => {
        const fields = { subscription_status: status.value, seat_limit: Math.max(1, Number(seats.value) || 1), ...extra };
        // a trial with no end date, or one that has ended, gets a fresh 14 days when it is switched on
        if (fields.subscription_status === 'trialing' && !('trial_ends_at' in extra) && (r.subscription_status !== 'trialing' || restaurantPlan(r).ended)) {
          fields.trial_ends_at = trialEnd(14);
        }
        try {
          await cloud.updateRestaurant(r.id, fields); Object.assign(r, fields);
          toast('Saved'); await ctx.refreshCloud(); paintRestaurants(openRest);
        } catch (err) { toast(err.message, 5000); }
      };
      status.addEventListener('change', () => save());
      seats.addEventListener('change', () => save());
      // the package they bought (add_restaurant_packages.sql): sets their costing (only Managed is kept by you) and logins
      const pkgNow = packageOf(r);
      const pkg = h('select', { 'aria-label': `Package for ${r.name}` },
        Object.entries(PACKAGES).map(([k, p]) => h('option', { value: k }, `${p.label} (${p.fee})`)));
      pkg.value = pkgNow;
      pkg.addEventListener('change', async () => {
        const next = PACKAGES[pkg.value];
        const costingChanges = next.costing !== PACKAGES[pkgNow].costing;
        const seatsTo = next.seats || Number(r.seat_limit);
        const ok = await ctx.confirmDialog(`Move ${r.name} to ${next.label} (${next.fee})? `
          + (next.readOnly ? 'Their team keeps reading its recipes and any costing exactly as it is now, with no monthly plan, but can’t add or change anything, and prices aren’t updated. Their plan status no longer hides the recipes. '
            : PACKAGES[pkgNow].readOnly ? 'Their team can add and change recipes again while the plan is active. '
            : '')
          + (pkg.value === 'advisory' ? 'No app fee while their monthly advisory is active: mark their plan Active, and choose another package if the advisory ends. ' : '')
          + (!next.readOnly && costingChanges ? (next.costing === 'managed'
            ? 'You keep their ingredient prices: their logins see the costs and set their target food cost %, menu prices and plates, but can’t change prices or import supplier lists. '
            : 'They keep their own ingredient prices again, and can import supplier price lists. ') : '')
          + `Logins allowed: ${seatsTo}${seatsTo !== Number(r.seat_limit) ? ` (was ${r.seat_limit}; you can change it after)` : ''}.`, 'Change package');
        if (!ok) { pkg.value = pkgNow; return; }
        try {
          await cloud.updateRestaurant(r.id, { package: pkg.value, seat_limit: seatsTo });
          Object.assign(r, { package: pkg.value, costing_tier: next.costing, seat_limit: seatsTo });
          toast(`${r.name}: ${next.label}`); paintRestaurants(openRest);
        } catch (err) {
          toast(/package/.test(err.message) ? 'The database needs supabase/add_restaurant_packages.sql first' : err.message, 5000);
          pkg.value = pkgNow;
        }
      });
      const p = restaurantPlan(r);
      const del = async () => {
        let members = [];
        try { members = await cloud.restaurantMembers(r.id); } catch { /* still ask */ }
        const recipes = lib.cloud.filter((x) => x.scope === 'restaurant' && x.restaurant_id === r.id);
        const msg = `Delete ${r.name}? This deletes its collection (${plural(recipes.length, 'recipe')}) and its invite codes, and ${plural(members.length, 'staff login')} will lose access to the collection. Their accounts stay, as free accounts. This cannot be undone.`;
        if (!await ctx.confirmDialog(msg, 'Delete restaurant', true)) return;
        try { await cloud.deleteRestaurant(r.id); } catch (err) { toast(err.message, 5000); return; }
        toast(`${r.name} deleted`);
        await ctx.refreshCloud();
        const keep = new Set(lib.cloud.map((x) => x.photo).filter(Boolean));
        await photos.discard(recipes.map((x) => x.photo).filter((ph) => ph && !keep.has(ph)));   // collection photos nobody else uses
        viewAdmin(ctx);
      };
      const nRecipes = lib.cloud.filter((x) => x.scope === 'restaurant' && x.restaurant_id === r.id).length;
      const card = h('details', { class: 'card restcard', open: openCards.has(r.id) || restaurants.length === 1 || null },
        h('summary', null, h('strong', null, r.name),
          h('span', { class: `badge${p.read ? '' : ' warn'}` }, planText(r)),
          h('span', { class: 'muted small' }, plural(nRecipes, 'recipe'))),
        h('div', { class: 'stack' },
        h('div', { class: 'row' },
          h('a', { class: 'linkbtn preview', href: `${PORTAL}?preview=${encodeURIComponent(r.id)}`, target: '_blank', rel: 'noopener' }, 'View their portal ↗'),
          h('a', { class: 'linkbtn sheet', href: `${PORTAL}?preview=${encodeURIComponent(r.id)}#kitchen/${encodeURIComponent(r.id)}/sheet`, target: '_blank', rel: 'noopener' }, 'Costing sheet ↗')),
        h('div', { class: 'row' }, h('label', { class: 'row' }, 'Plan', status), h('label', { class: 'row' }, 'Logins', seats)),
        h('div', { class: 'row' }, h('label', { class: 'row' }, 'Package', pkg), h('span', { class: 'muted small' }, PACKAGES[pkgNow].blurb)),
        planLine(r),
        p.trial && h('div', { class: 'row' },
          h('button', { type: 'button', onclick: () => save({ trial_ends_at: trialEnd(14, p.ended || !p.ends ? Date.now() : p.ends.getTime()) }) }, p.ended ? 'Start 14 more days' : 'Add 14 days'),
          h('button', { type: 'button', onclick: () => { status.value = 'active'; save({ trial_ends_at: null }); } }, 'Mark active')),
        collectionBox(r),
        teamBox(r),
        h('div', null, h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete restaurant'))));
      card.addEventListener('toggle', () => { if (card.open) openCards.add(r.id); else openCards.delete(r.id); });
      return card;
    });
    fill(restBox, rows.length ? rows : h('p', { class: 'muted' }, 'No restaurants yet. Add one below.'), addForm);
  }
  paintRestaurants();

  // the page: four tabs, so each job is one screen (#/admin/<tab>, remembered on this device)
  // help messages from restaurants (saved by the portal's Help tab, as well as emailed)
  const inbox = h('div', { class: 'stack inbox' });
  const loadInbox = async () => {
    let rows = [];
    try { rows = await cloud.listHelpMessages(); } catch { fill(inbox); return; }
    const open = rows.filter((x) => x.status === 'open');
    const answered = rows.filter((x) => x.status !== 'open');
    const nameOf = (id) => restaurants.find((x) => x.id === id)?.name || 'A restaurant';
    counts.restaurants = open.length; badges();
    const card = (x) => h('div', { class: `card stack msg ${x.status}` },
      h('div', null, h('strong', null, nameOf(x.restaurant_id)), h('span', { class: 'badge' }, x.topic || 'Help')),
      h('p', { class: 'muted small' }, `${x.author_name || 'Someone'}${x.author_email ? ` · ${x.author_email}` : ''} · ${whenText(x.created_at)}`),
      h('p', { class: 'small', style: 'white-space:pre-wrap' }, x.body),
      h('div', { class: 'row' },
        x.author_email && h('a', { class: 'linkbtn', href: `mailto:${x.author_email}?subject=${encodeURIComponent(`Re: ${x.topic || 'your question'} (${nameOf(x.restaurant_id)})`)}` }, 'Reply by email'),
        h('button', { type: 'button', onclick: async () => {
          try { await cloud.setHelpMessageStatus(x.id, x.status === 'open' ? 'done' : 'open'); loadInbox(); } catch (err) { toast(err.message, 4000); }
        } }, x.status === 'open' ? 'Mark answered' : 'Reopen')));
    fill(inbox, h('h2', null, `Help messages${open.length ? ` (${open.length})` : ''}`),
      open.length ? open.map(card) : h('p', { class: 'muted' }, 'No questions waiting.'),
      answered.length > 0 && h('details', null, h('summary', { class: 'muted small' }, `Answered (${answered.length})`), h('div', { class: 'stack', style: 'margin-top:.6rem' }, answered.slice(0, 50).map(card))));
  };

  const TABS = [['restaurants', 'Restaurants'], ['people', 'People'], ['invites', 'Invites'], ['community', 'Community']];
  const panels = {
    restaurants: [inbox, h('h2', null, 'Restaurants'), restBox,
      h('p', { class: 'muted small', style: 'margin-top:1.4rem' }, 'Until billing is connected, set a restaurant’s plan by hand: Active, or Trial until its end date. Anything else, or a trial that has ended, hides its collection and returns its staff to the free plan. “View their portal” opens the page their team uses on jonesridgekitchen.com; “Costing sheet” opens their ingredient prices, which you can fill in and change for them. The first time, sign in there with this admin account.')],
    people: [people.el],
    invites: [
      requestsHead, requestsEl,
      h('h2', null, 'Invite someone'),
      h('section', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', null, 'Who are you inviting?'), whoSel),
        rRow,
        h('h3', null, 'Email them an invite'),
        h('p', { class: 'muted small' }, 'They get an email with a button. One tap and a password, and they’re in.'),
        emailInviteForm(ctx, who, () => codes.reload()),
        h('h3', null, 'Or share a link / QR code'),
        h('p', { class: 'muted small' }, 'Good for a class: show the QR code on screen and everyone scans it.'),
        h('div', { class: 'row' }, usesRow, linkBtn),
        inviteOut),
      h('details', { class: 'admincodes' }, h('summary', null, h('h2', null, 'Invite codes')), codes.el),
      h('h2', null, 'Sign-up'),
      signupBox],
    community: [h('h2', null, `Waiting for approval${pending.length ? ` (${pending.length})` : ''}`), approvals],
  };
  const fromHash = location.hash.replace(/^#\/?/, '').split('/')[1];
  let saved = '';
  try { saved = sessionStorage.getItem('admin-tab') || ''; } catch { /* private mode */ }
  let tab = [fromHash, saved].find((t) => panels[t]) || 'restaurants';
  const counts = { community: pending.length, invites: 0, restaurants: 0 };
  const tabBtns = TABS.map(([k, label]) => [k, h('button', { type: 'button', role: 'tab', class: 'admintab', id: `admintab-${k}`, 'aria-controls': `adminpanel-${k}`,
    onclick: () => show(k) }, label, h('span', { class: 'count' }))]);
  const panelEls = Object.fromEntries(TABS.map(([k]) => [k, h('div', { role: 'tabpanel', id: `adminpanel-${k}`, 'aria-labelledby': `admintab-${k}`, class: 'adminpanel' }, panels[k])]));
  function badges() {
    for (const [k, b] of tabBtns) { const n = counts[k] || 0; b.querySelector('.count').textContent = n ? String(n) : ''; b.querySelector('.count').hidden = !n; }
  }
  function show(k) {
    tab = k;
    for (const [key, b] of tabBtns) { b.setAttribute('aria-selected', String(key === k)); b.tabIndex = key === k ? 0 : -1; }
    for (const [key, el] of Object.entries(panelEls)) el.hidden = key !== k;
    try { sessionStorage.setItem('admin-tab', k); } catch { /* private mode */ }
    if (location.hash !== `#/admin/${k}`) history.replaceState(history.state, '', `#/admin/${k}`);
  }
  ctx.adminInviteCount = (n) => { counts.invites = n; badges(); };
  const tabBar = h('div', { class: 'admintabs', role: 'tablist', 'aria-label': 'Admin tools', onkeydown: (e) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j][0]); tabBtns[j][1].focus(); }
  } }, tabBtns.map(([, b]) => b));
  badges();
  show(tab);
  loadInbox();
  fill(ctx.$app, ctx.pageHead('Admin tools'), tabBar, Object.values(panelEls));
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ join page (#/join/CODE, from a link or QR code)

export async function viewJoin(ctx, rawCode) {
  const { h, fill, lib } = ctx;
  const code = String(rawCode || '').trim().toUpperCase();
  ctx.setView('settings', 'settings');
  const top = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => ctx.goBack('#/') }, ctx.icon('back')));

  if (cloud.isSignedIn()) {
    fill(ctx.$app, top, h('h1', null, 'You’re already signed in'),
      h('p', { class: 'muted' }, `You’re signed in as ${cloud.currentUser()?.email || 'someone'}. This invite is for someone new. Pass the link on to them.`),
      h('p', null, h('a', { class: 'btnlink primary', href: '#/' }, 'Go to the recipes')));
    return;
  }
  fill(ctx.$app, top, h('h1', null, 'Checking your invite…'));
  let info;
  try { info = await cloud.inviteInfo(code); } catch (err) {
    fill(ctx.$app, top, h('h1', null, 'You’re invited!'),
      h('p', { class: 'note' }, `Could not check the invite right now: ${err.message} You need an internet connection to create an account.`),
      h('button', { type: 'button', onclick: () => viewJoin(ctx, code) }, 'Try again'));
    return;
  }
  if (info.status !== 'active') {
    const why = { 'used up': 'This invite has already been used.', expired: 'This invite has expired.', cancelled: 'This invite was cancelled.' }[info.status]
      || 'This invite link is not valid. Check that the whole link was copied.';
    fill(ctx.$app, top, h('h1', null, 'This invite can’t be used'),
      h('p', { class: 'note' }, `${why} Ask the person who sent it for a new one, or send a request below.`),
      h('section', { class: 'card stack' }, h('strong', null, 'Ask for an invite'), requestInviteForm(ctx, { compact: true })),
      h('p', { class: 'muted small' }, 'Already have an account? ', h('a', { href: '#/settings' }, 'Sign in')));
    return;
  }
  ctx.joinCode = code;
  const where = info.kind === 'restaurant'
    ? `You’ll join ${info.restaurant_name || 'a restaurant'} as ${info.member_role === 'owner' ? 'an owner' : 'staff'}, with its recipe collection.`
    : 'Scale thousands of recipes, keep your own, star favourites on every device and share with the Community.';
  fill(ctx.$app, top,
    h('header', { class: 'hero' }, h('h1', null, 'You’re invited!'), h('p', { class: 'muted' }, `Create your ${APP_NAME} account. ${where}`)),
    accountCard(ctx),
    h('p', { class: 'muted small' }, 'Already have an account? Use Sign in above. Your invite stays for someone else.'));
  void lib;
}
