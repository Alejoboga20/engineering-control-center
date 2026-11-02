import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { TerminalCloseCode } from '@ecc/shared';
import { connect, RunningApp, startApp, TEST_ORIGIN, testConfig, waitUntil } from './helpers';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;
const describeWithTmux = tmuxAvailable ? describe : describe.skip;

/**
 * Exercises real tmux and real node-pty against a private tmux server (`tmux -L`), so it cannot
 * touch any session outside this test. Skipped when tmux is not installed.
 */
describeWithTmux('real tmux', () => {
  const socket = `ecc-test-${process.pid}`;
  const tmux = (...args: string[]) =>
    execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();

  let root: string;
  let running: RunningApp;


  const api = () => ({
    post: (path: string) =>
      request(running.app.getHttpServer())
        .post(path)
        .set('Host', 'localhost:4999')
        .set('Origin', TEST_ORIGIN),
    get: (path: string) => request(running.app.getHttpServer()).get(path).set('Host', 'localhost:4999'),
    delete: (path: string) =>
      request(running.app.getHttpServer())
        .delete(path)
        .set('Host', 'localhost:4999')
        .set('Origin', TEST_ORIGIN),
  });

  const boot = () =>
    startApp(testConfig({ projectRoots: [root], tmuxSocket: socket }));

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ecc-real-')));
    mkdirSync(join(root, 'project'));
    running = await boot();
  });

  afterEach(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  });

  afterAll(async () => {
    await running.app.close();
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports no sessions when no tmux server is running', async () => {
    const response = await api().get('/api/sessions').expect(200);
    expect(response.body).toEqual([]);
  });

  it('creates, lists, and terminates a detached session in the requested directory', async () => {
    const dir = join(root, 'project');
    const created = await api()
      .post('/api/sessions')
      .send({ name: 'alpha', workingDirectory: dir })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'alpha', attachedClients: 0, windows: 1 });
    expect(tmux('display-message', '-p', '-t', '=alpha:', '#{pane_current_path}')).toBe(dir);

    await api().post('/api/sessions').send({ name: 'alpha', workingDirectory: dir }).expect(409);

    const listed = await api().get('/api/sessions').expect(200);
    expect(listed.body.map((s: { name: string }) => s.name)).toEqual(['alpha']);

    await api().delete('/api/sessions/alpha').expect(204);
    await api().delete('/api/sessions/alpha').expect(404);
  });

  it('matches session names exactly, not by prefix', async () => {
    tmux('new-session', '-d', '-s', 'payroll-prod');
    await api().delete('/api/sessions/payroll').expect(404);
    expect(tmux('has-session', '-t', '=payroll-prod')).toBe('');

    const client = connect(running.port, '/api/sessions/payroll/terminal');
    expect((await client.closed).code).toBe(TerminalCloseCode.SessionNotFound);
  });

  it('lists sessions created outside the dashboard, flagging unmanageable names', async () => {
    tmux('new-session', '-d', '-s', 'has space');
    const { body } = await api().get('/api/sessions').expect(200);
    expect(body[0]).toMatchObject({ name: 'has space', manageable: false });
  });

  it('refuses a directory name that tmux would interpret as a format', async () => {
    const evil = join(root, '#(touch format-expansion-ran)');
    mkdirSync(evil);
    await api().post('/api/sessions').send({ name: 'evil', workingDirectory: evil }).expect(400);
    const { body } = await api().get('/api/sessions').expect(200);
    expect(body).toEqual([]);
  });

  it('keeps the session and its process through a browser disconnect and a backend restart', async () => {
    tmux('new-session', '-d', '-s', 'keeper', '-x', '100', '-y', '30');
    const stateFile = join(root, 'counter.sh');
    writeFileSync(stateFile, 'i=0; while true; do i=$((i+1)); echo "tick-$i"; sleep 0.2; done\n');
    tmux('send-keys', '-t', '=keeper:', `sh ${stateFile}`, 'Enter');
    const pane = tmux('display-message', '-p', '-t', '=keeper:', '#{pane_pid}');

    const first = connect(running.port, '/api/sessions/keeper/terminal?cols=100&rows=30');
    await first.waitFor(() => first.output().includes('tick-'));
    await waitUntil(() => tmux('list-clients', '-t', '=keeper').length > 0);

    // Browser disconnect: the client goes away, the session and its process do not.
    first.ws.close();
    await first.closed;
    await waitUntil(() => tmux('list-clients', '-t', '=keeper') === '');
    expect(tmux('display-message', '-p', '-t', '=keeper:', '#{pane_pid}')).toBe(pane);

    // Backend restart: a new instance rediscovers the session from tmux alone.
    const second = connect(running.port, '/api/sessions/keeper/terminal');
    await second.waitFor(() => second.messages.some((m) => m.type === 'ready'));
    await running.app.close();
    await second.closed;
    running = await boot();
    expect(tmux('display-message', '-p', '-t', '=keeper:', '#{pane_pid}')).toBe(pane);

    const { body } = await api().get('/api/sessions').expect(200);
    expect(body.map((s: { name: string }) => s.name)).toEqual(['keeper']);

    const third = connect(running.port, '/api/sessions/keeper/terminal?cols=100&rows=30');
    const before = Number(/tick-(\d+)(?![\s\S]*tick-)/.exec(tmux('capture-pane', '-p', '-t', '=keeper:'))?.[1]);
    await third.waitFor(() => {
      const ticks = [...third.output().matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
      return ticks.some((tick) => tick > before);
    });
    third.ws.close();
    await third.closed;
  }, 30000);

  it('sends typed input through tmux and reports deletion to the attached client', async () => {
    tmux('new-session', '-d', '-s', 'typing');
    const client = connect(running.port, '/api/sessions/typing/terminal?cols=80&rows=24');
    await client.waitFor(() => client.messages.some((m) => m.type === 'ready'));

    client.send({ type: 'input', data: 'echo round-$((40+2))\r' });
    await client.waitFor(() => client.output().includes('round-42'));

    await api().delete('/api/sessions/typing').expect(204);
    expect((await client.closed).code).toBe(TerminalCloseCode.SessionEnded);
  }, 15000);

  it('applies resize to the attached tmux client', async () => {
    tmux('new-session', '-d', '-s', 'sizing');
    const client = connect(running.port, '/api/sessions/sizing/terminal?cols=80&rows=24');
    await client.waitFor(() => client.messages.some((m) => m.type === 'ready'));
    const size = () => tmux('display-message', '-p', '-t', '=sizing:', '#{window_width}x#{window_height}');

    await waitUntil(() => size().startsWith('80x'));
    client.send({ type: 'resize', cols: 133, rows: 41 });
    await waitUntil(() => size().startsWith('133x'));
    client.ws.close();
    await client.closed;
  }, 15000);

  it('delivers the wheel to a full-screen application that tracks the mouse, as Claude Code does', async () => {
    const log = join(root, 'wheel-input.log');
    const app = join(root, 'mouse-app.cjs');
    writeFileSync(
      app,
      `const fs = require('fs');
       process.stdin.setRawMode(true);
       process.stdout.write('\\x1b[?1049h\\x1b[?1003h\\x1b[?1006h');
       process.stdin.on('data', (data) => fs.appendFileSync(${JSON.stringify(log)}, data));
       setInterval(() => {}, 1000);`,
    );
    tmux('new-session', '-d', '-s', 'mouseapp', '-x', '80', '-y', '24');
    tmux('send-keys', '-t', '=mouseapp:', `exec ${JSON.stringify(process.execPath)} ${app}`, 'Enter');
    const flags = () => tmux('display-message', '-p', '-t', '=mouseapp:', '#{alternate_on}:#{mouse_any_flag}');
    await waitUntil(() => flags() === '1:1');

    const client = connect(running.port, '/api/sessions/mouseapp/terminal?cols=80&rows=24');
    await client.waitFor(() => client.messages.some((m) => m.type === 'ready'));
    client.send({ type: 'scroll', lines: -1 });
    client.send({ type: 'scroll', lines: 1 });

    const received = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    await waitUntil(() => received().includes('\x1b[<65;'));
    expect(received()).toContain('\x1b[<64;');
    expect(received()).not.toContain('\x1b[A');
    expect(received()).not.toContain('\x1b[B');
    expect(tmux('display-message', '-p', '-t', '=mouseapp:', '#{pane_in_mode}')).toBe('0');
    client.ws.close();
    await client.closed;
  }, 15000);

  it('scrolls tmux history and returns to the live view when typing', async () => {
    tmux('new-session', '-d', '-s', 'history', '-x', '80', '-y', '24');
    const client = connect(running.port, '/api/sessions/history/terminal?cols=80&rows=24');
    await client.waitFor(() => client.messages.some((m) => m.type === 'ready'));
    // The quotes keep the marker out of the echoed command line.
    client.send({ type: 'input', data: 'seq 1 200; echo fin""ished\r' });
    await client.waitFor(() => client.output().includes('finished'));
    const inMode = () => tmux('display-message', '-p', '-t', '=history:', '#{pane_in_mode}');
    const offset = () => tmux('display-message', '-p', '-t', '=history:', '#{scroll_position}');

    client.send({ type: 'scroll', lines: -10 });
    await waitUntil(() => offset() === '10');
    expect(inMode()).toBe('1');

    client.send({ type: 'input', data: 'echo live\r' });
    await client.waitFor(() => client.output().includes('live'));
    expect(inMode()).toBe('0');
    client.ws.close();
    await client.closed;
  }, 15000);
});
