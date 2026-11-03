import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppConfig } from '../src/config/app-config';
import { TmuxRunner } from '../src/tmux/tmux-runner';
import { connect, hookToken, RunningApp, startApp, testConfig, TEST_ORIGIN, TestClient, waitUntil } from './helpers';

const HOST = 'localhost:4999';
/** tmux list-sessions output, created long before any event in these tests. */
const TMUX_LIST = '1000000000:0:1:payroll\n1000000000:0:1:manual\n';

describe('Claude monitoring API', () => {
  let running: RunningApp;
  let config: AppConfig;
  let run: jest.Mock;
  let token: string;
  const sockets: TestClient[] = [];

  const http = () => request(running.app.getHttpServer());

  function event(overrides: Record<string, unknown> = {}) {
    return {
      eventId: randomUUID(),
      claudeSessionId: 'claude-1',
      tmuxSession: 'payroll',
      eventType: 'UserPromptSubmit',
      timestamp: new Date().toISOString(),
      pane: '%1',
      ...overrides,
    };
  }

  const post = (body: unknown, bearer: string | null = token) => {
    const req = http().post('/api/claude/hooks').set('Host', HOST);
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req.send(body as object);
  };

  const statusOf = async (name: string) =>
    (await http().get(`/api/claude/status/${name}`).set('Host', HOST).expect(200)).body;

  async function start(overrides: Partial<AppConfig> = {}) {
    run = jest.fn(async (args: string[]) => (args[0] === 'list-sessions' ? TMUX_LIST : ''));
    config = testConfig(overrides);
    running = await startApp(config, [
      { token: TmuxRunner, value: { run, binary: 'tmux', serverArgs: () => [] } },
    ]);
    token = hookToken(config);
  }

  beforeEach(() => start());

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.ws.terminate();
    await running.app.close();
    rmSync(config.stateDir, { recursive: true, force: true });
  });

  describe('ingestion', () => {
    it('accepts a valid event and updates the status', async () => {
      const { body } = await post(event()).expect(202);
      expect(body).toEqual({ accepted: true });
      expect(await statusOf('payroll')).toMatchObject({
        tmuxSession: 'payroll',
        state: 'working',
        monitored: true,
        lastEvent: 'UserPromptSubmit',
      });
    });

    it('rejects an unsupported event type', async () => {
      const { body } = await post(event({ eventType: 'SomethingElse' })).expect(400);
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an event with no Claude session ID', async () => {
      await post(event({ claudeSessionId: undefined })).expect(400);
    });

    it('rejects an event with no tmux session, rather than guessing one', async () => {
      await post(event({ tmuxSession: undefined })).expect(400);
    });

    it('rejects a tmux session name the dashboard would not accept', async () => {
      await post(event({ tmuxSession: 'has space' })).expect(400);
    });

    it.each([
      ['prompt', 'secret prompt'],
      ['tool_input', { command: 'cat .env' }],
      ['transcript_path', '/home/dev/.claude/transcript.jsonl'],
    ])('rejects a body containing %s, and stores nothing', async (field, value) => {
      await post({ ...event(), [field]: value }).expect(400);
      expect((await statusOf('payroll')).monitored).toBe(false);
    });

    it('rejects an oversized payload', async () => {
      await post({ ...event(), toolName: 'x'.repeat(20_000) }).expect(413);
    });

    it('rejects a timestamp from the future, which would outrank every later event', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await post(event({ timestamp: future })).expect(400);
    });

    it('rejects a malformed timestamp', async () => {
      await post(event({ timestamp: 'yesterday' })).expect(400);
    });

    it('reports a duplicate as not accepted, without applying it twice', async () => {
      const first = event();
      await post(first).expect(202);
      const { body } = await post({ ...first, eventType: 'Stop' }).expect(202);
      expect(body).toEqual({ accepted: false });
      expect((await statusOf('payroll')).state).toBe('working');
    });

    it('keeps the newest state when events arrive out of order', async () => {
      const now = Date.now();
      await post(event({ eventType: 'Stop', timestamp: new Date(now).toISOString() })).expect(202);
      const { body } = await post(
        event({ eventType: 'PreToolUse', timestamp: new Date(now - 5000).toISOString() }),
      ).expect(202);
      expect(body).toEqual({ accepted: false });
      expect((await statusOf('payroll')).state).toBe('idle');
    });
  });

  describe('authorization', () => {
    it('rejects a missing token', async () => {
      const { body } = await post(event(), null).expect(401);
      expect(body.code).toBe('UNAUTHORIZED');
      expect((await statusOf('payroll')).monitored).toBe(false);
    });

    it('rejects a wrong token', async () => {
      await post(event(), 'x'.repeat(43)).expect(401);
    });

    it('checks the token before validating the body', async () => {
      await post({ nonsense: true }, null).expect(401);
    });

    it('still applies the Host guard to authorized requests', async () => {
      await http()
        .post('/api/claude/hooks')
        .set('Host', 'evil.example')
        .set('Authorization', `Bearer ${token}`)
        .send(event())
        .expect(403);
    });

    it('refuses a cross-site browser request to read status', async () => {
      await http()
        .get('/api/claude/status')
        .set('Host', HOST)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });

    it('never exposes the token through the status API', async () => {
      await post(event()).expect(202);
      const { text } = await http().get('/api/claude/status').set('Host', HOST).expect(200);
      expect(text).not.toContain(token);
    });
  });

  describe('credentials file', () => {
    const file = () => join(config.stateDir, 'claude-hook.json');

    it('is readable by its owner only, inside a private directory', () => {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
      expect(statSync(config.stateDir).mode & 0o777).toBe(0o700);
    });

    it('names a Host that the request guard accepts', () => {
      expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ host: HOST });
    });

    it('keeps the token across restarts, so that running sessions keep reporting', async () => {
      const previous = token;
      await running.app.close();
      await start({ stateDir: config.stateDir });
      expect(token).toBe(previous);
    });

    it('replaces a token that other users could have read', async () => {
      const previous = token;
      chmodSync(file(), 0o644);
      await running.app.close();
      await start({ stateDir: config.stateDir });
      expect(token).not.toBe(previous);
      expect(statSync(file()).mode & 0o777).toBe(0o600);
    });

    it('replaces a corrupt file', async () => {
      writeFileSync(file(), 'not json', { mode: 0o600 });
      await running.app.close();
      await start({ stateDir: config.stateDir });
      expect(token.length).toBeGreaterThanOrEqual(32);
    });

    it('disables only ingestion when it cannot be written', async () => {
      await running.app.close();
      const blocker = join(mkdtempSync(join(tmpdir(), 'ecc-blocked-')), 'file');
      writeFileSync(blocker, '');
      run = jest.fn(async (args: string[]) => (args[0] === 'list-sessions' ? TMUX_LIST : ''));
      config = testConfig({ stateDir: join(blocker, 'state') });
      running = await startApp(config, [
        { token: TmuxRunner, value: { run, binary: 'tmux', serverArgs: () => [] } },
      ]);
      await post(event(), 'anything').expect(401);
      const { body } = await http().get('/api/claude/status').set('Host', HOST).expect(200);
      expect(body.ingestionAvailable).toBe(false);
      await http().get('/api/sessions').set('Host', HOST).expect(200);
      config = { ...config, stateDir: blocker };
    });
  });

  describe('status API', () => {
    it('returns Unknown for a tmux session with no monitoring information', async () => {
      expect(await statusOf('manual')).toEqual({
        tmuxSession: 'manual',
        state: 'unknown',
        monitored: false,
        reason: 'no-events',
        instanceCount: 0,
      });
    });

    it('lists every tmux session', async () => {
      await post(event()).expect(202);
      const { body } = await http().get('/api/claude/status').set('Host', HOST).expect(200);
      expect(body.ingestionAvailable).toBe(true);
      expect(body.sessions.map((s: { tmuxSession: string; state: string }) => [s.tmuxSession, s.state])).toEqual([
        ['payroll', 'working'],
        ['manual', 'unknown'],
      ]);
    });

    it('returns 404 for a session that does not exist', async () => {
      await http().get('/api/claude/status/missing').set('Host', HOST).expect(404);
    });

    it('rejects an invalid session name', async () => {
      await http().get('/api/claude/status/bad%20name').set('Host', HOST).expect(400);
    });

    it('accepts an event for a session unknown to tmux, without listing it', async () => {
      await post(event({ tmuxSession: 'elsewhere' })).expect(202);
      await http().get('/api/claude/status/elsewhere').set('Host', HOST).expect(404);
    });

    it('falls back to Unknown after a backend restart, and recovers on the next event', async () => {
      await post(event()).expect(202);
      expect((await statusOf('payroll')).state).toBe('working');

      await running.app.close();
      await start({ stateDir: config.stateDir });
      expect(await statusOf('payroll')).toMatchObject({ state: 'unknown', monitored: false });

      await post(event({ eventType: 'Stop' })).expect(202);
      expect((await statusOf('payroll')).state).toBe('idle');
    });

    it('forgets a session when the dashboard terminates it', async () => {
      await post(event()).expect(202);
      await http()
        .delete('/api/sessions/payroll')
        .set('Host', HOST)
        .set('Origin', TEST_ORIGIN)
        .expect(204);
      expect((await statusOf('payroll')).monitored).toBe(false);
    });
  });

  describe('WS /api/claude/events', () => {
    function monitor(origin: string | null = TEST_ORIGIN) {
      const client = connect(running.port, '/api/claude/events', origin);
      sockets.push(client);
      return client;
    }

    it('sends a snapshot first, and then changes', async () => {
      await post(event()).expect(202);
      const client = monitor();
      await client.waitFor(() => client.messages.length === 1);
      expect(client.messages[0]).toMatchObject({
        type: 'claude.status.snapshot',
        data: {
          ingestionAvailable: true,
          sessions: [
            { tmuxSession: 'payroll', state: 'working' },
            { tmuxSession: 'manual', state: 'unknown' },
          ],
        },
      });

      await post(event({ eventType: 'PermissionRequest', toolName: 'Bash' })).expect(202);
      await client.waitFor(() => client.messages.length === 2);
      expect(client.messages[1]).toMatchObject({
        type: 'claude.status.changed',
        data: { tmuxSession: 'payroll', state: 'needs_attention', lastEvent: 'PermissionRequest' },
      });
    });

    it('refuses a foreign origin and a missing origin', async () => {
      for (const origin of ['https://evil.example', null]) {
        const client = monitor(origin);
        const failure = await new Promise<string>((resolve) => {
          client.ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
          client.ws.on('open', () => resolve('opened'));
        });
        expect(failure).toBe('403');
      }
    });

    it('does not interfere with terminal routes or unknown paths', async () => {
      const client = connect(running.port, '/api/other');
      sockets.push(client);
      const failure = await new Promise<string>((resolve) => {
        client.ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
        client.ws.on('open', () => resolve('opened'));
      });
      expect(failure).toBe('404');
    });

    it('delivers changes to every client, and survives one leaving', async () => {
      const first = monitor();
      const second = monitor();
      await waitUntil(() => first.messages.length === 1 && second.messages.length === 1);
      first.ws.terminate();
      await post(event()).expect(202);
      await second.waitFor(() => second.messages.length === 2);
      expect(second.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('sends a current snapshot to a client that reconnects after a restart', async () => {
      await post(event()).expect(202);
      await running.app.close();
      await start({ stateDir: config.stateDir });
      const client = monitor();
      await client.waitFor(() => client.messages.length === 1);
      expect(client.messages[0]).toMatchObject({
        data: { sessions: [{ tmuxSession: 'payroll', state: 'unknown', monitored: false }, {}] },
      });
    });

    it('still sends a snapshot when tmux fails', async () => {
      run.mockRejectedValue(new Error('tmux failed'));
      const client = monitor();
      await client.waitFor(() => client.messages.length === 1);
      expect(client.messages[0]).toMatchObject({ data: { sessions: [] } });
    });
  });
});
