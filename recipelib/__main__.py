"""Tiny command-line front end, handy for trying the core before the GUI exists.

    python -m recipelib import samples/sample.mmf
    python -m recipelib list [search words]
    python -m recipelib show 1
    python -m recipelib scale 1 --servings 12      (or --factor 2)
    python -m recipelib regroup --preview          (show the tidy category groups, change nothing)
    python -m recipelib regroup                    (apply them; backs up the database first)
    python -m recipelib regroup --restore          (put the original categories back)
    python -m recipelib duplicates                 (report near-duplicate groups, change nothing)
    python -m recipelib duplicates --remove high   (merge each 'high' group into its best copy; backs up first)
"""
from __future__ import annotations

import argparse
import sys
from fractions import Fraction

from . import categories, duplicates
from .db import RecipeDB, default_db_path
from .formatting import recipe_to_text
from .mealmaster import parse_file
from .scaling import scale_recipe


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recipelib")
    ap.add_argument("--db", default=str(default_db_path()), help="database file")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("import"); p.add_argument("files", nargs="+")
    p = sub.add_parser("regroup")
    g2 = p.add_mutually_exclusive_group()
    g2.add_argument("--preview", action="store_true"); g2.add_argument("--restore", action="store_true")
    p = sub.add_parser("duplicates")
    p.add_argument("--limit", type=int, default=40, help="groups to print (default 40)")
    p.add_argument("--remove", choices=list(duplicates.LEVELS),
                   help="merge groups of this confidence or better into their best copy")
    p.add_argument("--yes", action="store_true", help="don't ask before removing")
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
                summary = db.import_recipes(res.recipes, regroup=True)
                print(f"{path}: {len(summary.added)} added, "
                      f"{len(summary.skipped_duplicates)} duplicates skipped")
                for w in res.warnings:
                    print("  warning:", w)
        elif args.cmd == "regroup":
            if args.preview:
                print(categories.report(db.light_recipes()))
            elif args.restore:
                backup = db.backup()
                print(f"Restored original categories on {db.restore_original_categories():,} recipes."
                      + (f" Backup: {backup}" if backup else ""))
            else:
                backup = db.backup()
                n = db.regroup_all()
                print(f"Filed {n:,} recipes under {len(db.list_categories())} groups."
                      + (f" Backup: {backup}" if backup else ""))
        elif args.cmd == "duplicates":
            groups = duplicates.scan(db)
            if not args.remove:
                print(duplicates.report(groups, db, limit=args.limit))
                return 0
            cutoff = duplicates.LEVELS.index(args.remove)
            chosen = [g for g in groups if duplicates.LEVELS.index(g.level) <= cutoff]
            n = sum(len(g.ids) - 1 for g in chosen)
            print(f"{len(chosen)} groups, {n} recipes would be removed (the first of each group is kept).")
            if not n:
                return 0
            if not args.yes and input("Type 'yes' to continue: ").strip().lower() != "yes":
                print("Cancelled.")
                return 1
            backup = db.backup()
            removed = sum(duplicates.merge_group(db, g.keep_id, g.ids[1:]) for g in chosen)
            print(f"Removed {removed:,} duplicates." + (f" Backup: {backup}" if backup else ""))
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
