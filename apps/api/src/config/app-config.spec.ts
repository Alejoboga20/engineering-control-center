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
});
