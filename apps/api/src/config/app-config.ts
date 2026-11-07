import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

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
  /** Private directory for files the backend shares with the Claude Code hook reporter. */
  stateDir: string;
  /** Claude Code's user directory. Canonicalized when used. */
  claudeConfigDir: string;
  /** Administrator-approved Markdown directories outside Claude Code's own structure. */
  claudeKnowledgeDirs: {
    /** Absolute. Shown in the global scope. */
    global: string[];
    /** Relative to each project. Shown in the project scope. */
    project: string[];
  };
  /** Directories that a symlink in a configuration location may point into. */
  claudeSymlinkTargets: string[];
  /** Private directory for the Engineering Inbox database. Outside the repository and builds. */
  dataDir: string;
  github: GitHubConfig;
}

export type GitHubInitialSync = 'open' | 'new';

export interface GitHubConfig {
  /** `owner/name`, lower case. Nothing else is ever queried. Empty disables GitHub sync. */
  repositories: string[];
  /** Lower-case logins. Empty means every author in the allowed repositories. */
  authors: string[];
  /** A file that holds only the token. Read at each sync, never logged or stored. */
  tokenFile: string | null;
  pollSeconds: number;
  initialSync: GitHubInitialSync;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);
const TMUX_SOCKET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
export const GITHUB_POLL_SECONDS = { default: 180, min: 60, max: 3600 } as const;

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

function loadKnowledgeDirs(value: string | undefined): AppConfig['claudeKnowledgeDirs'] {
  const dirs: AppConfig['claudeKnowledgeDirs'] = { global: [], project: [] };
  for (const entry of splitList(value).map(expandHome)) {
    if (isAbsolute(entry)) {
      dirs.global.push(resolve(entry));
      continue;
    }
    const relativeDir = normalize(entry).replace(/[/\\]+$/, '');
    if (relativeDir === '.' || relativeDir.split(sep).includes('..')) {
      throw new Error(
        `ECC_CLAUDE_KNOWLEDGE_DIRS entries must be absolute, or inside the project, got "${entry}"`,
      );
    }
    dirs.project.push(relativeDir);
  }
  return dirs;
}

function loadSymlinkTargets(value: string | undefined): string[] {
  return splitList(value)
    .map(expandHome)
    .map((target) => {
      if (!isAbsolute(target)) {
        throw new Error(`ECC_CLAUDE_SYMLINK_TARGETS entries must be absolute paths, got "${target}"`);
      }
      return resolve(target);
    });
}

function loadGitHubConfig(env: Env): GitHubConfig {
  const repositories = [...new Set(splitList(env.ECC_GITHUB_REPOS).map((repo) => repo.toLowerCase()))];
  for (const repo of repositories) {
    if (!REPOSITORY_PATTERN.test(repo)) {
      throw new Error(`ECC_GITHUB_REPOS entries must look like owner/name, got "${repo}"`);
    }
  }
  const authors = splitList(env.ECC_GITHUB_AUTHORS).map((author) => author.toLowerCase());
  for (const author of authors) {
    if (!GITHUB_LOGIN_PATTERN.test(author)) {
      throw new Error(`Invalid login in ECC_GITHUB_AUTHORS: "${author}"`);
    }
  }
  const rawPoll = env.ECC_GITHUB_POLL_SECONDS?.trim();
  const pollSeconds = rawPoll ? Number(rawPoll) : GITHUB_POLL_SECONDS.default;
  if (
    !Number.isInteger(pollSeconds) ||
    pollSeconds < GITHUB_POLL_SECONDS.min ||
    pollSeconds > GITHUB_POLL_SECONDS.max
  ) {
    throw new Error(
      `ECC_GITHUB_POLL_SECONDS must be an integer from ${GITHUB_POLL_SECONDS.min} to ${GITHUB_POLL_SECONDS.max}, got "${rawPoll}"`,
    );
  }
  const initialSync = env.ECC_GITHUB_INITIAL_SYNC?.trim() || 'open';
  if (initialSync !== 'open' && initialSync !== 'new') {
    throw new Error(`ECC_GITHUB_INITIAL_SYNC must be "open" or "new", got "${initialSync}"`);
  }
  const tokenFile = env.ECC_GITHUB_TOKEN_FILE?.trim();
  if (tokenFile && !isAbsolute(expandHome(tokenFile))) {
    throw new Error(`ECC_GITHUB_TOKEN_FILE must be an absolute path, got "${tokenFile}"`);
  }
  return {
    repositories,
    authors,
    tokenFile: tokenFile ? resolve(expandHome(tokenFile)) : null,
    pollSeconds,
    initialSync,
  };
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
    stateDir: env.ECC_STATE_DIR?.trim()
      ? resolve(expandHome(env.ECC_STATE_DIR.trim()))
      : join(homedir(), '.config', 'engineering-control-center'),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR?.trim()
      ? resolve(expandHome(env.CLAUDE_CONFIG_DIR.trim()))
      : join(homedir(), '.claude'),
    claudeKnowledgeDirs: loadKnowledgeDirs(env.ECC_CLAUDE_KNOWLEDGE_DIRS),
    claudeSymlinkTargets: loadSymlinkTargets(env.ECC_CLAUDE_SYMLINK_TARGETS),
    dataDir: env.ECC_DATA_DIR?.trim()
      ? resolve(expandHome(env.ECC_DATA_DIR.trim()))
      : join(homedir(), '.local', 'share', 'engineering-control-center'),
    github: loadGitHubConfig(env),
  };
}
