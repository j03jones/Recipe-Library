"""Tidy how recipes read without changing what they are.

Old recipe collections are full of titles typed in capitals ("PEPPERY RICE"). tidy_title turns
those into ordinary title case ("Peppery Rice") and leaves every other title exactly as it is,
so a title someone capitalised on purpose ("BBQ Ribs", "Coq au Vin") is not touched.
"""
from __future__ import annotations

import re

_SMALL = {"a", "an", "and", "as", "at", "au", "aux", "by", "con", "de", "del", "di", "du", "en", "et", "for",
          "from", "in", "la", "le", "of", "on", "or", "the", "to", "with", "without", "y"}
_KEEP = {"BBQ", "ABM", "TVP", "USA", "UK", "II", "III", "IV", "VI", "VII", "VIII", "MSG", "BLT", "PB",
         "KFC", "TV", "OJ", "XO", "FF"}
_WORD = re.compile(r"[A-Za-zÀ-ÿ]+(?:['’][A-Za-zÀ-ÿ]+)*")


def _cap(word: str) -> str:
    parts = re.split(r"(['’])", word.lower())
    out = [parts[0][:1].upper() + parts[0][1:]]
    for n in range(1, len(parts), 2):
        tail = parts[n + 1]
        # O'Brien, D'Oeuvres, L'Orange: a one-letter start means the next part is the real word
        out.append(parts[n] + (tail[:1].upper() + tail[1:] if len(parts[0]) == 1 and len(tail) > 2 else tail))
    return "".join(out)


def tidy_title(title: str) -> str:
    """'PEPPERY RICE (QUICK)' -> 'Peppery Rice (Quick)'. Titles that are not all capitals are returned unchanged."""
    letters = [c for c in title if c.isalpha()]
    if len(letters) < 4 or any(c.islower() for c in letters):
        return title
    first = True

    def fix(m: "re.Match") -> str:
        nonlocal first
        word = m.group(0)
        start_of_part = first or title[:m.start()].rstrip()[-1:] in "(:-/–—"
        first = False
        if word in _KEEP:
            return word
        if word.lower() in _SMALL and not start_of_part:
            return word.lower()
        return _cap(word)

    return _WORD.sub(fix, title)


# ------------------------------------------------------------------ ingredients
#
# Some collections wrap a long ingredient onto following lines with nothing to mark the wrap, put
# section labels ("Filling:") and stray steps in the ingredient list, and write the unit as a word
# inside the item ("1/4 To 1/3 cup water"). tidy_recipe puts those right:
#
#   6 oz  Cold, unsalted butter, cut          6 oz  Cold, unsalted butter, cut into cubes, plus
#         Into cubes, plus butter for    ->         butter for the pie tin
#         The pie tin
#
# Every rule looks only at ingredient lines that have no amount of their own, and joins one to the
# line above only when the wording shows it cannot stand alone. When in doubt a line is left as it is.

from .units import canonical_unit  # noqa: E402

# the line above ends on one of these: it is not finished
_DANGLING = {"and", "or", "for", "of", "with", "into", "in", "to", "cut", "about", "plus", "the", "a", "an", "as",
             "from", "on", "at", "by", "each", "per", "such", "if", "your", "any", "some", "very", "more", "no",
             "not", "until", "like", "than", "x"}
_ADJECTIVES = {"brown", "white", "red", "green", "yellow", "black", "dark", "light", "fresh", "dry",
               "sweet", "hot", "cold", "warm", "large", "small", "medium", "whole", "heavy", "sour", "extra",
               "low", "virgin", "sharp", "mild", "ripe", "raw", "lean",
               "golden", "new", "baby", "plain", "instant", "powdered", "granulated", "semisweet", "bittersweet",
               "unsweetened", "unsalted", "seedless", "boneless", "skinless", "kosher", "all-purpose", "purpose",
               "balsamic", "sun-dried", "italian", "french", "dijon"}
# a line made only of these says how to prepare the thing above; it is not a thing itself
_PREP = {"chopped", "sliced", "diced", "minced", "peeled", "cored", "seeded", "cut", "torn", "drained", "rinsed",
         "trimmed", "halved", "quartered", "cubed", "grated", "shredded", "crushed", "melted", "softened", "beaten",
         "separated", "removed", "thawed", "divided", "sifted", "packed", "crumbled", "julienned", "pitted",
         "stemmed", "washed", "cleaned", "deveined", "shelled", "toasted", "cooled", "chilled", "optional",
         "finely", "coarsely", "thinly", "thickly", "roughly", "lightly", "well", "very", "fresh", "freshly",
         "and", "or", "into", "in", "to", "for", "with", "at", "on", "the", "a", "of", "if", "desired", "needed",
         "as", "pieces", "piece", "cubes", "strips", "slices", "chunks", "halves", "quarters", "rings", "wedges",
         "eighths", "bits", "dice", "small", "large", "medium", "thin", "thick", "bite", "size", "sized", "inch",
         "lengthwise", "crosswise", "diagonally", "garnish", "decoration", "taste", "room", "temperature",
         "about", "approximately", "plus", "more", "extra", "each", "total", "only", "julienne", "matchsticks"}
_LEADERS = {"into", "and", "or", "for", "with", "plus", "to", "in", "about", "such", "each", "per", "of", "at",
            "on", "until", "if", "then", "but", "from", "including", "preferably", "approximately", "depending"}
_CONTAINERS = {"stick", "sticks", "can", "cans", "package", "packages", "pkg", "pkgs", "jar", "jars", "bottle",
               "bottles", "box", "boxes", "bag", "bags", "head", "heads", "bunch", "bunches", "envelope",
               "envelopes", "clove", "cloves", "slice", "slices", "piece", "pieces", "cube", "cubes", "container",
               "carton", "tub", "tin", "tins", "packet", "packets", "loaf", "square", "squares", "sprig", "sprigs",
               "stalk", "stalks", "ear", "ears", "pound", "pounds", "ounce", "ounces", "cup", "cups", "pint",
               "quart", "tablespoon", "tablespoons", "teaspoon", "teaspoons", "small", "medium", "large"}
# amount-less lines that are ingredients in their own right, however the line above ends
_STANDALONE_RE = re.compile(r"\b(to taste|for (frying|garnish|serving|dusting|greasing|brushing|sprinkling|dipping|"
                            r"decoration|the pan)|as needed|if desired)\b|^(salt|pepper|water|oil|flour|butter|sugar|"
                            r"paprika|parsley|ice|salt (and|&) pepper|freshly ground (black )?pepper|black pepper|"
                            r"cooking spray|nonstick spray|vegetable oil|olive oil)$", re.IGNORECASE)
_PROPER = {"italian", "french", "granny", "dijon", "parmesan", "worcestershire", "tabasco", "mexican", "chinese",
           "greek", "swiss", "english", "german", "spanish", "thai", "indian", "japanese", "cajun", "creole",
           "romano", "kahlua", "grand", "southern", "idaho", "yukon", "vidalia", "bermuda", "roma", "belgian",
           "hungarian", "jamaican", "kalamata", "marsala", "madeira", "monterey", "philadelphia", "tb", "i"}
_VERBS = {"mix", "combine", "stir", "bake", "cook", "add", "pour", "heat", "preheat", "place", "serve", "blend",
          "beat", "melt", "whisk", "bring", "simmer", "boil", "saute", "fry", "brown", "cream", "fold", "spread",
          "sprinkle", "roll", "remove", "let", "cover", "chill", "refrigerate", "press", "pat", "line", "grease"}
_META_RE = re.compile(r"^(from|yield|servings?|serves|makes|posted by|typed by|typed in by|source|recipe by|"
                      r"notes?|submitted by|per serving)\s*:", re.IGNORECASE)


def _plain(ing) -> bool:
    return ing.quantity is None and not ing.raw_quantity and not ing.unit


def _heading(item: str, shouting: bool = False) -> str:
    """'Egg wash:' / 'Pie dough-' / 'FILLING' -> the section name; '' if the line is not a section label.
    A line in capitals counts only when the rest of the list is not in capitals too (`shouting`)."""
    if item.startswith(":") or _META_RE.match(item):
        return ""
    words = item.rstrip(":- ").split()
    if not words or len(item) > 42 or not any(c.isalpha() for c in item):
        return ""
    if item.endswith(":") and len(words) <= 6:
        name = " ".join(words)
    elif re.search(r"[A-Za-z)]-$", item) and len(words) <= 3 and re.fullmatch(r"[A-Za-z' ]+-", item):
        name = " ".join(words)
    elif not shouting and len(words) <= 3 and item.isupper() and re.fullmatch(r"[A-Z' &]{4,}", item) \
            and not _STANDALONE_RE.search(item):
        name = " ".join(words)
    else:
        return ""
    if re.search(r"\b(to taste|or)$", name, re.IGNORECASE):
        return ""
    tidied = tidy_title(name)
    return tidied if tidied != name or not name.isupper() else name.capitalize()


def _is_step(item: str) -> bool:
    words = re.findall(r"[A-Za-z']+", item)
    if len(words) < 5 or not item.rstrip().endswith("."):
        return False
    return words[0].lower() in _VERBS or (words[0].lower() == "in" and words[1].lower() in ("a", "the", "an"))


def _continues(prev: str, frag: str) -> bool:
    """True when `frag` (a line with no amount) reads as the rest of `prev` rather than a new ingredient."""
    p, f = prev.rstrip(), frag.strip()
    if not p or not f:
        return False
    last = (re.findall(r"[A-Za-z'-]+|\d+", p.lower()) or [""])[-1]
    # strong signs: the line above is visibly unfinished, or this one closes something it opened
    if p[-1] in ",(&/" or p.count("(") > p.count(")") or f.count(")") > f.count("("):
        return True
    if last in _DANGLING or p[-1].isdigit():
        return True
    # the line above stops on a describing word ("dark brown", "thinly"): the thing itself is still to come
    # ("Thyme, dried" is finished: the describing word came after a comma)
    if ((last.endswith("ly") and len(last) > 4) or last in _ADJECTIVES) \
            and not re.search(r"([,;]|ed)\s*[\w'-]+$", p):          # nor "chopped roughly"
        return True
    if _STANDALONE_RE.search(f):
        return False
    # weaker signs, only for lines that are not ingredients in their own right
    fw = re.findall(r"[a-z'-]+", f.lower())
    if fw and (all(w in _PREP for w in fw) or fw[0] in _LEADERS):
        return True
    bare = re.sub(r"\([^)]*\)", " ", p.lower())
    bw = re.findall(r"[a-z'-]+", bare)
    # "(8 tablespoons)" or "can (14 oz)": a measure with nothing measured yet
    return all(w in _CONTAINERS for w in bw) and (bool(bw) or "(" in p)


def _lower_start(frag: str) -> str:
    """'Into cubes' -> 'into cubes'; proper names and abbreviations keep their capital."""
    first = frag.split(" ", 1)[0]
    if first[:1].isupper() and not first.isupper() and first.lower().strip(",.;:()") not in _PROPER:
        return frag[:1].lower() + frag[1:]
    return frag


def tidy_recipe(recipe) -> int:
    """Tidy a recipe's ingredient list in place. Returns how many lines were changed, joined or moved."""
    out, steps, notes = [], [], []
    changes = 0
    section = None           # a section label found in the list ("Filling:"), applied to what follows
    last_group = None
    letters = [i.item for i in recipe.ingredients if any(c.isalpha() for c in i.item)]
    shouting = sum(1 for t in letters if t.isupper()) > len(letters) / 2     # the whole list is in capitals
    for ing in recipe.ingredients:
        if ing.group != last_group:
            last_group, section = ing.group, None
        item = " ".join(ing.item.split())
        if item != ing.item:
            ing.item = item
        # "1/4-1/3 | | cup ice cold water": the unit was written as a word inside the item
        if not ing.unit and (ing.quantity is not None or ing.raw_quantity) and " " in item:
            word, rest = item.split(" ", 1)
            unit = canonical_unit(word) if len(word.strip(".")) > 1 else None
            if unit in ("small", "medium", "large"):   # a size is part of the name ("2 Small beets"), not a measure
                unit = None
            if unit and rest.strip():
                ing.unit, ing.item, item = unit, rest.strip(), rest.strip()
                changes += 1
        if _plain(ing):
            if not item:
                changes += 1
                continue
            if _META_RE.match(item):
                notes.append(item)
                changes += 1
                continue
            name = _heading(item, shouting)
            if name:
                section = name
                changes += 1
                continue
            if _is_step(item):
                steps.append(item)
                changes += 1
                continue
            prev = out[-1] if out else None
            if prev is not None and prev.group == (section if section is not None else ing.group) \
                    and _continues(prev.item, item):
                prev.item = prev.item + ("" if prev.item.endswith("(") else " ") + _lower_start(item)
                changes += 1
                continue
        if section is not None:
            ing.group = section
        out.append(ing)
    if changes:
        recipe.ingredients = out
        parts = steps + ([recipe.directions] if recipe.directions else []) + notes
        if steps or notes:
            recipe.directions = "\n\n".join(parts)
    return changes
