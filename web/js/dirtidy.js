// Tidying the method of the built-in library recipes for reading. Many came from 1990s mailing lists and TV
// show archives, so they carry sign-offs ("Posted by ...", "Typed for you by ..."), converter stamps
// ("Converted by MMCONV"), show tags ("ESSENCE OF EMERIL SHOW#EE61"), separator lines, nutrition and yield
// lines Garni shows elsewhere, emails, whole recipes in CAPITALS and "500 DEG F". This takes those out and
// keeps the "Source: ..." credit for a small line at the end. Display only: the recipe itself is unchanged.
// Pure functions (tested in Node).

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', deg: '°', frac12: '½', frac14: '¼', frac34: '¾' };
const decode = (s) => s.replace(/&(#\d+|[a-z]+\d*);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

// paragraphs that are nothing but bookkeeping
const DROP = [
  /^(posted|typed|formatted|converted|brought to you|contributed|submitted|shared|uploaded|entered|transcribed|scanned)( (for you|to the [\w -]+))? by\b/i,
  /^(contributed to|courtesy of|recipe (posted|courtesy)|downloaded from|from the [\w' -]+ (bbs|list|mailing list|echo))/i,
  /^(meal-?master|m{4,}|mm[- ]?conv|mc formatted|exported from|-+ ?recipe via)/i,
  /^(keywords|categories|category|prep(aration)? time|cook(ing)? time|total time|difficulty|ready in)\s*:/i,
  /^(yield|yields|servings|serves|makes)\b:?\s*(about |approx\.? |approximately |up to )?\d/i,   // not "Makes a great gift."
  /\b(SUBJECT|TOPIC|TO|FROM|DATE):\s/,                                // forum message headers, in capitals
  /^(per serving|nutritional? (information|info|analysis|facts)|nutrition (per|facts)|calories per|food exchanges?|exchanges? per|each serving)/i,
  /^:/,                                                            // ": Copyright (c) ...", ": Difficulty: easy."
  /^copyright\b|^\(c\)\s|©/i,
  /^(directions|method|instructions|preparation|procedure):?$/i,
  /(essence of emeril|emeril live|too hot tamales|cooking live|chef du jour|molto mario|taste show|in julia's kitchen|cooking monday to friday|food network|tv food)/i,
  /\bshow\s*#\s*[\w-]+\.?$/i,
  /^[^\p{L}]*$/u,                                                  // only marks and numbers ("*-*-*", "1.")
];
const CREDIT = /^(source|from|adapted from|recipe from|recipe by|chef|by|origin|credit|reprinted from|from an article)\b:?\s*/i;
// ...and the same sign-offs at the end of a paragraph of real text
const TAIL = /\s*\b(typed (for you )?by|posted (to [\w -]+ )?by|converted by|formatted by|brought to you by|downloaded from|recipe by:)\b.*$/i;
// the bookkeeping after a credit: "Reprinted with permission ... Electronic format courtesy of Karen"
const CREDIT_TAIL = /\s*\b(reprinted|electronic format|courtesy of|typed|posted|converted|formatted|shared by|submitted by)\b.*$/i;
// a forum message stamp and everything after it: "01/02/92 9:51 AM FOOD AND WINE CLUB TOPIC: ..."
const STAMP = /\s*\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s*[AP]M\b.*$/;
const cleanCredit = (c) => c.replace(CREDIT_TAIL, '').replace(TAIL, '').replace(STAMP, '').replace(/[;,.:\s]+$/, '').trim();
const goodCredit = (c) => c.length > 3 && !/^(source|from|by|chef)[:\s]*$/i.test(c) && !/\b(SUBJECT|TOPIC):|\([A-Z0-9]{6,}\)/.test(c);

/** "COOK GROUND ROUND AND DRAIN. RINSE BEEF." -> "Cook ground round and drain. Rinse beef." */
export function unshout(p) {
  const letters = p.replace(/[^A-Za-z]/g, '');
  if (letters.length < 12 || /[a-z]/.test(p.replace(/\b\d+[a-z]{1,3}\b/g, ''))) return p;   // "22g" doesn't count as lower case
  return p.toLowerCase()
    // a capital after a full stop, but not after "oz." or "tsp." ("Spread 6 oz. cheese")
    .replace(/(^|(?<!\b(?:oz|lb|lbs|tsp|tbsp|pkg|approx|min|mins|hr|hrs|deg|qt|pt|c|t|no|vol|doz|ea|env|sq|in))[.!?]\s+|\n)([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\bi\b/g, 'I')
    .replace(/(\d)\s*f\b/g, '$1 F').replace(/(\d)\s*c\b/g, '$1 C');
}

/** "375 degrees F.", "500 DEG F", "400-F", "350°" in an oven sentence -> "375°F" (and "200 C" -> "200°C"). */
export function temps(p) {
  return p
    .replace(/\s*\b(fahrenheit|farenheit|fahrenheight)\b\.?/gi, ' F').replace(/\s*\b(celsius|centigrade)\b\.?/gi, ' C')
    .replace(/\b(\d{3}\s*(?:degre+s*|deg))\.(?=[A-Z])/g, '$1. ')          // "375 deg.Place": the space it lost
    .replace(/\b(\d{3})\s*-?\s*(?:degrees?|deg\.?|º|°)\s*(F|C)\b(?=[\s.),;:]|$)/gi, (m, n, u) => `${n}°${u.toUpperCase()}`)
    .replace(/\b(\d{3})\s*-?\s*(F|C)\b(?![a-z])/g, (m, n, u) => `${n}°${u}`)
    // US recipes: plain "350 degrees" is Fahrenheit ("degress" is a common typo; "375 deg.Place" lost its space)
    .replace(/\b(\d{3})\s*(?:degre+s*|deg\.?|º|°)(?![a-z])(?!\s*[FC]\b)/gi, (m, n) => `${n}°F${m.endsWith('.') ? '.' : ''}`)
    .replace(/°F\.(?=\s+[a-z])/g, '°F');                                                   // "375°F. for 40 minutes" -> "375°F for"
}

const EMAIL = /\s*[<(]?[\w.+-]+@[\w-]+(\.[\w-]+)+[>)]?/g;
const URL = /\s*[<(]?(https?:\/\/|www\.)\S+[>)]?/gi;

/** { text, credits }: the method without the bookkeeping, and any "Source: ..." lines. Two passes, because taking
 *  one thing out can uncover another ("---- DIRECTIONS: Cook ..." -> "DIRECTIONS: Cook ..."). */
export function tidyDirections(dir) {
  const a = tidyOnce(dir);
  const b = tidyOnce(a.text);
  return { text: b.text, credits: [...new Set([...a.credits, ...b.credits])].slice(0, 2) };
}

function tidyOnce(dir) {
  if (!dir) return { text: '', credits: [] };
  let s = decode(dir).replace(/\r/g, '');
  s = s.replace(/[ \t]*([-=~_*#+]\s?){4,}[ \t]*/g, '\n\n');          // separator lines and runs (----, ====, ~~~, *-*-*)
  s = s.replace(/^\s*(directions|method|instructions)\s*:?\s*(?=\S)/i, '');
  const credits = [];
  const out = [];
  for (let p of s.split(/\n\s*\n|\n(?=\s*(?:source|from|posted by|typed by|typed for you by|converted by|yield|serves|makes|per serving)\b)/i)) {
    p = p.replace(EMAIL, '').replace(URL, '').replace(/[ \t]{2,}/g, ' ').trim();
    p = p.replace(/^\*+\s*|\s*\*+$/g, '').replace(/\s\*+(?=\s)/g, '').trim();   // "** Crust", "Raisins *"
    if (!p) continue;
    if (CREDIT.test(p) && p.length < 300) {
      const c = cleanCredit(p).replace(/^(source|from):\s*/i, '');
      if (goodCredit(c)) credits.push(c);
      continue;
    }
    if (p.length <= 200 && DROP.some((re) => re.test(p))) continue;   // bookkeeping is short; a long paragraph is the recipe
    p = p.replace(STAMP, '').trim();
    const tail = p.match(TAIL);
    if (tail && tail.index > 40) p = p.slice(0, tail.index).trim();
    else if (tail) {                                                  // '"A Well Seasoned Appetite" Posted by Dan': a credit line
      const c = cleanCredit(p.slice(0, tail.index));
      if (goodCredit(c)) credits.push(c);
      continue;
    }
    // "...the oven. Source: Bon Appetit, 1987." at the end of a paragraph
    const m = p.match(/\s+(?:source|from):\s+(.{4,200})$/i);
    if (m) { const c = cleanCredit(m[1]); if (goodCredit(c)) credits.push(c); p = p.slice(0, m.index).trim(); }
    // nutrition tacked onto the end: "... golden brown. PER SERVING: 530 CALORIES, 22g FAT"
    const nut = p.match(/\s*\b(per serving|nutrition(al)? (information|info|analysis)|calories per serving)\b\s*:.*$/i);
    if (nut && nut.index > 40 && p.length - nut.index < 400) p = p.slice(0, nut.index).trim();
    if (!p) continue;
    p = temps(unshout(p));
    out.push(p);
  }
  const text = out.join('\n\n');
  // never leave a recipe with no method: if everything looked like bookkeeping, show it as written (tidied up)
  if (!text.trim()) return { text: temps(unshout(decode(dir).replace(EMAIL, '').replace(URL, '').replace(/[ \t]{2,}/g, ' ').trim())), credits: [] };
  return { text, credits: [...new Set(credits)].slice(0, 2) };
}
