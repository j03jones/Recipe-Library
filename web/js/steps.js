// Turning a method into steps people can follow at the stove. Most of the built-in recipes (old MealMaster
// archives) keep the whole method in one long paragraph, sometimes in capitals; this breaks it into short
// numbered steps at sentence ends, and finds which ingredients each step uses so their amounts can be shown
// right under it. Nothing is changed in the stored recipe. No DOM here: tests run it in Node.

const ABBREV = /\b(?:approx|tsp|tbsp|tbs|oz|lb|lbs|pt|qt|gal|pkg|pkgs|doz|deg|min|mins|hr|hrs|sec|no|st|ea|vs|etc|e\.g|i\.e|mr|mrs|dr|f|c|fl)\.$/i;
const LONG = 260;   // a line longer than this is split into sentences
const AIM = 180;    // ...which are gathered into steps of about this length

/** Mostly capital letters (an old all-caps recipe)? */
const shouting = (s) => { const letters = s.replace(/[^A-Za-z]/g, ''); return letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7; };

/** "PREHEAT OVEN TO 350 DEG F. MIX WELL." -> "Preheat oven to 350 deg F. Mix well." */
export function sentenceCase(s) {
  return s.toLowerCase()
    .replace(/(^|[.!?]\s+|\(\s*)([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b(\d+)\s*deg(?:rees)?\.?\s*f\b/gi, (_, n) => `${n} deg F`)
    .replace(/\bi\b/g, 'I');
}

function sentences(text) {
  const out = [];
  let cur = '';
  for (const part of text.split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)) {
    cur = cur ? `${cur} ${part}` : part;
    const open = (cur.match(/\(/g) || []).length > (cur.match(/\)/g) || []).length;   // never break inside brackets
    if (!ABBREV.test(cur) && !open) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/** The method as a list of steps: lines as written, with long paragraphs broken at sentence ends. */
export function splitSteps(dir) {
  const lines = String(dir || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const steps = [];
  for (let line of lines) {
    if (shouting(line)) line = sentenceCase(line);
    if (line.length <= LONG) { steps.push(line); continue; }
    // MealMaster marks paragraph breaks inside a line with a lone " . "
    for (const para of line.split(/\s+\.\s+(?=[A-Z(])/).map((p) => p.trim()).filter(Boolean)) {
      let cur = '';
      for (const s of sentences(para)) {
        if (cur && cur.length + s.length > AIM + 60 && cur.length >= AIM * 0.6) { steps.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
      }
      if (cur) steps.push(cur);
    }
  }
  return steps.map((s) => s.replace(/^\d+[.)]\s+/, '').replace(/\s{2,}/g, ' '));
}

// ------------------------------------------------------------------ which ingredients a step uses
const FILLER = new Set(('chopped minced fresh freshly large small medium ground diced sliced thinly thickly softened melted dried dry '
  + 'whole cup cups of and or to taste optional beaten finely coarsely roughly peeled packed light hot cold warm room temperature '
  + 'cut into pieces piece about plus more for the a an each can cans jar package pkg pkgs oz lb lbs tsp tbsp grated shredded '
  + 'crushed divided drained rinsed trimmed cubed halved quartered lightly well firmly extra virgin all purpose all-purpose '
  + 'unsalted salted skinless boneless frozen thawed canned prepared cooked uncooked raw ripe good quality fine coarse kosher sea '
  + 'some few little such as other any your favorite plain regular low-fat lowfat nonfat lite reduced fat free sodium style').split(' '));

/** The words of an ingredient name worth looking for in the method ("Onion, finely chopped" -> ['onion']). */
export function keywords(item) {
  const name = String(item || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[,;]| -- /)[0];
  return [...new Set(name.split(/[^a-z\-]+/).map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length >= 3 && !FILLER.has(w)))];
}

const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(oes|ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

/** Indexes of the ingredients that `step` mentions (by name: "the flour", "2 eggs", "the onions"). */
export function ingredientsIn(step, ings) {
  const words = new Set(String(step).toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem));
  const out = [];
  ings.forEach((ing, i) => {
    const keys = keywords(ing.item);
    if (!keys.length) return;
    // the last word is usually the food itself ("brown sugar" -> sugar); short names need every word
    const head = stem(keys[keys.length - 1]);
    if (words.has(head) || (keys.length > 1 && keys.every((k) => words.has(stem(k))))) out.push(i);
  });
  return out;
}

// ------------------------------------------------------------------ voice commands in cook mode
const COMMANDS = [
  ['next', /\b(next|forward|continue|go on|okay next|done with (this|that))\b/],
  ['back', /\b(back|previous|go back|last step)\b/],
  ['repeat', /\b(repeat|again|say that again|read( it)?|what was that)\b/],
  ['timer', /\b(start (the )?timer|set (a |the )?timer|timer)\b/],
  ['ingredients', /\b(ingredients?|what do i need)\b/],
];
/** What a spoken phrase asks cook mode to do ('next', 'back', 'repeat', 'timer', 'ingredients'), or null.
 *  Only the last few words count, so "...and now next" still means next. */
export function voiceCommand(text) {
  const tail = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).slice(-4).join(' ');
  for (const [cmd, re] of COMMANDS) if (re.test(tail)) return cmd;
  return null;
}
