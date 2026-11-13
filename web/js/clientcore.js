// Meal prep clients: the rules that both the chef's screens (clients.js, in the recipe app) and the
// client's own page on jonesridgekitchen.com (portal/portal.js) need. No DOM and nothing from the
// recipe library, so the client's page stays small. Tested in Node (tests/test_clients.py).
import { clean as cleanAllergens, conflicts } from './allergens.js';

/** The meal prep plans, as on the website. `fee` is the weekly service fee; groceries are billed at cost. */
export const PLANS = {
  family: { label: 'Family Table', entrees: 5, servings: 4, fee: 240, blurb: '5 entrées, 4 servings each' },
  couple: { label: 'Couple', entrees: 5, servings: 2, fee: 185, blurb: '5 entrées, 2 servings each' },
  lean: { label: 'Lean & Fresh', entrees: 10, servings: 1, fee: 175, blurb: '10 single meals with protein, carbs and fat labeled', macros: true },
  custom: { label: 'Custom', entrees: 5, servings: 2, fee: 0, blurb: 'Your own number of dishes and servings' },
};
export const planOf = (client) => PLANS[client?.plan] || PLANS.custom;

export const MACROS = [['kcal', 'Calories', ''], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g']];

/** Daily targets, tidied: positive whole numbers only. */
export function cleanTargets(t) {
  const out = {};
  for (const [key] of MACROS) {
    const v = Number(t?.[key]);
    if (Number.isFinite(v) && v > 0 && v < 20000) out[key] = Math.round(v);
  }
  return out;
}

/** Why a meal needs a second look for this client: allergens they avoid, and disliked foods named in it. */
export function warnings(meal, client) {
  const out = [];
  const hit = conflicts(meal.allergens, client.allergens);
  if (hit.length) out.push({ kind: 'allergen', text: `Contains ${hit.join(', ')}`, allergens: hit });
  const avoid = String(client.dislikes || '').toLowerCase().split(/[,;\n]| and /).map((s) => s.replace(/^\s*(no|not|avoid|hates?|dislikes?)\s+/, '').trim()).filter((s) => s.length >= 3);
  const text = [meal.title, ...(meal.ingredients || [])].join(' | ').toLowerCase();
  const named = avoid.filter((a) => text.includes(a.replace(/s$/, '')));
  if (named.length) out.push({ kind: 'dislike', text: `Has ${named.join(', ')} (on their avoid list)`, foods: named });
  return out;
}

/** Counts of answers on a menu. */
export function tally(meals) {
  const t = { total: meals.length, approved: 0, swap: 0, proposed: 0 };
  for (const m of meals) t[m.status === 'approved' ? 'approved' : m.status === 'swap' ? 'swap' : 'proposed']++;
  return t;
}

/** One line about where a menu stands, for lists. */
export function menuStatus(menu) {
  if (menu.status === 'draft') return 'Draft: not sent yet';
  const t = tally(menu.meals || []);
  if (!t.total) return 'No meals yet';
  if (menu.status === 'closed') return `Finished: ${t.approved} of ${t.total} approved`;
  if (t.proposed === t.total) return 'Sent: waiting for an answer';
  if (t.proposed === 0 && t.swap === 0) return 'All approved';
  return [t.approved && `${t.approved} approved`, t.swap && `${t.swap} to swap`, t.proposed && `${t.proposed} unanswered`].filter(Boolean).join(', ');
}

/** "Approve the week's menu each Sunday": 6 pm on the Sunday before the week starts (weekStart is a Monday, 'YYYY-MM-DD'). */
export function defaultApproveBy(weekStart) {
  const [y, m, d] = weekStart.split('-').map(Number);
  return new Date(y, m - 1, d - 1, 18, 0, 0);
}

/** Average nutrition per serving across the meals that have numbers, and how that sits against daily targets. */
export function nutritionSummary(meals, targets = {}) {
  const withNumbers = meals.filter((m) => m.nutrition && m.nutrition.kcal > 0);
  if (!withNumbers.length) return null;
  const avg = {};
  for (const [key] of MACROS) avg[key] = Math.round(withNumbers.reduce((s, m) => s + (m.nutrition[key] || 0), 0) / withNumbers.length);
  const t = cleanTargets(targets);
  const share = {};
  for (const [key] of MACROS) if (t[key]) share[key] = Math.round((avg[key] / t[key]) * 100);
  return { avg, share, counted: withNumbers.length, of: meals.length };
}

/** Every dish a client has had, most recent first, with how often and how they rated it. */
export function history(menus) {
  const dishes = new Map();
  for (const menu of [...menus].sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0))) {
    for (const meal of menu.meals || []) {
      if (meal.status === 'swap') continue;               // asked for something else instead
      const key = meal.title.trim().toLowerCase();
      if (!dishes.has(key)) dishes.set(key, { key, title: meal.title, times: 0, last: menu.week_start, ratings: [], meal });
      const d = dishes.get(key);
      d.times++;
      if (meal.rating) d.ratings.push(meal.rating);
    }
  }
  return [...dishes.values()].map((d) => ({
    ...d, rating: d.ratings.length ? Math.round((d.ratings.reduce((a, b) => a + b, 0) / d.ratings.length) * 10) / 10 : null,
  }));
}

/** What a container label says: dish, client, date made, use-by, reheating, allergens, and macros on plans that label them. */
export function labelFor(meal, client, madeOn) {
  const lines = [];
  if (meal.reheat) lines.push(`Reheat: ${meal.reheat}`);
  if (meal.storage) lines.push(`Keep: ${meal.storage}`);
  const a = cleanAllergens(meal.allergens);
  const macros = planOf(client).macros && meal.nutrition?.kcal
    ? `${meal.nutrition.kcal} cal · ${meal.nutrition.protein || 0}g protein · ${meal.nutrition.carbs || 0}g carbs · ${meal.nutrition.fat || 0}g fat`
    : '';
  return {
    title: meal.title, client: client.name, made: madeOn || '', useBy: meal.use_by || '',
    lines, allergens: a.length ? `Contains: ${a.join(', ')}` : 'No major allergens listed', macros,
  };
}
