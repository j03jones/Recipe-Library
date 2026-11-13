// Companion to tests/test_clients.py: runs web/js/allergens.js and web/js/clients.js on cases given
// as JSON on stdin and prints what they make of them.
import { readFileSync } from 'node:fs';
import { fromRow } from '../web/js/model.js';
import { ALLERGENS, clean, conflicts, detect, inIngredient } from '../web/js/allergens.js';
import * as clients from '../web/js/clients.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const out = { ALLERGENS, plans: clients.PLANS };
out.ingredients = Object.fromEntries(input.names.map((n) => [n, inIngredient(n).map((x) => x.allergen)]));
out.detect = detect(input.dish);
out.clean = clean(input.messy);
out.conflicts = conflicts(input.dishAllergens, input.personAllergens);

const recipes = input.rows.map(fromRow);
out.snapshots = recipes.map((r, n) => clients.snapshot(r, input.servings[n]));
out.factors = recipes.map((r, n) => String(clients.factorFor(r, input.servings[n])));
out.warnings = input.meals.map((m) => clients.warnings(m, input.client));
out.tally = clients.tally(input.meals);
out.status = input.menus.map((m) => clients.menuStatus(m));
out.approveBy = clients.defaultApproveBy('2026-11-16').toString().slice(0, 21);
out.targets = clients.cleanTargets(input.targets);
out.summary = clients.nutritionSummary(input.meals, input.targets);
out.history = clients.history(input.menus).map((d) => [d.title, d.times, d.last, d.rating]);
const sheet = clients.prepSheet(input.menus);
out.prep = { dishes: sheet.dishes.map((d) => [d.title, d.recipeId, String(d.factor), d.portions, d.clients]), waiting: sheet.waiting };
out.labels = [clients.labelFor(input.meals[0], input.client, 'Nov 15'), clients.labelFor(input.meals[1], { ...input.client, plan: 'lean' }, '')];
out.cost = clients.groceryCost(recipes[0], clients.factorFor(recipes[0], 4), input.prices);
process.stdout.write(JSON.stringify(out));
