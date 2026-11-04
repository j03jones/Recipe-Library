"""Export recipes to the compact JSON the offline web app loads.

    python3 tools/export_web.py --db ~/.local/share/recipe-library/recipes.db
    python3 tools/export_web.py --mmf file1.mmf file2.mmf ...

Writes web/data/recipes.json (override with --out). Duplicates (same content) are dropped.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recipelib import categories  # noqa: E402
from recipelib.db import RecipeDB, content_hash  # noqa: E402
from recipelib.mealmaster import parse_file  # noqa: E402


def recipe_to_row(r) -> list:
    """[id, title, categories, yield_qty, yield_unit, yield_raw, ingredients, directions, tags]
    id is a stable fingerprint of the content, so edits made on a phone stay attached to the
    right recipe even when the library is re-exported. ingredient = [qty ("9/4" or ""),
    raw_qty, unit, item, group]."""
    ings = [
        [str(i.quantity) if i.quantity is not None else "", i.raw_quantity, i.unit, i.item, i.group]
        for i in r.ingredients
    ]
    yq = str(r.yield_quantity) if r.yield_quantity is not None else ""
    return [content_hash(r)[:10], r.title, categories.in_display_order(r.categories), yq, r.yield_unit, r.yield_raw, ings, r.directions, list(r.tags)]


def main() -> int:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--db", help="a Recipe Library database file")
    src.add_argument("--mmf", nargs="+", help="MealMaster files")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "web" / "data" / "recipes.json"))
    args = ap.parse_args()

    recipes = []
    if args.db:
        with RecipeDB(args.db) as db:
            for s in db.list_recipes():
                recipes.append(db.get_recipe(s.id))
    else:
        for path in args.mmf:
            recipes.extend(parse_file(path).recipes)

    seen, rows = set(), []
    for r in recipes:
        if not r.tags:  # not tidied yet: keep the old labels as tags and file under the groups
            categories.apply(r)
        h = content_hash(r)
        if h in seen:
            continue
        seen.add(h)
        rows.append(recipe_to_row(r))
    rows.sort(key=lambda row: row[1].lower())

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"v": 1, "recipes": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(rows):,} recipes to {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
