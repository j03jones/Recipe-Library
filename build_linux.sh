#!/usr/bin/env bash
# Build a standalone Linux app. Run from the project folder with the virtual
# environment active (source .venv/bin/activate).
set -euo pipefail

pip install --upgrade pyinstaller
pyinstaller --noconfirm --clean --windowed --name RecipeLibrary launch.py

echo
echo "Done. Run it with:  dist/RecipeLibrary/RecipeLibrary"
echo "To share it, copy or zip the whole dist/RecipeLibrary folder."
