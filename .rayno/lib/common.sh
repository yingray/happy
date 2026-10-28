# Shared settings and helpers for install.sh and uninstall.sh.
# Source this file. It works with the bash 3.2 that macOS ships.

HAPPY_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HAPPY_LOCAL="${HAPPY_LOCAL:-$HOME/.happy-local}"
SERVER_PORT="${HAPPY_SERVER_PORT:-3007}"
WEB_PORT="${HAPPY_WEB_PORT:-3008}"
LABEL_PREFIX="${HAPPY_LABEL_PREFIX:-local.happy}"
CLI_HOME="${HAPPY_HOME_DIR:-$HOME/.happy}"
CLI_HOME="${CLI_HOME/#\~/$HOME}"

SERVER_LABEL="$LABEL_PREFIX.server"
WEB_LABEL="$LABEL_PREFIX.web"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
MANIFEST="$HAPPY_LOCAL/install-manifest.json"
BACKUP_DIR="$HAPPY_LOCAL/install-backup"
JSON="$HAPPY_SRC/.rayno/lib/json.mjs"

if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_OFF=$'\033[0m'
else
    C_BOLD=''; C_RED=''; C_YEL=''; C_GRN=''; C_OFF=''
fi

step() { echo; echo "${C_BOLD}==> $*${C_OFF}"; }
info() { echo "    $*"; }
ok() { echo "    ${C_GRN}ok${C_OFF} $*"; }
warn() { echo "    ${C_YEL}warning:${C_OFF} $*" >&2; }
die() { echo "${C_RED}error:${C_OFF} $*" >&2; exit 1; }

json() { node "$JSON" "$@"; }
mf() { json "$1" "$MANIFEST" "${@:2}"; }

sleep1() { perl -e 'select(undef, undef, undef, 1)'; }

port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
port_up() { [ -n "$(port_pids "$1")" ]; }

# wait_http <url> <seconds>: wait for HTTP 200.
wait_http() {
    local i
    for ((i = 0; i < $2; i++)); do
        [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)" = 200 ] && return 0
        sleep1
    done
    return 1
}

# wait_port_down <port> <seconds>
wait_port_down() {
    local i
    for ((i = 0; i < $2; i++)); do
        port_up "$1" || return 0
        sleep1
    done
    return 1
}

job_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

job_stop() {
    job_loaded "$1" || return 0
    launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
}

job_start() { launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$1.plist"; }

# write_plist <label> <program> <log file> <output file>
write_plist() {
    cat > "$4" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array><string>$2</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$3</string>
  <key>StandardErrorPath</key><string>$3</string>
</dict>
</plist>
EOF
}

# The tailnet host name of this machine, without the trailing dot.
tailnet_host() {
    tailscale status --json 2>/dev/null | node -e '
        const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const name = (s.Self && s.Self.DNSName || "").replace(/\.$/, "");
        if (s.BackendState !== "Running") { console.error("not-running"); process.exit(1); }
        if (!(s.CertDomains || []).includes(name)) { console.error("no-https"); process.exit(1); }
        console.log(name);
    '
}

# serve_target <host> <port>: print the proxy target of the "/" route on
# that HTTPS port, "none" when the port has no route, or "other" when the
# port has a route that this script did not make (more paths, or TCP only).
serve_target() {
    tailscale serve status --json 2>/dev/null | node -e '
        const [host, port] = process.argv.slice(1);
        const text = require("fs").readFileSync(0, "utf8").trim();
        const s = text ? JSON.parse(text) : {};
        const tcp = (s.TCP || {})[port];
        const web = (s.Web || {})[`${host}:${port}`];
        if (!tcp && !web) { console.log("none"); process.exit(0); }
        const handlers = (web && web.Handlers) || {};
        const paths = Object.keys(handlers);
        if (!tcp || !tcp.HTTPS || paths.length !== 1 || paths[0] !== "/" || !handlers["/"].Proxy) {
            console.log("other");
        } else {
            console.log(handlers["/"].Proxy);
        }
    ' "$1" "$2"
}

# Name the command when one fails without its own message.
set -E
trap 'echo "${C_RED}error:${C_OFF} line $LINENO failed: $BASH_COMMAND" >&2' ERR
