"""Tiny command-line front end, handy for trying the core before the GUI exists.

    python -m recipelib import samples/sample.mmf
    python -m recipelib list [search words]
    python -m recipelib show 1
    python -m recipelib scale 1 --servings 12      (or --factor 2)
"""
from __future__ import annotations

import argparse
import sys
from fractions import Fraction

from .db import RecipeDB, default_db_path
from .formatting import recipe_to_text
from .mealmaster import parse_file
from .scaling import scale_recipe


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recipelib")
    ap.add_argument("--db", default=str(default_db_path()), help="database file")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("import"); p.add_argument("files", nargs="+")
    p = sub.add_parser("list"); p.add_argument("search", nargs="*")
    p = sub.add_parser("show"); p.add_argument("id", type=int)
    p = sub.add_parser("scale"); p.add_argument("id", type=int)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--factor"); g.add_argument("--servings")
    args = ap.parse_args(argv)

    with RecipeDB(args.db) as db:
        if args.cmd == "import":
            for path in args.files:
                res = parse_file(path)
                summary = db.import_recipes(res.recipes)
                print(f"{path}: {len(summary.added)} added, "
                      f"{len(summary.skipped_duplicates)} duplicates skipped")
                for w in res.warnings:
                    print("  warning:", w)
        elif args.cmd == "list":
            for s in db.list_recipes(search=" ".join(args.search)):
                print(f"{s.id:>5}  {s.title}  [{', '.join(s.categories)}]")
        else:
            recipe = db.get_recipe(args.id)
            if recipe is None:
                print(f"No recipe with id {args.id}", file=sys.stderr)
                return 1
            if args.cmd == "scale":
                try:
                    res = scale_recipe(
                        recipe,
                        factor=Fraction(args.factor) if args.factor else None,
                        target_servings=Fraction(args.servings) if args.servings else None,
                    )
                except ValueError as e:
                    print(e, file=sys.stderr)
                    return 1
                recipe = res.recipe
                for w in res.warnings:
                    print("warning:", w, file=sys.stderr)
            print(recipe_to_text(recipe))
    return 0


if __name__ == "__main__":
    sys.exit(main())
