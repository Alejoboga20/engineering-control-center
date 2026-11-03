# Engineering Control Center

A self-hosted web dashboard for persistent terminal sessions on an Ubuntu server. Its main purpose is
to run several Claude Code instances remotely, driving them from a browser, while they keep running
through closed browsers, dropped SSH connections, and dashboard restarts.

It is a thin layer over tmux. There is no database and no stored application state.

> **Security:** this application has **no login** and gives a shell to anyone who reaches it. Keep it on
> a trusted private channel, as described under [Security](#security).

## Architecture

```text
 Browser                    NestJS backend (one process, port 3000)              tmux server
┌─────────────┐  REST      ┌────────────────────────────────────┐  execFile     ┌─────────────┐
│ React       │───────────▶│ SessionsModule → TmuxService       │──────────────▶│ session A   │
│ dashboard   │            │ SystemModule  (/proc, statfs)      │               │  claude     │
│             │  WebSocket │ TerminalModule                     │  node-pty     │ session B   │
│ xterm.js    │◀──────────▶│  one PTY per open terminal         │◀─────────────▶│  claude     │
└─────────────┘            │  running `tmux attach-session`     │  tmux client  │ ...         │
                           └────────────────────────────────────┘               └─────────────┘
    disposable                         disposable                              owns the processes
```

| Concern | Source of truth |
| --- | --- |
| Sessions | tmux, queried on every request |
| System metrics | Linux (`/proc/meminfo`, `os.cpus()`, `statfs`) |
| Available project directories | The filesystem, under the configured roots |
| Claude Code history and configuration | Claude Code |

| Path | Contents |
| --- | --- |
| `apps/api/src/tmux/` | The only code that invokes tmux: `TmuxRunner` executes, `TmuxService` holds the logic |
| `apps/api/src/sessions/` | REST endpoints and working directory validation |
| `apps/api/src/terminal/` | WebSocket gateway, and the PTY-to-socket bridge |
| `apps/api/src/system/` | Host statistics |
| `apps/api/src/common/` | Error format, Host and Origin checks, security headers |
| `apps/web/src/` | React dashboard |
| `packages/shared/` | API types, WebSocket protocol, session name rules |

### How terminal persistence works

1. Every process runs inside tmux, whose server is a daemon independent of the backend.
2. Opening a terminal runs `tmux attach-session -t =name` in a PTY, and connects it to a WebSocket. This
   is exactly what happens when you attach over SSH. The attach client is the only thing the backend owns.
3. When the socket closes for any reason, the backend kills that client. tmux treats this as a detach.
4. Reconnecting attaches a new client, and tmux repaints the current screen.

No code path other than an explicit `DELETE /api/sessions/:name` calls `kill-session`.

| Event | tmux sessions and processes |
| --- | --- |
| Browser closed, or network lost | Survive |
| SSH connection dropped | Survive |
| Backend restart or crash | Survive, as long as `KillMode=process` is kept in the service file |
| OS reboot | **Lost.** This is out of scope, and nothing tries to recreate them. Claude Code's own history stays on disk. |

## Requirements

- Ubuntu 22.04 or newer (macOS works for development)
- tmux 3.2 or newer
- Node.js 20.11 or newer (22 recommended), and pnpm 10 (`corepack enable` provides it)
- `build-essential` and `python3` on Linux, to compile `node-pty`

```bash
sudo apt install -y tmux build-essential python3
```

## Local development

```bash
corepack enable
pnpm install
ECC_PROJECT_ROOTS=$HOME/projects pnpm dev
```

Open <http://localhost:5173>. Vite proxies `/api` and WebSockets to the backend on port 3000.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API and Vite dev server, with reload |
| `pnpm build` | Compile everything |
| `pnpm start` | Run the production build on port 3000 |
| `pnpm test` | All automated tests |
| `pnpm lint`, `pnpm typecheck` | Static checks |

## Configuration

All settings are environment variables. In production, put them in `/etc/engineering-control-center.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ECC_PROJECT_ROOTS` | `~/projects` | Comma-separated absolute directories in which sessions may be created |
| `ECC_HOST` | `127.0.0.1` | Bind address. Wildcards are always refused. |
| `ECC_PORT` | `3000` | Port |
| `ECC_ALLOWED_ORIGINS` | `http://localhost:<port>`, `http://127.0.0.1:<port>` | Browser origins allowed in. Also adds the Vite origins outside production. Setting this replaces the defaults. |
| `ECC_ALLOW_REMOTE_BIND` | unset | Must be `true` to bind to a specific non-loopback address |
| `ECC_TMUX_BIN` | `tmux` | tmux binary |
| `ECC_TMUX_SOCKET` | unset | Use a dedicated tmux server (`tmux -L`). Unset, the dashboard shares the default server with your SSH logins. |
| `ECC_WEB_DIST` | `apps/web/dist` | Compiled frontend location |

## Deploying on Ubuntu

The commands assume user `dev` and a checkout at `/home/dev/engineering-control-center`.

**1. Build.** Run as `dev`:

```bash
sudo apt install -y tmux build-essential python3
cd ~/engineering-control-center
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

**2. Configure.**

```bash
sudo tee /etc/engineering-control-center.env >/dev/null <<'CONF'
ECC_PROJECT_ROOTS=/home/dev/projects
CONF
```

**3. Install the service.** systemd does not load shell profiles or nvm, so the unit needs the absolute
path of your Node version. This fills in the placeholders:

```bash
NODE_VERSION_DIR=$(dirname "$(dirname "$(nvm which 22)")")
sed -e "s#/home/dev/.nvm/versions/node/v22.0.0#$NODE_VERSION_DIR#g" \
    -e "s#/home/dev#$HOME#g" \
    -e "s#User=dev#User=$USER#" \
    deploy/systemd/engineering-control-center.service \
  | sudo tee /etc/systemd/system/engineering-control-center.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now engineering-control-center
```

After a Node upgrade through nvm, update the paths in the unit and reinstall dependencies with `pnpm install`,
since `node-pty` is compiled for a particular Node version.

**4. Operate.**

```bash
systemctl status engineering-control-center
sudo systemctl restart engineering-control-center    # sessions keep running
journalctl -u engineering-control-center -f
```

**5. Connect** from your own machine, and open <http://localhost:3000>:

```bash
ssh -N -L 3000:127.0.0.1:3000 dev@your-server
```

To use a different local port (for example `-L 8080:127.0.0.1:3000`), add it to `ECC_ALLOWED_ORIGINS`:
`http://localhost:8080`. The Host and Origin checks otherwise reject it.

### Using Tailscale later

Keep the backend on loopback, and let Tailscale proxy to it:

```bash
sudo tailscale serve --bg 3000
```

Then, in `/etc/engineering-control-center.env`, allow the HTTPS name it gives you, and restart:

```bash
ECC_ALLOWED_ORIGINS=https://your-server.your-tailnet.ts.net,http://localhost:3000
```

Use `tailscale serve`, never `tailscale funnel`, which publishes to the internet. Restrict the tailnet's
ACLs so that only your own devices can reach this machine. Binding directly to a Tailscale IP with
`ECC_HOST` and `ECC_ALLOW_REMOTE_BIND=true` is also possible, but it has no TLS of its own, and clipboard
copy in the browser requires HTTPS or localhost.

## Security

This dashboard provides shell access as the service user, on a machine assumed to hold private
repositories and credentials. V1 is **single-user**, for use only over a trusted private channel.

**SSH forwarding and Tailscale provide transport and access control. They are not application-level
authentication, and this application has none.**

Consequences to understand:

- **Every local user on the server can use the dashboard.** The loopback port is open to all local accounts,
  and non-browser clients can forge `Origin`. Anyone with another account on the machine, or any process
  running as another user, can get a shell as the service user. Use a host where you are the only user.
- Anyone able to forward a port to the machine, or to reach it on the tailnet, gets a shell.
- Malicious code running as your own user can already do everything the dashboard can.
- Browser extensions with access to the page can read and type into the terminal.

Protections in place:

| Threat | Protection |
| --- | --- |
| Accidental exposure | Binds to `127.0.0.1`. Wildcards are always refused, and other addresses need an explicit opt-in. No firewall changes are made. Refuses to run as root. |
| Malicious websites opening a shell | WebSocket upgrades require an allowlisted `Origin` |
| Cross-site requests | `Origin` allowlist on all requests, strict CORS, JSON-only bodies |
| DNS rebinding | `Host` allowlist on all requests and upgrades |
| Clickjacking and injected content | CSP with `frame-ancestors 'none'` |
| Command injection | tmux runs from argument arrays without a shell. Session names use a strict allowlist. No endpoint accepts commands, and the terminal socket is the only source of shell input. |
| Wrong session targeted | `=name` targets, because tmux otherwise matches prefixes: `kill-session -t pay` would kill `payroll` |
| Directory escapes | Paths are canonicalized with `realpath`, resolving symlinks, before being compared with canonical roots. Names that tmux would interpret as formats are refused. |
| Secret leakage | No endpoint returns environment variables. tmux and the PTY get an allowlisted environment, and error messages do not expose internals. |

Terminal output passes through memory only. It is never written to disk by the dashboard.

## Using the terminal

- **Scrolling:** in a shell, the mouse wheel scrolls tmux history. Full-screen programs that track the mouse,
  like Claude Code, receive it as wheel events and scroll themselves. tmux keeps only 2000 lines per pane by default, so
  consider adding `set -g history-limit 50000` to `~/.tmux.conf`. Typing returns to the live view.
- **Copy:** drag to select, then Ctrl+Shift+C (Cmd+C on a Mac). Selection works in every program, including
  Claude Code. Copies made by tmux or by programs using OSC 52, such as Claude Code's `/copy`, also reach
  the browser clipboard, which needs HTTPS or localhost. Programs can write to the clipboard but never read it.
- **Links:** click a `http` or `https` link to open it in a new tab. Hover over it first to see its real target,
  because a program can make a link's text say anything. Other link types do not open. Links that programs mark
  with OSC 8 need tmux 3.4 or newer. A plain-text URL that a program split across lines opens only the part on the
  line you click, so check the target of long URLs.
- **Mouse clicks** are otherwise not sent to programs in the terminal, as that would disable text selection. The
  wheel still works.
- **Paste:** Ctrl+Shift+V (Cmd+V on a Mac).
- **Reserved keys:** browsers keep a few shortcuts for themselves, notably Ctrl+W and Ctrl+T. Installing the
  dashboard as a browser app (PWA window) can free some of them.
- **Disconnect** leaves everything running. **Terminate** kills the session.
- **Attachments:** each session accepts one dashboard connection at a time. A plain `tmux attach` over SSH
  is not counted, and can be used alongside it.

## Testing

```bash
pnpm test
```

Backend tests use Jest. They cover session name validation, directory validation (traversal and symlink
escapes), tmux execution with mocked processes, error handling over HTTP, and WebSocket behavior with a
fake PTY. `test/real-tmux.integration.spec.ts` drives real tmux and real `node-pty` on a private socket,
and is skipped if tmux is not installed. Frontend tests use Vitest and Testing Library.

The end-to-end browser procedure is in [docs/manual-integration-test.md](docs/manual-integration-test.md),
and the terminal protocol in [docs/websocket-protocol.md](docs/websocket-protocol.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Sessions die when the service restarts | The unit lost `KillMode=process`, or it was not reloaded. Check with `systemctl show engineering-control-center -p KillMode`. |
| Journal says `Found left-over process ... in control group` | Expected and harmless. Those are your tmux sessions, surviving a restart because of `KillMode=process`. |
| Service fails with status 203/EXEC | The Node path in `ExecStart` is wrong, perhaps after an nvm upgrade. Check with `nvm which 22`. |
| `NODE_MODULE_VERSION` mismatch at startup | Node changed since the install. Run `pnpm install --force`. |
| `pnpm install` fails compiling `node-pty` | Install the build tools: `sudo apt install build-essential python3` |
| `Host or Origin is not allowed` | You are using a URL that is not in `ECC_ALLOWED_ORIGINS`, such as a different forwarded port. |
| Terminal stuck on "Connecting" | Same cause, as the upgrade is rejected. Check `journalctl` for `Rejected terminal upgrade`. |
| "Already open in another browser tab" | Close the other tab, and choose Reconnect. A connection that died without closing clears within about 30 seconds. |
| Sessions from SSH are not listed | Both must use the same tmux server and user. Check that `ECC_TMUX_SOCKET` is unset, and that `systemctl show -p User` matches your login. |
| A session is greyed out | Its name has characters the dashboard refuses. Rename it: `tmux rename-session -t old new` |
| "No project root exists" | The directories in `ECC_PROJECT_ROOTS` are missing. Create them, or fix the setting. |
| `claude` is not found in a new session | The session's shell did not load your profile as expected. Make sure your `~/.bashrc` sets up nvm, and check `which claude` over SSH. |
| Attaching exits at once with an `unknown option -- T` error | tmux is older than 3.2. Upgrade it. |
| Sessions from SSH die on logout | `KillUserProcesses=yes` is set in logind. Run `loginctl enable-linger $USER`, or change the setting. |
| `posix_spawnp failed` on macOS | Rerun `pnpm install`, which restores the execute bit on node-pty's helper. |

## Known limitations

- There is no application login. Multi-user use is not supported.
- Sessions do not survive an OS reboot.
- One dashboard connection per session. There is no read-only view or takeover yet.
- Sessions start in a shell. Launching Claude Code automatically is left for a future feature.
- Disk statistics cover the root filesystem only.
- A slow connection receives tmux repaints rather than every intermediate frame, which is what tmux does for
  any slow client.
