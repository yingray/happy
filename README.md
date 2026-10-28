<div align="center">

<h1>Happy Engineering</h1>

<p>The fun way of making things :D</p>

</div>

https://github.com/user-attachments/assets/deeeeaf5-e550-49bc-829f-1186898f441a

<p align="center">
<a href="https://happy.engineering/#download"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/download-desktop-dark.svg"><img width="212" height="39" alt="Download Desktop for macOS, Windows, and Linux" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/download-desktop-light.svg" /></picture></a>
</p>

<p align="center">
<a href="https://apps.apple.com/us/app/happy-codex-claude-code-app/id6748571505"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/app-store-rating-dark.svg"><img width="150" height="56" alt="Download on the App Store. Rated 4.9 stars from 1,000+ ratings" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/app-store-rating-light.svg" /></picture></a>&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/google-play-rating-dark.svg"><img width="150" height="56" alt="Get it on Google Play. Rated 5.0 stars from 3.1k+ reviews" src="https://raw.githubusercontent.com/slopus/happy-desktop/main/.github/google-play-rating-light.svg" /></picture></a>
</p>

## What you get

1. **Any model: Claude, Codex, Grok, Gemini, and more.** Gemini runs through
   Antigravity, and OpenCode or any Agent Client Protocol agent plugs in as a
   harness. Give every task the model that fits, and delegate to subagents on
   any of them.
2. **Reuse your subscriptions.** Sign in with the Claude, Codex, and Grok
   subscriptions you already pay for; Antigravity, OpenCode, and ACP agents
   keep their own logins. Happy adds a harness, not another bill.
3. **Open source MIT.** It runs on your own hardware and your projects stay
   ordinary folders. Read the code, fork it, ship your own build.
4. **End-to-end encrypted mobile app.** Left your desk? The same sessions are
   already on your phone, and what moves between your devices is encrypted.
5. **Natively multiplayer.** Invite a colleague or a friend into the session.
   You both watch the same agent work, and either of you can steer it.

#### Resources

<p align="center">
<a href="https://happy.engineering/">Website</a> · <a href="https://happy.engineering/welcome/">Documentation</a> · <a href="https://discord.gg/fX9WBAhyfD">Discord</a> · <a href="docs/CONTRIBUTING.md">Development guide</a> · <a href="LICENSE">MIT License</a>
</p>

## How Happy fits together

| Repository                                                                            | What it is                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[slopus/happy](https://github.com/slopus/happy)** ← this repository | **The mobile app (iOS, Android, web), the original CLI, and the relay server** |
| [slopus/happy-desktop](https://github.com/slopus/happy-desktop) | The desktop app for macOS, Windows, and Linux |
| [slopus/happy-agent](https://github.com/slopus/happy-agent)                           | Happy Agent, the open-source agent runtime the desktop app runs on         |
| [slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)                 | The website and docs at happy.engineering                                  |

## Self-host the server and the web app

You can run your own Happy server and your own web app on your machine.
They use two ports. Tailscale makes both available on your tailnet with HTTPS.

| Part       | Local address           | Tailnet address                     |
| ---------- | ----------------------- | ----------------------------------- |
| Server API | `http://127.0.0.1:3007` | `https://<machine>.<tailnet>.ts.net:3007` |
| Web app    | `http://127.0.0.1:3008` | `https://<machine>.<tailnet>.ts.net:3008` |

Replace `<machine>.<tailnet>.ts.net` with the name from `tailscale status`.

You need macOS, Node.js 24, and pnpm. Tailscale with HTTPS certificates
turned on is optional: with it, other devices can reach your server. Without
it, the server and the web app answer only at `http://127.0.0.1` on this Mac.
In that case, use Rayno in Chrome, or the web app at `http://127.0.0.1:3008`.
Safari blocks an HTTPS page such as Rayno from calling an HTTP address.
Replace `<repo-url>` with the URL of this repository.

### Install with one command

```sh
git clone <repo-url> happy
cd happy
./.rayno/install.sh
```

The script installs the dependencies and builds the web app. It starts the
server and the web app as launchd services, so they run after a restart.
When Tailscale is ready, it publishes both ports with `tailscale serve`.
It links the global `happy` command to this clone, and points the CLI
settings at your server.

When the CLI is not signed in yet, the script makes a new account on your
server and signs the CLI in. At the end, it prints the server address and the
recovery key of that account. Paste both into Rayno or into the web app.
Save the recovery key in a safe place. Anyone with the key can read all of
your sessions. When the CLI uses a newer login that does not keep the key,
the script tells you to copy it from the Happy app instead.

| Command                          | What it does                                                      |
| -------------------------------- | ----------------------------------------------------------------- |
| `./.rayno/install.sh`            | Install. Run it again after `git pull` to upgrade.                |
| `./.rayno/install.sh --no-cli-link` | Install, but do not change the global `happy` command.         |
| `HAPPY_NO_TAILSCALE=1 ./.rayno/install.sh` | Install for this Mac only, without Tailscale.            |
| `./.rayno/uninstall.sh`          | Remove the services, routes, link, and settings. Keep your data.  |
| `./.rayno/uninstall.sh --purge`  | Also delete the data, after a final archive in your home folder.  |

The install records each change in `~/.happy-local/install-manifest.json`.
Uninstall reads that file and undoes only those changes. A Tailscale route or
a setting that you made yourself stays.

Keep a copy of `~/.happy-local/server/master-secret`. When you lose it, every
device must sign in again.

To use other ports or folders, set `HAPPY_SERVER_PORT`, `HAPPY_WEB_PORT`,
`HAPPY_LOCAL`, or `HAPPY_HOME_DIR`. Use the same values for uninstall.
Run `./.rayno/install.sh --help` for the full list.

The steps below do the same work by hand.

### 1. Get the code

```sh
git clone <repo-url> happy
cd happy
pnpm install
```

### 2. Start the server

The server keeps its data in a PGlite database. Keep the data directory
outside the repo, so a new checkout does not touch it.

```sh
export DATA_DIR="$HOME/.happy-local/server"
mkdir -p "$DATA_DIR"
# Make the master secret one time. Keep it: it signs every auth token.
[ -f "$DATA_DIR/master-secret" ] || openssl rand -hex 32 > "$DATA_DIR/master-secret"
chmod 600 "$DATA_DIR/master-secret"

cd packages/happy-server
export DB_PROVIDER=pglite
export PGLITE_DIR="$DATA_DIR/pglite"
export HANDY_MASTER_SECRET="$(cat "$DATA_DIR/master-secret")"
export PORT=3007
export HOST=127.0.0.1
export PUBLIC_URL="https://<machine>.<tailnet>.ts.net:3007"
pnpm exec tsx sources/standalone.ts migrate
pnpm exec tsx sources/standalone.ts serve
```

In a second terminal, publish the port and check it:

```sh
tailscale serve --bg --https=3007 http://127.0.0.1:3007
curl https://<machine>.<tailnet>.ts.net:3007/
# Welcome to Happy Server!
```

The server has no web pages. That reply is all you get on this port.

### 3. Start the web app

The web app reads the server address at build time from
`EXPO_PUBLIC_HAPPY_SERVER_URL`. Use the tailnet address, not `127.0.0.1`.
Other devices open the web app, and `127.0.0.1` points to those devices.

```sh
cd packages/happy-app
EXPO_PUBLIC_HAPPY_SERVER_URL="https://<machine>.<tailnet>.ts.net:3007" \
  APP_ENV=development pnpm exec expo start --web --port 3008
```

In another terminal:

```sh
tailscale serve --bg --https=3008 http://127.0.0.1:3008
```

Open `https://<machine>.<tailnet>.ts.net:3008/`. The login screen shows the
server address at the top. Make sure that it is your `:3007` address.

### 4. Point the CLI at your server

Add these two keys to `~/.happy/settings.json`. Keep the other keys in the file.

```json
{
  "serverUrl": "http://127.0.0.1:3007",
  "webappUrl": "https://<machine>.<tailnet>.ts.net:3008"
}
```

The `HAPPY_SERVER_URL` and `HAPPY_WEBAPP_URL` environment variables
override these keys. Then sign in:

```sh
happy auth login
```

### 5. Sign in to the web app

Your account is a secret key that lives on your devices. The server does not
have it. Use one of these ways to sign in:

| Situation                       | What to do                                                        |
| ------------------------------- | ----------------------------------------------------------------- |
| You have no account yet         | Select **Create account** in the web app.                          |
| The Happy app on your phone uses this server | Select **Login with mobile app**. On the phone, open **Settings › Account › Link New Device** and scan the QR code. |
| You saved your secret key       | Select **Login with mobile app**, then **Use a secret key instead**. |

An account on `app.happy.engineering` does not exist on your server.
Make a new account, or move your phone app to this server first.

### Stop the services

Press `Ctrl+C` in each terminal. Then remove the Tailscale routes:

```sh
tailscale serve --https=3007 off
tailscale serve --https=3008 off
```

Both services stop when you close their terminals. To keep them running,
start them from a service manager such as launchd or systemd.

## Original Happy CLI

The original CLI wraps the Claude Code and Codex harnesses directly in your
terminal and lets you continue from your phone.

For multi-model sessions and teams, move to the desktop app and Happy Harness.

```sh
npm install -g happy

# Start Claude Code
happy claude

# Or start Codex
happy codex
```

- [happy-app](packages/happy-app): the Happy mobile app and web client (Expo)
- [happy-cli](packages/happy-cli): the original Happy CLI (`happy` on npm)
- [happy-agent](packages/happy-agent): remote session control for the original Happy CLI (not the Happy Agent runtime)
- [happy-server](packages/happy-server): the relay server for encrypted sync
- [happy-push-server](packages/happy-push-server): Cloudflare Worker that delivers push notifications via APNs/FCM (replaces the Expo push service)

Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!
