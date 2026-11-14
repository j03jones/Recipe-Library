// Tiny client for the hosted database (Supabase): sign-in plus the few queries the app needs.
// Plain fetch, no library, so the offline app has nothing extra to cache. Everything here needs a
// connection; callers fall back to their cached copy when it fails.
import { SUPABASE_URL as URL_, SUPABASE_KEY as KEY } from './config.js';

const SESSION_KEY = 'recipelib.session';
let session = null;
const listeners = new Set();

export class CloudError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}

// ------------------------------------------------------------------ session storage
function loadSession() {
  if (session) return session;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
  return session;
}
function setSession(s) {
  session = s;
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  listeners.forEach((fn) => fn(s));
}
export const onSessionChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const currentUser = () => loadSession()?.user || null;
export const isSignedIn = () => !!loadSession();

function fromTokenResponse(t) {
  return {
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: t.expires_at || Math.floor(Date.now() / 1000) + (t.expires_in || 3600),
    user: { id: t.user.id, email: t.user.email },
  };
}

// ------------------------------------------------------------------ low-level calls
async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${URL_}${path}`, {
      method,
      headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CloudError('Could not reach the server. Check your connection.', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `Request failed (${res.status})`;
    throw new CloudError(String(msg), res.status, (data && (data.error_code || data.code)) || '');
  }
  return data;
}

async function freshToken() {
  const s = loadSession();
  if (!s) throw new CloudError('Please sign in.', 401);
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  try {
    const t = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } });
    setSession(fromTokenResponse(t));
    return session.access_token;
  } catch (err) {
    if (err.status === 400 || err.status === 401) setSession(null);   // refresh token no longer valid
    throw err;
  }
}

async function authed(path, opts = {}) {
  return call(path, { ...opts, token: await freshToken() });
}

// ------------------------------------------------------------------ accounts
export async function signIn(email, password) {
  try {
    const t = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    setSession(fromTokenResponse(t));
  } catch (err) {
    if (err.code === 'email_not_confirmed' || /not confirmed/i.test(err.message)) {
      throw new CloudError('Your email is not confirmed yet. Open the link we emailed you, or send it again below.', 400, 'email_not_confirmed');
    }
    if (err.status === 400) throw new CloudError('Wrong email or password.', 400, 'invalid_credentials');
    throw err;
  }
}

/** Creates an account. Returns 'signed-in' or 'confirm-email'. */
export async function signUp({ email, password, displayName, inviteCode, data = {}, redirectTo = '' }) {
  try {
    // redirectTo: where the confirmation link should land (must be on the project's Redirect URLs list)
    const t = await call(`/auth/v1/signup${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`, {
      method: 'POST',
      body: { email, password, data: { ...data, display_name: displayName, ...(inviteCode ? { invite_code: inviteCode } : {}) } },
    });
    if (t && t.access_token) { setSession(fromTokenResponse(t)); return 'signed-in'; }
    return 'confirm-email';
  } catch (err) {
    if (err.status === 422 || err.code === 'user_already_exists') {
      throw new CloudError('That email already has an account. Sign in instead, or use “Forgot password?”.', 422, 'user_already_exists');
    }
    // The database refuses bad or missing invite codes; Supabase reports that as a generic server error.
    if (err.status >= 500 || /database error/i.test(err.message)) {
      throw new CloudError('That invite code is not valid, has been used up, or the restaurant has no free seats.', err.status);
    }
    throw err;
  }
}

export async function signOut() {
  const s = loadSession();
  setSession(null);
  if (s) { try { await call('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch { /* already signed out locally */ } }
}

/** Emails a password-reset link. Always looks successful, so it cannot be used to find out who has an account. */
export async function requestPasswordReset(email) {
  const back = encodeURIComponent(`${location.origin}${location.pathname}`);
  try { await call(`/auth/v1/recover?redirect_to=${back}`, { method: 'POST', body: { email } }); }
  catch (err) { if (err.status === 0 || err.status === 429) throw err; }
}

export async function changePassword(newPassword) {
  await authed('/auth/v1/user', { method: 'PUT', body: { password: newPassword } });
}

/**
 * Handles the link in a confirmation / password-reset / invite email (…#access_token=…&type=invite).
 * Returns the type ('signup', 'recovery', 'invite', …), 'error:<message>' for an expired or used link, or null.
 */
export function takeSessionFromHash(hash = location.hash) {
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
  if (q.get('error_description') || q.get('error_code')) {
    const code = q.get('error_code') || '';
    return `error:${code === 'otp_expired' ? 'That link has expired or was already used.' : (q.get('error_description') || 'That link did not work.').replace(/\+/g, ' ')}`;
  }
  if (!q.get('access_token')) return null;
  const expires = Number(q.get('expires_in') || 3600);
  setSession({
    access_token: q.get('access_token'), refresh_token: q.get('refresh_token'),
    expires_at: Number(q.get('expires_at')) || Math.floor(Date.now() / 1000) + expires,
    user: userFromJwt(q.get('access_token')),
  });
  return q.get('type') || 'signup';
}
function userFromJwt(jwt) {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { id: p.sub, email: p.email };
  } catch { return { id: '', email: '' }; }
}

// ------------------------------------------------------------------ data
const enc = encodeURIComponent;

/** Who am I: profile + restaurant memberships. */
export async function loadMe() {
  const u = currentUser();
  const [profile] = await authed(`/rest/v1/profiles?id=eq.${enc(u.id)}&select=display_name,role,avatar`);
  const memberships = await authed(
    `/rest/v1/restaurant_members?user_id=eq.${enc(u.id)}&select=member_role,restaurant:restaurants(id,name,subscription_status,seat_limit)`);
  return { id: u.id, email: u.email, displayName: profile?.display_name || '', role: profile?.role || 'student', avatar: profile?.avatar || null, memberships };
}

/** Everything this person may see (the database filters by their access). */
export const listRecipes = () => authed('/rest/v1/recipes?select=*&order=title');

/** One restaurant's collection. The database returns it only to members, and only while the plan is active. */
export const restaurantRecipes = (restaurantId) =>
  authed(`/rest/v1/recipes?scope=eq.restaurant&restaurant_id=eq.${enc(restaurantId)}&select=*&order=title`);

const toRow = (r) => ({ title: r.title, categories: r.categories || [], body: bodyOf(r) });
function bodyOf(r) {
  const { id, title, categories, updated, ...rest } = r;   // keep ings, dir, yq, yu, yr, tags
  return rest;
}
export async function createRecipe(record, extra = {}) {
  const u = currentUser();
  const [row] = await authed('/rest/v1/recipes', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: { owner_id: u.id, scope: 'private', ...toRow(record), ...extra },
  });
  return row;
}
export async function updateRecipe(id, record) {
  const [row] = await authed(`/rest/v1/recipes?id=eq.${enc(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: toRow(record),
  });
  if (!row) throw new CloudError('You do not have permission to change that recipe.', 403);
  return row;
}
export const deleteRecipe = (id) => authed(`/rest/v1/recipes?id=eq.${enc(id)}`, { method: 'DELETE' });
export const shareLinkToCommunity = (id) => authed('/rest/v1/rpc/share_link_to_community', { method: 'POST', body: { p_recipe: id } });
export const submitToCommunity = (id) => authed('/rest/v1/rpc/submit_to_community', { method: 'POST', body: { p_recipe: id, p_confirm: true } });

// per-person data that follows them between devices
export async function loadUserData() {
  const u = currentUser();
  const [row] = await authed(`/rest/v1/user_data?user_id=eq.${enc(u.id)}&select=stars,library_photos,updated_at`);
  return row || null;
}
// meal plan and shopping list: one document, asked for on its own so that a project which has not
// run supabase/add_planner.sql yet still syncs stars and photos
export async function loadPlanner() {
  const [row] = await authed(`/rest/v1/user_data?user_id=eq.${enc(currentUser().id)}&select=planner`);
  return row ? row.planner : null;
}
export async function savePlanner(doc) {
  await authed('/rest/v1/user_data', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { user_id: currentUser().id, planner: doc },
  });
}
export async function saveLibraryPhotos(map) {
  await authed('/rest/v1/user_data', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { user_id: currentUser().id, library_photos: map },
  });
}
export async function saveStars(ids) {
  const [row] = await authed('/rest/v1/user_data', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: { user_id: currentUser().id, stars: ids },
  });
  return row;
}

// admin
export const reviewRecipe = (id, approve, note) => authed(`/rest/v1/recipes?id=eq.${enc(id)}`, {
  method: 'PATCH', body: { status: approve ? 'approved' : 'declined', review_note: note || null } });
export const listRestaurants = () => authed('/rest/v1/restaurants?select=*&order=name');
export const createRestaurant = (name, seatLimit = 3) => authed('/rest/v1/restaurants', {
  method: 'POST', headers: { Prefer: 'return=representation' }, body: { name, seat_limit: seatLimit } });
export async function deleteRestaurant(id) {
  const rows = await authed(`/rest/v1/restaurants?id=eq.${enc(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!rows || !rows.length) throw new CloudError('That restaurant could not be deleted. Only the admin can delete restaurants.', 403);
}
export const restaurantMembers = (id) => authed(`/rest/v1/restaurant_members?restaurant_id=eq.${enc(id)}&select=user_id,member_role`);
export const updateRestaurant = (id, fields) => authed(`/rest/v1/restaurants?id=eq.${enc(id)}`, { method: 'PATCH', body: fields });
export const createInvite = (kind, restaurantId = null, memberRole = 'staff', maxUses = 1, days = 14) =>
  authed('/rest/v1/rpc/create_invite', { method: 'POST', body: { p_kind: kind, p_restaurant: restaurantId, p_member_role: memberRole, p_max_uses: maxUses, p_days: days } });
export const removeMember = (restaurantId, userId) =>
  authed('/rest/v1/rpc/remove_member', { method: 'POST', body: { p_restaurant: restaurantId, p_user: userId } });
export const listInvites = () => authed('/rest/v1/rpc/admin_list_invites', { method: 'POST', body: {} });
export const cancelInvite = (code) => authed('/rest/v1/rpc/cancel_invite', { method: 'POST', body: { p_code: code } });
export const listPeople = () => authed('/rest/v1/rpc/admin_list_people', { method: 'POST', body: {} });
export const removePerson = (userId) => authed('/rest/v1/rpc/admin_remove_person', { method: 'POST', body: { p_user: userId } });

// ------------------------------------------------------------------ photos (Storage bucket "photos")
// Paths look like recipes/<person id>/<random>.jpg; the database decides who may read or write them.
export async function setRecipePhoto(id, path) {
  const rows = await authed(`/rest/v1/recipes?id=eq.${enc(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { photo: path } });
  if (!rows || !rows.length) throw new CloudError('You do not have permission to change that recipe.', 403);
}
export const setAvatar = (path) => authed(`/rest/v1/profiles?id=eq.${enc(currentUser().id)}`, { method: 'PATCH', body: { avatar: path } });
export const communityAvatars = () => authed('/rest/v1/rpc/community_avatars', { method: 'POST', body: {} });
export const listAvatars = () => authed('/rest/v1/profiles?select=id,avatar&avatar=not.is.null');

async function storage(path, { method = 'GET', body, type } = {}) {
  const token = await freshToken();
  let res;
  try {
    res = await fetch(`${URL_}/storage/v1/${path}`, {
      method, body,
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, ...(type ? { 'Content-Type': type } : {}) },
    });
  } catch {
    throw new CloudError('Could not reach the server. Check your connection.', 0);
  }
  if (!res.ok) {
    let msg = `Photo request failed (${res.status})`;
    try { const d = await res.json(); msg = d.message || d.error || msg; } catch { /* not JSON */ }
    throw new CloudError(String(msg), res.status);
  }
  return res;
}
const encPath = (p) => p.split('/').map(enc).join('/');
export async function uploadPhoto(path, blob) {
  await storage(`object/photos/${encPath(path)}`, { method: 'POST', body: blob, type: blob.type || 'image/jpeg' });
  return path;
}
export async function downloadPhoto(path) {
  return (await storage(`object/authenticated/photos/${encPath(path)}`)).blob();
}
export async function removePhotos(paths) {
  if (!paths.length) return;
  await storage('object/photos', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }), type: 'application/json' });
}
/** File names directly inside a folder such as "library/<id>". */
export async function listPhotos(folder) {
  const res = await storage('object/list/photos', {
    method: 'POST', type: 'application/json', body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 }),
  });
  return (await res.json()).filter((f) => f.id).map((f) => `${folder}/${f.name}`);
}

// ------------------------------------------------------------------ import from a web page
// The phone can't read other websites directly (browsers block it), so the import-recipe edge function
// fetches the one page the person chose and returns only its schema.org Recipe block. Signed-in users only.
export async function fetchRecipePage(url) {
  return authed('/functions/v1/import-recipe', { method: 'POST', body: { url } });
}

// ------------------------------------------------------------------ invites
/** The link someone opens (or scans as a QR code) to join with an invite code. */
export const inviteLink = (code) => `${location.origin}${location.pathname}#/join/${encodeURIComponent(code)}`;
/** Whether an invite code still works, and what it is for. Works without signing in. */
export async function inviteInfo(code) {
  const rows = await call('/rest/v1/rpc/invite_info', { method: 'POST', body: { p_code: code } });
  return (Array.isArray(rows) ? rows[0] : rows) || { status: 'not found' };
}
/** Ask the admin for an invite. Works without signing in. */
export async function requestInvite({ name, email, about, note }) {
  try {   // saves the request and emails the admin (the request-invite edge function)
    return await call('/functions/v1/request-invite', { method: 'POST', body: { name, email, about, note: note || '' } });
  } catch (err) {
    if (err.status !== 404) throw err;   // function not deployed yet: just save the request
    return call('/rest/v1/rpc/request_invite', { method: 'POST', body: { p_name: name, p_email: email, p_about: about, p_note: note || '' } });
  }
}
/** Can people create an account without an invite code right now? Works without signing in. */
export const signupOpen = async () => (await call('/rest/v1/rpc/signup_open', { method: 'POST', body: {} })) === true;
/** Admin only: switch open sign-up on or off. */
export const setSignupOpen = (open) => authed('/rest/v1/app_settings?id=eq.true', { method: 'PATCH', body: { open_signup: !!open } });
/** Email someone a one-person invite (the send-invite edge function; Supabase sends the email). */
export const sendInvite = ({ email, name, kind = 'student', restaurantId = null, memberRole = 'staff', requestId = null }) =>
  authed('/functions/v1/send-invite', { method: 'POST', body: {
    email, name, kind, restaurant_id: restaurantId, member_role: memberRole, request_id: requestId,
    app_url: `${location.origin}${location.pathname}`,
  } });
export const listInviteRequests = () => authed('/rest/v1/invite_requests?status=eq.waiting&order=created_at.desc&select=*');
export const dismissInviteRequest = (id) => authed(`/rest/v1/invite_requests?id=eq.${enc(id)}`, {
  method: 'PATCH', body: { status: 'dismissed', handled_at: new Date().toISOString() } });
/** Send the "confirm your email" message again. Always looks successful. */
export async function resendConfirmation(email) {
  const back = encodeURIComponent(`${location.origin}${location.pathname}`);
  try { await call(`/auth/v1/resend?redirect_to=${back}`, { method: 'POST', body: { type: 'signup', email } }); }
  catch (err) { if (err.status === 0 || err.status === 429) throw err; }
}


// ------------------------------------------------------------------ meal prep clients (supabase/add_clients.sql)
// The chef (admin) reads and writes everything; a client reads their own record and menus and answers
// through the functions, which change only what a client may change.
const rpc = (name, body = {}) => authed(`/rest/v1/rpc/${name}`, { method: 'POST', body });
const one = { Prefer: 'return=representation' };

/** Link this login to the client record made for its email address; then the client record(s) it has. */
export async function myClients() {
  try { await rpc('claim_client'); } catch (err) { if (err.status === 0) throw err; }   // older database: no client section yet
  return authed(`/rest/v1/clients?user_id=eq.${enc(currentUser().id)}&select=*&order=created_at`);
}

// ---- chef side
export const listClients = () => authed('/rest/v1/clients?select=*,notes:client_notes(notes)&order=name');
export async function saveClient(client) {
  const { id, notes, ...fields } = client;
  const [row] = id
    ? await authed(`/rest/v1/clients?id=eq.${enc(id)}`, { method: 'PATCH', headers: one, body: fields })
    : await authed('/rest/v1/clients', { method: 'POST', headers: one, body: { ...fields, chef_id: currentUser().id } });
  if (notes !== undefined) {
    await authed('/rest/v1/client_notes', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { client_id: row.id, notes: notes || '' } });
  }
  return row;
}
export const deleteClient = (id) => authed(`/rest/v1/clients?id=eq.${enc(id)}`, { method: 'DELETE' });

const MENU_SELECT = 'select=*,meals:client_meals(*,private:client_meal_private(*))';   // * so a database without parts (add_meal_parts.sql) still loads
/** A client's menus, newest week first, each with its meals in order. */
export async function listMenus(clientId) {
  const rows = await authed(`/rest/v1/client_menus?client_id=eq.${enc(clientId)}&${MENU_SELECT}&order=week_start.desc`);
  for (const m of rows) m.meals.sort((a, b) => a.position - b.position);
  return rows;
}
/** Every client's menu for one week (the prep sheet). */
export async function listMenusForWeek(weekStart) {
  const rows = await authed(`/rest/v1/client_menus?week_start=eq.${enc(weekStart)}&${MENU_SELECT}`);
  for (const m of rows) m.meals.sort((a, b) => a.position - b.position);
  return rows;
}
export async function createMenu(clientId, weekStart, fields = {}) {
  const [row] = await authed('/rest/v1/client_menus', { method: 'POST', headers: one, body: { client_id: clientId, week_start: weekStart, ...fields } });
  return { ...row, meals: [] };
}
export const updateMenu = (id, fields) => authed(`/rest/v1/client_menus?id=eq.${enc(id)}`, { method: 'PATCH', body: fields });
export const deleteMenu = (id) => authed(`/rest/v1/client_menus?id=eq.${enc(id)}`, { method: 'DELETE' });

/** Add a meal (the snapshot the client sees) with the chef-only link to its recipe(s). */
export async function addMeal(menuId, meal, priv) {
  const p = { recipe_id: priv.recipe_id || '', factor: priv.factor || '1', grocery_cost: priv.grocery_cost ?? null,
    ...(priv.parts?.length ? { parts: priv.parts } : {}) };    // only sent when there are several, so older databases still work
  const [row] = await authed('/rest/v1/client_meals', { method: 'POST', headers: one, body: { menu_id: menuId, ...meal } });
  try {
    await authed('/rest/v1/client_meal_private', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { meal_id: row.id, ...p } });
  } catch (err) {
    await authed(`/rest/v1/client_meals?id=eq.${enc(row.id)}`, { method: 'DELETE' }).catch(() => {});
    throw partsError(err);
  }
  return { ...row, private: p };
}
/** The database has no parts column yet: say which file adds it. */
export const partsError = (err) => (/parts/.test(err.message) && err.status >= 400
  ? new CloudError('Dishes with more than one recipe need a database update: run supabase/add_meal_parts.sql in Supabase > SQL Editor.', err.status) : err);
export const updateMeal = (id, fields) => authed(`/rest/v1/client_meals?id=eq.${enc(id)}`, { method: 'PATCH', body: fields });
export const updateMealPrivate = (id, fields) => authed(`/rest/v1/client_meal_private?meal_id=eq.${enc(id)}`, { method: 'PATCH', body: fields })
  .catch((err) => { throw partsError(err); });
export const deleteMeal = (id) => authed(`/rest/v1/client_meals?id=eq.${enc(id)}`, { method: 'DELETE' });

export const listRequests = (clientId) =>
  authed(`/rest/v1/client_requests?${clientId ? `client_id=eq.${enc(clientId)}&` : ''}select=*&order=created_at.desc`);
export const updateRequest = (id, status) => authed(`/rest/v1/client_requests?id=eq.${enc(id)}`, { method: 'PATCH', body: { status } });
export const listFavorites = (clientId) => authed(`/rest/v1/client_favorites?client_id=eq.${enc(clientId)}&select=dish,title&order=title`);

export const listTemplates = () => authed('/rest/v1/client_menu_templates?select=*&order=name');
export const saveTemplate = (name, meals) => authed('/rest/v1/client_menu_templates', { method: 'POST', headers: one, body: { chef_id: currentUser().id, name, meals } });
export const deleteTemplate = (id) => authed(`/rest/v1/client_menu_templates?id=eq.${enc(id)}`, { method: 'DELETE' });

// ---- client side
/** The signed-in client's own menus (only sent or closed ones come back), newest first. */
export async function myMenus(clientId) {
  const rows = await authed(`/rest/v1/client_menus?client_id=eq.${enc(clientId)}&select=*,meals:client_meals(*)&order=week_start.desc`);
  for (const m of rows) m.meals.sort((a, b) => a.position - b.position);
  return rows;
}
export const respondToMeal = (mealId, approve, note = '') => rpc('respond_to_meal', { p_meal: mealId, p_approve: approve, p_note: note });
export const rateMeal = (mealId, rating, feedback = '') => rpc('rate_meal', { p_meal: mealId, p_rating: rating, p_feedback: feedback });
export const setFavorite = (clientId, title, on) => rpc('set_favorite', { p_client: clientId, p_title: title, p_on: on });
export const requestMeal = (clientId, title, note = '') => rpc('request_meal', { p_client: clientId, p_title: title, p_note: note });
export const updateMyPreferences = (clientId, allergens, allergyNotes, dislikes) =>
  rpc('update_my_preferences', { p_client: clientId, p_allergens: allergens, p_allergy_notes: allergyNotes, p_dislikes: dislikes });
