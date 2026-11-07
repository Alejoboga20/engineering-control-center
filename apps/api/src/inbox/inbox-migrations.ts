/**
 * Schema steps, applied in order and tracked with `PRAGMA user_version`. A shipped step is never
 * edited: a change is a new step appended to the end, so existing databases keep their data.
 *
 * Nothing here may hold credentials, prompts, tool arguments, pull request bodies or raw hook
 * payloads. Titles and descriptions are the only free text, and they are length-limited.
 */
export const INBOX_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE inbox_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL
      CHECK (type IN ('pull_request', 'human_input', 'permission_request', 'agent_failure')),
    source_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT CHECK (description IS NULL OR length(description) <= 4000),
    priority TEXT NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
    suggested_priority TEXT NOT NULL CHECK (suggested_priority IN ('P1', 'P2', 'P3')),
    priority_overridden INTEGER NOT NULL DEFAULT 0 CHECK (priority_overridden IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
    source TEXT NOT NULL CHECK (source IN ('github', 'claude', 'manual')),
    source_state TEXT NOT NULL
      CHECK (source_state IN ('open', 'merged', 'closed', 'pending', 'cleared', 'uncertain')),
    source_session TEXT,
    source_agent TEXT,
    pr_repository TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    pr_author TEXT,
    pr_draft INTEGER CHECK (pr_draft IS NULL OR pr_draft IN (0, 1)),
    pr_review_state TEXT CHECK (pr_review_state IS NULL OR pr_review_state IN
      ('review_required', 'approved', 'changes_requested', 'none', 'unknown')),
    pr_checks_state TEXT CHECK (pr_checks_state IS NULL OR pr_checks_state IN
      ('passing', 'failing', 'pending', 'none', 'unknown')),
    pr_attribution TEXT CHECK (pr_attribution IS NULL OR pr_attribution IN
      ('discovered', 'agent_reported')),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT,
    resolution TEXT CHECK (resolution IS NULL OR resolution IN
      ('manual', 'auto_merged', 'auto_closed', 'auto_cleared')),
    CHECK ((status = 'resolved') = (resolution IS NOT NULL))
  );
  CREATE UNIQUE INDEX inbox_items_pull_request ON inbox_items (pr_repository, pr_number)
    WHERE pr_repository IS NOT NULL AND pr_number IS NOT NULL;
  CREATE INDEX inbox_items_listing ON inbox_items (status, priority, last_activity_at);
  CREATE INDEX inbox_items_session ON inbox_items (source, source_session, source_state);

  CREATE TABLE inbox_events (
    id TEXT PRIMARY KEY,
    item_id TEXT REFERENCES inbox_items (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(summary) <= 500),
    idempotency_key TEXT UNIQUE,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX inbox_events_item ON inbox_events (item_id);

  CREATE TABLE github_sync_state (
    repository TEXT PRIMARY KEY,
    last_sync_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    initial_sync_done INTEGER NOT NULL DEFAULT 0 CHECK (initial_sync_done IN (0, 1)),
    -- With ECC_GITHUB_INITIAL_SYNC=new, pull requests created before this become no items.
    baseline_at TEXT
  );

  -- Agent reports of pull requests that GitHub has not confirmed yet. Linked by the next sync.
  CREATE TABLE github_pending_reports (
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    source_session TEXT,
    source_agent TEXT,
    reported_at TEXT NOT NULL,
    PRIMARY KEY (repository, number)
  );
  `,
];
