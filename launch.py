"""Entry point used by the packaged app (PyInstaller needs a plain script, not `-m`)."""
import sys

from recipelib.gui.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
