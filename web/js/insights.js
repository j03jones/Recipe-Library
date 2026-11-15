// Things worked out from a recipe's own text, for the home feed, filters and recipe pages: about how long it
// takes, whether it looks vegetarian, and a tidy sort key. The built-in recipes come from old
// MealMaster archives that carry none of this, so it is estimated, and the app says so.
// No DOM here: tests run it in Node.

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60, 'a half': 0.5, half: 0.5 };
const NUM = String.raw`\d+(?:\.\d+)?(?:\s+\d/\d)?|\d/\d|` + Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|');
const DURATION = new RegExp(String.raw`\b(${NUM})(?:\s*(?:-|–|to|or)\s*(${NUM}))?\s*(?:more\s+|additional\s+|longer\s+)?(hours?|hrs?|minutes?|mins?)\b`, 'gi');
const LONG_WAITS = [[/\bovernight\b/i, 8 * 60], [/\bseveral hours\b|\bfew hours\b/i, 3 * 60], [/\b(several|a few|2|two) days?\b/i, 24 * 60]];
const HEAT = /\b(bake|baked|baking|roast|simmer|boil|fry|fried|frying|saut[eé]|broil|grill|braise|stew|poach|steam|cook|microwave|toast|heat)\w*/i;

const num = (x) => {
  if (x == null) return null;
  const s = x.toLowerCase().trim();
  if (s in WORDS) return WORDS[s];
  const [whole, frac] = s.split(/\s+/);
  const f = (t) => (t.includes('/') ? t.split('/').reduce((a, b) => a / b) : parseFloat(t));
  return frac ? f(whole) + f(frac) : f(whole);
};

/** Every time span in a piece of text, in minutes (the middle of a range: "10-12 minutes" is 11). */
export function durations(text) {
  const out = [];
  for (const m of String(text || '').matchAll(DURATION)) {
    const lo = num(m[1]); const hi = m[2] ? num(m[2]) : lo;
    if (!(lo > 0)) continue;
    const mins = ((lo + hi) / 2) * (m[3].toLowerCase().startsWith('h') ? 60 : 1);
    if (mins <= 72 * 60) out.push(mins);
  }
  return out;
}

/** About how many minutes a recipe takes from start to finish, or null when the text doesn't say enough
 *  (it bakes or simmers but never says for how long). Hands-on prep is guessed from the ingredient count. */
export function estimateMinutes(r) {
  if (!r || r.stub || r.kind === 'link' || !r.dir) return null;
  const prep = Math.min(30, Math.max(10, Math.round(r.ings.filter((i) => i.item || i.raw).length * 2.5)));
  let wait = durations(r.dir).reduce((a, b) => a + b, 0);
  for (const [re, mins] of LONG_WAITS) if (re.test(r.dir) && wait < mins) wait += mins;
  if (!wait && HEAT.test(r.dir)) return null;
  return Math.round((prep + wait) / 5) * 5;
}

/** "25 min", "1 hr 15 min", "Overnight" for long waits. */
export function formatMinutes(m) {
  if (m == null) return '';
  if (m >= 8 * 60) return m >= 24 * 60 ? 'A day or more' : 'Overnight';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

// ------------------------------------------------------------------ diet, from the ingredient names
const MEAT_GROUPS = new Set(['Meats', 'Beef', 'Pork', 'Poultry', 'Seafood']);
const MEAT = new RegExp(String.raw`\b(beef|steaks?|veal|pork|ham|hams|bacon|spare ?ribs|short ribs|baby back|rib roast|roast|pot roast|pigs?'? (?:feet|knuckles)|knuckles|hocks?|hens?|cornish|poultry|chickens|game|tongue|tripe|kidneys|sweetbreads|oxtails?|mincemeat|herrings?|trouts?|char|crabs|seafood|eel|roe|caviar|lox|kippers?|mackerel|turbot|grouper|pike|carp|smelts?|shad|escargots?|snails|frogs?|conch|langoustines?|venison|bison|elk|sausages?|chorizo|pepperoni|salami|prosciutto|pancetta|chicken|turkey|duck|goose|lamb|mutton|venison|rabbit|livers?|hamburger|chuck|sirloin|tenderloin|brisket|oxtail|giblets|meat|meats|meatballs?|frankfurters?|hot dogs?|bologna|jerky|pheasant|quail|gelatin|gelatine|lard|suet|drippings|\w*fish|fillets?|filets?|salmon|tuna|cod|perch|bass|mahi|flounder|sole|pollock|swordfish|walleye|whitefish|shrimps?|prawns?|crab|crabmeat|lobster|clams?|oysters?|mussels?|scallops?|anchov\w*|sardines?|trout|halibut|tilapia|haddock|catfish|snapper|squid|calamari|octopus|worcestershire|lea & perrins|lea and perrins|chicken broth|beef broth|chicken stock|beef stock|fish sauce|oyster sauce)\b`, 'i');

/** { vegetarian } worked out from the ingredient names, or null when there's nothing to go on. (No vegan label:
 *  in these old recipes dairy and eggs hide inside ready-made products, so it would too often be wrong.) */
export function dietOf(r) {
  if (!r || r.kind === 'link') return null;
  const names = r.ings.map((i) => `${i.item || ''} ${i.raw || ''}`).join(' | ').toLowerCase();
  if (!names.trim().replace(/\|/g, '')) return null;
  // conservative on purpose: anything filed under a meat or fish group, or named for one, is not vegetarian
  const meaty = r.categories.some((c) => MEAT_GROUPS.has(c)) || MEAT.test(r.title) || MEAT.test(names);
  return { vegetarian: !meaty };
}

// ------------------------------------------------------------------ sorting and daily picks
/** Sort key that ignores leading quotes and punctuation, so '"21" Apple Pie' sorts as "21 Apple Pie". */
export const sortKey = (title) => String(title).replace(/["'“”‘’(\[*#.\-–—]+/g, ' ').trim();

/** A number that changes once a day (so the home feed's picks change daily but stay put while you look). */
export function daySeed(date = new Date()) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** `n` items from `list`, in an order fixed by `seed` (the same seed always picks the same items). */
export function pick(list, n, seed) {
  let s = (seed >>> 0) || 1;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// ------------------------------------------------------------------ what's in season (a US kitchen calendar)
const SEASON = [
  ['Winter warmers', ['citrus', 'orange', 'grapefruit', 'cabbage', 'kale', 'leek', 'turnip', 'parsnip', 'potato', 'beans', 'lentil']],      // Jan
  ['Winter warmers', ['citrus', 'orange', 'grapefruit', 'cabbage', 'leek', 'turnip', 'parsnip', 'potato', 'chocolate', 'lentil']],         // Feb
  ['Early spring', ['cabbage', 'leek', 'potato', 'spinach', 'peas', 'green onion', 'citrus', 'lemon']],                                     // Mar
  ['Spring', ['asparagus', 'peas', 'spinach', 'radish', 'rhubarb', 'strawberr', 'green onion', 'lemon']],                                   // Apr
  ['Spring', ['asparagus', 'peas', 'rhubarb', 'strawberr', 'spinach', 'radish', 'mint', 'lettuce']],                                       // May
  ['Early summer', ['strawberr', 'cherr', 'blueberr', 'zucchini', 'peas', 'lettuce', 'basil', 'new potato']],                              // Jun
  ['High summer', ['tomato', 'corn', 'zucchini', 'peach', 'blueberr', 'cucumber', 'basil', 'watermelon', 'green beans']],                  // Jul
  ['High summer', ['tomato', 'corn', 'peach', 'blackberr', 'eggplant', 'pepper', 'zucchini', 'melon', 'okra']],                            // Aug
  ['Harvest', ['apple', 'pear', 'tomato', 'corn', 'pepper', 'eggplant', 'squash', 'grape', 'plum']],                                       // Sep
  ['Fall flavors', ['apple', 'pumpkin', 'squash', 'pear', 'sweet potato', 'cranberr', 'cauliflower', 'brussels']],                       // Oct
  ['Fall flavors', ['pumpkin', 'cranberr', 'sweet potato', 'squash', 'apple', 'pecan', 'pear', 'brussels', 'turkey']],                   // Nov
  ['Holiday baking', ['cranberr', 'gingerbread', 'ginger', 'cinnamon', 'pecan', 'peppermint', 'eggnog', 'orange', 'chestnut']],          // Dec
];

/** This month's heading and the ingredients it looks for ("Fall flavors", ['pumpkin', ...]). */
export function inSeason(date = new Date()) {
  const [title, words] = SEASON[date.getMonth()];
  return { title, words };
}
/** True when the recipe's title or main ingredients use something in `words`. */
export function usesAny(r, words) {
  const hay = `${r.title} ${r.ings.slice(0, 8).map((i) => i.item).join(' ')}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}
