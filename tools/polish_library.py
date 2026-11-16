"""Polish the published library in web/data (run after tools/clean_library.mjs; safe to run again):

    python3 tools/polish_library.py --dry-run   # counts and examples, changes nothing
    python3 tools/polish_library.py

1. Copies: recipes the duplicate finder rates "same" or "probably the same" are tagged `duplicate` except
   the best copy (a built-in one first, then the most descriptive title, then the fullest), which gets the
   copies' categories and labels.
   The app keeps tagged copies out of lists and search; they still open from a saved link.
2. Titles: no footnote stars or "#", no "<T>" tags, no "#2"/" 2" copy numbers, "W/" -> "with".
3. Words: common misspellings fixed ("coarsley", "tumeric", "parmesean"...), and words glued together where
   an old file wrapped a line ("peppersauce" -> "pepper sauce") split, in methods and ingredient names.
4. Ingredient lines that are the wrapped end of the line above ("Temperature", "Into 8 chops") are joined to it.
5. Uncategorized recipes are filed from what's in them (salmon -> Seafood, sugar + flour -> Desserts...).
Ids never change.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from recipelib import categories, duplicates  # noqa: E402
from recipelib.shopping import item_name  # noqa: E402
from tools.export_more import recipe_from_row  # noqa: E402

DATA = ROOT / "web" / "data"
HIDDEN = {"needs-work", "duplicate"}

TYPOS = {
    "coarsley": "coarsely", "potaotes": "potatoes", "tomatos": "tomatoes", "potatos": "potatoes", "squeese": "squeeze",
    "brocolli": "broccoli", "brocoli": "broccoli", "parsely": "parsley", "worchestershire": "worcestershire",
    "worcestshire": "worcestershire", "worchestshire": "worcestershire", "tumeric": "turmeric", "cinammon": "cinnamon",
    "cinnamin": "cinnamon", "vanila": "vanilla", "spagetti": "spaghetti", "zuchini": "zucchini", "zucchinni": "zucchini",
    "mozarella": "mozzarella", "mozzarela": "mozzarella", "parmesean": "parmesan", "parmasean": "parmesan",
    "jalepeno": "jalapeno", "jalepenos": "jalapenos", "fettucine": "fettuccine", "fettucini": "fettuccine",
    "lettice": "lettuce", "seperate": "separate", "seperately": "separately", "untill": "until", "boullion": "bouillon",
    "bouillion": "bouillon", "tablspoon": "tablespoon", "tablespon": "tablespoon", "teapoon": "teaspoon",
    "teaspon": "teaspoon", "iches": "inches", "occassionally": "occasionally", "ocasionally": "occasionally",
    "thouroughly": "thoroughly", "throughly": "thoroughly", "refridgerate": "refrigerate", "refrigirate": "refrigerate",
    "refridgerator": "refrigerator", "simmmer": "simmer", "carmelize": "caramelize", "carmelized": "caramelized",
    "sautee": "saute", "pinapple": "pineapple", "pinneapple": "pineapple", "strawberrys": "strawberries",
    "rasberries": "raspberries", "rasberry": "raspberry", "cauliflour": "cauliflower", "marjarine": "margarine",
    "margerine": "margarine", "mayonaise": "mayonnaise", "mayonaisse": "mayonnaise", "cinamon": "cinnamon",
    "chocolote": "chocolate", "choclate": "chocolate", "vinager": "vinegar", "vinegarette": "vinaigrette",
    "orignal": "original", "recieve": "receive", "tempature": "temperature", "temperture": "temperature",
    "minuites": "minutes", "mintues": "minutes", "minuts": "minutes", "untl": "until", "mixutre": "mixture",
    "mixure": "mixture", "ingrediants": "ingredients", "ingredents": "ingredients", "sprinke": "sprinkle",
}
TYPO_RE = re.compile(r"\b(" + "|".join(sorted(TYPOS, key=len, reverse=True)) + r")\b", re.I)

# ingredient lines that are the wrapped end of the line above
# (only words that can't start an ingredient of their own: "Sliced almonds" is an ingredient, "Into 8 chops" isn't)
CONT_START = re.compile(r"^(into|inch|inches|pieces|removed|divided|temperature|total|thick|and|to|for|in|with|purpose flour|"
                        r"room temperature|at room|cut into|cut in|ends|stems|discarded|reserved|or more|or less|approximately)\b",
                        re.I)
CONT_END = re.compile(r"((?<=[a-z])-|\(|\b(all|and|or|of|with|into|to|in|room|inch|cut|cut into|plus|about|the|an|very|such as|"
                      r"preferably)\s*)$", re.I)

# Uncategorized recipes, filed by what's in them (checked in this order; title words count double)
INGREDIENT_RULES = [
    (r"\b(salmon|shrimp|prawns?|crab|lobster|scallops?|clams?|mussels?|oysters?|tuna|cod|halibut|snapper|trout|"
     r"sole|catfish|tilapia|swordfish|anchov|sardines?|gravlax|calamari|squid|fish)\b", ["Seafood", "Main Dishes"]),
    (r"\b(chicken|turkey|duck|pheasant|quail|cornish hen|goose|poussin)\b", ["Poultry", "Main Dishes"]),
    (r"\b(lamb|venison|rabbit|veal|goat)\b", ["Meats", "Main Dishes"]),
    (r"\b(beef|steak|brisket|sirloin|chuck|ground round|short ribs?)\b", ["Beef", "Main Dishes"]),
    (r"\b(pork|ham|bacon|sausage|tasso|prosciutto|pancetta|chorizo|andouille)\b", ["Pork", "Main Dishes"]),
    (r"\b(stock|broth|soup|bisque|chowder|consomme|gumbo)\b", ["Soups & Stews"]),
    (r"\b(sauce|icing|glaze|frosting|vinaigrette|dressing|aioli|beurre|mayonnaise|salsa|chutney|relish|pesto|syrup|"
     r"marinade|rub|butter)\b", ["Sauces & Condiments"]),
    (r"\b(cake|tart|torte|pie|cookies?|brownies?|pudding|custard|compote|cobbler|crisp|sorbet|gelato|ice cream|"
     r"mousse|souffle|beignets?|fritters?|babka|blintz|crepes?|meringue|marzipan|frangipane|gratin of|truffles?)\b",
     ["Desserts"]),
    (r"\b(pasta|spaghetti|linguine|fettuccine|penne|ravioli|risotto|rice|polenta|gnocchi|couscous|noodles?|tagarin|"
     r"orzo|barley|quinoa)\b", ["Pasta, Rice & Grains"]),
    (r"\b(bread|rolls?|biscuits?|muffins?|scones?|focaccia|brioche|loaf)\b", ["Breads & Baking"]),
    (r"\b(salad|slaw)\b", ["Salads & Dressings"]),
    (r"\b(eggs?|omelet|frittata|quiche|cheese)\b", ["Eggs & Cheese"]),
    (r"\b(potato|potatoes|plantains?|squash|cabbage|corn|beans?|greens|spinach|mushrooms?|chanterelles|eggplant|"
     r"carrots?|peppers?|tomato|tomatoes|onions?|leeks?|asparagus|zucchini|vegetables?|taro|lentils?|dhal)\b",
     ["Vegetables & Sides"]),
    (r"\b(peaches|apples?|pears?|berries|blueberr|strawberr|cherr|plums?|grapes?|mango|pineapple|bananas?|citrus|fruit)\b",
     ["Fruit"]),
]
INGREDIENT_RULES = [(re.compile(p, re.I), g) for p, g in INGREDIENT_RULES]


def load():
    core_doc = json.loads((DATA / "recipes.json").read_text(encoding="utf-8"))
    version = json.loads((DATA / "more.json").read_text(encoding="utf-8"))["v"]
    more = []
    for f in sorted((DATA / "more" / version).glob("*.json")):
        if f.name != "index.json":
            more += json.loads(f.read_text(encoding="utf-8"))["recipes"]
    return core_doc, more


def tags_of(row):
    return row[8] if len(row) > 8 else []


def case_like(src: str, word: str) -> str:
    if src.isupper() and len(src) > 1:
        return word.upper()
    return word[:1].upper() + word[1:] if src[:1].isupper() else word


class Polisher:
    def __init__(self, rows):
        self.stats = collections.Counter()
        self.examples = collections.defaultdict(list)
        words = collections.Counter()
        for r in rows:
            for w in re.findall(r"[a-z]+", (r[7] or "").lower() + " " + " ".join(i[3].lower() for i in r[6])):
                words[w] += 1
        self.words = words

    def note(self, kind, example):
        self.stats[kind] += 1
        if len(self.examples[kind]) < 8:
            self.examples[kind].append(example)

    # ---- words
    def split_glued(self, w: str):
        """'peppersauce' -> 'pepper sauce' when the word is (almost) never seen but both halves are common."""
        lw = w.lower()
        camel = re.fullmatch(r"([a-z]{3,})([A-Z][a-z]{2,})", w)           # "cannedItalian" -> "canned Italian"
        if camel and self.words[camel.group(1).lower()] >= 50 and self.words[camel.group(2).lower()] >= 50:
            return f"{camel.group(1)} {camel.group(2)}"
        if len(lw) < 8 or not lw.isalpha() or self.words[lw] > 2:
            return None
        best = None
        for i in range(3, len(lw) - 2):
            a, b = lw[:i], lw[i:]
            fa, fb = self.words[a], self.words[b]
            if fa >= 300 and fb >= 300 and (best is None or min(fa, fb) > best[0]):
                best = (min(fa, fb), a, b)
        if not best:
            return None
        return case_like(w, best[1]) + " " + best[2]

    def fix_words(self, text: str, where: str) -> str:
        if not text:
            return text
        def typo(m):
            self.note("typos", f"{m.group(0)} -> {TYPOS[m.group(0).lower()]} ({where})")
            return case_like(m.group(0), TYPOS[m.group(0).lower()])
        text = TYPO_RE.sub(typo, text)
        def glue(m):
            s = self.split_glued(m.group(0))
            if s:
                self.note("glued", f"{m.group(0)} -> {s} ({where})")
                return s
            return m.group(0)
        return re.sub(r"[A-Za-z]{8,}", glue, text)

    # ---- titles
    def title(self, t: str) -> str:
        new = re.sub(r"<[^>]*>", " ", t)
        new = re.sub(r"[*#]+(?=\s*$)|^[*#]+|\s[*#]+\s", " ", new)
        new = re.sub(r"\s+(#\s*\d{1,2}|\d{1,2})$", "", new)                 # "Arroz con Pollo #2", "Chicken Noodle Soup 2"
        new = re.sub(r"\bW/\s*", "with ", new)
        new = re.sub(r"\s+", " ", new).strip(" -:")
        new = self.fix_words(new, "title")
        if new != t and new:
            self.note("titles", f"{t} -> {new}")
            return new
        return t

    # ---- ingredients
    def ingredients(self, ings):
        out = []
        for row in ings:
            q, raw, unit, item, group = (list(row) + [""] * 5)[:5]
            item = self.fix_words(item, "ingredient")
            if out and not q and not raw and not unit and item and (CONT_START.match(item) or CONT_END.search(out[-1][3])):
                prev = out[-1]
                joined = f"{prev[3].rstrip()} {item[0].lower() + item[1:] if not item[:2].isupper() else item}"
                self.note("joined", f"{prev[3]} + {item} -> {joined}")
                prev[3] = re.sub(r"\s+", " ", joined).strip()
                continue
            out.append([q, raw, unit, item, group])
        return out

    # ---- categories
    def file_uncategorized(self, row):
        if row[2] != [categories.data.UNCATEGORIZED] if hasattr(categories, "data") else row[2] != ["Uncategorized"]:
            return row[2]
        title = row[1]
        main = " ".join(i[3] for i in row[6][:6])                          # the main ingredients come first
        found = next((g for pat, g in INGREDIENT_RULES if pat.search(title)), None)   # the title says what it is
        if not found:                                                     # else its main meat or fish
            found = next((g for pat, g in INGREDIENT_RULES[:5] if pat.search(main)), None)
        if not found and re.search(r"\bsugar\b", main, re.I) and re.search(r"\b(flour|chocolate|cream|butter)\b", main, re.I):
            found = ["Desserts"]
        if not found:
            return row[2]
        found = categories.in_display_order(found)
        self.note("filed", f"{title} -> {', '.join(found)}")
        return found


def mark_duplicates(rows, core_ids, pol):
    live = [i for i, r in enumerate(rows) if not (set(tags_of(r)) & HIDDEN)]
    recs = []
    for n in live:
        r = recipe_from_row(rows[n])
        r.id = n
        recs.append(r)
    groups = [g for g in duplicates.find_duplicate_groups(recs) if g.level in (duplicates.HIGH, duplicates.LIKELY)]
    for g in groups:
        # keep a built-in copy first (it works offline), then the one whose title says most ("Hearty Russian Beet
        # Soup" over "Borsch"), then the fullest
        ids = sorted(g.ids, key=lambda i: (rows[i][0] in core_ids, min(len(rows[i][1].split()), 5), len(rows[i][7]),
                                           len(rows[i][6])), reverse=True)
        keep, *copies = ids
        k = rows[keep]
        for c in copies:
            row = rows[c]
            k[2] = categories.in_display_order(list(dict.fromkeys(k[2] + [x for x in row[2] if x != "Uncategorized"])))
            if len(k[2]) > 1 and "Uncategorized" in k[2]:
                k[2].remove("Uncategorized")
            k[8] = list(dict.fromkeys(tags_of(k) + [t for t in tags_of(row) if t not in HIDDEN]))
            row[8] = tags_of(row) + ["duplicate"]
            pol.note("duplicates", f"{row[1]} -> kept {k[1]}")
    return len(groups)


def write(core_doc, core_rows, more_rows):
    dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    (DATA / "recipes.json").write_text(dump({"v": core_doc.get("v", 1), "recipes": core_rows}), encoding="utf-8")
    version = hashlib.sha1(dump(more_rows).encode("utf-8")).hexdigest()[:8]
    shutil.rmtree(DATA / "more", ignore_errors=True)
    out = DATA / "more" / version
    out.mkdir(parents=True)
    listed = [r for r in more_rows if not (set(tags_of(r)) & HIDDEN)]
    index = [[r[0], r[1], r[2], list(dict.fromkeys(n for n in (item_name(i[3]) for i in r[6]) if n))] for r in listed]
    (out / "index.json").write_text(dump({"v": version, "recipes": index}), encoding="utf-8")
    shards = collections.defaultdict(list)
    for r in more_rows:
        shards[r[0][:2]].append(r)
    for prefix, group in shards.items():
        (out / f"{prefix}.json").write_text(dump({"recipes": group}), encoding="utf-8")
    (DATA / "more.json").write_text(dump({"v": version, "count": len(listed)}), encoding="utf-8")
    return version, len(listed)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--examples", action="store_true", help="print examples of each change")
    args = ap.parse_args(argv)
    core_doc, more = load()
    core = core_doc["recipes"]
    rows = core + more
    pol = Polisher(rows)
    for r in rows:
        while len(r) < 9:
            r.append([])
        r[1] = pol.title(r[1])
        r[6] = pol.ingredients(r[6])
        r[7] = pol.fix_words(r[7], "method")
        r[2] = pol.file_uncategorized(r)
    groups = mark_duplicates(rows, {r[0] for r in core}, pol)
    print(f"{len(rows):,} recipes: {groups} groups of copies, {pol.stats['duplicates']} copies hidden; "
          f"{pol.stats['titles']} titles, {pol.stats['typos']} misspellings, {pol.stats['glued']} glued words, "
          f"{pol.stats['joined']} wrapped ingredient lines joined, {pol.stats['filed']} uncategorized recipes filed")
    if args.examples or args.dry_run:
        for kind, ex in pol.examples.items():
            print(f"  {kind}:")
            for e in ex:
                print(f"    {e}")
    if args.dry_run:
        return 0
    more_rows = sorted(rows[len(core):], key=lambda r: r[1].lower())
    version, listed = write(core_doc, rows[:len(core)], more_rows)
    print(f"wrote recipes.json and more/{version} ({listed:,} listed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
