#!/usr/bin/env bash
# Start the REDLINE server (if it isn't already up) and open the game.
cd "$(dirname "$0")"
PORT=8126
if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  python3 serve.py >/dev/null 2>&1 &
  sleep 0.5
fi
BROWSER=$(command -v firefox || command -v google-chrome || command -v chromium)
"$BROWSER" "http://localhost:$PORT/" >/dev/null 2>&1 &
