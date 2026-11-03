"""MealMaster (.mmf / .txt) recipe parser.

MealMaster files hold one or more recipes. Each recipe looks like:

    MMMMM----- Recipe via Meal-Master (tm) v8.05
          Title: Chocolate Chip Cookies
     Categories: Cookies, Desserts
          Yield: 48 cookies

        2 1/4 c  Flour
          1 ts   Baking soda
    MMMMM---------------TOPPING---------------      <- optional ingredient group
          1 c    Pecans, chopped
               -- toasted                          <- continuation of previous line

      Mix and bake at 375 for 10 minutes.
    MMMMM                                           <- end marker

Ingredient lines use fixed columns: 7-char amount, space, 2-char unit, space,
item text. Two ingredients can share one line (second column near col 40).
Plenty of files in the wild are sloppy, so there is a free-form fallback.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import List, Optional, Tuple

from .models import Ingredient, Recipe
from .units import canonical_unit, parse_quantity

_START_RE = re.compile(r"^(?:m{5}|-{5,}).*meal[\s-]?master", re.IGNORECASE)
_FIELD_RE = re.compile(r"^\s*(title|categories|yield|servings)\s*:\s*(.*?)\s*$", re.IGNORECASE)
_QTY_REGION_RE = re.compile(r"^[\d\s/.]*$")
_UNIT_REGION_RE = re.compile(r"^[A-Za-z]{0,2}$")
_FREEFORM_RE = re.compile(r"^\s*((?:\d+\s+)?\d+/\d+|\d*\.\d+|\d+)\s+(\S+)\s+(.+?)\s*$")
_YIELD_RE = re.compile(r"^((?:\d+\s+)?\d+/\d+|\d*\.\d+|\d+)\s*(.*)$")
_STEP_RE = re.compile(r"^\s*\d+[.)]\s")


@dataclass
class ParseResult:
    recipes: List[Recipe] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------- public API

def parse_file(path) -> ParseResult:
    data = Path(path).read_bytes()
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return parse_text(data.decode(enc))
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not decode {path}")  # latin-1 never fails; defensive


def parse_text(text: str) -> ParseResult:
    result = ParseResult()
    for block in _split_blocks(text.expandtabs(8)):
        recipe, warnings = _parse_block(block)
        result.warnings.extend(warnings)
        if recipe is not None:
            result.recipes.append(recipe)
    return result


# ----------------------------------------------------------- block splitting

def _is_end_marker(line: str) -> bool:
    s = line.rstrip()
    if re.fullmatch(r"-{5}", s):
        return True
    return bool(re.match(r"^m{5}", s, re.IGNORECASE)) and not _group_name(s)


def _group_name(line: str) -> str:
    """Name from 'MMMMM-----SAUCE-----' or '-------SAUCE-------' lines, else ''."""
    s = line.rstrip()
    if re.match(r"^m{5}", s, re.IGNORECASE):
        name = s[5:].strip("- \t")
    else:
        t = s.strip()
        if not re.fullmatch(r"-{3,}\s*[^-\s](?:.*?[^-\s])?\s*-{3,}", t):
            return ""
        name = t.strip("- \t")
    return name.rstrip(":").strip()


def _split_blocks(text: str) -> List[List[str]]:
    blocks: List[List[str]] = []
    current: Optional[List[str]] = None
    for line in text.splitlines():
        if _START_RE.match(line):
            if current is not None:  # missing end marker: close previous recipe
                blocks.append(current)
            current = []
        elif current is not None and _is_end_marker(line):
            blocks.append(current)
            current = None
        elif current is not None:
            current.append(line)
    if current is not None:
        blocks.append(current)
    return blocks


# ----------------------------------------------------------- ingredient lines

def _strict_parts(line: str) -> Optional[Tuple[str, str, str]]:
    """Fixed-width MealMaster ingredient line -> (qty, unit, item), else None."""
    padded = line.ljust(11)
    qty, unit = padded[0:7], padded[8:10].strip()
    if padded[7] != " " or padded[10] != " ":
        return None
    if not _QTY_REGION_RE.match(qty) or not _UNIT_REGION_RE.match(unit):
        return None
    item = line[11:].strip()
    if not item:
        return None
    return qty.strip(), unit, item


RIGHT_COL = 41  # right-hand ingredient: qty [41:48], unit [49:51], item from 52


def _split_two_columns(line: str):
    """If a line holds a second, right-hand ingredient return (left, right, False).

    The right-hand field uses the same layout as the left, shifted by 41 columns. Wrapped text
    in either column is marked with a leading '-' (see _join_continuation); a right-hand field
    with no amount or unit but no dash is a new ingredient such as "Watercress for garnish".
    """
    if len(line) <= RIGHT_COL + 11:
        return None
    left, right = line[:RIGHT_COL], line[RIGHT_COL:]
    if left[-1] != " ":
        return None
    left_ok = _strict_parts(left.rstrip()) is not None
    if not left_ok and left.strip():
        return None
    parts = _strict_parts(right)
    if parts is None:
        return None
    return left.rstrip(), right.rstrip(), False


def _join_continuation(base: str, cont: str) -> str:
    """Append wrapped text to an ingredient.

    MealMaster wraps long items onto lines that begin with '-' in the item column:
    '- more words' and '-- more words' continue after a space; '-xyz' (no space) continues
    in the middle of a word, so it is joined directly.
    """
    cont = cont.strip()
    m = re.match(r"^(-+)(.*)$", cont)
    if not m:
        return f"{base} {cont}".strip()
    dashes, rest = m.groups()
    if len(dashes) == 1 and rest and not rest.startswith(" "):
        return base + rest.rstrip()
    rest = rest.strip()
    return f"{base} {rest}" if rest else base


def _make_ingredient(qty: str, unit: str, item: str, group: str) -> Ingredient:
    item = re.sub(r"\s{2,}", " ", item)
    quantity = parse_quantity(qty)
    raw = "" if quantity is not None or not qty else qty
    canon = canonical_unit(unit, mealmaster=True)
    if canon is None:  # unknown code: keep it visible rather than lose it
        canon = unit
    return Ingredient(item=item, quantity=quantity, unit=canon, group=group, raw_quantity=raw)


def _parse_ingredient_line(line: str, group: str):
    """Fixed-width ingredient line -> list of (side, Ingredient | str), or None.

    side is "L" or "R" for ingredients; "RC" carries continuation text for the previous
    right-hand ingredient.
    """
    split = _split_two_columns(line)
    if split:
        left, right, right_cont = split
        out = []
        lp = _strict_parts(left)
        if lp:
            out.append(_left_entry(lp, group))
        rp = _strict_parts(right)
        if right_cont or (not rp[0] and not rp[1] and rp[2].startswith("-")):
            out.append(("RC", rp[2]))
        else:
            out.append(("R", _make_ingredient(*rp, group)))
        return out
    parts = _strict_parts(line)
    if parts:
        return [_left_entry(parts, group)]
    return None


def _left_entry(parts, group: str):
    qty, unit, item = parts
    if not qty and not unit and item.startswith("-"):
        return ("LC", item)
    return ("L", _make_ingredient(qty, unit, item, group))


def _parse_freeform(line: str, group: str) -> Optional[Ingredient]:
    m = _FREEFORM_RE.match(line)
    if not m:
        return None
    qty_text, token, rest = m.groups()
    quantity = parse_quantity(qty_text)
    if quantity is None:
        return None
    unit = canonical_unit(token, mealmaster=True)
    if unit is not None:
        return Ingredient(item=rest, quantity=quantity, unit=unit, group=group)
    return Ingredient(item=f"{token} {rest}", quantity=quantity, group=group)


def _looks_freeform_with_unit(line: str) -> bool:
    m = _FREEFORM_RE.match(line)
    return bool(m and parse_quantity(m.group(1)) is not None
                and canonical_unit(m.group(2), mealmaster=True))


# ---------------------------------------------------------------- recipe body

def parse_yield(text: str) -> Tuple[Optional[Fraction], str]:
    m = _YIELD_RE.match(text.strip())
    if not m:
        return None, text.strip()
    return parse_quantity(m.group(1)), m.group(2).strip()


def _unwrap(lines: List[str]) -> str:
    """Join hard-wrapped lines into paragraphs; numbered steps stay on their own line."""
    paragraphs: List[List[str]] = [[]]
    for line in lines:
        if not line.strip():
            if paragraphs[-1]:
                paragraphs.append([])
            continue
        s = line.strip()
        if _STEP_RE.match(line) and paragraphs[-1]:
            paragraphs.append([])
            paragraphs[-1].append(s)
            continue
        paragraphs[-1].append(s)
    return "\n\n".join(" ".join(p) for p in paragraphs if p)


def _next_nonblank(lines: List[str], i: int) -> Optional[str]:
    while i < len(lines):
        if lines[i].strip():
            return lines[i]
        i += 1
    return None


def _parse_block(lines: List[str]) -> Tuple[Optional[Recipe], List[str]]:
    warnings: List[str] = []
    title = ""
    categories: List[str] = []
    yield_text = ""
    i = 0

    # --- header fields (blank lines allowed between them)
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = _FIELD_RE.match(line)
        if not m:
            break
        name, value = m.group(1).lower(), m.group(2)
        if name == "title":
            title = value
        elif name == "categories":
            categories = [c.strip() for c in value.split(",") if c.strip()]
        elif name in ("yield", "servings") and not yield_text:
            yield_text = value
            if name == "servings" and value.strip().isdigit():
                yield_text = f"{value.strip()} servings"
        i += 1

    if not title:
        title = "Untitled recipe"
        warnings.append("Recipe without a title; imported as 'Untitled recipe'.")

    # --- ingredients
    ingredients: List[Ingredient] = []
    group = ""
    in_ingredients = True
    contiguous = False  # True right after an ingredient line (no blank in between)
    last_left: Optional[Ingredient] = None
    last_right: Optional[Ingredient] = None
    while i < len(lines) and in_ingredients:
        line = lines[i]
        if not line.strip():
            nxt = _next_nonblank(lines, i + 1)
            if nxt is None:
                i += 1
                break
            if _group_name(nxt) or _parse_ingredient_line(nxt, group) is not None \
                    or _looks_freeform_with_unit(nxt):
                contiguous = False
                i += 1
                continue
            in_ingredients = False
            i += 1
            break
        gname = _group_name(line)
        if gname:
            group = gname
            contiguous = True
            i += 1
            continue
        parsed = _parse_ingredient_line(line, group)
        if parsed is not None:
            for side, value in parsed:
                if side in ("RC", "LC"):
                    target = last_right if side == "RC" else (last_left or (ingredients[-1] if ingredients else None))
                    if target is not None:
                        target.item = _join_continuation(target.item, value)
                    else:
                        target = Ingredient(item=value.lstrip("- ").strip(), group=group)
                        ingredients.append(target)
                        if side == "RC":
                            last_right = target
                        else:
                            last_left = target
                else:
                    if (value.quantity is None and not value.unit and not value.raw_quantity
                            and value.item.startswith("(")):
                        # older exports wrap notes like "(optional)" without a dash
                        target = last_left if side == "L" else last_right
                        if target is not None:
                            target.item += " " + value.item
                            continue
                    ingredients.append(value)
                    if side == "L":
                        last_left = value
                    else:
                        last_right = value
            contiguous = True
            i += 1
            continue
        free = _parse_freeform(line, group)
        if free is not None and line.lstrip()[:1].isdigit():
            ingredients.append(free)
            contiguous = True
            i += 1
            continue
        stripped = line.strip()
        if contiguous and len(stripped) <= 50 and not stripped.endswith("."):
            # e.g. "salt to taste" in a sloppy file: an ingredient with no amount
            ingredients.append(Ingredient(item=stripped, group=group))
            i += 1
            continue
        in_ingredients = False  # first non-ingredient line starts the directions

    directions = _unwrap(lines[i:])
    yq, yu = parse_yield(yield_text) if yield_text else (None, "")

    recipe = Recipe(
        title=title,
        ingredients=ingredients,
        directions=directions,
        categories=categories,
        yield_quantity=yq,
        yield_unit=yu,
        yield_raw=yield_text,
    )
    if not ingredients:
        warnings.append(f"'{title}': no ingredients found.")
    return recipe, warnings
