// Meal prep clients: the rules behind the client section (no DOM here, so it can be tested in Node).
//
// The plans, prices and wording match the Meal prep page of jonesridgekitchen.com. A "meal" on a
// client's menu is a snapshot made for the client: dish name, description, ingredient names,
// nutrition per serving, allergens and reheating notes. It never carries amounts or the method.
import { Frac, scaleRecipe } from './units.js';
import { itemName } from './shopping.js';
import { costing, nutrition } from './nutrition.js';
import { clean as cleanAllergens, detect } from './allergens.js';
import { MACROS, PLANS, cleanTargets, defaultApproveBy, history, labelFor, menuStatus, nutritionSummary, planOf, tally, warnings } from './clientcore.js';

export { MACROS, PLANS, cleanTargets, defaultApproveBy, history, labelFor, menuStatus, nutritionSummary, planOf, tally, warnings };

const round = (v, step = 1) => Math.round(v / step) * step;

/** How much to multiply a recipe by to make `servings` portions (1 when the recipe has no yield). */
export function factorFor(recipe, servings) {
  if (!recipe.yq || recipe.yq.n <= 0n) return new Frac(1n);
  return Frac.parse(String(servings)).div(recipe.yq);
}

/**
 * What a client is shown for a recipe: no amounts, no method.
 * `servings` is how many portions the client gets. Allergens are a suggestion from the ingredient
 * names for the chef to confirm (see allergens.js).
 */
export function snapshot(recipe, servings) {
  const names = [];
  for (const ing of recipe.ings) {
    const name = itemName(ing.item);
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  const n = nutrition(recipe);
  const per = n.per
    ? { kcal: round(n.per.kcal, 5), protein: round(n.per.protein), carbs: round(n.per.carbs), fat: round(n.per.fat), sodium: round(n.per.sodium, 5) }
    : {};
  return {
    title: recipe.title,
    description: '',
    ingredients: names.slice(0, 60),
    allergens: detect(names).map((d) => d.allergen),
    // how much of the recipe could be counted, so the chef knows how far to trust the numbers
    nutrition: n.per ? { ...per, coverage: Math.round(n.coverage * 100) } : {},
    servings,
  };
}

/** A dish name from its recipes, main first: "Grilled Chicken with Rice Pilaf and Roasted Carrots". */
export function dishTitle(titles) {
  const t = titles.map((x) => String(x || '').trim()).filter(Boolean);
  if (t.length <= 1) return t[0] || '';
  const sides = t.slice(1);
  const list = sides.length === 1 ? sides[0] : `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}`;
  return `${t[0]} with ${list}`.slice(0, 200);
}

/**
 * One dish made of several recipes (main first, then sides, sauces…), each made for the same number of
 * portions. What the client sees is one dish: every ingredient name once, every allergen, and nutrition
 * per serving added up across the parts (a plate of chicken and rice is both). A part without numbers
 * lowers the coverage, so the chef is told the numbers are rough.
 */
export function combine(snaps) {
  if (snaps.length <= 1) return snaps[0];
  const ingredients = [];
  for (const s of snaps) for (const n of s.ingredients) if (!ingredients.some((x) => x.toLowerCase() === n.toLowerCase())) ingredients.push(n);
  const counted = snaps.filter((s) => s.nutrition && s.nutrition.kcal > 0);
  const nutrition = {};
  if (counted.length) {
    for (const key of ['kcal', 'protein', 'carbs', 'fat', 'sodium']) nutrition[key] = counted.reduce((sum, s) => sum + (s.nutrition[key] || 0), 0);
    nutrition.coverage = Math.min(...snaps.map((s) => (s.nutrition && s.nutrition.kcal > 0 ? s.nutrition.coverage ?? 100 : 0)));
  }
  return {
    title: dishTitle(snaps.map((s) => s.title)),
    description: '',
    ingredients: ingredients.slice(0, 60),
    allergens: cleanAllergens(snaps.flatMap((s) => s.allergens)),
    nutrition,
    servings: snaps[0].servings,
  };
}

/**
 * The recipes behind a meal, from its chef-only row: [{ recipe_id, title, factor, grocery_cost }].
 * Meals made before dishes could have several recipes have just the one (titled as the meal).
 */
export function partsOf(meal) {
  const p = meal?.private;
  if (Array.isArray(p?.parts) && p.parts.length) return p.parts;
  return p?.recipe_id ? [{ recipe_id: p.recipe_id, title: meal.title, factor: p.factor || '1', grocery_cost: p.grocery_cost ?? null }] : [];
}

/** The chef-only row for a dish made of these parts: the first is the main recipe; the cost is the total. */
export function privateFor(parts) {
  const priced = parts.filter((x) => x.grocery_cost != null);
  return {
    recipe_id: parts[0]?.recipe_id || '', factor: parts[0]?.factor || '1',
    grocery_cost: priced.length ? Math.round(priced.reduce((sum, x) => sum + Number(x.grocery_cost), 0) * 100) / 100 : null,
    parts: parts.length > 1 ? parts : [],
  };
}

/**
 * One prep sheet for a week: every approved meal across the given menus, the same recipe added up.
 * `menus` are rows with meals[].private and a `client` (name). A dish made of several recipes counts
 * each recipe on its own line. Returns
 *   { dishes: [{ recipeId, title, factor (Frac), portions, clients: [{ name, servings }] }],
 *     waiting: [{ client, title, status }] }   // meals not approved yet
 */
export function prepSheet(menus) {
  const dishes = new Map();
  const waiting = [];
  for (const menu of menus) {
    if (menu.status === 'draft') continue;
    const name = menu.client?.name || 'Client';
    for (const meal of menu.meals || []) {
      if (meal.status !== 'approved') { waiting.push({ client: name, title: meal.title, status: meal.status }); continue; }
      const parts = partsOf(meal);
      for (const part of parts.length ? parts : [{ recipe_id: '', title: meal.title, factor: meal.private?.factor || '1' }]) {
        const recipeId = part.recipe_id || '';
        const title = parts.length > 1 ? part.title : meal.title;
        const key = recipeId || `title:${title.toLowerCase()}`;
        if (!dishes.has(key)) dishes.set(key, { recipeId, title, factor: new Frac(0n), portions: 0, clients: [] });
        const d = dishes.get(key);
        d.factor = d.factor.add(Frac.parse(part.factor || '1') || new Frac(1n));
        d.portions += meal.servings;
        d.clients.push({ name, servings: meal.servings });
      }
    }
  }
  return { dishes: [...dishes.values()].sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1)), waiting };
}

/** Estimated groceries for a meal: the recipe at its scale, costed with the chef's price book. null if nothing is priced. */
export function groceryCost(recipe, factor, prices) {
  const scaled = scaleRecipe(recipe, factor).recipe;
  const c = costing(scaled, prices);
  return c.total > 0 ? { total: Math.round(c.total * 100) / 100, complete: c.complete, missing: c.missing } : null;
}

