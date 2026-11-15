// Search that forgives typos: when a word matches nothing, the closest real word from the recipe titles and
// ingredients is tried instead ("choclate" -> "chocolate"), and the app says so. Plus recent searches.
// No DOM here: tests run it in Node.

/** Every word (3+ letters) used in recipe titles and ingredient names, with how often it appears. */
export function vocabulary(recipes) {
  const counts = new Map();
  for (const r of recipes) {
    const text = `${r.title} ${r.ings.map((i) => i.item).join(' ')}`.toLowerCase();
    for (const w of text.split(/[^\p{L}]+/u)) if (w.length >= 3) counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

/** Edit distance between two short words (a swapped pair like "cokie"/"ckoie" counts as one slip),
 *  giving up early once it is past `max`. */
export function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let back2 = null;
  let back1 = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(back1[j] + 1, cur[j - 1] + 1, back1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (back2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], back2[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    back2 = back1; back1 = cur;
  }
  return back1[b.length];
}

/** The closest known word to a misspelled one (most common wins a tie), or '' if nothing is close.
 *  Short words allow one slip, longer ones two. */
export function closest(word, vocab) {
  if (word.length < 4) return '';
  // a word the recipes use is left alone, unless it's a rare slip in them ("chiken") and the usual spelling is far commoner
  const seen = vocab.get(word) || 0;
  if (seen > 3) return '';
  const max = word.length <= 5 ? 1 : 2;
  let best = ''; let bestD = max + 1; let bestN = 0;
  for (const [w, n] of vocab) {
    if (w === word || Math.abs(w.length - word.length) > max || (seen && n < seen * 20)) continue;
    const d = distance(word, w, max);
    if (d < bestD || (d === bestD && n > bestN)) { best = w; bestD = d; bestN = n; }
  }
  return bestD <= max ? best : '';
}

/** A query with its unknown words corrected ("choclate cake" -> "chocolate cake"), or '' if nothing changed. */
export function correct(query, vocab) {
  let changed = false;
  const out = String(query).toLowerCase().split(/\s+/).filter(Boolean).map((w) => {
    const fix = /^[\p{L}]+$/u.test(w) ? closest(w, vocab) : '';
    if (fix) { changed = true; return fix; }
    return w;
  });
  return changed ? out.join(' ') : '';
}

// ------------------------------------------------------------------ recent searches (kept on the device)
const KEY = 'garni.recentSearches';
export function recentSearches() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []; } catch { return []; }
}
export function rememberSearch(q) {
  const s = String(q || '').trim();
  if (s.length < 2) return;
  const list = [s, ...recentSearches().filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, 6);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
export function forgetSearches() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
