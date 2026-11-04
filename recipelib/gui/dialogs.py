"""Recipe add/edit dialog."""
from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout,
    QHeaderView, QLabel, QLineEdit, QMessageBox, QPlainTextEdit, QPushButton,
    QStyledItemDelegate, QTableWidget, QTableWidgetItem, QVBoxLayout,
)

from ..editing import (
    UNIT_CHOICES, amount_for_editing, ingredient_from_fields, recipe_from_fields,
)
from ..formatting import format_yield
from ..models import Recipe

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

        form = QFormLayout()
        form.addRow("Title:", self.title_edit)
        form.addRow("Categories:", self.categories_edit)
        form.addRow("Yield:", self.yield_edit)

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
        for ing in recipe.ingredients:
            row = self.table.rowCount()
            self.table.insertRow(row)
            self._set_row(row, [amount_for_editing(ing), ing.unit, ing.item, ing.group])

    def recipe(self) -> Recipe:
        ingredients = [ingredient_from_fields(a, u, i, g) for a, u, i, g in self._read_rows()]
        return recipe_from_fields(
            self.title_edit.text(),
            self.categories_edit.text(),
            self.yield_edit.text(),
            ingredients,
            self.directions_edit.toPlainText(),
            recipe_id=self._recipe_id,
            tags=self._tags,
        )

    def accept(self) -> None:
        if not self.title_edit.text().strip():
            QMessageBox.warning(self, "Missing title", "Please give the recipe a title.")
            self.title_edit.setFocus()
            return
        super().accept()
