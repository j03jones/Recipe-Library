// Allergens in a dish, suggested from its ingredient names.
//
// The nine allergens are the same list, in the same words, as the intake form on
// jonesridgekitchen.com. detect() is a suggestion for the chef to check, never the last word: it
// reads ingredient names, so it cannot know what is in a bought sauce or stock. The chef confirms
// the list on every meal before a client sees it.
// No DOM access here, so it can be tested in Node.

export const ALLERGENS = ['Peanuts', 'Tree nuts', 'Milk / dairy', 'Eggs', 'Wheat / gluten', 'Soy', 'Fish', 'Shellfish', 'Sesame'];

// Words (or phrases) in an ingredient name that point to an allergen. Matched on whole words,
// with a trailing "s" or "es" allowed.
const SIGNS = {
  Peanuts: ['peanut', 'groundnut', 'goober'],
  'Tree nuts': ['almond', 'pecan', 'walnut', 'cashew', 'pistachio', 'hazelnut', 'filbert', 'macadamia', 'pine nut',
    'brazil nut', 'chestnut', 'praline', 'marzipan', 'amaretto', 'frangelico', 'nutella', 'pesto', 'mixed nuts', 'nuts'],
  'Milk / dairy': ['milk', 'butter', 'buttermilk', 'cheese', 'cream', 'yogurt', 'yoghurt', 'whey', 'ghee', 'half and half',
    'half-and-half', 'custard', 'ricotta', 'mozzarella', 'parmesan', 'cheddar', 'feta', 'mascarpone', 'provolone', 'gruyere',
    'romano', 'brie', 'gouda', 'swiss', 'velveeta', 'creme fraiche', 'evaporated milk', 'condensed milk', 'ice cream',
    'sour cream', 'whipped topping', 'kefir', 'paneer', 'queso', 'alfredo', 'ranch dressing', 'milk chocolate', 'white chocolate'],
  Eggs: ['egg', 'eggs', 'mayonnaise', 'mayo', 'meringue', 'aioli', 'hollandaise', 'egg noodle', 'egg white', 'egg yolk'],
  'Wheat / gluten': ['flour', 'bread', 'breadcrumb', 'bread crumb', 'pasta', 'noodle', 'spaghetti', 'macaroni', 'fettuccine',
    'linguine', 'lasagna', 'penne', 'orzo', 'couscous', 'bulgur', 'semolina', 'cracker', 'tortilla', 'pita', 'bun', 'roll',
    'biscuit', 'crouton', 'panko', 'wheat', 'barley', 'rye', 'farro', 'seitan', 'pie crust', 'puff pastry', 'phyllo',
    'graham cracker', 'cake mix', 'pancake mix', 'bisquick', 'soy sauce', 'teriyaki', 'beer', 'malt', 'roux', 'dumpling',
    'wonton', 'ramen', 'udon', 'baguette', 'stuffing', 'cornbread mix', 'cream of mushroom soup', 'cream of chicken soup'],
  Soy: ['soy', 'soya', 'soybean', 'tofu', 'edamame', 'miso', 'tempeh', 'tamari', 'soy sauce', 'teriyaki', 'hoisin'],
  Fish: ['fish', 'salmon', 'tuna', 'cod', 'catfish', 'anchovy', 'anchovies', 'tilapia', 'trout', 'halibut', 'snapper',
    'sardine', 'mackerel', 'haddock', 'flounder', 'sole', 'swordfish', 'bass', 'grouper', 'mahi', 'herring', 'pollock',
    'fish sauce', 'worcestershire', 'caesar dressing', 'bonito', 'caviar', 'roe'],
  Shellfish: ['shrimp', 'crab', 'crabmeat', 'lobster', 'crawfish', 'crayfish', 'clam', 'oyster', 'mussel', 'scallop',
    'prawn', 'langoustine', 'squid', 'calamari', 'octopus', 'oyster sauce', 'shrimp paste'],
  Sesame: ['sesame', 'tahini', 'hummus', 'benne'],
};

// Names that contain one of the words above without containing the allergen.
const NOT = {
  Peanuts: [],
  'Tree nuts': ['nutmeg', 'butternut', 'water chestnut', 'coconut', 'doughnut', 'donut', 'nut-free', 'nut free'],
  'Milk / dairy': ['coconut milk', 'coconut cream', 'almond milk', 'soy milk', 'oat milk', 'rice milk', 'peanut butter',
    'almond butter', 'cashew butter', 'nut butter', 'apple butter', 'cocoa butter', 'butter bean', 'butter lettuce',
    'butternut', 'cream of tartar', 'creamed corn', 'cream style corn', 'cream-style corn', 'dairy-free', 'dairy free',
    'non-dairy', 'nondairy', 'vegan butter', 'vegan cheese', 'swiss chard', 'sunflower butter', 'shea butter'],
  Eggs: ['eggplant', 'egg-free', 'egg free', 'eggless', 'egg roll wrapper'],
  'Wheat / gluten': ['rice flour', 'corn flour', 'cornflour', 'almond flour', 'coconut flour', 'oat flour', 'chickpea flour',
    'tapioca flour', 'potato flour', 'masa', 'corn tortilla', 'rice noodle', 'rice pasta', 'gluten-free', 'gluten free',
    'buckwheat', 'spring roll', 'egg roll', 'cinnamon roll', 'root beer', 'ginger beer', 'cornbread', 'breadfruit',
    'sweetbread', 'rolled oats', 'jelly roll', 'tootsie roll', 'glass noodle', 'bean thread', 'zucchini noodle', 'shirataki'],
  Soy: ['soy-free', 'soy free'],
  Fish: ['shellfish', 'crawfish', 'crayfish', 'jellyfish', 'starfish', 'goldfish cracker', 'fish-free'],
  Shellfish: ['oyster mushroom', 'oyster cracker', 'shellfish-free'],
  Sesame: [],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (phrase) => new RegExp(`(^|[^a-z])${esc(phrase)}(e?s)?($|[^a-z])`);
const COMPILED = Object.fromEntries(ALLERGENS.map((a) => [a, {
  signs: SIGNS[a].map((p) => [p, wordRe(p)]),
  not: NOT[a].map((p) => wordRe(p)),
}]));

/** Allergens one ingredient name points to: [{ allergen, because }] ('because' is the word that matched). */
export function inIngredient(name) {
  const text = ` ${String(name).toLowerCase().replace(/\s+/g, ' ')} `;
  const out = [];
  for (const a of ALLERGENS) {
    const { signs, not } = COMPILED[a];
    // take out the look-alikes first, so "peanut butter" cannot count as butter
    let rest = text;
    for (const re of not) rest = rest.replace(new RegExp(re.source, 'g'), ' ');
    const hit = signs.find(([, re]) => re.test(rest));
    if (hit) out.push({ allergen: a, because: hit[0] });
  }
  return out;
}

/** Allergens across a list of ingredient names, in the standard order:
 *  [{ allergen, from: [ingredient names that pointed to it] }]. */
export function detect(names) {
  const found = new Map();
  for (const name of names) {
    for (const { allergen } of inIngredient(name)) {
      if (!found.has(allergen)) found.set(allergen, []);
      if (!found.get(allergen).includes(name)) found.get(allergen).push(name);
    }
  }
  return ALLERGENS.filter((a) => found.has(a)).map((a) => ({ allergen: a, from: found.get(a) }));
}

/** A known-allergen list, tidied: only the nine, each once, in the standard order. */
export const clean = (list) => ALLERGENS.filter((a) => (Array.isArray(list) ? list : []).includes(a));

/** The allergens of a dish that a person must avoid. */
export const conflicts = (dishAllergens, personAllergens) => clean(dishAllergens).filter((a) => clean(personAllergens).includes(a));
