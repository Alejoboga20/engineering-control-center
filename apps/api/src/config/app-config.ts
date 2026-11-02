import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  /** Absolute paths as configured. Canonicalized when used, since links can change. */
  projectRoots: string[];
  allowedOrigins: string[];
  /** `host[:port]` values accepted in the Host header, derived from allowedOrigins. */
  allowedHosts: string[];
  tmuxBin: string;
  tmuxSocket?: string;
  webDistPath: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);
const TMUX_SOCKET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Env = Record<string, string | undefined>;

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const host = env.ECC_HOST?.trim() || '127.0.0.1';
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind to wildcard address "${host}". This application has no login and grants shell access.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host) && env.ECC_ALLOW_REMOTE_BIND !== 'true') {
    throw new Error(
      `Refusing to bind to non-loopback address "${host}" without ECC_ALLOW_REMOTE_BIND=true. ` +
        'Anyone who can reach this port gets a shell. See the security section of the README.',
    );
  }

  const port = Number(env.ECC_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ECC_PORT: "${env.ECC_PORT}"`);
  }

  const rawRoots = splitList(env.ECC_PROJECT_ROOTS);
  const projectRoots = (rawRoots.length > 0 ? rawRoots : ['~/projects']).map(expandHome);
  for (const root of projectRoots) {
    if (!isAbsolute(root)) {
      throw new Error(`ECC_PROJECT_ROOTS entries must be absolute paths, got "${root}"`);
    }
  }

  const configuredOrigins = splitList(env.ECC_ALLOWED_ORIGINS);
  const defaultOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (env.NODE_ENV !== 'production') {
    defaultOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }
  const allowedOrigins = (configuredOrigins.length > 0 ? configuredOrigins : defaultOrigins).map(
    (origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(`Invalid origin in ECC_ALLOWED_ORIGINS: "${origin}"`);
      }
    },
  );
  const allowedHosts = allowedOrigins.map((origin) => new URL(origin).host);

  const tmuxSocket = env.ECC_TMUX_SOCKET?.trim() || undefined;
  if (tmuxSocket && !TMUX_SOCKET_PATTERN.test(tmuxSocket)) {
    throw new Error(`Invalid ECC_TMUX_SOCKET: "${tmuxSocket}"`);
  }

  return {
    host,
    port,
    projectRoots,
    allowedOrigins,
    allowedHosts,
    tmuxBin: env.ECC_TMUX_BIN?.trim() || 'tmux',
    tmuxSocket,
    webDistPath: env.ECC_WEB_DIST
      ? resolve(env.ECC_WEB_DIST)
      : resolve(__dirname, '../../../web/dist'),
  };
}
