import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './inbox-database';
import { INBOX_MIGRATIONS } from './inbox-migrations';

describe('Inbox migrations', () => {
  let dir: string;
  let db: Database.Database;

  const item = (overrides: Record<string, unknown> = {}) => ({
    id: Math.random().toString(36).slice(2),
    type: 'pull_request',
    source_key: 'github:pr:acme/api#1',
    title: 'Add retries',
    priority: 'P2',
    suggested_priority: 'P2',
    status: 'open',
    source: 'github',
    source_state: 'open',
    pr_repository: 'acme/api',
    pr_number: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-01-01T00:00:00.000Z',
    resolution: null,
    ...overrides,
  });
  const insert = (row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO inbox_items (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
    ).run(row);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecc-migrate-'));
    db = new Database(join(dir, 'test.sqlite3'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds the schema from an empty database and records the version', () => {
    expect(migrate(db)).toBe(INBOX_MIGRATIONS.length);
    expect(db.pragma('user_version', { simple: true })).toBe(INBOX_MIGRATIONS.length);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['github_pending_reports', 'github_sync_state', 'inbox_events', 'inbox_items']);
  });

  it('is idempotent, and keeps data when run again', () => {
    migrate(db);
    insert(item());
    migrate(db);
    expect(db.prepare('SELECT count(*) AS n FROM inbox_items').get()).toEqual({ n: 1 });
  });

  it('applies only the steps a database has not seen, in order', () => {
    migrate(db, INBOX_MIGRATIONS);
    const next = [...INBOX_MIGRATIONS, 'CREATE TABLE later (id INTEGER)'];
    expect(migrate(db, next)).toBe(next.length);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'later'`).get()).toBeDefined();
  });

  it('rolls a failed step back entirely', () => {
    migrate(db);
    expect(() => migrate(db, [...INBOX_MIGRATIONS, 'CREATE TABLE half (id INTEGER); NOT SQL'])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(INBOX_MIGRATIONS.length);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined();
  });

  it('refuses a database from a newer build', () => {
    db.pragma(`user_version = ${INBOX_MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  describe('constraints', () => {
    beforeEach(() => migrate(db));

    it('allows one item per source key', () => {
      insert(item());
      expect(() => insert(item({ pr_number: 2 }))).toThrow(/UNIQUE/);
    });

    it('allows one item per pull request', () => {
      insert(item());
      expect(() => insert(item({ source_key: 'other' }))).toThrow(/UNIQUE/);
    });

    it('allows many items without a pull request', () => {
      insert(item({ type: 'human_input', source_key: 'a', pr_repository: null, pr_number: null }));
      insert(item({ type: 'human_input', source_key: 'b', pr_repository: null, pr_number: null }));
    });

    it.each([
      ['type', { type: 'email' }],
      ['priority', { priority: 'P0' }],
      ['status', { status: 'done' }],
      ['source state', { source_state: 'gone' }],
      ['resolution without resolved status', { resolution: 'manual' }],
      ['resolved status without resolution', { status: 'resolved' }],
      ['an oversized title', { title: 'x'.repeat(201) }],
    ])('rejects %s', (_name, overrides) => {
      expect(() => insert(item(overrides))).toThrow(/CHECK/);
    });

    it('allows one event per idempotency key', () => {
      const add = () =>
        db
          .prepare(
            `INSERT INTO inbox_events (id, kind, source, summary, idempotency_key, occurred_at, recorded_at)
             VALUES (?, 'x', 'system', '', 'hook:1', '', '')`,
          )
          .run(Math.random().toString());
      add();
      expect(add).toThrow(/UNIQUE/);
    });
  });
});
