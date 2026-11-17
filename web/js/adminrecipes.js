// The admin's recipe collection, the parts with no screen (tested in Node): finding recipes entered twice, saying
// what changed between two versions of a recipe, and the backup file of everyone's recipes.
import { itemKey } from './shopping.js';

/** A title folded for comparing: case, punctuation, "(my version)", "copy", "#2" and leading articles don't count. */
export function normTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/\((?:my|our)\s+version\)|\bcopy\b|#\s*\d+|\b\d+\b/g, ' ')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^\s*(the|a|an)\s+/, '').replace(/\s+/g, ' ').trim();
}

const nameSet = (ings) => new Set((ings || []).map((i) => itemKey(Array.isArray(i) ? i[3] : i?.item || i)).filter(Boolean));
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

/**
 * Groups of recipes that look like the same recipe entered more than once: the same name (folded) with mostly the
 * same ingredients, or different names with nearly all the same ingredients (at least four). A restaurant copy and
 * the recipe it was copied from (`source`) are expected to match and are not reported.
 * items: [{ id, title, ings, source }] -> [[item, item, ...], ...], biggest groups first.
 */
export function findDuplicates(items) {
  const ids = new Set(items.map((x) => x.id));
  const rows = items.filter((x) => !(x.source && ids.has(x.source)))       // a copy of a recipe that is here: expected
    .map((x) => ({ x, t: normTitle(x.title), n: nameSet(x.ings) }));
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const linked = (a, b) => !!a.x.source && a.x.source === b.x.source;      // two copies of the same recipe
  const byTitle = new Map();
  rows.forEach((r, i) => { if (r.t) { if (!byTitle.has(r.t)) byTitle.set(r.t, []); byTitle.get(r.t).push(i); } });
  const join = (i, j) => { if (!linked(rows[i], rows[j])) parent[find(i)] = find(j); };
  for (const idx of byTitle.values()) {
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const [i, j] = [idx[a], idx[b]];
      if (!rows[i].n.size || !rows[j].n.size || overlap(rows[i].n, rows[j].n) >= 0.6) join(i, j);
    }
  }
  // different names, nearly the same ingredients: only worth the comparison for recipes with a few of them
  const big = rows.map((r, i) => i).filter((i) => rows[i].n.size >= 4);
  for (let a = 0; a < big.length; a++) for (let b = a + 1; b < big.length; b++) {
    const [i, j] = [big[a], big[b]];
    if (rows[i].t !== rows[j].t && find(i) !== find(j) && overlap(rows[i].n, rows[j].n) >= 0.9) join(i, j);
  }
  const groups = new Map();
  rows.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.x); });
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title));
}

const ingLine = (i) => (Array.isArray(i) ? [i[0], i[1], i[2], i[3]].filter(Boolean).join(' ') : String(i)).replace(/\s+/g, ' ').trim();
const lines = (dir) => String(dir || '').split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * What changed from version `a` to version `b` of a recipe ({ title, categories, body }), as short sentences:
 * "Renamed from …", "Added: 1 cup corn", "Removed: …", "Method: 2 steps changed", "Makes 8 (was 6)", "Categories …".
 */
export function diffRecipe(a, b) {
  const out = [];
  if ((a.title || '') !== (b.title || '')) out.push(`Renamed from “${a.title}” to “${b.title}”`);
  const ca = (a.categories || []).join(', '), cb = (b.categories || []).join(', ');
  if (ca !== cb) out.push(`Categories: ${cb || 'none'} (was ${ca || 'none'})`);
  const ya = [a.body?.yq, a.body?.yu].filter(Boolean).join(' ') || a.body?.yr || '';
  const yb = [b.body?.yq, b.body?.yu].filter(Boolean).join(' ') || b.body?.yr || '';
  if (ya !== yb) out.push(`Makes ${yb || 'no amount'} (was ${ya || 'no amount'})`);
  const ia = (a.body?.ings || []).map(ingLine), ib = (b.body?.ings || []).map(ingLine);
  const added = ib.filter((x) => !ia.includes(x)), removed = ia.filter((x) => !ib.includes(x));
  if (added.length) out.push(`Added: ${added.slice(0, 4).join('; ')}${added.length > 4 ? ` and ${added.length - 4} more` : ''}`);
  if (removed.length) out.push(`Removed: ${removed.slice(0, 4).join('; ')}${removed.length > 4 ? ` and ${removed.length - 4} more` : ''}`);
  const da = lines(a.body?.dir), db = lines(b.body?.dir);
  const changedSteps = db.filter((x) => !da.includes(x)).length + da.filter((x) => !db.includes(x)).length;
  if (changedSteps) out.push(da.length === db.length ? `Method: ${Math.ceil(changedSteps / 2)} ${Math.ceil(changedSteps / 2) === 1 ? 'step' : 'steps'} reworded`
    : `Method: ${db.length} ${db.length === 1 ? 'step' : 'steps'} (was ${da.length})`);
  const ka = JSON.stringify(a.body?.src || {}), kb = JSON.stringify(b.body?.src || {});
  if (ka !== kb) out.push('Credit changed');
  return out.length ? out : ['Small changes'];
}

/**
 * The backup file of everyone's recipes: each row as the database keeps it, with whose it is and the restaurant
 * named, so it can be read without the database. people: { id: { name, email } }, restaurants: [{ id, name }].
 */
export function backupFile(rows, people = {}, restaurants = [], now = new Date()) {
  const rName = Object.fromEntries(restaurants.map((r) => [r.id, r.name]));
  return {
    app: 'jones-ridge-recipes-backup',
    version: 1,
    exported_at: now.toISOString(),
    count: rows.length,
    recipes: rows.map((r) => ({
      id: r.id, title: r.title, categories: r.categories || [], scope: r.scope, status: r.status,
      owner: { id: r.owner_id, name: people[r.owner_id]?.name || '', email: people[r.owner_id]?.email || '' },
      restaurant: r.restaurant_id ? { id: r.restaurant_id, name: rName[r.restaurant_id] || '' } : null,
      copied_from: r.source_recipe_id || null, author_name: r.author_name || null,
      created_at: r.created_at || null, updated_at: r.updated_at || null, photo: r.photo || null, body: r.body,
    })),
  };
}
