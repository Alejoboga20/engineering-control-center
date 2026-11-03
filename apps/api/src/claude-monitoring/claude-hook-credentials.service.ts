import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export const HOOK_CREDENTIALS_FILE = 'claude-hook.json';

/** What the hook reporter reads to reach this backend. Never served over HTTP. */
export interface HookCredentials {
  url: string;
  /** A Host header that passes the request guard, whatever ECC_ALLOWED_ORIGINS is set to. */
  host: string;
  token: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Owns the bearer token shared with the hook reporter. Binding to loopback does not stop other
 * local users from reaching the port, so the file permissions are the actual trust boundary.
 * The token survives restarts, so that running Claude sessions keep reporting.
 */
@Injectable()
export class ClaudeHookCredentialsService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeHookCredentialsService.name);
  private tokenDigest: Buffer | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get available(): boolean {
    return this.tokenDigest !== null;
  }

  /** Monitoring is optional, so a failure here disables ingestion and nothing else. */
  onModuleInit(): void {
    try {
      this.tokenDigest = digest(this.prepareFile());
    } catch (error) {
      this.logger.warn(`Claude monitoring disabled: ${(error as Error).message}`);
    }
  }

  isAuthorized(header: string | undefined): boolean {
    if (!this.tokenDigest || !header?.startsWith('Bearer ')) return false;
    return timingSafeEqual(digest(header.slice('Bearer '.length)), this.tokenDigest);
  }

  private prepareFile(): string {
    const { stateDir } = this.config;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);

    const path = join(stateDir, HOOK_CREDENTIALS_FILE);
    const url = this.backendUrl();
    const host = this.config.allowedHosts[0] ?? new URL(url).host;
    const existing = this.readTrustedToken(path);
    const token = existing?.token ?? randomBytes(32).toString('base64url');
    if (existing?.url !== url || existing.host !== host) {
      this.writePrivate(path, { url, host, token });
    }
    return token;
  }

  /** A file that others could have read has an exposed token, so it is replaced, not repaired. */
  private readTrustedToken(path: string): HookCredentials | null {
    try {
      const stat = lstatSync(path);
      const ours = process.getuid === undefined || stat.uid === process.getuid();
      if (!stat.isFile() || !ours || (stat.mode & 0o077) !== 0) return null;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HookCredentials>;
      return typeof parsed.token === 'string' && parsed.token.length >= 32
        ? (parsed as HookCredentials)
        : null;
    } catch {
      return null;
    }
  }

  /** Written to a new file and renamed, so the reporter never reads a partial file. */
  private writePrivate(path: string, credentials: HookCredentials): void {
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(credentials)}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private backendUrl(): string {
    const host = this.config.host.includes(':') ? `[${this.config.host}]` : this.config.host;
    return `http://${host}:${this.config.port}`;
  }
}
