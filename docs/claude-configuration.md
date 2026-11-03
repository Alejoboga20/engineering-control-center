# Claude Code configuration explorer

The **Configuration** tab shows how Claude Code is configured on this machine, without SSH. It is strictly
read-only: the API has only GET endpoints, nothing is ever executed, and the filesystem is the only source of
truth, with no database, index, cache or background scanning. Every request and every **Refresh** reads the
files again.

It shows what each file says. It does not compute Claude Code's effective configuration, because that also
depends on managed settings, command-line flags, plugins, environment variables and parent directories.

Locations were checked against the official documentation and Claude Code 2.1.317.

## What is read

Global paths are relative to `~/.claude`, or to `$CLAUDE_CONFIG_DIR` if the backend has it set. Project paths
are relative to a project: a directory in `ECC_PROJECT_ROOTS`, or an immediate subdirectory of one.

| Category | Global | Project |
| --- | --- | --- |
| Agents | `agents/**/*.md` | `.claude/agents/**/*.md` |
| Skills | `skills/<name>/SKILL.md`, `skills/synced/<bucket>/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| Instructions | `CLAUDE.md` | `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` (Local) |
| Rules | `rules/**/*.md` | `.claude/rules/**/*.md` |
| Knowledge directories | Absolute entries of `ECC_CLAUDE_KNOWLEDGE_DIRS` | Relative entries of `ECC_CLAUDE_KNOWLEDGE_DIRS` |
| Hooks and settings | `settings.json` | `.claude/settings.json`, `.claude/settings.local.json` (Local) |
| MCP server count | Not read | `.mcp.json` |

Directory walks skip names starting with a dot and `node_modules`, go at most 5 levels deep, and return at most
500 files per category. Nothing else is read: not the rest of `~/.claude`, not transcripts, logs, caches or
credentials, not `~/.claude.json`, and not other Markdown in a repository.

Every resource is labeled **Global**, **Project** or **Local**, with its relative path, so same-named resources
stay distinguishable.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude Code's user directory, if not `~/.claude`. |
| `ECC_CLAUDE_KNOWLEDGE_DIRS` | Comma-separated Markdown directories. Absolute entries appear in the global scope, and relative ones in each project. Relative entries cannot contain `..`. |
| `ECC_CLAUDE_SYMLINK_TARGETS` | Comma-separated absolute directories that symlinks in configuration locations may point into. |

### Symlinks

A cloned repository can contain a symlink to anything the backend user can read, so symlinks are not followed
unless their canonical target is inside `ECC_CLAUDE_SYMLINK_TARGETS`. The list shows how many were skipped.
The file-name rules still apply to the target, so a link to `.env` is refused even inside an approved
directory. One exception needs no approval: `ln -s AGENTS.md CLAUDE.md`, a documented setup, works among the
instruction files of the same directory.

If your configuration is kept in a dotfiles repository and linked into place, approve that directory:

```bash
ECC_CLAUDE_SYMLINK_TARGETS=~/claude-config,~/.agents/skills
```

`~/.claude` itself may be a link. A configured root is trusted, and resolved to its canonical path.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/claude/config/scopes` | Whether the global directory exists, and the approved projects with opaque IDs. |
| `GET /api/claude/config/agents` | Agent summaries. |
| `GET /api/claude/config/skills` | Skill summaries. |
| `GET /api/claude/config/knowledge` | Instruction, rule and knowledge file summaries. |
| `GET /api/claude/config/hooks` | Hook registrations, as structure. |
| `GET /api/claude/config/settings` | Allowlisted settings, for each file. |
| `GET /api/claude/config/resources/:resourceId` | One resource, with its Markdown body and modification time. |

The list endpoints take `?scope=global` (the default) or `?scope=project&project=<id>`. Types are in
[`packages/shared/src/types/claude-configuration.ts`](../packages/shared/src/types/claude-configuration.ts).
Access follows the rest of the dashboard: the private channel plus the Host and Origin checks. Responses are
sent with `Cache-Control: no-store`.

## Security

**No path ever comes from a caller.** Projects and resources are selected by opaque IDs. A resource ID is only
ever resolved by running discovery again and looking for it among the results, so there is no generic file read
to attack, and a removed file stops resolving.

**Allowlists, not redaction.** Redacting arbitrary shell commands cannot be made reliable, so:

- **Frontmatter:** only named fields are returned, and the raw block never is. `hooks`, `mcpServers` and
  `initialPrompt` are dropped. `tools` is reduced to tool names, so `Bash(curl -H "..." *)` becomes `Bash`.
  Frontmatter without a closing line gives an empty body, because its extent is unknown.
- **Hooks:** event name, handler count, matcher group count, handler type, scope and file. Commands, arguments,
  URLs, headers, prompts and matchers are never returned. An event name that is not in Claude Code's documented
  list is only counted, since it could be anything.
- **Settings:** a fixed set of fields, each validated by type. Models, themes and similar values must look like
  identifiers, so a URL or ARN is omitted. Permission rules, MCP lists and plugins are shown as counts. `env`,
  `apiKeyHelper` and every unknown field are only included in a count of hidden fields.
- **`.mcp.json`:** the number of servers, and nothing else.

**Filesystem.** Node filesystem APIs only, with no shell. Roots are resolved to canonical paths, and paths are
walked one component at a time, applying the symlink policy to each. Files are opened with `O_NOFOLLOW` and
`O_NONBLOCK`, must be regular files of at most 1 MiB with no NUL bytes, and are checked again after opening that
the path still resolves to the same file. This narrows, but cannot fully close, the window for a local user who
can write to these directories. Errors never include paths or parse messages, since V8's JSON errors quote the
input.

**Rendering.** Markdown is rendered by `react-markdown` with no raw HTML plugin, so HTML stays inert text. Unsafe
link protocols are dropped, and images become text, so opening a file cannot contact another server.

**Markdown bodies are shown as written.** Instructions, agents, Skills, rules and knowledge files are displayed
in full, because that is the purpose of this feature. They are not scanned for secrets, so anything pasted into
such a file is visible to anyone who can use the dashboard. Anyone who can use the dashboard already has a shell
as this user.

## Limitations

- **Not included:** managed settings and managed `CLAUDE.md`, plugin-provided agents, Skills and hooks, hooks in
  agent or Skill frontmatter, legacy `.claude/commands`, and `--add-dir` directories.
- **User-scope and local-scope MCP servers** live in `~/.claude.json`, which also holds account data, so they are
  not read or counted.
- **`CLAUDE.md` in parent or nested directories** is not shown, although Claude Code can load it. Resolving it would
  mean reading outside the approved locations. `@path` imports are shown as text and not followed.
- **Only `SKILL.md`** is shown for a Skill, not its supporting files.
- **A project** is a root or an immediate subdirectory of one, as in the session dialog, and at most 500 are listed.
- **Hard links** cannot be told apart from regular files. Creating one requires local write access, and Git does not
  create them.
- **Frontmatter** that is still not parseable after retrying with plain values quoted is reported as invalid. Its
  body is shown, without metadata.
- **Unknown settings and event names** added by future Claude Code versions remain hidden until allowlisted.
