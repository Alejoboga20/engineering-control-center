import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { INBOX_MIGRATIONS } from './inbox-migrations';

export const INBOX_DATABASE_FILE = 'inbox.sqlite3';
const BUSY_TIMEOUT_MS = 5000;

export type Db = Database.Database;

/** Applies every step after the database's `user_version`, each in its own transaction. */
export function migrate(db: Db, steps: readonly string[] = INBOX_MIGRATIONS): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > steps.length) {
    throw new Error(
      `The Inbox database is at schema version ${current}, newer than this build (${steps.length}).`,
    );
  }
  for (let version = current; version < steps.length; version += 1) {
    db.transaction(() => {
      db.exec(steps[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  return steps.length;
}

/** Creates the file owner-only before SQLite opens it, so it is never briefly readable by others. */
function preparePrivateFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    closeSync(openSync(path, 'wx', 0o600));
  }
  chmodSync(path, 0o600);
}

/**
 * Owns the SQLite connection. The Inbox is optional: if the database cannot be opened, every
 * Inbox endpoint answers 503 and the rest of the application keeps working.
 * It opens in the constructor, so the database is ready before any dependent's lifecycle hooks.
 */
@Injectable()
export class InboxDatabase implements OnApplicationShutdown {
  private readonly logger = new Logger(InboxDatabase.name);
  private connection: Db | null = null;
  readonly path: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.path = join(config.dataDir, INBOX_DATABASE_FILE);
    try {
      mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(config.dataDir, 0o700);
      preparePrivateFile(this.path);
      const db = new Database(this.path);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        migrate(db);
      } catch (error) {
        db.close();
        throw error;
      }
      this.connection = db;
    } catch (error) {
      this.logger.warn(`Engineering Inbox disabled: ${(error as Error).message}`);
    }
  }

  get available(): boolean {
    return this.connection?.open === true;
  }

  /** The connection, or the 503 that every Inbox endpoint returns without one. */
  get db(): Db {
    if (!this.connection?.open) {
      throw new ApiError(503, 'INBOX_UNAVAILABLE', 'The Engineering Inbox database is unavailable.');
    }
    return this.connection;
  }

  /** Throws the 503 when the Inbox is unavailable. */
  ensureAvailable(): void {
    void this.db;
  }

  onApplicationShutdown(): void {
    if (this.connection?.open) this.connection.close();
  }
}
