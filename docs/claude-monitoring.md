# Claude Code lifecycle monitoring

The dashboard shows what Claude Code appears to be doing in each tmux session, using Claude Code hooks.
States are **observations, not guarantees**. Monitoring never controls Claude Code: hooks return no
decisions, and nothing is approved or sent on your behalf.

## Event flow

```text
Claude Code, in a tmux pane
  │  hook JSON on stdin (the variable ECC_TMUX_SESSION is inherited from the pane)
  ▼
scripts/claude-hook-reporter.cjs      keeps metadata only, always exits 0, prints nothing
  │  POST /api/claude/hooks           bearer token from a private file
  ▼
ClaudeHooksController ─► ClaudeStateService      in-memory, bounded, ordered, deduplicated
                              │
                              ▼
                 ClaudeMonitoringGateway         WS /api/claude/events
                              │
                              ▼
                 useClaudeStatus ─► session list and status strip
```

Hook reporting does not depend on a browser being connected. tmux and Claude Code do not depend on the
backend: with the backend stopped, hooks fail fast and Claude continues.

## Installing the hooks

```bash
pnpm claude-hooks status
pnpm claude-hooks install --dry-run   # Shows what would be added. Changes nothing.
pnpm claude-hooks install
pnpm claude-hooks uninstall           # Removes only these hooks.
```

The installer edits the user-level `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), so no
repository is touched. It keeps every other setting and hook, writes a timestamped backup next to the file
before each change, avoids duplicates, and refuses to touch a file it cannot parse. Run it as the same user
that runs the dashboard and Claude Code.

- **When hooks take effect:** Claude Code documents that edits to hooks in settings files are normally picked
  up automatically. Restart any running Claude Code that does not start reporting.
- **After moving Node or this repository:** the command holds absolute paths, so run `install` again. Until
  then the hook does nothing, silently. `status` reports a command that differs from this checkout.
- **Cost outside monitored sessions:** the command tests `ECC_TMUX_SESSION` in the shell first, so other
  Claude Code sessions on the machine pay for one shell test and start no Node process.

## Which session an event belongs to

Claude Code identifies itself by a `session_id`, which has no relation to a tmux session name. The link is an
environment variable:

1. Creating a session in the dashboard runs `tmux new-session -e ECC_TMUX_SESSION=<name>`, so each pane in it,
   including later ones, inherits the variable. Claude Code passes it on to its hooks. No special launch command
   is needed, and the variable is scoped to that session.
2. The reporter also asks tmux which session its pane (`TMUX_PANE`) belongs to. If tmux disagrees with the
   variable, as after `tmux rename-session` or inside a nested tmux, **nothing is reported**. If tmux cannot
   answer, the variable stands.
3. The reporter reports nothing without the variable, or outside tmux.

Working directories, terminal output and process names are never used. When no reliable mapping exists, the
session stays Unknown.

### Sessions created outside the dashboard

Sessions created over SSH, and any created before this feature, have no variable and show Unknown. They keep
working as before. To monitor one, set the variable when starting Claude Code:

```bash
ECC_TMUX_SESSION=payroll claude     # In a pane of the tmux session named payroll.
```

or set it for every new pane in that session. Panes that are already open do not change:

```bash
tmux set-environment -t payroll ECC_TMUX_SESSION payroll
```

Inside tmux, a wrong name is caught by check 2 above.

## States

| State | Set by | Meaning |
| --- | --- | --- |
| Working | `UserPromptSubmit`, or a main-conversation tool event | Claude is processing. |
| Needs Attention | `PermissionRequest`, or a `Notification` of type `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` or `agent_needs_input` | Claude asked for something. It may already be resolved. |
| Idle | `Stop`, `StopFailure`, `SessionStart`, or a `Notification` of type `idle_prompt` | Claude is likely waiting for input. `Stop` means a response ended, not that a task is complete. |
| Offline | `SessionEnd` | Claude ended, or a new Claude replaced it in the same pane. |
| Unknown | Anything else | See `reason` below. |

Refinements, each based on what Claude Code 2.1.317 was observed to send:

- **Permission requests** are cleared only by a completed or failed event for the same tool from the same agent,
  by a new prompt, by `Stop`, or by `SessionEnd`. Another tool's events do not clear them, because tools can run
  in parallel.
- **Subagents** count as activity but do not make an idle Claude look busy. Claude Code can run a background agent
  just after `Stop`. Their permission requests do raise Needs Attention. Subagents are not shown individually.
- **`SessionStart` with source `compact`** changes nothing, since compaction happens mid-session.
- **Other notifications** are ignored.

### Unknown reasons

| `reason` | Meaning |
| --- | --- |
| `no-events` | Nothing reported for this session since the backend started. `monitored` is false. |
| `insufficient-events` | Claude was seen, but its events do not establish a state. |
| `stale` | No event for 10 minutes while Working, or for 24 hours while Needs Attention or Idle. A stale Working never becomes Idle. The next event recovers it. |
| `multiple-instances` | More than one Claude is live here, so one state cannot describe them. The exception is a request for attention from any of them, which is shown as Needs Attention. |

### Restarts and several instances

Instances are told apart by `session_id` and pane:

- A new Claude in the same pane supersedes the previous one, even if that one crashed without `SessionEnd`. This
  covers restarts and `/clear`.
- Claude in two panes of a session is reported as `multiple-instances`. When one ends or goes stale, the session
  returns to one-to-one.
- A nested Claude, started by another in the same pane, supersedes its parent until the parent's next event. The
  session then reports `multiple-instances` until the child ends.

After a backend restart nothing is restored: every session is Unknown until its next event. An old state is
never shown as current. State is also dropped when a session disappears from tmux, and events older than a
session cannot apply to a new session that reuses the name.

## Attention notifications

The page title always shows how many sessions need attention, as in `(2) Engineering Control Center`. The bell
beside **New session** adds browser notifications. It is off until you click it, and the choice is remembered in
that browser. This is entirely in the browser: the backend is unchanged, and an alert never answers Claude Code.
Clicking one only opens the session.

- **When an alert appears:** when a session enters Needs Attention. Sessions already waiting when the page opens
  are not announced, though the title counts them. A session that entered Needs Attention while the connection
  was down is announced on reconnecting.
- **When it stays quiet:** when that session is on screen in a focused window. Other sessions still alert.
- **When an alert closes:** when you click it, when the session leaves Needs Attention, or when you turn the bell off.
- **What it shows:** the session name and a fixed sentence, never prompts or tool names, because it can appear on
  a lock screen.

Limitations:

- **The page must stay open.** With every dashboard tab closed, or a tab the browser has discarded to save
  memory, nothing can alert you. Alerting with the browser closed would need a push service.
- **HTTPS or localhost is required,** so SSH forwarding and `tailscale serve` work, and a plain `http://` address
  does not. The title count works everywhere.
- **Phones:** Android browsers allow notifications only from an installed app, and iOS only from a web app added
  to the home screen, so the bell reports this or is unavailable there.
- **The operating system can hide them.** Check its notification settings for the browser, and any Do Not Disturb
  mode. The confirmation sent on turning the bell on shows whether they get through.
- **It inherits the limitations below.** A second request in a session already in Needs Attention changes no state,
  so it does not alert again. After a denied request the state remains until the next prompt, so the next request
  may not alert either. No alert does not mean Claude is not waiting.

## API

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `POST /api/claude/hooks` | Bearer token | Ingests one event. Returns 202 and `{"accepted":boolean}`. `false` means duplicate, outdated, or irrelevant. |
| `GET /api/claude/status` | Dashboard (Host and Origin checks) | `{"ingestionAvailable":boolean,"sessions":[...]}` for every tmux session. |
| `GET /api/claude/status/:tmuxSession` | Dashboard | One status. 404 if tmux has no such session. |
| `WS /api/claude/events` | Dashboard (mandatory allowed Origin) | Pushes only. |

Messages on the socket, defined in
[`packages/shared/src/types/claude-monitoring.ts`](../packages/shared/src/types/claude-monitoring.ts):

```json
{ "type": "claude.status.snapshot", "data": { "ingestionAvailable": true, "sessions": [] } }
{ "type": "claude.status.changed", "data": { "tmuxSession": "payroll", "state": "needs_attention", "monitored": true, "reason": null, "instanceCount": 1, "lastEvent": "PermissionRequest" } }
```

A snapshot always comes first, and replaces everything the client knows, so reconnecting needs no separate
fetch. State changes go out immediately. Updates that only change the activity time go out at most every 5
seconds per session, and a sweep every 15 seconds publishes staleness and vanished sessions.

Limits: 256 sessions, 16 instances per session, 4096 remembered event IDs, 16 KiB per request. Timestamps more
than 5 minutes ahead of the server are rejected, because they would outrank every later event.

## Security and privacy

**What is sent:** a random event ID, the Claude session ID, the tmux session name, the event type, a timestamp,
the pane ID, and where applicable the session source, notification type, tool name and agent ID. The reporter
copies these fields individually. Prompts, tool arguments, tool output, transcripts, assistant messages,
working directories and environment contents are never read out of the input. The API also rejects any body
with an undeclared field, so such a body fails rather than being stored. Nothing is written to disk.

**Hook token:** generated by the backend on first start, in `~/.config/engineering-control-center/claude-hook.json`
(mode 0600, directory 0700, overridable with `ECC_STATE_DIR`). It is never served over HTTP and never enters
tmux's environment. Loopback alone would let any local user post events, so this file is the boundary. A file
that others could read is replaced, since its token must be assumed exposed. If the file cannot be prepared,
ingestion is disabled and the rest of the dashboard works. The token only allows reporting status.

**Dashboard endpoints** follow the V1 trust model: there is no login, and access relies on the private channel
plus the Host and Origin checks. Anyone who can use the dashboard already has a shell.

## Performance

Hooks run synchronously, because Claude waiting for each one is what keeps events in order. On the development
machine, Node took about 17 ms to start and the tmux lookup about 4 ms. That was judged small enough to
report every event instead of adding throttling state that could lose a transition. The network timeout is
500 ms, the tmux lookup 500 ms, and the whole reporter 1.5 seconds. With the backend stopped, connections fail
immediately.

## Limitations

These follow from what hooks expose:

- **Denying a permission request sends no hook.** Choosing "No", or pressing Esc, at a permission dialog was
  observed to send nothing, so Needs Attention remains until the next prompt. The status strip says so.
- **Pressing Esc mid-turn sends no `Stop`,** according to the Claude Code documentation, so Working remains until
  the next event or until it goes stale after 10 minutes. This case was not observed directly.
- **An approved tool still running** keeps showing Needs Attention until it completes, since approval sends no event.
- **A long tool or a long model call** with no events for over 10 minutes shows Unknown until it next reports.
- **A killed Claude,** or one that crashes, sends no `SessionEnd`. Its last state stands until it goes stale,
  until a new Claude starts in that pane, or until the tmux session ends.
- **Not every permission prompt is guaranteed to send a hook.** Treat the absence of Needs Attention as absence of
  evidence.
- **A renamed session** stops reporting until Claude is started with the new name in the variable.
- **Two dashboards run by one user** share the credentials file unless they set different `ECC_STATE_DIR` values.
- **A second tmux server** is not told apart: `ECC_TMUX_SESSION` naming a session on another server would report to
  a session of that name on the dashboard's server.
