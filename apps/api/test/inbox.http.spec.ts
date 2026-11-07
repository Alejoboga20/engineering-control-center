import { rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { connect, TEST_ORIGIN, TestClient } from './helpers';
import { detail, HOST, InboxTestApp, listItems, postReport, startInboxApp } from './inbox-helpers';

describe('Engineering Inbox API', () => {
  let app: InboxTestApp;
  const sockets: TestClient[] = [];

  /** A few milliseconds apart, so that activity times never tie. */
  const report = async (title: string, extra: Record<string, unknown> = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return postReport(app, { type: 'human_input', title, sourceSession: 'payroll', ...extra }).expect(202);
  };
  const action = (id: string, name: string) =>
    app.http().post(`/api/inbox/${id}/${name}`).set('Host', HOST);
  const patch = (id: string, body: unknown) =>
    app.http().patch(`/api/inbox/${id}`).set('Host', HOST).send(body as object);

  beforeEach(async () => {
    app = await startInboxApp();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.ws.terminate();
    await app.close();
    rmSync(app.config.dataDir, { recursive: true, force: true });
    rmSync(app.config.stateDir, { recursive: true, force: true });
  });

  describe('storage', () => {
    it('keeps the database owner-only, in a private directory', () => {
      expect(statSync(app.config.dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(app.config.dataDir, 'inbox.sqlite3')).mode & 0o777).toBe(0o600);
    });

    it('keeps items, statuses, priorities and events across a backend restart', async () => {
      const { body } = await report('Choose a retry strategy');
      await action(body.itemId, 'acknowledge').expect(200);
      await patch(body.itemId, { priority: 'P1' }).expect(200);
      await app.close();

      app = await startInboxApp({ dataDir: app.config.dataDir, stateDir: app.config.stateDir });
      const { item, events } = await detail(app, body.itemId);
      expect(item).toMatchObject({ status: 'acknowledged', priority: 'P1', priorityOverridden: true });
      expect(events.map((event) => event.kind)).toEqual([
        'priority.changed',
        'item.acknowledged',
        'agent.reported',
      ]);
    });

    it('stores nothing outside the declared fields', async () => {
      await report('Choose a retry strategy', { description: 'Waiting for a decision.' });
      await app.close();
      const db = new Database(join(app.config.dataDir, 'inbox.sqlite3'), { readonly: true });
      const dump = JSON.stringify(db.prepare('SELECT * FROM inbox_items').all());
      db.close();
      expect(dump).not.toContain(app.token);
      app = await startInboxApp({ dataDir: app.config.dataDir, stateDir: app.config.stateDir });
    });

    it('answers 503 when the database cannot be opened, and the rest keeps working', async () => {
      await app.close();
      const blocked = join(app.config.dataDir, 'not-a-directory');
      writeFileSync(blocked, '');
      app = await startInboxApp({ dataDir: blocked });
      const { body } = await app.http().get('/api/inbox').set('Host', HOST).expect(503);
      expect(body.code).toBe('INBOX_UNAVAILABLE');
      await app.http().get('/api/inbox/summary').set('Host', HOST).expect(503);
      await postReport(app, { type: 'human_input', title: 'x' }).expect(503);
      await app.http().get('/api/claude/status').set('Host', HOST).expect(200);
    });
  });

  describe('lifecycle', () => {
    let id: string;

    beforeEach(async () => {
      id = (await report('Choose a retry strategy')).body.itemId;
    });

    it('acknowledges, resolves and reopens, returning the updated item each time', async () => {
      let { body } = await action(id, 'acknowledge').expect(200);
      expect(body).toMatchObject({ id, status: 'acknowledged', revision: 2 });
      expect(body.acknowledgedAt).toEqual(expect.any(String));
      ({ body } = await action(id, 'resolve').expect(200));
      expect(body).toMatchObject({ status: 'resolved', resolution: 'manual', revision: 3 });
      ({ body } = await action(id, 'reopen').expect(200));
      expect(body).toMatchObject({ status: 'open', resolution: null, resolvedAt: null, revision: 4 });
    });

    it('treats repeating the current state as a no-op', async () => {
      await action(id, 'acknowledge').expect(200);
      const { body } = await action(id, 'acknowledge').expect(200);
      expect(body.revision).toBe(2);
      const { events } = await detail(app, id);
      expect(events.filter((event) => event.kind === 'item.acknowledged')).toHaveLength(1);
    });

    it('refuses transitions the rules do not allow', async () => {
      await action(id, 'resolve').expect(200);
      const { body } = await action(id, 'acknowledge').expect(409);
      expect(body.code).toBe('INBOX_INVALID_TRANSITION');
      await action(id, 'reopen').expect(200);
      await action(id, 'acknowledge').expect(200);
      await action(id, 'reopen').expect(409);
    });

    it('sets a manual priority, and clears it back to the suggestion with null', async () => {
      let { body } = await patch(id, { priority: 'P3' }).expect(200);
      expect(body).toMatchObject({ priority: 'P3', suggestedPriority: 'P2', priorityOverridden: true });
      ({ body } = await patch(id, { priority: null }).expect(200));
      expect(body).toMatchObject({ priority: 'P2', priorityOverridden: false });
    });

    it.each([
      [{}],
      [{ priority: 'P4' }],
      [{ priority: 'P1', status: 'resolved' }],
    ])('rejects the update %j', async (body) => {
      const { body: error } = await patch(id, body).expect(400);
      expect(error.code).toBe('VALIDATION_ERROR');
    });

    it('answers 404 for an unknown item and 400 for an id that is not a uuid', async () => {
      const { body } = await action('6f1c1a52-4a8e-4b4e-9b59-1d1f6c1f0d11', 'resolve').expect(404);
      expect(body.code).toBe('INBOX_ITEM_NOT_FOUND');
      await app.http().get('/api/inbox/1%27%20OR%201=1').set('Host', HOST).expect(400);
    });

    it('refuses cross-site requests', async () => {
      await action(id, 'resolve').set('Origin', 'https://evil.example').expect(403);
      await app.http().get('/api/inbox').set('Host', 'evil.example').expect(403);
    });

    it('allows PATCH from the allowed origin in CORS preflight', async () => {
      const { headers } = await app
        .http()
        .options(`/api/inbox/${id}`)
        .set('Host', HOST)
        .set('Origin', TEST_ORIGIN)
        .set('Access-Control-Request-Method', 'PATCH')
        .expect(204);
      expect(headers['access-control-allow-methods']).toContain('PATCH');
    });
  });

  describe('listing', () => {
    it('sorts by priority, then actionability, then latest activity', async () => {
      const p2old = (await report('P2 older')).body.itemId;
      const p1 = (await report('P1 blocker', { priority: 'P1' })).body.itemId;
      const p2acked = (await report('P2 acknowledged')).body.itemId;
      const p3 = (await report('P3 later', { priority: 'P3' })).body.itemId;
      const p2new = (await report('P2 newer')).body.itemId;
      await action(p2acked, 'acknowledge').expect(200);

      const ids = (await listItems(app)).map((item) => item.id);
      expect(ids).toEqual([p1, p2new, p2old, p2acked, p3]);
    });

    it('filters needs attention, resolved, and by priority and status', async () => {
      const p1 = (await report('P1 blocker', { priority: 'P1' })).body.itemId;
      const p1acked = (await report('P1 acknowledged', { priority: 'P1' })).body.itemId;
      const done = (await report('Done')).body.itemId;
      await action(p1acked, 'acknowledge').expect(200);
      await action(done, 'resolve').expect(200);

      expect((await listItems(app, '?filter=needs_attention')).map((i) => i.id)).toEqual([p1]);
      expect((await listItems(app, '?filter=resolved')).map((i) => i.id)).toEqual([done]);
      expect((await listItems(app, '?filter=agent_blockers')).map((i) => i.id)).toEqual([p1, p1acked]);
      expect(await listItems(app, '?filter=pull_requests')).toEqual([]);
      expect((await listItems(app, '?status=acknowledged')).map((i) => i.id)).toEqual([p1acked]);
      expect((await listItems(app, '?priority=P2')).map((i) => i.id)).toEqual([done]);
    });

    it('shows recently resolved items in all, older ones only under resolved', async () => {
      const old = (await report('Resolved long ago')).body.itemId;
      await action(old, 'resolve').expect(200);
      await app.close();
      const db = new Database(join(app.config.dataDir, 'inbox.sqlite3'));
      db.prepare('UPDATE inbox_items SET resolved_at = ? WHERE id = ?').run(
        new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        old,
      );
      db.close();
      app = await startInboxApp({ dataDir: app.config.dataDir, stateDir: app.config.stateDir });
      const recent = (await report('Resolved today')).body.itemId;
      await action(recent, 'resolve').expect(200);

      expect((await listItems(app)).map((i) => i.id)).toEqual([recent]);
      expect((await listItems(app, '?filter=resolved')).map((i) => i.id).sort()).toEqual(
        [old, recent].sort(),
      );
    });

    it.each(['?filter=everything', '?priority=P0', '?status=done', '?sort=title'])(
      'rejects the query %s',
      async (query) => {
        await app.http().get(`/api/inbox${query}`).set('Host', HOST).expect(400);
      },
    );

    it('summarizes counts and sync health', async () => {
      await report('P1 blocker', { priority: 'P1' });
      const acked = (await report('Acknowledged')).body.itemId;
      await action(acked, 'acknowledge').expect(200);
      const { body } = await app.http().get('/api/inbox/summary').set('Host', HOST).expect(200);
      expect(body).toMatchObject({
        open: 1,
        needsAttention: 1,
        pullRequestsAwaitingReview: 0,
        acknowledged: 1,
        agentReportingAvailable: true,
        github: { configured: false, configurationProblem: 'ECC_GITHUB_REPOS is not set.', running: false },
      });
    });
  });

  describe('realtime', () => {
    it('says hello first, then pushes item changes with increasing revisions', async () => {
      const client = connect(app.running.port, '/api/inbox/stream');
      sockets.push(client);
      await client.waitFor(() => client.messages.length >= 1);
      expect(client.messages[0]).toMatchObject({ type: 'inbox.hello' });

      const id = (await report('Choose a retry strategy')).body.itemId;
      await action(id, 'acknowledge').expect(200);
      await action(id, 'resolve').expect(200);
      await client.waitFor(() => client.messages.length >= 4);
      expect(client.messages.slice(1).map((m) => [m.type, (m.data as { revision: number }).revision])).toEqual([
        ['inbox.item.created', 1],
        ['inbox.item.updated', 2],
        ['inbox.item.resolved', 3],
      ]);
    });

    it('says hello again on reconnection, so the client refetches', async () => {
      const first = connect(app.running.port, '/api/inbox/stream');
      sockets.push(first);
      await first.waitFor(() => first.messages.length >= 1);
      first.ws.terminate();
      const second = connect(app.running.port, '/api/inbox/stream');
      sockets.push(second);
      await second.waitFor(() => second.messages.length >= 1);
      expect(second.messages[0]).toMatchObject({ type: 'inbox.hello' });
    });

    it('refuses an upgrade from another origin', async () => {
      const client = connect(app.running.port, '/api/inbox/stream', 'https://evil.example');
      sockets.push(client);
      const unexpected = await new Promise<number>((resolve) => {
        client.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      });
      expect(unexpected).toBe(403);
    });
  });
});
