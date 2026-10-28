#!/bin/bash
# Serve the happy-app web build. install.sh copies this file into
# $HAPPY_LOCAL, and launchd runs it. The settings come from config.env.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/config.env"

exec "$NODE_BIN" "$HAPPY_SRC/.rayno/lib/web-serve.mjs" \
    --root "$HAPPY_LOCAL/web" \
    --port "$WEB_PORT" \
    --server-url "$SERVER_PUBLIC_URL"
