"""Main window: searchable library on the left, recipe view with scaling on the right."""
from __future__ import annotations

from fractions import Fraction
from typing import Optional

from PySide6.QtCore import QSettings, Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QHBoxLayout, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QMessageBox, QProgressDialog,
    QPushButton, QSplitter, QTextBrowser, QVBoxLayout, QWidget,
)

from .. import __version__
from ..db import RecipeDB
from ..formatting import recipe_to_text
from ..mealmaster import parse_file
from ..models import Recipe
from ..render import recipe_to_html
from ..scaling import scale_recipe
from .dialogs import RecipeEditor

FILE_FILTER = "MealMaster files (*.mmf *.mm *.txt);;All files (*)"


class MainWindow(QMainWindow):
    def __init__(self, db: RecipeDB):
        super().__init__()
        self.db = db
        self.current: Optional[Recipe] = None
        self.factor = Fraction(1)
        self._syncing = False
        self.settings = QSettings("RecipeLibrary", "RecipeLibrary")

        self.setWindowTitle("Recipe Library")
        self.resize(1150, 720)
        self._build_ui()
        self._build_actions()
        self._restore_state()

        self.search_timer = QTimer(self)
        self.search_timer.setSingleShot(True)
        self.search_timer.setInterval(200)
        self.search_timer.timeout.connect(self.reload_list)
        self.search_edit.textChanged.connect(lambda _text: self.search_timer.start())

        self.reload_categories()
        self.reload_list()

    # ------------------------------------------------------------------- UI

    def _build_ui(self) -> None:
        # Left: search, category filter, list
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Search titles, ingredients, directions...")
        self.search_edit.setClearButtonEnabled(True)
        self.category_combo = QComboBox()
        self.category_combo.currentIndexChanged.connect(lambda _i: self.reload_list())
        self.list = QListWidget()
        self.list.currentItemChanged.connect(self._on_item_changed)
        self.list.itemDoubleClicked.connect(lambda _item: self.edit_recipe())

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(6, 6, 6, 6)
        left_layout.addWidget(self.search_edit)
        left_layout.addWidget(self.category_combo)
        left_layout.addWidget(self.list, 1)

        # Right: scaling bar + recipe view + action buttons
        self.servings_spin = QDoubleSpinBox()
        self.servings_spin.setRange(0.01, 99999)
        self.servings_spin.setDecimals(2)
        self.servings_spin.setSingleStep(1)
        self.servings_spin.valueChanged.connect(self._on_servings_changed)
        self.factor_spin = QDoubleSpinBox()
        self.factor_spin.setRange(0.01, 999)
        self.factor_spin.setDecimals(3)
        self.factor_spin.setSingleStep(0.25)
        self.factor_spin.setSuffix(" ×")
        self.factor_spin.setValue(1.0)
        self.factor_spin.valueChanged.connect(self._on_factor_changed)
        self.smart_units = QCheckBox("Smart units")
        self.smart_units.setToolTip("Convert amounts to friendlier units, e.g. 8 Tbsp to 1/2 cup")
        self.smart_units.setChecked(True)
        self.smart_units.toggled.connect(lambda _on: self.refresh_view())

        scale_bar = QHBoxLayout()
        scale_bar.addWidget(QLabel("Scale:"))
        for label, value in (("½×", Fraction(1, 2)), ("1×", Fraction(1)), ("2×", Fraction(2)), ("3×", Fraction(3))):
            btn = QPushButton(label)
            btn.setMaximumWidth(48)
            btn.clicked.connect(lambda _checked=False, v=value: self.set_factor(v))
            scale_bar.addWidget(btn)
        scale_bar.addWidget(self.factor_spin)
        scale_bar.addSpacing(12)
        scale_bar.addWidget(QLabel("or make:"))
        scale_bar.addWidget(self.servings_spin)
        self.yield_unit_label = QLabel("")
        scale_bar.addWidget(self.yield_unit_label)
        scale_bar.addSpacing(12)
        scale_bar.addWidget(self.smart_units)
        scale_bar.addStretch(1)

        self.scale_widgets = QWidget()
        self.scale_widgets.setLayout(scale_bar)
        scale_bar.setContentsMargins(0, 0, 0, 0)

        self.view = QTextBrowser()
        self.view.setOpenExternalLinks(False)

        self.copy_btn = QPushButton("Copy as text")
        self.copy_btn.clicked.connect(self.copy_text)
        self.save_scaled_btn = QPushButton("Save scaled copy...")
        self.save_scaled_btn.setToolTip("Open the scaled recipe in the editor so you can save it as a new recipe")
        self.save_scaled_btn.clicked.connect(self.save_scaled_copy)
        self.edit_btn = QPushButton("Edit...")
        self.edit_btn.clicked.connect(self.edit_recipe)
        self.delete_btn = QPushButton("Delete")
        self.delete_btn.clicked.connect(self.delete_recipe)
        buttons = QHBoxLayout()
        buttons.addWidget(self.edit_btn)
        buttons.addWidget(self.delete_btn)
        buttons.addStretch(1)
        buttons.addWidget(self.copy_btn)
        buttons.addWidget(self.save_scaled_btn)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(6, 6, 6, 6)
        right_layout.addWidget(self.scale_widgets)
        right_layout.addWidget(self.view, 1)
        right_layout.addLayout(buttons)

        self.splitter = QSplitter()
        self.splitter.addWidget(left)
        self.splitter.addWidget(right)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([340, 800])
        self.setCentralWidget(self.splitter)
        self.statusBar()

    def _build_actions(self) -> None:
        def action(text, slot, shortcut=None):
            a = QAction(text, self)
            a.triggered.connect(lambda _checked=False: slot())
            if shortcut:
                a.setShortcut(QKeySequence(shortcut))
            return a

        file_menu = self.menuBar().addMenu("&File")
        file_menu.addAction(action("&Import MealMaster files...", self.import_files, "Ctrl+I"))
        file_menu.addAction(action("&New recipe...", self.new_recipe, "Ctrl+N"))
        file_menu.addSeparator()
        file_menu.addAction(action("&Quit", self.close, "Ctrl+Q"))

        recipe_menu = self.menuBar().addMenu("&Recipe")
        recipe_menu.addAction(action("&Edit...", self.edit_recipe, "Ctrl+E"))
        recipe_menu.addAction(action("&Delete", self.delete_recipe, "Ctrl+Backspace"))
        recipe_menu.addAction(action("Copy as &text", self.copy_text, "Ctrl+Shift+C"))
        recipe_menu.addAction(action("&Save scaled copy...", self.save_scaled_copy))

        edit_menu = self.menuBar().addMenu("&Search")
        edit_menu.addAction(action("&Find", self.focus_search, "Ctrl+F"))

        help_menu = self.menuBar().addMenu("&Help")
        help_menu.addAction(action("&About", self.about))

    def _restore_state(self) -> None:
        geometry = self.settings.value("geometry")
        if geometry is not None:
            self.restoreGeometry(geometry)
        sizes = self.settings.value("splitter")
        if sizes:
            try:
                self.splitter.setSizes([int(s) for s in sizes])
            except (TypeError, ValueError):
                pass

    def closeEvent(self, event) -> None:
        self.settings.setValue("geometry", self.saveGeometry())
        self.settings.setValue("splitter", self.splitter.sizes())
        super().closeEvent(event)

    # ---------------------------------------------------------- list loading

    def focus_search(self) -> None:
        self.search_edit.setFocus()
        self.search_edit.selectAll()

    def reload_categories(self) -> None:
        previous = self.category_combo.currentData()
        self.category_combo.blockSignals(True)
        self.category_combo.clear()
        self.category_combo.addItem(f"All categories ({self.db.count():,})", None)
        for name, count in self.db.list_categories():
            self.category_combo.addItem(f"{name} ({count})", name)
        index = self.category_combo.findData(previous) if previous else 0
        self.category_combo.setCurrentIndex(max(index, 0))
        self.category_combo.blockSignals(False)

    def reload_list(self, select_id: Optional[int] = None) -> None:
        if select_id is None and self.current is not None:
            select_id = self.current.id
        summaries = self.db.list_recipes(
            search=self.search_edit.text(), category=self.category_combo.currentData()
        )
        self.list.blockSignals(True)
        self.list.clear()
        row_to_select = -1
        for row, s in enumerate(summaries):
            item = QListWidgetItem(s.title)
            item.setData(Qt.ItemDataRole.UserRole, s.id)
            if s.categories:
                item.setToolTip(", ".join(s.categories))
            self.list.addItem(item)
            if s.id == select_id:
                row_to_select = row
        self.list.blockSignals(False)
        self.statusBar().showMessage(f"{len(summaries):,} of {self.db.count():,} recipes shown")
        if row_to_select >= 0:
            self.list.setCurrentRow(row_to_select)
        elif summaries:
            self.list.setCurrentRow(0)
        else:
            self._show_recipe(None)

    def _on_item_changed(self, item, _previous) -> None:
        if item is None:
            self._show_recipe(None)
        else:
            self._show_recipe(self.db.get_recipe(item.data(Qt.ItemDataRole.UserRole)))

    # -------------------------------------------------------- viewing/scaling

    def _show_recipe(self, recipe: Optional[Recipe]) -> None:
        self.current = recipe
        self.factor = Fraction(1)
        has = recipe is not None
        for w in (self.edit_btn, self.delete_btn, self.copy_btn, self.save_scaled_btn, self.scale_widgets):
            w.setEnabled(has)
        self._syncing = True
        self.factor_spin.setValue(1.0)
        has_yield = has and recipe.yield_quantity is not None and recipe.yield_quantity > 0
        self.servings_spin.setEnabled(bool(has_yield))
        if has_yield:
            self.servings_spin.setValue(float(recipe.yield_quantity))
            self.yield_unit_label.setText(recipe.yield_unit or "")
        else:
            self.servings_spin.setValue(self.servings_spin.minimum())
            self.yield_unit_label.setText("(no yield listed)" if has else "")
        self._syncing = False
        self.refresh_view()

    def set_factor(self, value: Fraction) -> None:
        if self.current is None:
            return
        self._apply_factor(value)

    def _apply_factor(self, factor: Fraction) -> None:
        self.factor = factor
        self._syncing = True
        self.factor_spin.setValue(float(factor))
        if self.current is not None and self.current.yield_quantity:
            self.servings_spin.setValue(float(self.current.yield_quantity * factor))
        self._syncing = False
        self.refresh_view()

    def _on_factor_changed(self, value: float) -> None:
        if self._syncing or self.current is None:
            return
        self._apply_factor(Fraction(str(round(value, 3))))

    def _on_servings_changed(self, value: float) -> None:
        if self._syncing or self.current is None or not self.current.yield_quantity:
            return
        target = Fraction(str(round(value, 2)))
        self.factor = target / self.current.yield_quantity
        self._syncing = True
        self.factor_spin.setValue(float(self.factor))
        self._syncing = False
        self.refresh_view()

    def _scaled(self) -> Optional[Recipe]:
        if self.current is None:
            return None
        if self.factor == 1:
            return self.current
        return scale_recipe(self.current, factor=self.factor, smart_units=self.smart_units.isChecked()).recipe

    def refresh_view(self) -> None:
        scaled = self._scaled()
        if scaled is None:
            self.view.setHtml("<p><i>Select a recipe, or use File &gt; Import to add some.</i></p>")
            return
        self.view.setHtml(recipe_to_html(scaled))
        notes = []
        if self.factor != 1:
            for w in scale_recipe(self.current, factor=self.factor).warnings:
                notes.append(w)
        self.statusBar().showMessage("  ".join(notes) if notes else
                                     f"{self.list.count():,} of {self.db.count():,} recipes shown")

    # ----------------------------------------------------------------- actions

    def _select(self, recipe_id: int) -> None:
        self.search_edit.blockSignals(True)
        self.search_edit.clear()
        self.search_edit.blockSignals(False)
        self.category_combo.blockSignals(True)
        self.category_combo.setCurrentIndex(0)
        self.category_combo.blockSignals(False)
        self.reload_list(select_id=recipe_id)

    def new_recipe(self) -> None:
        dialog = RecipeEditor(self)
        if dialog.exec():
            new_id = self.db.add_recipe(dialog.recipe())
            self.reload_categories()
            self._select(new_id)

    def edit_recipe(self) -> None:
        if self.current is None:
            return
        dialog = RecipeEditor(self, self.current)
        if dialog.exec():
            updated = dialog.recipe()
            self.db.update_recipe(updated)
            self.reload_categories()
            self.reload_list(select_id=updated.id)
            self._show_recipe(self.db.get_recipe(updated.id))

    def delete_recipe(self) -> None:
        if self.current is None:
            return
        answer = QMessageBox.question(
            self, "Delete recipe", f"Delete \"{self.current.title}\"? This can't be undone.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.db.delete_recipe(self.current.id)
            self.current = None
            self.reload_categories()
            self.reload_list()

    def copy_text(self) -> None:
        scaled = self._scaled()
        if scaled is not None:
            QApplication.clipboard().setText(recipe_to_text(scaled))
            self.statusBar().showMessage("Recipe copied to the clipboard", 3000)

    def save_scaled_copy(self) -> None:
        scaled = self._scaled()
        if scaled is None:
            return
        copy = scale_recipe(self.current, factor=self.factor, smart_units=self.smart_units.isChecked()).recipe
        copy.id = None
        if self.factor != 1:
            copy.title = f"{copy.title} (scaled)"
        dialog = RecipeEditor(self, copy)
        dialog.setWindowTitle("Save scaled copy as new recipe")
        if dialog.exec():
            new_id = self.db.add_recipe(dialog.recipe())
            self.reload_categories()
            self._select(new_id)

    def import_files(self) -> None:
        paths, _filter = QFileDialog.getOpenFileNames(self, "Import MealMaster files", "", FILE_FILTER)
        if not paths:
            return
        recipes, warnings, failed = [], [], []
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            for path in paths:
                try:
                    result = parse_file(path)
                except OSError as exc:
                    failed.append(f"{path}: {exc}")
                    continue
                recipes.extend(result.recipes)
                warnings.extend(result.warnings)
        finally:
            QApplication.restoreOverrideCursor()

        if not recipes:
            QMessageBox.information(self, "Import", "No recipes were found in the selected file(s).")
            return

        progress = QProgressDialog("Importing recipes...", "Cancel", 0, len(recipes), self)
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)

        def on_progress(done: int, total: int) -> bool:
            progress.setValue(done)
            QApplication.processEvents()
            return not progress.wasCanceled()

        summary = self.db.import_recipes(recipes, progress=on_progress)
        progress.close()

        self.reload_categories()
        self.reload_list()

        message = (f"Added {len(summary.added):,} recipe(s).\n"
                   f"Skipped {len(summary.skipped_duplicates):,} already in your library.")
        details = []
        if failed:
            details.append("Could not read:\n" + "\n".join(failed))
        if warnings:
            details.append("Notes:\n" + "\n".join(warnings[:50]))
        box = QMessageBox(QMessageBox.Icon.Information, "Import finished", message, parent=self)
        if details:
            box.setDetailedText("\n\n".join(details))
        box.exec()

    def about(self) -> None:
        QMessageBox.about(
            self, "About Recipe Library",
            f"<b>Recipe Library</b> {__version__}<br>"
            "Import MealMaster recipes, add your own, and scale them.<br><br>"
            f"Library file: {self.db.path}",
        )
