#!/usr/bin/env bash
#
# Back up the local Happy server DB ($HAPPY_LOCAL/server).
#
#   backup-db.sh             Stop the server, back up, start the server again.
#   backup-db.sh --offline   Back up only. The server must already be stopped.
#                            run-server.sh uses this before it opens the DB.
#   backup-db.sh --revision  Print the revision of the server code.
#   backup-db.sh --list      List the backups.
#
# A backup is copied to backup-<date>-<time>/server.partial, checked with a
# file count and `diff -rq`, and then renamed to server. A failed check
# removes the partial copy and exits non-zero.
#
# After a good backup, only the newest $KEEP backups stay (default 1). Only
# folders named backup-YYYYMMDD-HHMMSS that hold server/pglite are removed.
#
# The settings come from config.env next to this file, which install.sh
# writes. KEEP sets the number of backups to keep (default 1).
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/config.env"
KEEP="${KEEP:-1}"
LABEL="$SERVER_LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="$SERVER_PORT"
DATA="$HAPPY_LOCAL/server"
STATE="$HAPPY_LOCAL/last-backup-revision"

log() { echo "backup-db: $*"; }

# The code that run-server.sh runs: clone path, commit, and a hash of
# uncommitted edits in the server package.
revision() {
    local head dirty
    head="$(git -C "$HAPPY_SRC" rev-parse HEAD 2>/dev/null || echo none)"
    dirty="$(git -C "$HAPPY_SRC" status --porcelain -- packages/happy-server 2>/dev/null | shasum | cut -c1-12)"
    echo "$HAPPY_SRC $head $dirty"
}

port_up() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

wait_for() { # $1 = up|down, $2 = seconds
    local i
    for ((i = 0; i < $2; i++)); do
        if [ "$1" = up ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = 200 ]; then return 0; fi
        if [ "$1" = down ] && ! port_up; then return 0; fi
        perl -e 'select(undef, undef, undef, 1)'
    done
    return 1
}

list_backups() {
    local d
    for d in "$HAPPY_LOCAL"/backup-*; do
        [ -d "$d/server/pglite" ] || continue
        [[ "$(basename "$d")" =~ ^backup-[0-9]{8}-[0-9]{6}$ ]] || continue
        echo "$d"
    done | sort
}

backup_offline() {
    [ -d "$DATA/pglite" ] || { log "no DB at $DATA"; return 1; }
    if port_up; then
        log "port $PORT is in use. Stop the server first."
        return 1
    fi

    local need free dest src_count dst_count
    need="$(du -sk "$DATA" | cut -f1)"
    free="$(df -k "$HAPPY_LOCAL" | awk 'NR == 2 { print $4 }')"
    if [ "$free" -lt $((need * 2)) ]; then
        log "not enough disk space: need $((need * 2)) KB, have $free KB"
        return 1
    fi

    dest="$HAPPY_LOCAL/backup-$(date +%Y%m%d-%H%M%S)"
    [ ! -e "$dest" ] || { log "$dest exists already"; return 1; }
    mkdir -m 700 "$dest"
    log "copying $DATA to $dest"
    if ! cp -a "$DATA" "$dest/server.partial"; then
        log "copy failed"
        rm -rf "$dest"
        return 1
    fi

    src_count="$(find "$DATA" -type f | wc -l | tr -d ' ')"
    dst_count="$(find "$dest/server.partial" -type f | wc -l | tr -d ' ')"
    if [ "$src_count" != "$dst_count" ] || ! diff -rq "$DATA" "$dest/server.partial" >/dev/null; then
        log "check failed: $src_count files in the DB, $dst_count in the copy"
        rm -rf "$dest"
        return 1
    fi
    mv "$dest/server.partial" "$dest/server"
    cp -a "$HAPPY_LOCAL/run-server.sh" "$dest/run-server.sh" 2>/dev/null || true
    revision > "$dest/REVISION"
    revision > "$STATE"
    log "backup verified: $dst_count files, $(du -sh "$dest/server" | cut -f1)"

    local -a all=()
    local d
    while IFS= read -r d; do all+=("$d"); done < <(list_backups)
    if [ "${#all[@]}" -gt "$KEEP" ]; then
        for d in "${all[@]:0:$((${#all[@]} - KEEP))}"; do
            log "removing older backup $d"
            rm -rf "$d"
        done
    fi
}

restart_started=0
restart() {
    if [ "$restart_started" -eq 0 ]; then
        restart_started=1
        launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
        if wait_for up 120; then log "server is up"; else log "server did NOT come up. See $HAPPY_LOCAL/server.log"; fi
    fi
}

backup_with_restart() {
    trap restart EXIT

    log "stopping the server"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    wait_for down 30 || { log "server did not stop"; return 1; }
    backup_offline
}

case "${1:-}" in
    "") backup_with_restart ;;
    --offline) backup_offline ;;
    --revision) revision ;;
    --list) list_backups ;;
    *) echo "usage: $0 [--offline | --revision | --list]" >&2; exit 2 ;;
esac
