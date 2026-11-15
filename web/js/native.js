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

// ------------------------------------------------------------------ cook mode: reading steps aloud, and voice commands
const lang = () => globalThis.navigator?.language || 'en-US';
export const canSpeak = () => has('TextToSpeech') || !!globalThis.speechSynthesis;
export const canListen = () => has('SpeechRecognition') || !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);

/** Reads `text` aloud (cutting off anything still being read). */
export function speak(text) {
  if (has('TextToSpeech')) { call('TextToSpeech', 'speak', { text, lang: lang(), rate: 1, category: 'playback', queueStrategy: 0 }); return; }
  const synth = globalThis.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang();
  synth.speak(u);
}
export function stopSpeaking() { call('TextToSpeech', 'stop'); globalThis.speechSynthesis?.cancel(); }

/**
 * Listens until stopped, calling onHeard(text) with what was said so far. Call heard() after acting on a
 * command, so the same words aren't acted on twice. Resolves to { stop, heard }, or null when the person
 * said no to the microphone or the device can't do it.
 */
export async function listen(onHeard) {
  if (has('SpeechRecognition')) {
    const p = await call('SpeechRecognition', 'requestPermissions');
    if (p?.speechRecognition && p.speechRecognition !== 'granted') return null;
    let on = true;
    const start = () => on && call('SpeechRecognition', 'start', { language: lang(), maxResults: 3, partialResults: true, popup: false });
    cap().addListener('SpeechRecognition', 'partialResults', (d) => { const t = d?.matches?.[0]; if (on && t) onHeard(t); });
    // the phone stops listening after a pause; start again until cook mode is closed
    cap().addListener('SpeechRecognition', 'listeningState', (d) => { if (on && d?.status === 'stopped') setTimeout(start, 300); });
    start();
    return {
      heard: () => call('SpeechRecognition', 'stop'),            // a fresh session forgets what was said
      stop: () => { on = false; call('SpeechRecognition', 'stop'); call('SpeechRecognition', 'removeAllListeners'); },
    };
  }
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = lang();
  let on = true; let done = -1;
  rec.onresult = (e) => { const i = e.results.length - 1; if (i > done) onHeard(e.results[i][0].transcript); };
  rec.onend = () => { if (on) { try { rec.start(); } catch { /* already starting */ } } };
  let refused = false;
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { refused = true; on = false; } };
  try { rec.start(); } catch { return null; }
  await new Promise((r) => setTimeout(r, 400));
  if (refused) return null;
  return {
    heard: () => { done = Number.MAX_SAFE_INTEGER; setTimeout(() => { done = -1; try { rec.stop(); } catch { /* restarts in onend */ } }, 50); },
    stop: () => { on = false; try { rec.stop(); } catch { /* not running */ } },
  };
}
