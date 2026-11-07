import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './app-config';

describe('loadConfig', () => {
  it('binds to loopback on port 3000 by default', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.projectRoots).toEqual([join(homedir(), 'projects')]);
  });

  it.each(['0.0.0.0', '::', '[::]', '*'])('always refuses the wildcard address %s', (ECC_HOST) => {
    expect(() => loadConfig({ ECC_HOST, ECC_ALLOW_REMOTE_BIND: 'true' })).toThrow(/wildcard/);
  });

  it('requires an explicit opt-in for a non-loopback address', () => {
    expect(() => loadConfig({ ECC_HOST: '100.64.0.1' })).toThrow(/ECC_ALLOW_REMOTE_BIND/);
    expect(loadConfig({ ECC_HOST: '100.64.0.1', ECC_ALLOW_REMOTE_BIND: 'true' }).host).toBe(
      '100.64.0.1',
    );
  });

  it('allows only same-origin in production, and adds the Vite origin in development', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).allowedOrigins).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
    expect(loadConfig({}).allowedOrigins).toContain('http://localhost:5173');
  });

  it('normalizes origins and derives hosts', () => {
    const config = loadConfig({ ECC_ALLOWED_ORIGINS: 'https://box.tail1.ts.net/, http://localhost:8080' });
    expect(config.allowedOrigins).toEqual(['https://box.tail1.ts.net', 'http://localhost:8080']);
    expect(config.allowedHosts).toEqual(['box.tail1.ts.net', 'localhost:8080']);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ECC_PORT: 'abc' })).toThrow(/ECC_PORT/);
    expect(() => loadConfig({ ECC_PROJECT_ROOTS: 'relative/path' })).toThrow(/absolute/);
    expect(() => loadConfig({ ECC_ALLOWED_ORIGINS: 'nope' })).toThrow(/origin/);
    expect(() => loadConfig({ ECC_TMUX_SOCKET: '../x' })).toThrow(/SOCKET/);
  });

  describe('Engineering Inbox', () => {
    it('keeps the database outside the repository by default, and GitHub off', () => {
      const config = loadConfig({});
      expect(config.dataDir).toBe(join(homedir(), '.local', 'share', 'engineering-control-center'));
      expect(config.github).toEqual({
        repositories: [],
        authors: [],
        tokenFile: null,
        pollSeconds: 180,
        initialSync: 'open',
      });
    });

    it('reads the GitHub settings, lower-casing repositories and logins', () => {
      const config = loadConfig({
        ECC_DATA_DIR: '/var/lib/ecc',
        ECC_GITHUB_REPOS: 'Acme/API, acme/web,acme/api',
        ECC_GITHUB_AUTHORS: 'Alejo,dependabot[bot]',
        ECC_GITHUB_TOKEN_FILE: '/home/dev/.config/ecc/github-token',
        ECC_GITHUB_POLL_SECONDS: '300',
        ECC_GITHUB_INITIAL_SYNC: 'new',
      });
      expect(config.dataDir).toBe('/var/lib/ecc');
      expect(config.github).toEqual({
        repositories: ['acme/api', 'acme/web'],
        authors: ['alejo', 'dependabot[bot]'],
        tokenFile: '/home/dev/.config/ecc/github-token',
        pollSeconds: 300,
        initialSync: 'new',
      });
    });

    it('rejects invalid GitHub settings', () => {
      expect(() => loadConfig({ ECC_GITHUB_REPOS: 'acme' })).toThrow(/owner\/name/);
      expect(() => loadConfig({ ECC_GITHUB_REPOS: 'acme/api;drop' })).toThrow(/owner\/name/);
      expect(() => loadConfig({ ECC_GITHUB_AUTHORS: 'a b' })).toThrow(/ECC_GITHUB_AUTHORS/);
      expect(() => loadConfig({ ECC_GITHUB_POLL_SECONDS: '30' })).toThrow(/60 to 3600/);
      expect(() => loadConfig({ ECC_GITHUB_POLL_SECONDS: '4000' })).toThrow(/60 to 3600/);
      expect(() => loadConfig({ ECC_GITHUB_INITIAL_SYNC: 'all' })).toThrow(/INITIAL_SYNC/);
      expect(() => loadConfig({ ECC_GITHUB_TOKEN_FILE: 'token.txt' })).toThrow(/absolute/);
    });
  });
});
