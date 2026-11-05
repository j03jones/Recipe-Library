"""Recipe add/edit dialog."""
from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout,
    QHeaderView, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPlainTextEdit,
    QPushButton, QSplitter, QStyledItemDelegate, QTableWidget, QTableWidgetItem, QTextBrowser,
    QVBoxLayout,
)

from ..editing import (
    UNIT_CHOICES, amount_for_editing, ingredient_from_fields, recipe_from_fields,
)
from ..formatting import format_yield
from .. import duplicates
from ..models import Recipe
from ..render import recipe_to_html

COLUMNS = ["Amount", "Unit", "Ingredient", "Group"]


class UnitDelegate(QStyledItemDelegate):
    """Editable drop-down for the Unit column (you can still type any unit)."""

    def createEditor(self, parent, option, index):
        box = QComboBox(parent)
        box.setEditable(True)
        box.addItems(UNIT_CHOICES)
        return box

    def setEditorData(self, editor, index):
        editor.setCurrentText(index.data(Qt.ItemDataRole.EditRole) or "")

    def setModelData(self, editor, model, index):
        model.setData(index, editor.currentText().strip(), Qt.ItemDataRole.EditRole)


class RecipeEditor(QDialog):
    """Create a new recipe, or edit an existing one when `recipe` is given."""

    def __init__(self, parent=None, recipe: Optional[Recipe] = None):
        super().__init__(parent)
        self._recipe_id = recipe.id if recipe is not None else None
        self._tags = list(recipe.tags) if recipe is not None else []
        self.setWindowTitle("Edit recipe" if self._recipe_id else "New recipe")
        self.resize(760, 680)

        self.title_edit = QLineEdit()
        self.categories_edit = QLineEdit()
        self.categories_edit.setPlaceholderText("e.g. Soups, Main dish")
        self.yield_edit = QLineEdit()
        self.yield_edit.setPlaceholderText("e.g. 4 servings, 24 cookies")

        self.author_edit = QLineEdit()
        self.author_edit.setPlaceholderText("Who wrote the recipe, e.g. Nora Taylor (leave blank if it's yours)")
        self.site_edit = QLineEdit()
        self.site_edit.setPlaceholderText("Website, book or person it came from, e.g. Nora Cooks")
        self.url_edit = QLineEdit()
        self.url_edit.setPlaceholderText("Link to the original, e.g. https://...")

        form = QFormLayout()
        form.addRow("Title:", self.title_edit)
        form.addRow("Categories:", self.categories_edit)
        form.addRow("Yield:", self.yield_edit)
        form.addRow("Recipe by:", self.author_edit)
        form.addRow("From:", self.site_edit)
        form.addRow("Original link:", self.url_edit)

        self.table = QTableWidget(0, len(COLUMNS))
        self.table.setHorizontalHeaderLabels(COLUMNS)
        self.table.setItemDelegateForColumn(1, UnitDelegate(self.table))
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)

        add_btn = QPushButton("Add ingredient")
        del_btn = QPushButton("Remove")
        up_btn = QPushButton("Move up")
        down_btn = QPushButton("Move down")
        add_btn.clicked.connect(self._add_row)
        del_btn.clicked.connect(self._remove_row)
        up_btn.clicked.connect(lambda: self._move_row(-1))
        down_btn.clicked.connect(lambda: self._move_row(1))
        row_buttons = QHBoxLayout()
        for b in (add_btn, del_btn, up_btn, down_btn):
            row_buttons.addWidget(b)
        row_buttons.addStretch(1)

        self.directions_edit = QPlainTextEdit()
        self.directions_edit.setPlaceholderText("Directions. Leave a blank line between paragraphs.")

        hint = QLabel("Amounts can be whole numbers, fractions (1/2, 1 1/2) or decimals. "
                      "Use the Group column for sub-headings such as Sauce or Topping.")
        hint.setWordWrap(True)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(QLabel("Ingredients"))
        layout.addWidget(self.table, 3)
        layout.addLayout(row_buttons)
        layout.addWidget(hint)
        layout.addWidget(QLabel("Directions"))
        layout.addWidget(self.directions_edit, 2)
        layout.addWidget(buttons)

        if recipe is not None:
            self._load(recipe)
        if self.table.rowCount() == 0:
            self._add_row()
        self.title_edit.setFocus()

    # ------------------------------------------------------------------ rows

    def _set_row(self, row: int, values: List[str]) -> None:
        for col, text in enumerate(values):
            self.table.setItem(row, col, QTableWidgetItem(text))

    def _add_row(self, values: Optional[List[str]] = None) -> None:
        if not isinstance(values, list):  # button clicks pass a bool
            values = ["", "", "", ""]
        row = self.table.rowCount()
        self.table.insertRow(row)
        self._set_row(row, values)
        self.table.setCurrentCell(row, 0)
        self.table.editItem(self.table.item(row, 0))

    def _remove_row(self) -> None:
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)

    def _read_rows(self) -> List[List[str]]:
        rows = []
        for r in range(self.table.rowCount()):
            rows.append([
                (self.table.item(r, c).text() if self.table.item(r, c) else "")
                for c in range(len(COLUMNS))
            ])
        return rows

    def _move_row(self, delta: int) -> None:
        row = self.table.currentRow()
        target = row + delta
        if row < 0 or not 0 <= target < self.table.rowCount():
            return
        rows = self._read_rows()
        rows[row], rows[target] = rows[target], rows[row]
        for r, values in enumerate(rows):
            self._set_row(r, values)
        self.table.setCurrentCell(target, 0)

    # ------------------------------------------------------------- load/save

    def _load(self, recipe: Recipe) -> None:
        self.title_edit.setText(recipe.title)
        self.categories_edit.setText(", ".join(recipe.categories))
        self.yield_edit.setText(format_yield(recipe) or recipe.yield_raw)
        self.directions_edit.setPlainText(recipe.directions)
        self.author_edit.setText(recipe.source_author)
        self.site_edit.setText(recipe.source_name)
        self.url_edit.setText(recipe.source_url)
        for ing in recipe.ingredients:
            row = self.table.rowCount()
            self.table.insertRow(row)
            self._set_row(row, [amount_for_editing(ing), ing.unit, ing.item, ing.group])

    def recipe(self) -> Recipe:
        ingredients = [ingredient_from_fields(a, u, i, g) for a, u, i, g in self._read_rows()]
        r = recipe_from_fields(
            self.title_edit.text(),
            self.categories_edit.text(),
            self.yield_edit.text(),
            ingredients,
            self.directions_edit.toPlainText(),
            recipe_id=self._recipe_id,
            tags=self._tags,
        )
        r.source_author = self.author_edit.text().strip()
        r.source_name = self.site_edit.text().strip()
        r.source_url = self.url_edit.text().strip()
        return r

    def accept(self) -> None:
        if not self.title_edit.text().strip():
            QMessageBox.warning(self, "Missing title", "Please give the recipe a title.")
            self.title_edit.setFocus()
            return
        super().accept()


class DuplicatesDialog(QDialog):
    """Review groups of near-duplicate recipes: pick the copy to keep, merge the rest into it,
    or mark the group as 'not duplicates'. Nothing changes until a button is pressed; the caller
    takes a database backup first."""

    def __init__(self, db, groups, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Find duplicate recipes")
        self.resize(1000, 640)
        self.db = db
        self.all_groups = list(groups)
        self.changed = False
        self._titles = {rid: t for rid, t in db.conn.execute("SELECT id, title FROM recipes")}

        self.level_filter = QComboBox()
        self.level_filter.addItem("All matches", None)
        for lv in duplicates.LEVELS:
            self.level_filter.addItem(duplicates.LEVEL_LABEL[lv], lv)
        self.level_filter.currentIndexChanged.connect(self._fill_groups)
        self.summary = QLabel()

        self.group_list = QListWidget()
        self.group_list.currentRowChanged.connect(self._group_changed)
        self.copy_list = QListWidget()
        self.copy_list.currentRowChanged.connect(self._copy_changed)
        self.detail = QTextBrowser()
        self.why = QLabel()
        self.why.setWordWrap(True)

        self.keep_btn = QPushButton("Keep this one, remove the others")
        self.keep_btn.setToolTip("Categories and tags from the removed copies are added to the one you keep.")
        self.keep_btn.clicked.connect(self._merge)
        self.different_btn = QPushButton("These are different recipes")
        self.different_btn.setToolTip("Don't flag this group again.")
        self.different_btn.clicked.connect(self._not_duplicates)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)

        right = QSplitter(Qt.Orientation.Vertical)
        top = QVBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        top.addWidget(QLabel("Copies in this group (select one to preview it):"))
        top.addWidget(self.copy_list)
        top.addWidget(self.why)
        topw = QDialog()  # plain container
        topw.setLayout(top)
        right.addWidget(topw)
        right.addWidget(self.detail)
        right.setSizes([180, 420])

        split = QSplitter()
        left = QVBoxLayout()
        left.setContentsMargins(0, 0, 0, 0)
        left.addWidget(self.level_filter)
        left.addWidget(self.group_list)
        leftw = QDialog()
        leftw.setLayout(left)
        split.addWidget(leftw)
        split.addWidget(right)
        split.setSizes([320, 680])

        buttons = QHBoxLayout()
        buttons.addWidget(self.keep_btn)
        buttons.addWidget(self.different_btn)
        buttons.addStretch(1)
        buttons.addWidget(close)
        lay = QVBoxLayout(self)
        lay.addWidget(self.summary)
        lay.addWidget(split, 1)
        lay.addLayout(buttons)
        self._fill_groups()

    # -- helpers
    def _visible_groups(self):
        lv = self.level_filter.currentData()
        return [g for g in self.all_groups if lv is None or g.level == lv]

    def _fill_groups(self) -> None:
        self.group_list.clear()
        self._shown = self._visible_groups()
        for g in self._shown:
            title = self._titles.get(g.keep_id, "?")
            self.group_list.addItem(QListWidgetItem(f"{title}  ({len(g.ids)} copies, {g.level})"))
        extra = sum(len(g.ids) - 1 for g in self.all_groups)
        self.summary.setText(f"{len(self.all_groups)} groups of similar recipes; "
                             f"{extra} recipes could be removed. Review each group before merging.")
        if self._shown:
            self.group_list.setCurrentRow(0)
        else:
            self.copy_list.clear()
            self.detail.setHtml("<p>No duplicates to review.</p>")
            self.why.setText("")
        self.keep_btn.setEnabled(bool(self._shown))
        self.different_btn.setEnabled(bool(self._shown))

    def _current_group(self):
        row = self.group_list.currentRow()
        return self._shown[row] if 0 <= row < len(self._shown) else None

    def _group_changed(self, _row: int) -> None:
        g = self._current_group()
        self.copy_list.clear()
        if g is None:
            return
        for n, rid in enumerate(g.ids):
            mark = "  (suggested to keep)" if n == 0 else ""
            item = QListWidgetItem(f"{self._titles.get(rid, '?')}{mark}")
            item.setData(Qt.ItemDataRole.UserRole, rid)
            self.copy_list.addItem(item)
        best = max(g.pairs, key=lambda p: p.ingredients + p.directions)
        self.why.setText(f"{g.label}. Closest match: ingredients {best.ingredients:.0%} alike, "
                         f"titles {best.title:.0%}, directions {best.directions:.0%}.")
        self.copy_list.setCurrentRow(0)

    def _copy_changed(self, row: int) -> None:
        item = self.copy_list.item(row) if row >= 0 else None
        if item is None:
            return
        recipe = self.db.get_recipe(item.data(Qt.ItemDataRole.UserRole))
        if recipe is not None:
            self.detail.setHtml(recipe_to_html(recipe))

    def _remove_current(self) -> None:
        g = self._current_group()
        self.all_groups.remove(g)
        self._fill_groups()

    # -- actions
    def _merge(self) -> None:
        g = self._current_group()
        item = self.copy_list.currentItem()
        if g is None or item is None:
            return
        keep = item.data(Qt.ItemDataRole.UserRole)
        others = [i for i in g.ids if i != keep]
        answer = QMessageBox.question(
            self, "Remove duplicates",
            f"Keep \u201c{self._titles.get(keep, '?')}\u201d and remove {len(others)} other "
            f"cop{'y' if len(others) == 1 else 'ies'}?\n\nTheir categories and tags will be added to the one you keep.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No)
        if answer != QMessageBox.StandardButton.Yes:
            return
        duplicates.merge_group(self.db, keep, others)
        for rid in others:
            self._titles.pop(rid, None)
        self.changed = True
        self._remove_current()

    def _not_duplicates(self) -> None:
        g = self._current_group()
        if g is None:
            return
        duplicates.ignore_group(self.db, g.ids)
        self._remove_current()


class LinksDialog(QDialog):
    """Recipes from an outside author's website: titles only, each opening on their own site."""

    def __init__(self, collection: dict, parent=None, on_import=None):
        super().__init__(parent)
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtCore import QUrl
        from ..link_data import link_for

        self._open = lambda url: QDesktopServices.openUrl(QUrl(url))
        self.setWindowTitle(f"Vegan recipes from {collection['site']}")
        self.resize(560, 640)

        intro = QLabel(
            f"<b>{collection['site']}</b>, recipes by <b>{collection['author']}</b>.<br>"
            "Double-click a recipe to open it on her website. To keep one you cook often, open it, "
            "copy its address and use <i>File &gt; Import recipe from a web page</i>. It is saved to "
            "your own library with her name and a link back.")
        intro.setWordWrap(True)
        intro.setTextFormat(Qt.TextFormat.RichText)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Filter")
        self.search.setClearButtonEnabled(True)
        self.list = QListWidget()
        self._items = []
        for section, titles in collection["sections"]:
            head = QListWidgetItem(section.upper())
            head.setFlags(Qt.ItemFlag.NoItemFlags)
            self.list.addItem(head)
            for t in titles:
                item = QListWidgetItem("    " + t)
                item.setData(Qt.ItemDataRole.UserRole, link_for(collection, t))
                self.list.addItem(item)
                self._items.append((item, t.lower()))
        self.list.itemDoubleClicked.connect(self._activate)
        self.search.textChanged.connect(self._filter)

        open_btn = QPushButton("Open on her website")
        open_btn.clicked.connect(lambda: self._activate(self.list.currentItem()))
        site_btn = QPushButton(f"Browse all of {collection['site']}")
        site_btn.clicked.connect(lambda: self._open(collection["home"]))
        buttons = QHBoxLayout()
        buttons.addWidget(open_btn)
        buttons.addWidget(site_btn)
        if on_import is not None:
            imp = QPushButton("Import from a link...")
            imp.clicked.connect(lambda: (self.accept(), on_import()))
            buttons.addWidget(imp)
        buttons.addStretch(1)
        close = QPushButton("Close")
        close.clicked.connect(self.accept)
        buttons.addWidget(close)

        layout = QVBoxLayout(self)
        layout.addWidget(intro)
        layout.addWidget(self.search)
        layout.addWidget(self.list, 1)
        layout.addLayout(buttons)

    def _activate(self, item) -> None:
        if item is not None and item.data(Qt.ItemDataRole.UserRole):
            self._open(item.data(Qt.ItemDataRole.UserRole))

    def _filter(self, text: str) -> None:
        t = text.strip().lower()
        for item, title in self._items:
            item.setHidden(bool(t) and t not in title)
