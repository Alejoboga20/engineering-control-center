import { TerminalCloseCode } from '@ecc/shared';
import { PTY_FACTORY, PtyProcess } from '../src/terminal/pty.factory';
import { ATTACHMENT_LIMITS } from '../src/terminal/terminal-attachment';
import { TmuxRunner } from '../src/tmux/tmux-runner';
import { TmuxCommandError } from '../src/tmux/tmux.errors';
import { connect, RunningApp, startApp, testConfig, waitUntil } from './helpers';

class FakePty implements PtyProcess {
  written: string[] = [];
  resizes: [number, number][] = [];
  killed = 0;
  paused = 0;
  resumed = 0;
  emitData: (data: Buffer) => void = () => undefined;
  emitExit: () => void = () => undefined;
  subscriptionsDisposed = 0;

  onData(listener: (data: Buffer) => void) {
    this.emitData = listener;
    return { dispose: () => void this.subscriptionsDisposed++ };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.emitExit = () => listener({ exitCode: 0 });
    return { dispose: () => void this.subscriptionsDisposed++ };
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  kill() {
    this.killed++;
  }
}

describe('terminal WebSocket', () => {
  let running: RunningApp;
  let ptys: FakePty[];
  let spawnArgs: string[][];
  let tmuxCommands: string[][];
  let existingSessions: Set<string>;
  let paneState: string;

  beforeEach(async () => {
    paneState = '0:0:0\n';
    ptys = [];
    spawnArgs = [];
    tmuxCommands = [];
    existingSessions = new Set(['alpha', 'beta']);

    const runner = {
      binary: 'tmux',
      serverArgs: () => [],
      run: jest.fn(async (args: string[]) => {
        tmuxCommands.push(args);
        if (args[0] === 'has-session') {
          if (!existingSessions.has(args[2].replace(/^=/, ''))) {
            throw new TmuxCommandError(args, `can't find session: ${args[2]}`, 1);
          }
        }
        if (args[0] === 'display-message') return paneState;
        return '';
      }),
    };
    const factory = (_file: string, args: string[]) => {
      spawnArgs.push(args);
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    };
    running = await startApp(testConfig(), [
      { token: TmuxRunner, value: runner },
      { token: PTY_FACTORY, value: factory },
    ]);
    tmuxCommands.length = 0; // Discards the version check made at startup.
  });

  afterEach(async () => {
    await running.app.close();
  });

  const open = async (session = 'alpha', query = '') => {
    const client = connect(running.port, `/api/sessions/${session}/terminal${query}`);
    await client.waitFor(() => client.messages.some((m) => m.type === 'ready'));
    return client;
  };

  it('attaches with an exact target and the requested size, without creating a session', async () => {
    const client = await open('alpha', '?cols=100&rows=30');
    expect(client.messages[0]).toEqual({ type: 'ready', session: 'alpha', cols: 100, rows: 30 });
    expect(spawnArgs[0]).toEqual(['-u', '-T', 'RGB,hyperlinks', 'attach-session', '-t', '=alpha']);
    expect(tmuxCommands.map((args) => args[0])).toEqual(['has-session']);
    client.ws.close();
  });

  it('streams output as binary frames and forwards input and resize', async () => {
    const client = await open();
    ptys[0].emitData(Buffer.from('héllo'));
    await client.waitFor(() => client.output() === 'héllo');

    client.send({ type: 'input', data: 'ls\r' });
    client.send({ type: 'resize', cols: 90, rows: 20 });
    await waitUntil(() => ptys[0].resizes.length === 1);
    expect(ptys[0].written).toEqual(['ls\r']);
    expect(ptys[0].resizes).toEqual([[90, 20]]);
    client.ws.close();
  });

  it('on disconnect kills only the PTY client and never the tmux session', async () => {
    const client = await open();
    client.ws.close();
    await waitUntil(() => ptys[0].killed === 1);

    expect(ptys[0].subscriptionsDisposed).toBe(2);
    const issued = tmuxCommands.map((args) => args[0]);
    expect(issued).not.toContain('kill-session');
    expect(issued).not.toContain('kill-server');
  });

  it('on an abrupt socket loss kills only the PTY client', async () => {
    const client = await open();
    client.ws.terminate();
    await waitUntil(() => ptys[0].killed === 1);
    expect(tmuxCommands.map((args) => args[0])).not.toContain('kill-session');
  });

  it('allows reattaching after a disconnect', async () => {
    const first = await open();
    first.ws.close();
    await waitUntil(() => ptys[0].killed === 1);

    const second = await open();
    expect(ptys).toHaveLength(2);
    second.ws.close();
  });

  it('refuses a second attachment with a useful message and leaves the first working', async () => {
    const first = await open();
    const second = connect(running.port, '/api/sessions/alpha/terminal');
    const { code } = await second.closed;

    expect(code).toBe(TerminalCloseCode.SessionBusy);
    expect(second.messages[0]).toMatchObject({ type: 'error', code: 'SESSION_BUSY' });
    expect(ptys).toHaveLength(1);
    expect(ptys[0].killed).toBe(0);

    first.send({ type: 'input', data: 'x' });
    await waitUntil(() => ptys[0].written.length === 1);
    first.ws.close();
  });

  it('does not let simultaneous connections both attach', async () => {
    const clients = [1, 2, 3].map(() => connect(running.port, '/api/sessions/alpha/terminal'));
    await waitUntil(() => clients.filter((c) => c.messages.length > 0).length === 3);
    expect(ptys).toHaveLength(1);
    clients.forEach((client) => client.ws.close());
  });

  it('allows different sessions to be attached at once', async () => {
    const a = await open('alpha');
    const b = await open('beta');
    expect(ptys).toHaveLength(2);
    a.ws.close();
    b.ws.close();
  });

  it('reports a nonexistent session without spawning a PTY', async () => {
    const client = connect(running.port, '/api/sessions/missing/terminal');
    const { code } = await client.closed;
    expect(code).toBe(TerminalCloseCode.SessionNotFound);
    expect(client.messages[0]).toMatchObject({ type: 'error', code: 'SESSION_NOT_FOUND' });
    expect(ptys).toHaveLength(0);
  });

  it('rejects an invalid session name without calling tmux', async () => {
    const client = connect(running.port, `/api/sessions/${encodeURIComponent('a;b')}/terminal`);
    const { code } = await client.closed;
    expect(code).toBe(TerminalCloseCode.InvalidSession);
    expect(tmuxCommands).toEqual([]);
  });

  it.each([
    ['a foreign origin', 'http://evil.example'],
    ['a missing origin', null],
  ])('rejects the upgrade for %s', async (_label, origin) => {
    const client = connect(running.port, '/api/sessions/alpha/terminal', origin);
    await client.closed;
    expect(client.messages).toEqual([]);
    expect(ptys).toHaveLength(0);
    expect(tmuxCommands).toEqual([]);
  });

  it('reports when a session is deleted while attached', async () => {
    const client = await open();
    existingSessions.delete('alpha');
    ptys[0].emitExit();
    const { code } = await client.closed;

    expect(code).toBe(TerminalCloseCode.SessionEnded);
    expect(client.messages.at(-1)).toMatchObject({ type: 'exit', reason: 'session-ended' });
    // Listeners are released, and the exited process is not signalled.
    expect(ptys[0].subscriptionsDisposed).toBe(2);
    expect(ptys[0].killed).toBe(0);
  });

  it('reports a detach when the PTY exits but the session lives on', async () => {
    const client = await open();
    ptys[0].emitExit();
    const { code } = await client.closed;
    expect(code).toBe(TerminalCloseCode.Detached);
    expect(client.messages.at(-1)).toMatchObject({ type: 'exit', reason: 'detached' });
  });

  it('answers malformed frames with a protocol error and keeps the connection', async () => {
    const client = await open();
    client.ws.send('not json');
    client.send({ type: 'resize', cols: -1, rows: 'x' });
    client.send({ type: 'execute', command: 'rm -rf /' });
    client.ws.send(Buffer.from([1, 2, 3]));
    await client.waitFor(
      () => client.messages.filter((m) => m.code === 'PROTOCOL_ERROR').length === 4,
    );
    expect(ptys[0].written).toEqual([]);
    expect(ptys[0].killed).toBe(0);
    client.ws.close();
  });

  it('pauses the PTY when output backs up and resumes after it drains', async () => {
    const client = await open();
    client.ws.pause(); // The client stops reading, so unsent data accumulates on the server.
    const chunk = Buffer.alloc(256 * 1024, 'x');
    const deadline = Date.now() + 5000;
    while (ptys[0].paused === 0 && Date.now() < deadline) {
      ptys[0].emitData(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(ptys[0].paused).toBe(1);
    expect(ptys[0].resumed).toBe(0);

    client.ws.resume();
    await waitUntil(() => ptys[0].resumed === 1, 10000);
    client.ws.close();
  }, 20000);

  it('closes the connection when input exceeds the rate limit', async () => {
    const client = await open();
    const chunk = 'x'.repeat(64 * 1024);
    const needed = Math.ceil(ATTACHMENT_LIMITS.maxInputCharsPerSecond / chunk.length) + 1;
    for (let i = 0; i < needed; i++) client.send({ type: 'input', data: chunk });
    const { code } = await client.closed;
    expect(code).toBe(TerminalCloseCode.InputLimitExceeded);
    expect(ptys[0].killed).toBe(1);
  });

  it('routes the wheel through tmux and exits copy mode before forwarding typed input', async () => {
    const client = await open();
    client.send({ type: 'scroll', lines: -3 });
    await waitUntil(() => tmuxCommands.some((args) => args[0] === 'copy-mode'));

    client.send({ type: 'input', data: 'a' });
    await waitUntil(() => ptys[0].written.length === 1);
    const issued = tmuxCommands.map((args) => args[0]);
    expect(issued.indexOf('send-keys')).toBeGreaterThan(issued.indexOf('copy-mode'));
    expect(tmuxCommands.at(-1)).toEqual(['send-keys', '-X', '-t', '=alpha:', 'cancel']);
    client.ws.close();
  });

  it('sends wheel events, not arrow keys, to an application tracking the mouse', async () => {
    paneState = '0:1:1\n';
    const client = await open('alpha', '?cols=100&rows=30');
    client.send({ type: 'resize', cols: 120, rows: 40 });
    client.send({ type: 'scroll', lines: -2 });
    client.send({ type: 'scroll', lines: 1 });
    await waitUntil(() => ptys[0].written.length === 2);

    expect(ptys[0].written).toEqual(['\x1b[<64;60;20M\x1b[<64;60;20M', '\x1b[<65;60;20M']);
    expect(tmuxCommands.map((args) => args[0])).not.toContain('copy-mode');
    client.ws.close();
  });

  it('sends arrow keys to a full-screen application without mouse tracking', async () => {
    paneState = '0:1:0\n';
    const client = await open();
    client.send({ type: 'scroll', lines: -2 });
    await waitUntil(() => ptys[0].written.length === 1);
    expect(ptys[0].written).toEqual(['\x1b[A\x1b[A']);
    client.ws.close();
  });

  it('detaches clients on shutdown without touching tmux sessions', async () => {
    const client = await open();
    await running.app.close();
    await client.closed;
    expect(ptys[0].killed).toBe(1);
    expect(tmuxCommands.map((args) => args[0])).not.toContain('kill-session');
    // Reboot a fresh app so that afterEach has something to close.
    running = await startApp(testConfig(), [
      { token: TmuxRunner, value: { binary: 'tmux', serverArgs: () => [], run: async () => '' } },
      { token: PTY_FACTORY, value: () => new FakePty() },
    ]);
  });
});
