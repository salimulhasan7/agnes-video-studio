#!/bin/bash
# Start a static server for the Agnes Video Studio preview.
# Usage: bash start.sh

PORT="${PORT:-8080}"

if command -v python3 >/dev/null 2>&1; then
  echo "Serving on http://localhost:$PORT"
  python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  echo "Serving on http://localhost:$PORT"
  npx --yes serve -l "$PORT" .
else
  echo "No python3 or npx found. Install one of them."
  exit 1
fi
