#!/bin/bash
#
# Install the Happy server and the Happy web app on this Mac.
#
#   .rayno/install.sh [--adopt] [--no-cli-link]
#
#   --adopt        Take over an older launchd job that runs from $HAPPY_LOCAL
#                  without a prompt. The job is backed up, and uninstall.sh
#                  puts it back.
#   --no-cli-link  Do not point the global `happy` command at this clone.
#
# Run it again to upgrade: it rebuilds from the current checkout and restarts
# both services. Every change goes into $HAPPY_LOCAL/install-manifest.json,
# so uninstall.sh can undo exactly that change and nothing else.
#
# Environment (defaults in brackets):
#   HAPPY_LOCAL         data and runtime folder [~/.happy-local]
#   HAPPY_SERVER_PORT   server port [3007]
#   HAPPY_WEB_PORT      web app port [3008]
#   HAPPY_LABEL_PREFIX  launchd label prefix [local.happy]
#   HAPPY_HOME_DIR      Happy CLI folder [~/.happy]
#   HAPPY_NO_TAILSCALE  set to 1 to skip Tailscale and use 127.0.0.1 only
#
# Without Tailscale (or with its HTTPS certificates off), the server and the
# web app answer only on this Mac, at http://127.0.0.1.
#
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

ADOPT=0
LINK_CLI=1
for a in "$@"; do
    case "$a" in
        --adopt) ADOPT=1 ;;
        --no-cli-link) LINK_CLI=0 ;;
        -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option: $a (see --help)" ;;
    esac
done

# --- 1. Preflight -------------------------------------------------------------

step "Checking this machine"
[ "$(uname -s)" = Darwin ] || die "this installer supports macOS only"
for c in git node pnpm curl lsof launchctl; do
    command -v "$c" >/dev/null || die "'$c' is not on PATH"
done
NODE_BIN="$(node -p process.execPath)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node.js 24 or newer is required (found $(node -v))"
ok "node $(node -v), pnpm $(pnpm -v)"

# With Tailscale, both services get HTTPS addresses on the tailnet, so other
# devices can use them. Without it, they answer only on this Mac.
USE_TAILSCALE=0
if [ "${HAPPY_NO_TAILSCALE:-0}" = 1 ]; then
    info "HAPPY_NO_TAILSCALE=1: Tailscale is skipped"
elif ! command -v tailscale >/dev/null; then
    warn "Tailscale is not installed. Other devices cannot reach this server."
elif ! HOST="$(tailnet_host 2>&1)"; then
    case "$HOST" in
        *not-running*) warn "Tailscale is not running. Other devices cannot reach this server." ;;
        *no-https*) warn "Tailscale HTTPS certificates are off. Turn on HTTPS in the DNS page of the Tailscale admin console, then run install.sh again." ;;
        *) warn "cannot read the Tailscale status: $HOST" ;;
    esac
else
    USE_TAILSCALE=1
fi
if [ "$USE_TAILSCALE" -eq 1 ]; then
    SERVER_PUBLIC_URL="https://$HOST:$SERVER_PORT"
    WEB_PUBLIC_URL="https://$HOST:$WEB_PORT"
    ok "tailnet host $HOST"
else
    HOST=127.0.0.1
    SERVER_PUBLIC_URL="http://127.0.0.1:$SERVER_PORT"
    WEB_PUBLIC_URL="http://127.0.0.1:$WEB_PORT"
    ok "using $HOST. The services work only in a browser on this Mac."
fi

mkdir -p "$HAPPY_LOCAL"
chmod 700 "$HAPPY_LOCAL"
LOCK="$HAPPY_LOCAL/.install.lock"
mkdir "$LOCK" 2>/dev/null || die "another install or uninstall is running (remove $LOCK if not)"
on_exit() {
    local code=$?
    rmdir "$LOCK" 2>/dev/null || true
    if [ "$code" -ne 0 ] && [ -f "$MANIFEST" ]; then
        echo >&2
        echo "Install stopped. Fix the error and run install.sh again," >&2
        echo "or run $HAPPY_SRC/.rayno/uninstall.sh to undo what it changed." >&2
    fi
}
trap on_exit EXIT
mkdir -p "$BACKUP_DIR"

# The manifest starts after the last point where the user can say no, so a
# refusal leaves nothing behind.
start_manifest() {
    mf init version 1
    mf init installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mf set updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mf set src "$HAPPY_SRC"
    mf set ports.server "$SERVER_PORT"
    mf set ports.web "$WEB_PORT"
    mf set labels.server "$SERVER_LABEL"
    mf set labels.web "$WEB_LABEL"
    mf set host "$HOST"
}

# --- 2. Older services --------------------------------------------------------

# A launchd job that is not ours but runs a script from $HAPPY_LOCAL is an
# older manual setup. It uses the same port and the same DB, so only one of
# them can run.
step "Looking for older services"
old_label=""
for p in "$AGENTS_DIR"/*.plist; do
    [ -f "$p" ] || continue
    label="$(basename "$p" .plist)"
    [ "$label" = "$SERVER_LABEL" ] || [ "$label" = "$WEB_LABEL" ] && continue
    if grep -q "$HAPPY_LOCAL/run-server.sh\|$HAPPY_LOCAL/run-web.sh" "$p"; then
        [ -z "$old_label" ] || die "more than one older job uses $HAPPY_LOCAL: $old_label, $label"
        old_label="$label"
    fi
done

if [ -n "$old_label" ]; then
    info "found an older job: $old_label ($AGENTS_DIR/$old_label.plist)"
    if [ "$ADOPT" -eq 0 ]; then
        [ -t 0 ] || die "run again with --adopt to take over $old_label"
        read -r -p "    Take it over? It is backed up first, and uninstall.sh restores it. [y/N] " answer
        [ "$answer" = y ] || [ "$answer" = Y ] || die "stopped. Nothing changed."
    fi
    start_manifest
    info "stopping $old_label"
    job_stop "$old_label"
    wait_port_down "$SERVER_PORT" 30 || die "port $SERVER_PORT is still in use after the stop"
    if [ -d "$HAPPY_LOCAL/server/pglite" ] && [ -x "$HAPPY_LOCAL/backup-db.sh" ]; then
        info "backing up the DB with the older backup-db.sh"
        if ! "$HAPPY_LOCAL/backup-db.sh" --offline; then
            job_start "$old_label" || true
            die "the backup failed, so $old_label was started again. Nothing else changed."
        fi
    fi
    mv "$AGENTS_DIR/$old_label.plist" "$BACKUP_DIR/$old_label.plist"
    mf set adopted.label "$old_label"
    mf set adopted.backup "$BACKUP_DIR/$old_label.plist"
    ok "took over $old_label"
else
    ok "none"
fi

# Any other process on our ports is a conflict that we do not touch.
for port in "$SERVER_PORT" "$WEB_PORT"; do
    pids="$(port_pids "$port" | paste -sd, -)"
    [ -z "$pids" ] && continue
    if [ "$port" = "$SERVER_PORT" ] && job_loaded "$SERVER_LABEL"; then continue; fi
    if [ "$port" = "$WEB_PORT" ] && job_loaded "$WEB_LABEL"; then continue; fi
    die "port $port is in use by: $(ps -o pid=,comm= -p "$pids" | tr '\n' ';')"
done

start_manifest

# --- 3. Code ------------------------------------------------------------------

step "Installing dependencies"
(cd "$HAPPY_SRC" && pnpm install --frozen-lockfile)
ok "commit $(git -C "$HAPPY_SRC" rev-parse --short HEAD)"

# --- 4. Data ------------------------------------------------------------------

step "Preparing the data folder $HAPPY_LOCAL"
mkdir -p "$HAPPY_LOCAL/server"
chmod 700 "$HAPPY_LOCAL/server"
if [ -f "$HAPPY_LOCAL/server/master-secret" ]; then
    mf init masterSecretCreated false
    ok "kept the existing master secret"
else
    (umask 077 && openssl rand -hex 32 > "$HAPPY_LOCAL/server/master-secret")
    mf init masterSecretCreated true
    ok "made a new master secret"
fi

# install_file <manifest name> <source> <destination> [mode]
# The first time this script replaces a file that it did not make, the old
# file goes into install-backup, and uninstall.sh puts it back.
install_file() {
    local name="$1" src="$2" dst="$3" mode="${4:-755}"
    if ! mf has "files.$name"; then
        if [ -e "$dst" ]; then
            cp -p "$dst" "$BACKUP_DIR/$name"
            mf set "files.$name.backup" "$BACKUP_DIR/$name"
        else
            mf set "files.$name.backup" ""
        fi
    fi
    mf set "files.$name.path" "$dst"
    cp "$src" "$dst"
    chmod "$mode" "$dst"
}

tmp_env="$(mktemp)"
cat > "$tmp_env" <<EOF
# Written by .rayno/install.sh. Run install.sh again to change these values.
HAPPY_SRC='$HAPPY_SRC'
HAPPY_LOCAL='$HAPPY_LOCAL'
NODE_BIN='$NODE_BIN'
SERVER_PORT='$SERVER_PORT'
WEB_PORT='$WEB_PORT'
SERVER_LABEL='$SERVER_LABEL'
WEB_LABEL='$WEB_LABEL'
SERVER_PUBLIC_URL='$SERVER_PUBLIC_URL'
WEB_PUBLIC_URL='$WEB_PUBLIC_URL'
EOF
install_file configEnv "$tmp_env" "$HAPPY_LOCAL/config.env" 600
rm -f "$tmp_env"
install_file runServer "$HAPPY_SRC/.rayno/runtime/run-server.sh" "$HAPPY_LOCAL/run-server.sh"
install_file runWeb "$HAPPY_SRC/.rayno/runtime/run-web.sh" "$HAPPY_LOCAL/run-web.sh"
install_file backupDb "$HAPPY_SRC/.rayno/runtime/backup-db.sh" "$HAPPY_LOCAL/backup-db.sh"
ok "wrote config.env, run-server.sh, run-web.sh, backup-db.sh"

# --- 5. Server ----------------------------------------------------------------

step "Starting the server on port $SERVER_PORT"
job_stop "$SERVER_LABEL"
wait_port_down "$SERVER_PORT" 30 || die "port $SERVER_PORT did not close"
tmp_plist="$(mktemp)"
write_plist "$SERVER_LABEL" "$HAPPY_LOCAL/run-server.sh" "$HAPPY_LOCAL/server.log" "$tmp_plist"
mkdir -p "$AGENTS_DIR"
install_file serverPlist "$tmp_plist" "$AGENTS_DIR/$SERVER_LABEL.plist" 644
rm -f "$tmp_plist"
job_start "$SERVER_LABEL"
wait_http "http://127.0.0.1:$SERVER_PORT/" 180 ||
    die "the server did not start. See $HAPPY_LOCAL/server.log"
ok "server is up"

# --- 6. Web app ---------------------------------------------------------------

step "Building the web app (this takes a few minutes)"
APP_DIR="$HAPPY_SRC/packages/happy-app"
rm -rf "$APP_DIR/dist"
(cd "$APP_DIR" && pnpm exec expo export -p web --output-dir dist)
[ -f "$APP_DIR/dist/index.html" ] || die "expo export made no index.html"
rm -rf "$HAPPY_LOCAL/web.new"
cp -R "$APP_DIR/dist" "$HAPPY_LOCAL/web.new"
rm -rf "$APP_DIR/dist"

step "Starting the web app on port $WEB_PORT"
job_stop "$WEB_LABEL"
wait_port_down "$WEB_PORT" 30 || die "port $WEB_PORT did not close"
rm -rf "$HAPPY_LOCAL/web"
mv "$HAPPY_LOCAL/web.new" "$HAPPY_LOCAL/web"
mf set webDir "$HAPPY_LOCAL/web"
tmp_plist="$(mktemp)"
write_plist "$WEB_LABEL" "$HAPPY_LOCAL/run-web.sh" "$HAPPY_LOCAL/web.log" "$tmp_plist"
mkdir -p "$AGENTS_DIR"
install_file webPlist "$tmp_plist" "$AGENTS_DIR/$WEB_LABEL.plist" 644
rm -f "$tmp_plist"
job_start "$WEB_LABEL"
wait_http "http://127.0.0.1:$WEB_PORT/" 30 || die "the web app did not start. See $HAPPY_LOCAL/web.log"
ok "web app is up"

# --- 7. Tailscale -------------------------------------------------------------

if [ "$USE_TAILSCALE" -eq 1 ]; then
    step "Publishing both ports on the tailnet"
    for port in "$SERVER_PORT" "$WEB_PORT"; do
        want="http://127.0.0.1:$port"
        have="$(serve_target "$HOST" "$port")"
        if [ "$have" = none ]; then
            tailscale serve --bg --https="$port" "$want" >/dev/null
            mf setjson "tailscale.$port.added" true
            ok "added https://$HOST:$port"
        elif [ "$have" = "$want" ]; then
            # A route that was here before the first install is not ours to remove.
            mf has "tailscale.$port.added" || mf setjson "tailscale.$port.added" false
            ok "https://$HOST:$port is already published"
        else
            die "https://$HOST:$port already goes to '$have'. Remove that route or pick another port."
        fi
    done
fi

# --- 8. CLI -------------------------------------------------------------------

if [ "$LINK_CLI" -eq 1 ]; then
    step "Pointing the global happy command at this clone"
    (cd "$HAPPY_SRC" && pnpm --filter happy build)
    npm_root="$(npm root -g)"
    npm_bin="$(npm prefix -g)/bin"
    cli_dir="$HAPPY_SRC/packages/happy-cli"

    daemon_was_running=0
    if [ -f "$CLI_HOME/daemon.state.json" ]; then
        pid="$(json get "$CLI_HOME/daemon.state.json" pid)"
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && daemon_was_running=1
    fi

    # record_link <manifest key> <path>: remember what was at <path> before.
    record_link() {
        mf has "cli.$1" && return 0
        if [ -L "$2" ]; then
            mf set "cli.$1.kind" link
            mf set "cli.$1.target" "$(readlink "$2")"
        elif [ -e "$2" ]; then
            mv "$2" "$BACKUP_DIR/cli-$1"
            mf set "cli.$1.kind" moved
            mf set "cli.$1.target" "$BACKUP_DIR/cli-$1"
        else
            mf set "cli.$1.kind" none
        fi
    }
    record_link root "$npm_root/happy"
    record_link bin "$npm_bin/happy"
    mf set cli.rootPath "$npm_root/happy"
    mf set cli.binPath "$npm_bin/happy"
    ln -sfn "$cli_dir" "$npm_root/happy"
    ln -sfn "$npm_root/happy/bin/happy.mjs" "$npm_bin/happy"
    mf setjson cli.linked true
    ok "happy -> $cli_dir"
fi

step "Pointing the Happy CLI settings at this server"
mkdir -p "$CLI_HOME"
SETTINGS="$CLI_HOME/settings.json"
for pair in "serverUrl=http://127.0.0.1:$SERVER_PORT" "webappUrl=$WEB_PUBLIC_URL"; do
    key="${pair%%=*}"
    val="${pair#*=}"
    if ! mf has "settings.$key"; then
        if json has "$SETTINGS" "$key"; then
            mf setjson "settings.$key.had" true
            mf set "settings.$key.prev" "$(json get "$SETTINGS" "$key")"
        else
            mf setjson "settings.$key.had" false
        fi
    fi
    mf set "settings.$key.value" "$val"
    json set "$SETTINGS" "$key" "$val"
done
mf set settings.file "$SETTINGS"
ok "serverUrl and webappUrl in $SETTINGS"

# A new machine has no CLI login, so make an account on this server. The
# recovery key is the account. It is printed once at the end, and nothing
# else keeps a copy of it outside the CLI's access.key.
RECOVERY_KEY=""
step "Signing the Happy CLI in"
if [ -f "$CLI_HOME/access.key" ]; then
    ok "the CLI is signed in already. The account stays."
    info "if that login is for another server, move it away and run install.sh again"
    # An older CLI login keeps the account secret, so its key can be shown again.
    RECOVERY_KEY="$(node "$HAPPY_SRC/.rayno/lib/create-account.mjs" --print "$CLI_HOME/access.key" 2>/dev/null || true)"
else
    RECOVERY_KEY="$(node "$HAPPY_SRC/.rayno/lib/create-account.mjs" "http://127.0.0.1:$SERVER_PORT" "$CLI_HOME/access.key")" ||
        die "could not make an account on the server"
    mf setjson cli.accountCreated true
    ok "made a new account and signed the CLI in"
fi

if [ "$LINK_CLI" -eq 1 ] && { [ "$daemon_was_running" -eq 1 ] || [ -n "$RECOVERY_KEY" ]; }; then
    step "Starting the Happy daemon"
    [ "$daemon_was_running" -eq 1 ] && info "the new happy binary stops the old daemon, and then starts its own"
    "$npm_bin/happy" daemon start || warn "the daemon did not start. Run 'happy daemon start'."
fi

# --- 9. Verify ----------------------------------------------------------------

step "Checking both addresses"
body="$(curl -s --max-time 10 "$SERVER_PUBLIC_URL/" || true)"
[ "$body" = "Welcome to Happy Server!" ] || die "$SERVER_PUBLIC_URL did not answer as the Happy server (got: ${body:0:80})"
ok "$SERVER_PUBLIC_URL"
page="$(curl -s --max-time 10 "$WEB_PUBLIC_URL/" || true)"
case "$page" in
    *__HAPPY_CONFIG__*"$SERVER_PUBLIC_URL"*) ok "$WEB_PUBLIC_URL" ;;
    *) die "$WEB_PUBLIC_URL did not serve the web app with the server address" ;;
esac

echo
echo "${C_BOLD}Happy is installed.${C_OFF}"
echo
echo "  Web app: $WEB_PUBLIC_URL"
echo "  Server:  $SERVER_PUBLIC_URL"
echo "  Data:    $HAPPY_LOCAL (back up server/master-secret)"
echo
echo "${C_BOLD}Sign in to Rayno${C_OFF}, or to the web app above, with these two values:"
echo
echo "  Happy server:  $SERVER_PUBLIC_URL"
if [ -n "$RECOVERY_KEY" ]; then
    echo "  Recovery key:  $RECOVERY_KEY"
    echo
    echo "  ${C_YEL}Save the recovery key now.${C_OFF} It is your account."
    echo "  Anyone with it can read all of your sessions."
else
    echo "  Recovery key:  this CLI login does not keep it. In the Happy app,"
    echo "                 open Settings > Account > Secret Key."
fi
if [ "$USE_TAILSCALE" -eq 0 ]; then
    echo
    echo "  ${C_YEL}This address works only in a browser on this Mac.${C_OFF} To use other devices,"
    echo "  install Tailscale, turn on HTTPS certificates, and run install.sh again."
fi
echo
echo "  Undo:  $HAPPY_SRC/.rayno/uninstall.sh"
