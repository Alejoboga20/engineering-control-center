# Engineering Inbox

A persistent, prioritized queue of work that needs a person: pull requests to review, permission prompts,
questions from agents, and agents that stopped on an error. It exists so that no actionable agent output gets
lost across tmux sessions and conversations.

An **event** is something that happened (`pr.checks_failing`, `permission.requested`). An **item** is something
that needs attention ("Review PR #184"). Many events update one item, found by its stable source key. The Inbox
never merges, approves, answers or delegates anything.

## Architecture

```text
Claude Code hooks ─► POST /api/claude/hooks ─► ClaudeStateService (V2, in memory)
                                                  │ onEvent / onChange
                                                  ▼
                                           ClaudeInboxBridge ─┐
Agent (MCP tool) ─► scripts/ecc-inbox-mcp.cjs                 │
                    └► POST /api/inbox/events/agent           │
                       AgentReportsController ────────────────┤
GitHub GraphQL ◄── GitHubClient ◄── GitHubSyncService ────────┤
                   (read-only, polling)                       ▼
                                                        InboxService ─► InboxRepository ─► SQLite
                                                              │ after commit
                                                              ▼
                                      InboxGateway (WS /api/inbox/stream) ─► browser
                                      InboxController (REST /api/inbox)  ◄── browser
```

| Component | Role |
| --- | --- |
| `InboxDatabase` | Opens `inbox.sqlite3`, applies migrations. If it cannot open, the Inbox answers 503 and nothing else is affected. |
| `InboxRepository` | All SQL. Parameterized statements only. |
| `InboxService` | Rules that hold for every source: idempotent upsert by source key, revisions, manual priorities, transitions, bounded events. One logical change is one transaction; WebSocket messages go out after commit. |
| `ClaudeInboxBridge` | Turns accepted hook events into items, clears them on reliable signals, marks them uncertain otherwise. |
| `AgentReportsService` / `AgentReportsController` | Structured, authenticated agent reports. |
| `GitHubClient` / `GitHubSyncService` | Read-only GraphQL queries, polling, reconciliation, rate-limit backoff. |
| `InboxGateway` | Push-only WebSocket. SQLite, not the socket, is the source of truth. |

The module lives in `apps/api/src/inbox/`. The contract shared with the frontend is
`packages/shared/src/types/inbox.ts`.

## Storage

SQLite through [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): no ORM existed in the codebase; the
driver is synchronous, so a transaction in this single-process server is trivially atomic; and it ships prebuilt
binaries for Linux and macOS. Node's built-in `node:sqlite` is still experimental on Node 22.

- **Location:** `$ECC_DATA_DIR/inbox.sqlite3`, default `~/.local/share/engineering-control-center/`. Outside the
  repository and every build directory, so deploys and `pnpm build` never touch it. The directory is `0700` and the
  file `0600`; SQLite's `-wal` and `-shm` files take the same permissions.
- **Pragmas:** WAL journal, `foreign_keys=ON`, `busy_timeout=5000`.
- **Migrations:** an ordered list of SQL steps in `inbox-migrations.ts`, tracked with `PRAGMA user_version`. Each
  step runs in its own transaction at startup. A shipped step is never edited; changes are appended as new steps,
  so existing data is kept. A database newer than the build is refused (the Inbox is then disabled), never
  downgraded.
- **Never stored:** credentials, tokens, prompts, conversation content, tool arguments or output, pull request
  bodies, raw hook payloads. Titles (200 characters) and descriptions (4000) are the only free text.

### Schema

`inbox_items`: one row per thing that needs attention.

| Column | Meaning |
| --- | --- |
| `id` | UUID |
| `type` | `pull_request`, `human_input`, `permission_request`, `agent_failure` |
| `source_key` | Stable identity, `UNIQUE`. See below. |
| `title`, `description` | Plain text from untrusted sources |
| `priority`, `suggested_priority`, `priority_overridden` | Effective priority, what the rules suggest, and whether a person overrode it |
| `status` | `open`, `acknowledged`, `resolved` |
| `source` | `github`, `claude` (`manual` is reserved) |
| `source_state` | `open`, `merged`, `closed` for PRs; `pending`, `cleared`, `uncertain` for hook-raised Claude items; always `pending` for agent-reported blockers |
| `source_session`, `source_agent` | tmux session and Claude session ID, when known |
| `pr_repository`, `pr_number`, `pr_url`, `pr_author`, `pr_draft`, `pr_review_state`, `pr_checks_state`, `pr_attribution` | Pull request metadata. `UNIQUE (pr_repository, pr_number)`. |
| `revision` | Increases on every change |
| `created_at`, `updated_at`, `last_activity_at`, `acknowledged_at`, `resolved_at` | ISO 8601 UTC |
| `resolution` | `manual`, `auto_merged`, `auto_closed`, `auto_cleared` |

CHECK constraints guard every enum, the length limits, and that `resolution` is set exactly when the status is
`resolved`.

`inbox_events`: the audit trail. `item_id` (cascade on delete), `kind`, `source` (`github`, `claude`, `human`,
`system`), `summary` (safe text, at most 500 characters), `idempotency_key` (`UNIQUE`), `occurred_at`,
`recorded_at`. The newest 200 events per item are kept; older ones are pruned in the same transaction. The detail
endpoint returns the newest 100.

`github_sync_state`: per repository, `last_sync_at`, `last_success_at`, `last_error`, `initial_sync_done`,
`baseline_at`.

`github_pending_reports`: pull requests an agent reported that GitHub has not confirmed yet (repository, number,
session, agent, time). Forgotten after 7 days.

### Source keys

| Item | Key |
| --- | --- |
| Pull request | `github:pr:<owner/name lower case>#<number>` |
| Permission request | `claude:permission:<tmux session>:<Claude session ID>`: one item per Claude instance |
| Input request (elicitation, `agent_needs_input`) | `claude:input:<tmux session>:<Claude session ID>` |
| StopFailure | `claude:failure:<tmux session>:<Claude session ID>` |
| Agent report with an idempotency key | `agent:report:<key>` |
| Agent report without a key | `agent:report:<tmux session or unknown>:<sha256 of the normalized title>`, suffixed `:<n>` when earlier items with that title are resolved |

Hook events are also recorded with the idempotency key `hook:<eventId>:<kind>`, so a redelivered event changes
nothing, even after a restart. Agent reports use `agent:human_input:<key>` and `agent:pull_request:<key>`.

## Rules

### Priorities

| Condition | Suggested |
| --- | --- |
| Pull request, draft | P3 |
| Pull request, ready (including changes requested) | P2 |
| Pull request, ready, checks failing | P1 |
| Permission request | P1 |
| Input request from a notification | P1 |
| Agent report | Its `priority`, default P2 |
| Agent failure (StopFailure) | P2 |

Sources only ever change `suggested_priority`. The effective `priority` follows it unless a person set one with
`PATCH`, which sets `priority_overridden`. `PATCH` with `priority: null` clears the override and returns to the
suggestion. A sync therefore never resets a manual priority.

### Status transitions

| Action | From | To |
| --- | --- | --- |
| Acknowledge | open | acknowledged |
| Resolve | open, acknowledged | resolved (`manual`) |
| Reopen | resolved | open (clears `resolution`, `resolved_at`, `acknowledged_at`) |

Repeating the current state is a no-op that returns 200 and records nothing. Any other transition is
`409 INBOX_INVALID_TRANSITION`.

**New actionable conditions** return an acknowledged item to open, and reopen a resolved one. They are only:

- a pull request reopened on GitHub;
- a pull request's checks changing to failing from any other state;
- a new permission request, input request or StopFailure from the same Claude instance after its item was cleared,
  became uncertain, or was resolved.

Not actionable: title changes, new commits, pending checks, draft or review changes, repeated identical events,
agent report retries, or a second permission request while the first is still `pending` (the item keeps its status
and records the event).

### Pull requests

- Merged on GitHub: `source_state=merged`, resolved as `auto_merged` unless already resolved.
- Closed without merging: `source_state=closed`, resolved as `auto_closed`.
- Events are always kept. A person resolving an open PR's item is respected until a new actionable condition.

### Claude items

These items mean "answer this prompt", so they are cleared, and resolved as `auto_cleared`, by the same reliable
signals that end Needs Attention in [monitoring](claude-monitoring.md):

- permission and input items: the instance leaving Needs Attention (for example the completion of the very tool
  that asked), `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, or a new `SessionStart` (not `compact`);
- failure items: the next `UserPromptSubmit` or `SessionStart` (not `compact`).

An event older than the item's last activity changes nothing but the audit trail.

After a backend restart the monitor no longer knows which tool asked, so the completion of a tool does **not**
clear an `uncertain` permission item; only `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd` or a new
`SessionStart` do. This errs on the safe side: an item is never resolved on a signal that might belong to another
prompt.

Without a reliable signal, the item becomes **`uncertain`**, and is never resolved automatically:

- on backend start, every Claude item still `pending` (the in-memory monitor state is gone);
- when its tmux session disappears;
- when monitoring marks the session stale;
- when a new Claude Code starts in the same pane.

Items survive their session. **Denying a permission sends no hook** (verified in V2), so after a denial the item
stays `pending` until the next prompt clears it; the UI says so.

Agent-reported blockers also have `source_state` `pending`, but they are not cleared by hooks and never become
uncertain: an explicit blocker stays until a person
resolves it.

### Listing

Sorted by priority (P1 first), then actionability (open, acknowledged, resolved), then `last_activity_at`, newest
first. Human actions do not change `last_activity_at`, so triage never reshuffles the list. A response holds at
most 500 items.

| Filter | Items |
| --- | --- |
| `all` (default) | Every item not resolved, plus items resolved in the last 7 days |
| `needs_attention` | Open and P1 |
| `pull_requests` | Pull requests not resolved |
| `agent_blockers` | `human_input`, `permission_request`, `agent_failure` not resolved |
| `resolved` | Every resolved item |

`priority` and `status` narrow any filter further.

## API

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/inbox?filter=&priority=&status=` | | `InboxListResponse` |
| `GET /api/inbox/summary` | | `InboxSummary`: counts, GitHub sync health, agent reporting availability |
| `GET /api/inbox/:id` | | `InboxItemDetail`: the item and its newest 100 events |
| `PATCH /api/inbox/:id` | `{ "priority": "P1" \| "P2" \| "P3" \| null }` | The updated `InboxItem` |
| `POST /api/inbox/:id/acknowledge` | | The updated `InboxItem` |
| `POST /api/inbox/:id/resolve` | | The updated `InboxItem` |
| `POST /api/inbox/:id/reopen` | | The updated `InboxItem` |
| `POST /api/inbox/sync/github` | | `202` with `GitHubSyncStatus`; `409 GITHUB_SYNC_RUNNING`; `400 GITHUB_NOT_CONFIGURED` |
| `POST /api/inbox/events/agent` | `AgentReportRequest` | `202` with `AgentReportResponse`. Bearer token required. |
| `WS /api/inbox/stream` | | `inbox.hello` first, then `inbox.item.created`, `inbox.item.updated`, `inbox.item.resolved`, `inbox.sync.completed` |

Item ids must be UUIDs. Unknown query parameters and body fields are rejected with 400. Every browser endpoint is
behind the existing Host and Origin guard, and the stream behind the same upgrade check as terminals. There is no
create endpoint and no raw query access.

Clients apply item messages by `revision`, dropping older ones, and refetch `GET /api/inbox` on every
`inbox.hello`, including after a reconnection. While GitHub has asked to back off, `POST /sync/github` answers 202
without starting a sync, and the status carries `rateLimitedUntil`.

## GitHub

Pull requests come from the **GraphQL API v4** over HTTPS with Node's `fetch`. One paginated query per repository
returns each open pull request's draft state, `reviewDecision` and the head commit's `statusCheckRollup`; the REST
API would need two or three more calls per pull request on every poll. Only queries are sent, never mutations, and
pull request bodies are never requested.

### Setup

1. Create a **fine-grained personal access token** (GitHub, Settings, Developer settings) limited to the repositories
   you will list, with these repository permissions, all **read-only**:
   - **Metadata**: read (always included);
   - **Pull requests**: read;
   - **Commit statuses**: read, for checks reported as statuses.

   Fine-grained tokens have no separate "Checks" permission. GitHub documents no permission for the GraphQL
   `statusCheckRollup` field; if a query is refused, GitHub's error names the missing permission, and the sync error
   in the Inbox shows it. A classic token with the `repo` scope also works but grants far more.
2. Store it in a file that holds only the token, owned by the service user and readable by nobody else:

   ```bash
   install -m 600 /dev/null ~/.config/engineering-control-center/github-token
   $EDITOR ~/.config/engineering-control-center/github-token
   ```

   The file is refused if it is a symlink, belongs to another user, or is readable by group or others. It is read
   at each sync, so a rotated token needs no restart. The token is sent only in the `Authorization` header to
   `api.github.com`. It is never logged, never stored in SQLite and never sent to the browser.
3. Configure, then restart:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `ECC_GITHUB_REPOS` | unset | Comma-separated `owner/name`. Required. Nothing else is ever queried. |
   | `ECC_GITHUB_TOKEN_FILE` | unset | Absolute path of the token file. Required. |
   | `ECC_GITHUB_AUTHORS` | unset (all) | Comma-separated logins whose pull requests become items |
   | `ECC_GITHUB_POLL_SECONDS` | `180` | 60 to 3600 |
   | `ECC_GITHUB_INITIAL_SYNC` | `open` | `open`: import every open pull request on a repository's first sync. `new`: import none on the first sync, then only pull requests created after it. Changing it after the first sync has no effect on that repository. |

### Synchronization

The first sync starts 10 seconds after startup, then every `ECC_GITHUB_POLL_SECONDS`. Syncs never overlap. For each
repository:

1. Page through open pull requests, 50 per page, newest first, up to 20 pages. Each is created or updated.
2. Look up, by number and in batches of 25 aliased fields, the tracked pull requests that the database still
   believes open but that were not in the list. That is how merges and closes are found; closed pull requests are
   never listed wholesale.
3. Look up unconfirmed agent reports the same way.

A lookup that matches nothing (GitHub answers a null field with a `NOT_FOUND` error) is an answer, not a failure,
and does not fail the sync. An agent report of such a number (a typo, an issue number) is dropped, with a
`pr.report_dropped` event. A tracked item whose pull request GitHub no longer finds (deleted or transferred) keeps
its state, gets one `pr.not_found` event, and is never resolved automatically; resolve it yourself if it is gone.
Errors that are not GitHub's are shown as "Unexpected error while syncing." and logged with their message (never
the token).

GitHub is the source of truth. A failed sync records its error per repository and globally, and **never deletes or
resolves anything**. A repository removed from `ECC_GITHUB_REPOS` stops syncing; its items stay.

**Rate limits.** HTTP 403 or 429 with `retry-after`, or `x-ratelimit-remaining: 0` with `x-ratelimit-reset`, or a
GraphQL `RATE_LIMITED` error, or a 403/429 mentioning a rate limit without headers (a minute), sets
`rateLimitedUntil`. Scheduled and manual syncs are skipped until then. A response whose `rateLimit.remaining` is 0
also backs off until its `resetAt`.

**Attribution** is `discovered` unless an authenticated agent report named that repository and number, then
`agent_reported`. It is never inferred from the author.

**Agent reports of pull requests** must name an allowed repository (`403 REPOSITORY_NOT_ALLOWED` otherwise). The
backend looks the pull request up synchronously, with a 5 second limit. If GitHub confirms it, the item is created
or updated, linked to the reporting session and marked `agent_reported`, and the answer carries its id. Otherwise
(not yet visible, GitHub unreachable or not configured, backing off) the report is kept in
`github_pending_reports`, the answer has `itemId: null`, and the sync that first sees the pull request links it.

## Agent reporting

Agents report through a local MCP server, `scripts/ecc-inbox-mcp.cjs`: dependency-free, stdio, newline-delimited
JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`). A message without
an `id` is a notification: it is never answered, and a tool call sent that way is not carried out. It offers two
tools:

| Tool | Arguments |
| --- | --- |
| `report_blocker` | `title` (1-200, one line), `description` (up to 4000, plain text), `priority` (`P1`-`P3`, default P2), `idempotency_key` (8-128 of `A-Za-z0-9_.:-`) |
| `report_pull_request` | `repository` (`owner/name`), `number` |

It reads the backend URL, Host and token from the hook credentials file (`$ECC_STATE_DIR/claude-hook.json`, or
`~/.config/engineering-control-center/claude-hook.json`) and posts to `POST /api/inbox/events/agent`. The tmux
session comes from `ECC_TMUX_SESSION`, checked against `TMUX_PANE` with tmux exactly as the hook reporter does; if
that fails, the report goes out with no session and the item shows an unknown session, rather than a guess. It
never prints the token, never accepts paths or commands, and answers with short text.

### Installing

Installation is manual and reversible. This only prints the commands, with this checkout's absolute paths:

```bash
pnpm inbox-mcp
```

which shows:

```bash
claude mcp add --scope user ecc-inbox -- /path/to/node /path/to/repo/scripts/ecc-inbox-mcp.cjs
claude mcp remove --scope user ecc-inbox
```

Options go before the server name and the command after `--`, as Claude Code documents. `--scope user` makes the
tool available in every project for your user, without touching any repository. If `ECC_STATE_DIR` is set, add
`--env ECC_STATE_DIR=<dir>` before the name. Run the commands as the user that runs Claude Code.

### The endpoint

`POST /api/inbox/events/agent` uses the hook bearer token (`ClaudeHookAuthGuard`), which browsers never hold, plus
the usual Host rule, and the 16 KiB body limit. The body is validated against `AgentReportRequest`: unknown fields,
control characters (other than newline and tab in descriptions), bidirectional overrides, and anything over the
limits are rejected with 400. `human_input` requires `title` and refuses pull request fields; `pull_request`
requires `repository` and `pullRequestNumber` and refuses the others. Agents can report; they cannot resolve,
approve, merge or change priorities.

Idempotency: with `idempotencyKey`, the key is the report, and any retry returns the same item with
`created: false`. Keys are namespaced by report type, so a blocker and a pull request report may reuse one key.
Without a key, the same normalized title from the same session updates the matching item as long as it is not
resolved; once it is, the same title opens a new item. A retry without a key records no new event when the item's
latest event already says the same, so retries cannot push real history out of the 200-event limit.

## Security

- No GitHub token in SQLite, logs, responses or the browser; the token file must be private.
- Only allowlisted repositories are queried. Agent reports for other repositories are refused.
- Agent reporting needs the hook token. Browser endpoints keep the Host and Origin guard, CORS allowlist and CSP.
- All SQL is parameterized. Filters, priorities and statuses are allowlisted values.
- Titles and descriptions are untrusted plain text. The frontend never renders them as HTML or Markdown, and links
  open only for `https://github.com` URLs.
- No prompts, tool arguments, tool output or transcripts reach the Inbox: hook events are already reduced to
  metadata by the reporter, and only tool names appear in event summaries.
- No endpoint runs commands. Nothing is merged, approved or answered automatically.

## Supervisor readiness

A future, read-only Supervisor agent can read `GET /api/inbox`, `/summary` and `/:id` to rank work, summarize pull
requests and suggest duplicates. Its recommendations would be stored separately, never by mutating items: the Inbox
stays the deterministic source of truth. `revision` and the event history let it reason about what changed since it
last looked. No LLM is called in V4.

## Backup and restore

The database is one file. While the dashboard runs, copy it with SQLite's online backup, never with `cp`:

```bash
pnpm inbox backup ~/backups/inbox-$(date +%F).sqlite3
```

This uses better-sqlite3's backup API, so it works without the `sqlite3` command. The copy is switched out of WAL
mode, so it is one standalone file that opens read-only, for example with `sqlite3 -readonly`. With the CLI installed, this is
equivalent:

```bash
sqlite3 ~/.local/share/engineering-control-center/inbox.sqlite3 ".backup '$HOME/backups/inbox.sqlite3'"
```

To restore:

```bash
sudo systemctl stop engineering-control-center
cd ~/.local/share/engineering-control-center
rm -f inbox.sqlite3-wal inbox.sqlite3-shm
install -m 600 ~/backups/inbox-2026-11-07.sqlite3 inbox.sqlite3
sudo systemctl start engineering-control-center
```

Restarting marks pending Claude items uncertain, as after any restart. Pull request items catch up at the next
sync.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Inbox shows "unavailable" (503) | The journal says `Engineering Inbox disabled:` and why: an unwritable `ECC_DATA_DIR`, a corrupt file, or a database from a newer build. |
| GitHub "not configured" | The summary names the problem: missing `ECC_GITHUB_REPOS` or `ECC_GITHUB_TOKEN_FILE`, or a token file that is a symlink or readable by others (`chmod 600`). |
| `GitHub rejected the token (401)` | The token expired or was revoked. Replace the file's contents; no restart needed. |
| `GitHub refused the request (403)` or a query error naming a permission | The token lacks a permission or a repository. Edit the fine-grained token. |
| `Repository acme/api was not found.` | A typo in `ECC_GITHUB_REPOS`, or the token cannot see that repository. |
| Rate limited | Shown with the time it ends. Raise `ECC_GITHUB_POLL_SECONDS` if it recurs. |
| Agent reports fail with 401 | The MCP server reads a different credentials file. Set `--env ECC_STATE_DIR=...` to match the backend. |
| Agent items show no session | The agent's Claude Code was not started in a dashboard session, or tmux disagreed with `ECC_TMUX_SESSION`. |
| A permission item stays pending | The prompt was probably denied, which sends no hook. Resolve it, or it clears at the next prompt. |

## Limitations

- Detection of denied permissions is impossible with current hooks; see above. `PermissionDenied` exists but fires
  only for auto-mode denials, not for a person's denial.
- GitHub is polled, not pushed: a change appears within one poll interval or after Sync now.
- At most 1000 open pull requests are listed per repository and sync; tracked ones beyond that are still reconciled
  by lookup.
- Only the head commit's combined check state is used; individual checks are not listed.
- The MCP server cannot tell which Claude session it serves, so agent reports carry the tmux session only.
- `ECC_GITHUB_AUTHORS` filters which pull requests create items; it is not attribution.
