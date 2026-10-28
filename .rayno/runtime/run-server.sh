#!/bin/bash
# Start the local Happy server. install.sh copies this file into $HAPPY_LOCAL,
# and launchd runs it. The settings come from config.env next to it.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/config.env"

export DB_PROVIDER=pglite
export DATA_DIR="$HAPPY_LOCAL/server"
export PGLITE_DIR="$DATA_DIR/pglite"
HANDY_MASTER_SECRET="$(cat "$DATA_DIR/master-secret")"
export HANDY_MASTER_SECRET
export PORT="$SERVER_PORT"
export HOST=127.0.0.1
export PUBLIC_URL="$SERVER_PUBLIC_URL"

TSX="$HAPPY_SRC/packages/happy-server/node_modules/tsx/dist/cli.mjs"
[ -f "$TSX" ] || TSX="$HAPPY_SRC/node_modules/tsx/dist/cli.mjs"

# Back up the DB before new server code opens it. The DB is still closed here.
# A failed backup stops the start, so a migration never runs without a backup.
# A new install has no DB yet, so there is nothing to back up.
if [ -d "$PGLITE_DIR" ] &&
    [ "$("$HAPPY_LOCAL/backup-db.sh" --revision)" != "$(cat "$HAPPY_LOCAL/last-backup-revision" 2>/dev/null)" ]; then
    echo "run-server: the server code changed since the last backup; backing up first"
    "$HAPPY_LOCAL/backup-db.sh" --offline || { echo "run-server: backup failed; not starting"; exit 1; }
fi

cd "$HAPPY_SRC/packages/happy-server"
"$NODE_BIN" "$TSX" sources/standalone.ts migrate
[ -f "$HAPPY_LOCAL/last-backup-revision" ] || "$HAPPY_LOCAL/backup-db.sh" --revision > "$HAPPY_LOCAL/last-backup-revision"
exec "$NODE_BIN" "$TSX" sources/standalone.ts serve
