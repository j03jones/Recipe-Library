// Meal prep clients: the rules behind the client section (no DOM here, so it can be tested in Node).
//
// The plans, prices and wording match the Meal prep page of jonesridgekitchen.com. A "meal" on a
// client's menu is a snapshot made for the client: dish name, description, ingredient names,
// nutrition per serving, allergens and reheating notes. It never carries amounts or the method.
import { Frac, scaleRecipe } from './units.js';
import { itemName } from './shopping.js';
import { costing, nutrition } from './nutrition.js';
import { detect } from './allergens.js';
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

/**
 * One prep sheet for a week: every approved meal across the given menus, the same recipe added up.
 * `menus` are rows with meals[].private and a `client` (name). Returns
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
      const recipeId = meal.private?.recipe_id || '';
      const key = recipeId || `title:${meal.title.toLowerCase()}`;
      if (!dishes.has(key)) dishes.set(key, { recipeId, title: meal.title, factor: new Frac(0n), portions: 0, clients: [] });
      const d = dishes.get(key);
      d.factor = d.factor.add(Frac.parse(meal.private?.factor || '1') || new Frac(1n));
      d.portions += meal.servings;
      d.clients.push({ name, servings: meal.servings });
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

