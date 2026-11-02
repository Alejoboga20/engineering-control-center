import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { TmuxRunner } from '../src/tmux/tmux-runner';
import { TmuxCommandError, TmuxUnavailableError } from '../src/tmux/tmux.errors';
import { RunningApp, startApp, TEST_ORIGIN, testConfig } from './helpers';

describe('sessions HTTP API', () => {
  let running: RunningApp;
  let root: string;
  let run: jest.Mock;

  const http = () => request(running.app.getHttpServer());
  const post = (body: unknown) =>
    http()
      .post('/api/sessions')
      .set('Host', 'localhost:4999')
      .set('Origin', TEST_ORIGIN)
      .send(body as object);

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ecc-http-')));
    mkdirSync(join(root, 'project'));
  });

  beforeEach(async () => {
    run = jest.fn().mockResolvedValue('');
    running = await startApp(testConfig({ projectRoots: [root] }), [
      { token: TmuxRunner, value: { run, binary: 'tmux', serverArgs: () => [] } },
    ]);
    run.mockClear(); // Discards the version check made at startup.
  });

  afterEach(() => running.app.close());
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists sessions', async () => {
    run.mockResolvedValue('1700000000:1:2:alpha\n');
    const { body } = await http().get('/api/sessions').set('Host', 'localhost:4999').expect(200);
    expect(body).toEqual([
      {
        name: 'alpha',
        createdAt: '2023-11-14T22:13:20.000Z',
        attachedClients: 1,
        windows: 2,
        manageable: true,
      },
    ]);
  });

  it('creates a detached session with a canonical directory', async () => {
    run.mockImplementation(async (args: string[]) =>
      args[0] === 'list-sessions' ? '1700000000:0:1:alpha\n' : '',
    );
    await post({ name: 'alpha', workingDirectory: join(root, 'project') }).expect(201);
    expect(run).toHaveBeenCalledWith([
      'new-session',
      '-d',
      '-s',
      'alpha',
      '-c',
      join(root, 'project'),
    ]);
  });

  it.each([
    ['an unsafe name', { name: 'a;rm -rf /', workingDirectory: '/x' }],
    ['a leading dash', { name: '-kill', workingDirectory: '/x' }],
    ['a missing directory field', { name: 'alpha' }],
    ['a non-string name', { name: 5, workingDirectory: '/x' }],
    ['unknown properties', { name: 'alpha', workingDirectory: '/x', command: 'claude' }],
  ])('rejects %s with 400 before reaching tmux', async (_label, body) => {
    const response = await post(body).expect(400);
    expect(response.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a directory outside the roots with 403', async () => {
    const { body } = await post({ name: 'alpha', workingDirectory: tmpdir() }).expect(403);
    expect(body.code).toBe('WORKING_DIRECTORY_NOT_ALLOWED');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns 409 for a duplicate session', async () => {
    run.mockRejectedValue(new TmuxCommandError(['new-session'], 'duplicate session: alpha', 1));
    const { body } = await post({ name: 'alpha', workingDirectory: root }).expect(409);
    expect(body.code).toBe('SESSION_ALREADY_EXISTS');
  });

  it('returns 503 when tmux is not installed', async () => {
    run.mockRejectedValue(new TmuxUnavailableError());
    const { body } = await http().get('/api/sessions').set('Host', 'localhost:4999').expect(503);
    expect(body.code).toBe('TMUX_UNAVAILABLE');
  });

  it('does not leak raw errors on unexpected failures', async () => {
    run.mockRejectedValue(new Error('secret internal detail'));
    const { body } = await http().get('/api/sessions').set('Host', 'localhost:4999').expect(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    });
  });

  const del = (name: string) =>
    http().delete(`/api/sessions/${name}`).set('Host', 'localhost:4999').set('Origin', TEST_ORIGIN);

  it('deletes with an exact target', async () => {
    await del('alpha').expect(204);
    expect(run).toHaveBeenCalledWith(['kill-session', '-t', '=alpha']);
  });

  it('returns a useful 404 for a nonexistent session', async () => {
    run.mockRejectedValue(new TmuxCommandError(['kill-session'], "can't find session: =x", 1));
    const { body } = await del('x').expect(404);
    expect(body).toMatchObject({ code: 'SESSION_NOT_FOUND', message: expect.stringContaining('x') });
  });

  it('rejects an invalid name in DELETE', async () => {
    const { body } = await del(encodeURIComponent('a b')).expect(400);
    expect(body.code).toBe('INVALID_SESSION_NAME');
    expect(run).not.toHaveBeenCalled();
  });

  describe('request guard', () => {
    it('rejects a foreign Origin, with no tmux call', async () => {
      await http()
        .delete('/api/sessions/alpha')
        .set('Host', 'localhost:4999')
        .set('Origin', 'http://evil.example')
        .expect(403);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects a foreign Host, which defeats DNS rebinding', async () => {
      await http().get('/api/sessions').set('Host', 'evil.example:4999').expect(403);
      expect(run).not.toHaveBeenCalled();
    });

    it('ignores text/plain bodies, so that a cross-site form cannot create sessions', async () => {
      await http()
        .post('/api/sessions')
        .set('Host', 'localhost:4999')
        .set('Origin', TEST_ORIGIN)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ name: 'alpha', workingDirectory: root }))
        .expect(400);
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects oversized and malformed bodies', async () => {
      await post({ name: 'x'.repeat(20000), workingDirectory: root }).expect(413);
      await http()
        .post('/api/sessions')
        .set('Host', 'localhost:4999')
        .set('Origin', TEST_ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
    });

    it('sets frame and content-type protections', async () => {
      const { headers } = await http().get('/api/sessions').set('Host', 'localhost:4999');
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-powered-by']).toBeUndefined();
    });
  });

  it('never exposes environment variables through system stats', async () => {
    process.env.ECC_TEST_SECRET = 'do-not-leak';
    const { body, text } = await http().get('/api/system/stats').set('Host', 'localhost:4999');
    delete process.env.ECC_TEST_SECRET;
    expect(text).not.toContain('do-not-leak');
    expect(body.memory.totalBytes).toBeGreaterThan(0);
    expect(body.disk.totalBytes).toBeGreaterThan(0);
    expect(body.uptimeSeconds).toBeGreaterThan(0);
  });
});
