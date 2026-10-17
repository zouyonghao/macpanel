English | [简体中文](README.zh-CN.md)

# MacPanel

An in-house-built macOS server panel. A single Go binary (~13 MB, ~20–30 MB resident memory), a frontend with no build toolchain and no CDN dependencies — every asset is embedded in the binary.

<p align="center">
  <img src="docs/dashboard.png" width="960" alt="MacPanel dashboard: live CPU / memory / network / disk charts, disk mounts and top processes">
</p>

## Features

| Module | Description |
|---|---|
| Dashboard | Real-time CPU / memory / network / disk I/O charts (5s sampling, 75 minutes of history), top processes, mounted disks |
| Quick Links | Built-in navigation page: bookmark internal services (LAN / ZeroTier / tunnel addresses), freely add/edit/reorder/delete, grouped sections; also shown on the dashboard |
| Services | launchd (LaunchAgents/LaunchDaemons read-only, user domain manageable) and `brew services` start/stop |
| Monitors | Custom checks (launchd / port / HTTP / process name), auto-checked every 60s, with one-click restart of the linked service |
| Cron jobs | Visual add/edit/delete and enable/disable of crontab entries; automatic backup to `data/cron-backup/` before every write-back (last 20 kept) |
| Ports | Listening ports with their process names, favorites, known-service annotations, HTTP probing, quick open |
| Websites | Caddy reverse-proxy and static site management: generate Caddyfile → `caddy validate` → hot reload |
| Containers | Apple `container` management: list / start / stop / delete / logs / create |
| App store | Popular apps as brew packages or containers (catalog modeled on BaoTa / 1Panel), with live logs for background jobs |
| Terminal | Web SSH (PTY) via xterm.js, with window resize and quick commands |
| AI assistant | DeepSeek / OpenAI-compatible APIs over SSE streaming; can attach a live system snapshot to help with diagnostics |
| Security | argon2id, session + CSRF, login rate limiting, entrance path, IP allowlist, TLS, audit log |

## Quick start

```bash
./build.sh                          # Build
./macpanel                          # Listens on :9000 by default; data directory ~/macpanel/data
```

The first visit to `http://<host>:9000/` starts the setup wizard: once you create the admin account (password ≥ 10 characters), an **entrance path** (e.g. `/p_xxxx/`) is generated automatically — bookmark it immediately.

### Run persistently under launchd

```bash
./install.sh                        # builds, renders the plist to your checkout path,
                                    # installs the launchd agent and starts the panel
```

The agent (`com.macpanel`) auto-starts at login and is kept alive; logs go to `<checkout>/data/panel.log`. To uninstall: `launchctl bootout gui/$(id -u)/com.macpanel && rm ~/Library/LaunchAgents/com.macpanel.plist`.

## Security design (built to be exposed directly to the public internet)

Listening on `:9000` binds both IPv4 and IPv6 — if the host has a public IPv6 address (e.g. `panel.example.com` in direct mode), the panel is on the public internet. The following mechanisms are in effect by default:

1. **Entrance path**: every path outside `/api/*` and `/assets/*` 302-redirects to the entrance; scanners never see the page structure
2. **argon2id** password hashing; a constant-time hash is computed even for nonexistent users, preventing timing side channels
3. **Login rate limiting**: 5 failures from one IP locks it for 15 minutes (exponential backoff 15m→30m→60m→120m)
4. **Sessions**: 256-bit token, HttpOnly + SameSite=Lax, 24h sliding expiry; `Secure` is added automatically once TLS is on
5. **CSRF**: every non-GET API call requires the `X-Panel-CSRF` header; security response headers included (X-Frame-Options/CSP/nosniff)
6. **Audit**: logins, terminal opens, and all administrative operations are recorded in `data/audit.log` (JSONL)

**Configuring TLS immediately after initialization is strongly recommended** (Settings → Security/Network): enter the certificate and private key paths issued by acme.sh, then restart the panel to enable HTTPS, with an optional HTTP redirect port. Example:

```bash
~/.acme.sh/acme.sh --issue --dns dns_cf -d panel.example.com   # reuses the existing CF token
```

Optional: an **IP allowlist** (one entry per line in Settings, `192.168.31.` prefix notation supported).

### ⚠️ Terminal page risk

The web terminal means anyone with a login gets arbitrary command execution on the host (PTY). Mitigations in place: usable only by a logged-in session + an audit entry on every open. Be sure to: enable TLS (otherwise terminal traffic is plaintext), never share your session, and review the audit log regularly.

## Configuration file

`data/config.json` (0600). Make routine changes through the UI; if you edit the file directly, restart the panel afterwards.

```jsonc
{
  "listen": ":9000",          // listen address (takes effect on restart)
  "http_port": "",            // HTTP→HTTPS redirect port while TLS is enabled
  "entrance": "p_xxxxxx",     // entrance path
  "tls_cert": "", "tls_key": "",  // HTTPS is enabled only when both are set (takes effect on restart)
  "session_hours": 24,
  "ip_allowlist": [],
  "known_services": [{"port": 8083, "name": "Nextcloud", "url": "http://192.168.64.4:8083"}],
  "ai": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat", "key": "sk-..."}
}
```

## Directory layout

```
~/macpanel/
├── macpanel              # binary
├── data/                 # runtime data (created automatically)
│   ├── config.json       # configuration (0600)
│   ├── audit.log         # audit log
│   ├── cron-backup/      # crontab backups taken before write-back
│   ├── caddy/Caddyfile   # Caddy configuration generated by the panel
│   └── panel.log         # stdout/stderr when started by launchd
├── com.macpanel.plist    # launchd agent
└── web/                  # frontend source (embedded via go:embed; rebuild after changes)
```

## Website management (Caddy)

Site model: reverse proxy (`reverse_proxy 127.0.0.1:PORT`) or static site (`root * DIR` + `file_server`); TLS options are none / internal (Caddy's self-signed CA, trusted on the local network only) / certificate files (fullchain.cer + .key paths issued by acme.sh).

On save the panel: generates `data/caddy/Caddyfile` → `caddy validate` → writes it to the brew default location `/opt/homebrew/etc/Caddyfile` (a one-line import) → `caddy reload` for a hot reload. If Caddy is not installed, the configuration is only saved; the app store can install it in one click.

## Cron conventions

The panel parses standard 5-field crontab entries plus special schedules such as `@reboot`; a trailing ` # note` on a line is recognized as the job name; a commented-out cron line means the job is disabled (toggling adds or removes `# `, with an automatic backup before write-back).

## Containers

Built on Apple `container` (`container ls/logs/run/stop/start/delete`). Container apps in the app store pull images from the `docker.m.daocloud.io` mirror; `container run` arguments are validated against a whitelist (port mapping / environment variable / mount formats).

## Development

```bash
./build.sh                 # = go vet + go build
go run ./cmd/wstest ws://127.0.0.1:9000/api/terminal <session-cookie>   # terminal WS smoke test
```

- Backend: Go stdlib + gopsutil/v4 + gorilla/websocket + creack/pty + x/crypto/argon2
- Frontend: vanilla JS SPA (hash routing), charts drawn directly on canvas, xterm.js vendored into `web/assets/`
- CSP is `default-src 'self'`; **inline scripts and event handlers are forbidden in the frontend** — use `data-act` event delegation exclusively
