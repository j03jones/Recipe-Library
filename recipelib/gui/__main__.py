"""Launch with:  python3 -m recipelib.gui   [--db /path/to/recipes.db]"""
from __future__ import annotations

import argparse
import sys

from ..db import RecipeDB, default_db_path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recipelib.gui")
    ap.add_argument("--db", default=str(default_db_path()), help="library file to open")
    args = ap.parse_args(argv)

    try:
        from PySide6.QtWidgets import QApplication
    except ImportError:
        print("PySide6 is not installed in this Python environment.\n"
              "Activate your virtual environment (source .venv/bin/activate) and run:\n"
              "    pip install PySide6", file=sys.stderr)
        return 1

    from .mainwindow import MainWindow

    app = QApplication(sys.argv[:1])
    app.setApplicationName("Recipe Library")
    db = RecipeDB(args.db)
    window = MainWindow(db)
    window.show()
    code = app.exec()
    db.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
