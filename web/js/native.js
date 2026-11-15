// The phone apps' native features (Capacitor plugins: Haptics, LocalNotifications, Share, StatusBar, App).
// The web app has no bundler, so this talks to the native bridge directly
// (window.Capacitor.nativePromise(plugin, method, options)). On the web every function quietly does
// nothing (or reports false), so callers never need to check where they are running.

const cap = () => globalThis.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();
const has = (name) => isNative() && (cap().PluginHeaders || []).some((p) => p.name === name);

function call(plugin, method, options = {}) {
  if (!has(plugin)) return Promise.resolve(undefined);
  try { return cap().nativePromise(plugin, method, options).catch(() => undefined); } catch { return Promise.resolve(undefined); }
}

// ------------------------------------------------------------------ haptics
/** A tap you can feel: 'light' (ticks, toggles), 'medium' (stars, steps), 'heavy'; or 'success' / 'warning'. */
export function haptic(kind = 'light') {
  if (!has('Haptics')) return false;
  if (kind === 'success' || kind === 'warning' || kind === 'error') call('Haptics', 'notification', { type: kind.toUpperCase() });
  else call('Haptics', 'impact', { style: kind.toUpperCase() });
  return true;
}

// ------------------------------------------------------------------ timer alerts that ring with the phone locked
const nid = (key) => { let x = 7; for (const c of String(key)) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x) % 2000000000; };
let asked = false;

/** Schedules a notification for `at` (ms). Asks for permission the first time; false if it can't. */
export async function scheduleAlert(key, at, title, body) {
  if (!has('LocalNotifications')) return false;
  if (!asked) {
    asked = true;
    const p = await call('LocalNotifications', 'checkPermissions');
    if (p?.display !== 'granted') await call('LocalNotifications', 'requestPermissions');
  }
  await call('LocalNotifications', 'schedule', { notifications: [{
    id: nid(key), title, body, schedule: { at: new Date(at).toISOString(), allowWhileIdle: true },
  }] });
  return true;
}
export function cancelAlert(key) { return call('LocalNotifications', 'cancel', { notifications: [{ id: nid(key) }] }); }

// ------------------------------------------------------------------ share sheet
/** The phone's own share sheet (the web share sheet where it exists). Resolves false if neither is available. */
export async function share({ title, text, url }) {
  if (has('Share')) { await call('Share', 'share', { title, text, url, dialogTitle: title }); return true; }
  if (globalThis.navigator?.share) { try { await navigator.share({ title, text, url }); } catch { /* cancelled */ } return true; }
  return false;
}
export const canShare = () => has('Share') || !!globalThis.navigator?.share;

// ------------------------------------------------------------------ status bar and the Android back button
/** Matches the status bar to the page: dark text on the light theme, light text on the dark one. */
export function syncStatusBar() {
  if (!has('StatusBar')) return;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const paint = () => {
    const dark = mq.matches;
    call('StatusBar', 'setStyle', { style: dark ? 'DARK' : 'LIGHT' });
    call('StatusBar', 'setBackgroundColor', { color: dark ? '#15251c' : '#dff3e6' });   // the page-header wash
  };
  paint();
  mq.addEventListener?.('change', paint);
}

/** Android's back button goes back a page (and leaves the app from the home page) instead of closing it. */
export function handleBackButton(goBack) {
  if (!has('App')) return;
  cap().addListener('App', 'backButton', (e) => {
    if (location.hash && location.hash !== '#/' && (e?.canGoBack ?? true)) goBack();
    else call('App', 'exitApp');
  });
}
