#!/bin/bash
#
# Undo .rayno/install.sh.
#
#   .rayno/uninstall.sh [--purge]
#
# By default this removes what install.sh added: the two launchd jobs, the
# Tailscale routes that it made, the global `happy` link, and the URL
# settings. It keeps your data: the DB, the master secret, ~/.happy, and the
# clone. When install.sh took over an older job, this puts that job back.
#
#   --purge   Also delete $HAPPY_LOCAL, after a final archive in your home
#             folder. You must type "delete" to confirm.
#
# It reads $HAPPY_LOCAL/install-manifest.json and changes only what the
# manifest records. Use the same environment values as for install.sh.
#
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

PURGE=0
for a in "$@"; do
    case "$a" in
        --purge) PURGE=1 ;;
        -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $a (see --help)" ;;
    esac
done

[ -f "$MANIFEST" ] || die "no install found: $MANIFEST does not exist"
LOCK="$HAPPY_LOCAL/.install.lock"
mkdir "$LOCK" 2>/dev/null || die "another install or uninstall is running (remove $LOCK if not)"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

SERVER_PORT="$(mf get ports.server)"
WEB_PORT="$(mf get ports.web)"
SERVER_LABEL="$(mf get labels.server)"
WEB_LABEL="$(mf get labels.web)"
HOST="$(mf get host)"

if [ "$PURGE" -eq 1 ]; then
    echo "${C_BOLD}--purge deletes $HAPPY_LOCAL${C_OFF}, which holds the server DB and the master secret."
    echo "Every account on this server and all its data go away."
    echo "A final archive goes to your home folder first."
    [ -t 0 ] || die "--purge needs a terminal for the confirmation"
    read -r -p 'Type "delete" to continue: ' answer
    [ "$answer" = delete ] || die "stopped. Nothing changed."
fi

# --- 1. Services --------------------------------------------------------------

step "Stopping the services"
for pair in "$WEB_LABEL:$WEB_PORT" "$SERVER_LABEL:$SERVER_PORT"; do
    label="${pair%%:*}"
    port="${pair#*:}"
    job_stop "$label"
    wait_port_down "$port" 30 || warn "port $port is still in use"
    ok "stopped $label"
done

# --- 2. Tailscale -------------------------------------------------------------

step "Removing the Tailscale routes that install.sh added"
for port in $(mf keys tailscale); do
    if [ "$(mf get "tailscale.$port.added")" = true ]; then
        if [ "$(serve_target "$HOST" "$port")" = "http://127.0.0.1:$port" ]; then
            tailscale serve --https="$port" off >/dev/null
            ok "removed https://$HOST:$port"
        else
            warn "https://$HOST:$port changed after the install. It stays."
        fi
    else
        info "kept https://$HOST:$port (it was there before the install)"
    fi
done

# --- 3. CLI -------------------------------------------------------------------

step "Restoring the Happy CLI"
if [ "$(mf get cli.linked)" = true ]; then
    # restore_link <manifest key> <path>
    restore_link() {
        local kind target
        kind="$(mf get "cli.$1.kind")"
        target="$(mf get "cli.$1.target")"
        rm -f "$2"
        case "$kind" in
            link) ln -s "$target" "$2" ;;
            moved) [ -e "$target" ] && mv "$target" "$2" ;;
        esac
    }
    restore_link root "$(mf get cli.rootPath)"
    restore_link bin "$(mf get cli.binPath)"
    ok "restored the global happy command"
fi

SETTINGS="$(mf get settings.file)"
if [ -n "$SETTINGS" ] && [ -f "$SETTINGS" ]; then
    for key in $(mf keys settings); do
        [ "$key" = file ] && continue
        if [ "$(json get "$SETTINGS" "$key")" != "$(mf get "settings.$key.value")" ]; then
            warn "$key in $SETTINGS changed after the install. It stays."
        elif [ "$(mf get "settings.$key.had")" = true ]; then
            json set "$SETTINGS" "$key" "$(mf get "settings.$key.prev")"
        else
            json del "$SETTINGS" "$key"
        fi
    done
    ok "restored serverUrl and webappUrl in $SETTINGS"
fi

# --- 4. Files -----------------------------------------------------------------

step "Removing the files that install.sh wrote"
for name in $(mf keys files); do
    path="$(mf get "files.$name.path")"
    backup="$(mf get "files.$name.backup")"
    rm -f "$path"
    if [ -n "$backup" ] && [ -e "$backup" ]; then
        mv "$backup" "$path"
        ok "restored $path"
    else
        ok "removed $path"
    fi
done
rm -rf "$(mf get webDir)"

# --- 5. Older job -------------------------------------------------------------

old_label="$(mf get adopted.label)"
if [ -n "$old_label" ]; then
    backup="$(mf get adopted.backup)"
    if [ "$PURGE" -eq 1 ]; then
        warn "$old_label used the data that --purge deletes, so it is not restored."
        info "its plist is in the archive: install-backup/$old_label.plist"
    else
        step "Restoring the older job $old_label"
        mv "$backup" "$AGENTS_DIR/$old_label.plist"
        job_start "$old_label"
        if wait_http "http://127.0.0.1:$SERVER_PORT/" 180; then
            ok "$old_label is up again"
        else
            warn "$old_label did not come up. Check its log."
        fi
    fi
fi

# --- 6. Data ------------------------------------------------------------------

if [ "$PURGE" -eq 1 ]; then
    step "Deleting $HAPPY_LOCAL"
    archive="$HOME/happy-local-final-$(date +%Y%m%d-%H%M%S).tar.gz"
    rmdir "$LOCK"
    trap - EXIT
    tar -czf "$archive" -C "$(dirname "$HAPPY_LOCAL")" "$(basename "$HAPPY_LOCAL")"
    chmod 600 "$archive"
    tar -tzf "$archive" >/dev/null || die "the archive check failed. Nothing was deleted."
    rm -rf "$HAPPY_LOCAL"
    ok "deleted. The archive is $archive"
else
    rm -f "$MANIFEST"
    rmdir "$BACKUP_DIR" 2>/dev/null || true
    echo
    echo "${C_BOLD}Happy is uninstalled.${C_OFF} Your data stays in $HAPPY_LOCAL."
    echo "Run install.sh again to use it."
fi
