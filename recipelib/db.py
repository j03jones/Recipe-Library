"""SQLite-backed recipe library."""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from .models import Ingredient, Recipe

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS recipes (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,
    directions   TEXT NOT NULL DEFAULT '',
    yield_qty    TEXT,
    yield_unit   TEXT NOT NULL DEFAULT '',
    yield_raw    TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_recipes_hash ON recipes(content_hash);
CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS recipe_categories (
    recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, category_id)
);
CREATE TABLE IF NOT EXISTS ingredients (
    id        INTEGER PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    grp       TEXT NOT NULL DEFAULT '',
    qty       TEXT,
    raw_qty   TEXT NOT NULL DEFAULT '',
    unit      TEXT NOT NULL DEFAULT '',
    item      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id, position);
"""


@dataclass
class RecipeSummary:
    id: int
    title: str
    categories: List[str] = field(default_factory=list)


@dataclass
class ImportSummary:
    added: List[int] = field(default_factory=list)
    skipped_duplicates: List[str] = field(default_factory=list)  # titles


def default_db_path() -> Path:
    """Per-user data location on Linux, macOS, and Windows."""
    if sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "recipe-library" / "recipes.db"


def content_hash(recipe: Recipe) -> str:
    """Stable fingerprint of a recipe's content, used to spot duplicate imports."""
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip().lower()

    parts = [norm(recipe.title)]
    for ing in recipe.ingredients:
        q = str(ing.quantity) if ing.quantity is not None else ing.raw_quantity
        parts.append(f"{q}|{norm(ing.unit)}|{norm(ing.item)}")
    parts.append(norm(recipe.directions))
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RecipeDB:
    def __init__(self, path=":memory:"):
        self.path = str(path)
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._has_fts = self._init_fts()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------- full text

    def _init_fts(self) -> bool:
        try:
            self.conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts "
                "USING fts5(title, ingredients, directions, categories)"
            )
            return True
        except sqlite3.OperationalError:  # SQLite built without FTS5
            return False

    def _index(self, recipe_id: int, recipe: Recipe) -> None:
        if not self._has_fts:
            return
        self.conn.execute("DELETE FROM recipes_fts WHERE rowid = ?", (recipe_id,))
        self.conn.execute(
            "INSERT INTO recipes_fts(rowid, title, ingredients, directions, categories) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                recipe_id,
                recipe.title,
                " ".join(i.item for i in recipe.ingredients),
                recipe.directions,
                " ".join(recipe.categories),
            ),
        )

    # ----------------------------------------------------------------- write

    def _write_children(self, recipe_id: int, recipe: Recipe) -> None:
        c = self.conn
        c.execute("DELETE FROM ingredients WHERE recipe_id = ?", (recipe_id,))
        c.execute("DELETE FROM recipe_categories WHERE recipe_id = ?", (recipe_id,))
        for pos, ing in enumerate(recipe.ingredients):
            c.execute(
                "INSERT INTO ingredients(recipe_id, position, grp, qty, raw_qty, unit, item) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    recipe_id, pos, ing.group,
                    str(ing.quantity) if ing.quantity is not None else None,
                    ing.raw_quantity, ing.unit, ing.item,
                ),
            )
        seen = set()
        for name in recipe.categories:
            name = name.strip()
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            c.execute("INSERT OR IGNORE INTO categories(name) VALUES (?)", (name,))
            cat_id = c.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()["id"]
            c.execute(
                "INSERT INTO recipe_categories(recipe_id, category_id) VALUES (?, ?)",
                (recipe_id, cat_id),
            )

    def add_recipe(self, recipe: Recipe) -> int:
        now = _now()
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO recipes(title, directions, yield_qty, yield_unit, yield_raw, "
                "content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    recipe.title, recipe.directions,
                    str(recipe.yield_quantity) if recipe.yield_quantity is not None else None,
                    recipe.yield_unit, recipe.yield_raw, content_hash(recipe), now, now,
                ),
            )
            rid = cur.lastrowid
            self._write_children(rid, recipe)
            self._index(rid, recipe)
        recipe.id = rid
        return rid

    def update_recipe(self, recipe: Recipe) -> None:
        if recipe.id is None:
            raise ValueError("Recipe has no id; use add_recipe for new recipes.")
        with self.conn:
            cur = self.conn.execute(
                "UPDATE recipes SET title=?, directions=?, yield_qty=?, yield_unit=?, "
                "yield_raw=?, content_hash=?, updated_at=? WHERE id=?",
                (
                    recipe.title, recipe.directions,
                    str(recipe.yield_quantity) if recipe.yield_quantity is not None else None,
                    recipe.yield_unit, recipe.yield_raw, content_hash(recipe), _now(), recipe.id,
                ),
            )
            if cur.rowcount == 0:
                raise KeyError(f"No recipe with id {recipe.id}")
            self._write_children(recipe.id, recipe)
            self._index(recipe.id, recipe)
            self._prune_categories()

    def delete_recipe(self, recipe_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM recipes WHERE id = ?", (recipe_id,))
            if self._has_fts:
                self.conn.execute("DELETE FROM recipes_fts WHERE rowid = ?", (recipe_id,))
            self._prune_categories()

    def _prune_categories(self) -> None:
        self.conn.execute(
            "DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM recipe_categories)"
        )

    # ------------------------------------------------------------------ read

    def get_recipe(self, recipe_id: int) -> Optional[Recipe]:
        row = self.conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if row is None:
            return None
        ings = [
            Ingredient(
                item=r["item"],
                quantity=Fraction(r["qty"]) if r["qty"] is not None else None,
                unit=r["unit"], group=r["grp"], raw_quantity=r["raw_qty"],
            )
            for r in self.conn.execute(
                "SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY position", (recipe_id,)
            )
        ]
        cats = [
            r["name"]
            for r in self.conn.execute(
                "SELECT c.name FROM categories c JOIN recipe_categories rc ON rc.category_id = c.id "
                "WHERE rc.recipe_id = ? ORDER BY c.name COLLATE NOCASE",
                (recipe_id,),
            )
        ]
        return Recipe(
            id=row["id"], title=row["title"], ingredients=ings, directions=row["directions"],
            categories=cats,
            yield_quantity=Fraction(row["yield_qty"]) if row["yield_qty"] is not None else None,
            yield_unit=row["yield_unit"], yield_raw=row["yield_raw"],
        )

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM recipes").fetchone()[0]

    def list_categories(self) -> List[Tuple[str, int]]:
        rows = self.conn.execute(
            "SELECT c.name, COUNT(rc.recipe_id) AS n FROM categories c "
            "JOIN recipe_categories rc ON rc.category_id = c.id "
            "GROUP BY c.id ORDER BY c.name COLLATE NOCASE"
        )
        return [(r["name"], r["n"]) for r in rows]

    def list_recipes(
        self, search: str = "", category: Optional[str] = None, limit: Optional[int] = None
    ) -> List[RecipeSummary]:
        sql = "SELECT r.id, r.title FROM recipes r"
        where, params = [], []
        search = search.strip()
        if search:
            ids = self._search_ids(search)
            where.append(f"r.id IN ({','.join('?' * len(ids)) or 'NULL'})")
            params.extend(ids)
        if category:
            where.append(
                "r.id IN (SELECT rc.recipe_id FROM recipe_categories rc "
                "JOIN categories c ON c.id = rc.category_id WHERE c.name = ?)"
            )
            params.append(category)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY r.title COLLATE NOCASE"
        if limit:
            sql += f" LIMIT {int(limit)}"
        out = []
        for row in self.conn.execute(sql, params).fetchall():
            cats = [
                r["name"]
                for r in self.conn.execute(
                    "SELECT c.name FROM categories c JOIN recipe_categories rc "
                    "ON rc.category_id = c.id WHERE rc.recipe_id = ? ORDER BY c.name COLLATE NOCASE",
                    (row["id"],),
                )
            ]
            out.append(RecipeSummary(id=row["id"], title=row["title"], categories=cats))
        return out

    def _search_ids(self, text: str) -> List[int]:
        tokens = re.findall(r"\w+", text)
        if not tokens:
            return []
        if self._has_fts:
            query = " ".join(f'"{t}"*' for t in tokens)
            try:
                return [r[0] for r in self.conn.execute(
                    "SELECT rowid FROM recipes_fts WHERE recipes_fts MATCH ?", (query,))]
            except sqlite3.OperationalError:
                pass
        # Fallback: every token must appear in title, directions, ingredients, or categories.
        ids = None
        for t in tokens:
            like = f"%{t}%"
            found = {r[0] for r in self.conn.execute(
                "SELECT id FROM recipes WHERE title LIKE ? OR directions LIKE ? "
                "UNION SELECT recipe_id FROM ingredients WHERE item LIKE ? "
                "UNION SELECT rc.recipe_id FROM recipe_categories rc "
                "JOIN categories c ON c.id = rc.category_id WHERE c.name LIKE ?",
                (like, like, like, like))}
            ids = found if ids is None else ids & found
        return sorted(ids or [])

    # ---------------------------------------------------------------- import

    def find_duplicate(self, recipe: Recipe) -> Optional[int]:
        row = self.conn.execute(
            "SELECT id FROM recipes WHERE content_hash = ?", (content_hash(recipe),)
        ).fetchone()
        return row["id"] if row else None

    def import_recipes(
        self, recipes: Iterable[Recipe], skip_duplicates: bool = True, progress=None
    ) -> ImportSummary:
        """Add recipes, skipping exact duplicates.

        progress, if given, is called as progress(done, total) after each recipe; returning
        False from it stops the import early (recipes already added are kept).
        """
        items = list(recipes)
        summary = ImportSummary()
        for n, r in enumerate(items, 1):
            if skip_duplicates and self.find_duplicate(r) is not None:
                summary.skipped_duplicates.append(r.title)
            else:
                summary.added.append(self.add_recipe(r))
            if progress is not None and progress(n, len(items)) is False:
                break
        return summary
