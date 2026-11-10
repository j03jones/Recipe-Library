"""Combine the ingredients of several recipes into one shopping list.

The same ingredient from different recipes becomes one line, and amounts that can be added are
added: teaspoons, tablespoons and cups together; ounces and pounds together; grams and
kilograms; millilitres and litres. Amounts in different kinds of unit stay side by side
("2 cups + 1 lb"), and amounts that are not plain numbers ("2-3", "a few") are listed as notes.

web/js/shopping.js is the JavaScript twin; tests/test_shopping.py checks both give the same list.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Dict, Iterable, List, Tuple

from .formatting import format_ingredient
from .models import Ingredient, Recipe
from .scaling import _promote_unit, scale_recipe
from .units import display_unit, format_quantity

# unit -> (family, how many of the family's base unit it is)
_FAMILIES: Dict[str, Tuple[str, Fraction]] = {
    "tsp": ("volume", Fraction(1)), "Tbsp": ("volume", Fraction(3)), "fl oz": ("volume", Fraction(6)),
    "cup": ("volume", Fraction(48)), "pint": ("volume", Fraction(96)), "quart": ("volume", Fraction(192)),
    "gallon": ("volume", Fraction(768)),
    "oz": ("weight", Fraction(1)), "lb": ("weight", Fraction(16)),
    "ml": ("metric volume", Fraction(1)), "dl": ("metric volume", Fraction(100)), "l": ("metric volume", Fraction(1000)),
    "g": ("metric weight", Fraction(1)), "kg": ("metric weight", Fraction(1000)),
}
_FAMILY_ORDER = ["", "volume", "weight", "metric volume", "metric weight"]


@dataclass
class ShoppingLine:
    key: str                     # stable id for ticking the line off
    name: str                    # "Onion"
    amounts: List[str] = field(default_factory=list)   # ["2 cups", "1 lb"]
    notes: List[str] = field(default_factory=list)     # ["2-3 cloves"], amounts that can't be added
    recipes: List[str] = field(default_factory=list)   # titles that use it

    @property
    def text(self) -> str:
        parts = self.amounts + self.notes
        return f"{self.name}: {' + '.join(parts)}" if parts else self.name


def item_name(item: str) -> str:
    """'Onions; finely chopped' -> 'Onions' (the part you buy, without the preparation)."""
    item = re.sub(r"^\s*(\([^)]*\)\s*)+", "", item) or item   # "(10 oz) raspberries" -> "raspberries"
    name = re.split(r"[;,(]", item, maxsplit=1)[0]
    name = re.sub(r"\s+", " ", name).strip(" .-")
    return name or re.sub(r"\s+", " ", item).strip()


def item_key(item: str) -> str:
    """Lower-case name with simple plurals folded, so 'Onion' and 'onions' share a line."""
    words = []
    for w in item_name(item).lower().split(" "):
        if len(w) > 3 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("oes"):
            w = w[:-2]
        elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        words.append(w)
    return " ".join(words)


def _display(family: str, total: Fraction) -> Tuple[Fraction, str]:
    """The friendliest unit for a family total (given in the family's base unit)."""
    if family == "volume":
        if total >= 768:                       # a gallon or more: quarts read better than 64 cups
            return total / 192, "quart"
        q, unit = _promote_unit(total, "tsp")
        if unit == "tsp" and total >= 12:      # nothing reads nicely: still say cups, not 50 tsp
            return total / 48, "cup"
        if unit == "tsp" and total >= 3:
            return total / 3, "Tbsp"
        return q, unit
    if family == "weight":
        return (total / 16, "lb") if total >= 16 else (total, "oz")
    if family == "metric volume":
        return (total / 1000, "l") if total >= 1000 else (total, "ml")
    if family == "metric weight":
        return (total / 1000, "kg") if total >= 1000 else (total, "g")
    return total, family[1:]   # "=can" -> "can"; "=" -> no unit


def combine(recipes: Iterable[Recipe]) -> List[ShoppingLine]:
    """One line per ingredient across the given (already scaled) recipes, sorted by name."""
    lines: Dict[str, ShoppingLine] = {}
    totals: Dict[str, Dict[str, Fraction]] = {}
    for recipe in recipes:
        for ing in recipe.ingredients:
            key = item_key(ing.item)
            if not key:
                continue
            line = lines.get(key)
            if line is None:
                line = lines[key] = ShoppingLine(key=key, name=_title(item_name(ing.item)))
                totals[key] = {}
            if recipe.title not in line.recipes:
                line.recipes.append(recipe.title)
            if ing.quantity is not None:
                family, per = _FAMILIES.get(ing.unit, ("=" + ing.unit, Fraction(1)))
                totals[key][family] = totals[key].get(family, Fraction(0)) + ing.quantity * per
            elif ing.raw_quantity:
                note = format_ingredient(Ingredient(item="", unit=ing.unit, raw_quantity=ing.raw_quantity))
                line.notes.append(note)
    for key, line in lines.items():
        def order(family: str):
            return (_FAMILY_ORDER.index(family) if family in _FAMILY_ORDER else len(_FAMILY_ORDER), family)
        for family in sorted(totals[key], key=order):
            q, unit = _display("" if family == "=" else family, totals[key][family])
            line.amounts.append(f"{format_quantity(q)} {display_unit(unit, q)}".strip())
    return sorted(lines.values(), key=lambda l: (l.name.lower(), l.key))


def _title(name: str) -> str:
    return name[:1].upper() + name[1:]


def shopping_list(picks: Iterable[Tuple[Recipe, Fraction]]) -> List[ShoppingLine]:
    """picks: (recipe, scale factor) pairs."""
    return combine(scale_recipe(r, factor=f).recipe if f != 1 else r for r, f in picks)


def to_text(lines: Iterable[ShoppingLine]) -> str:
    return "\n".join(f"[ ] {line.text}" for line in lines)
