import { execFile } from 'node:child_process';
import type { AppConfig } from '../config/app-config';
import { TmuxRunner } from './tmux-runner';
import { TmuxCommandError, TmuxUnavailableError } from './tmux.errors';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = execFile as unknown as jest.Mock;

function runner(config: Partial<AppConfig> = {}) {
  return new TmuxRunner({ tmuxBin: '/usr/bin/tmux', ...config } as AppConfig);
}

function respond(error: Error | null, stdout = '', stderr = '') {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: ExecCallback) =>
      callback(error, stdout, stderr),
  );
}

describe('TmuxRunner', () => {
  beforeEach(() => execFileMock.mockReset());

  it('invokes tmux with an argument array and no shell, and returns stdout', async () => {
    respond(null, 'out');
    await expect(runner().run(['list-sessions'])).resolves.toBe('out');
    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe('/usr/bin/tmux');
    expect(args).toEqual(['list-sessions']);
    expect(options.shell).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('passes metacharacters through as literal arguments', async () => {
    respond(null);
    await runner().run(['has-session', '-t', '=x; rm -rf /']);
    expect(execFileMock.mock.calls[0][1]).toEqual(['has-session', '-t', '=x; rm -rf /']);
  });

  it('selects a dedicated server when a socket is configured', async () => {
    respond(null);
    await runner({ tmuxSocket: 'ecc' }).run(['list-sessions']);
    expect(execFileMock.mock.calls[0][1]).toEqual(['-L', 'ecc', 'list-sessions']);
  });

  it('does not pass secrets or TMUX from its environment to tmux', async () => {
    process.env.ANTHROPIC_API_KEY = 'secret';
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    respond(null);
    await runner().run(['list-sessions']);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TMUX;
    const { env } = execFileMock.mock.calls[0][2];
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
  });

  it('reports a missing binary', async () => {
    respond(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }));
    await expect(runner().run(['-V'])).rejects.toBeInstanceOf(TmuxUnavailableError);
  });

  it('wraps a non-zero exit with its stderr', async () => {
    respond(Object.assign(new Error('failed'), { code: 1 }), '', "can't find session: =x");
    const error = await runner().run(['kill-session']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TmuxCommandError);
    expect(error).toMatchObject({ stderr: "can't find session: =x", exitCode: 1 });
  });
});
