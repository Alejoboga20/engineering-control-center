import { rmSync } from 'node:fs';
import { ClaudeStateService } from '../src/claude-monitoring/claude-state.service';
import {
  ago,
  detail,
  HOST,
  hookEvent,
  InboxTestApp,
  listItems,
  postHook,
  postReport,
  startInboxApp,
} from './inbox-helpers';

describe('Engineering Inbox: Claude Code', () => {
  let app: InboxTestApp;

  const only = async (query = '') => {
    const items = await listItems(app, query);
    expect(items).toHaveLength(1);
    return items[0];
  };
  const permission = (overrides: Record<string, unknown> = {}) =>
    postHook(app, hookEvent({ eventType: 'PermissionRequest', toolName: 'Bash', ...overrides })).expect(202);
  const action = (id: string, name: string) =>
    app.http().post(`/api/inbox/${id}/${name}`).set('Host', HOST).expect(200);

  beforeEach(async () => {
    app = await startInboxApp();
  });

  afterEach(async () => {
    await app.close();
    rmSync(app.config.dataDir, { recursive: true, force: true });
    rmSync(app.config.stateDir, { recursive: true, force: true });
  });

  describe('permission requests', () => {
    it('create a P1 item tied to the Claude and tmux sessions, without tool arguments', async () => {
      await permission({ timestamp: ago(1000) });
      const item = await only();
      expect(item).toMatchObject({
        type: 'permission_request',
        source: 'claude',
        sourceState: 'pending',
        status: 'open',
        priority: 'P1',
        sourceSession: 'payroll',
        sourceAgent: 'claude-1',
        title: 'Claude in payroll is waiting for permission to use Bash',
      });
      const { events } = await detail(app, item.id as string);
      expect(events).toEqual([
        expect.objectContaining({ kind: 'permission.requested', summary: 'Permission requested for Bash.' }),
      ]);
    });

    it('update the same item when repeated, and ignore a redelivered event', async () => {
      const first = hookEvent({ eventType: 'PermissionRequest', toolName: 'Bash', timestamp: ago(3000) });
      await postHook(app, first).expect(202);
      await postHook(app, first).expect(202);
      await postHook(app, hookEvent({ eventType: 'Notification', notificationType: 'permission_prompt', timestamp: ago(2000) })).expect(202);
      const item = await only();
      expect(item.title).toBe('Claude in payroll is waiting for permission to use Bash');
      const { events } = await detail(app, item.id as string);
      expect(events.map((event) => event.kind)).toEqual(['permission.prompt_shown', 'permission.requested']);
    });

    it('are cleared and resolved when the same tool completes', async () => {
      await permission({ timestamp: ago(2000) });
      await postHook(app, hookEvent({ eventType: 'PostToolUse', toolName: 'Bash', timestamp: ago(1000) })).expect(202);
      expect(await listItems(app, '?filter=agent_blockers')).toEqual([]);
      expect(await only('?filter=resolved')).toMatchObject({
        sourceState: 'cleared',
        status: 'resolved',
        resolution: 'auto_cleared',
      });
    });

    it('are not cleared by a different tool completing in parallel', async () => {
      await permission({ timestamp: ago(2000) });
      await postHook(app, hookEvent({ eventType: 'PostToolUse', toolName: 'Read', timestamp: ago(1000) })).expect(202);
      expect(await only()).toMatchObject({ sourceState: 'pending', status: 'open' });
    });

    it('stay pending after a denial, which sends no hook, until the next prompt', async () => {
      await permission({ timestamp: ago(3000) });
      // Denying is followed by no event at all. Claude then waits for the person.
      expect(await only()).toMatchObject({ sourceState: 'pending' });
      await postHook(app, hookEvent({ eventType: 'UserPromptSubmit', timestamp: ago(1000) })).expect(202);
      expect(await only('?filter=resolved')).toMatchObject({ sourceState: 'cleared' });
    });

    it('reopen the item only for a new request after it was cleared', async () => {
      await permission({ timestamp: ago(4000) });
      const id = (await only()).id as string;
      await action(id, 'acknowledge');
      await permission({ toolName: 'Edit', timestamp: ago(3500) });
      expect(await only()).toMatchObject({ status: 'acknowledged', title: expect.stringContaining('Edit') });

      await postHook(app, hookEvent({ eventType: 'Stop', timestamp: ago(3000) })).expect(202);
      expect((await detail(app, id)).item.status).toBe('resolved');
      await permission({ timestamp: ago(2000) });
      expect(await only()).toMatchObject({ id, status: 'open', sourceState: 'pending', resolution: null });
    });

    it('ignore an older event that arrives after a newer one', async () => {
      await permission({ timestamp: ago(2000) });
      await postHook(app, hookEvent({ eventType: 'Stop', timestamp: ago(1000) })).expect(202);
      await postHook(app, hookEvent({ eventType: 'PermissionRequest', toolName: 'Bash', timestamp: ago(1500) })).expect(202);
      expect(await only('?filter=resolved')).toMatchObject({ sourceState: 'cleared', status: 'resolved' });
    });

    it('keep a manual priority when the request repeats', async () => {
      await permission({ timestamp: ago(3000) });
      const id = (await only()).id as string;
      await app.http().patch(`/api/inbox/${id}`).set('Host', HOST).send({ priority: 'P3' }).expect(200);
      await permission({ toolName: 'Edit', timestamp: ago(2000) });
      expect(await only()).toMatchObject({ priority: 'P3', suggestedPriority: 'P1', priorityOverridden: true });
    });

    it('become uncertain, not resolved, after a backend restart', async () => {
      await permission({ timestamp: ago(1000) });
      await app.close();
      app = await startInboxApp({ dataDir: app.config.dataDir, stateDir: app.config.stateDir });
      const item = await only();
      expect(item).toMatchObject({ sourceState: 'uncertain', status: 'open' });
      const { events } = await detail(app, item.id as string);
      expect(events[0]).toMatchObject({ kind: 'source.uncertain', source: 'system' });

      // A new request after the restart is a new condition.
      await permission({ timestamp: new Date().toISOString() });
      expect(await only()).toMatchObject({ sourceState: 'pending' });
    });

    it('become uncertain when the tmux session disappears, and the item survives', async () => {
      await permission({ timestamp: ago(1000) });
      app.sessions.splice(app.sessions.indexOf('payroll'), 1);
      await app.running.app.get(ClaudeStateService).sweep();
      expect(await only()).toMatchObject({ sourceState: 'uncertain', status: 'open', sourceSession: 'payroll' });
    });

    it('become uncertain when a new Claude starts in the same pane', async () => {
      await permission({ timestamp: ago(2000) });
      await postHook(
        app,
        hookEvent({ eventType: 'SessionStart', source: 'startup', claudeSessionId: 'claude-2', timestamp: ago(1000) }),
      ).expect(202);
      expect(await only()).toMatchObject({ sourceAgent: 'claude-1', sourceState: 'uncertain' });
    });
  });

  describe('other blockers', () => {
    it('turn input notifications into one human_input item', async () => {
      await postHook(app, hookEvent({ eventType: 'Notification', notificationType: 'elicitation_dialog', timestamp: ago(2000) })).expect(202);
      await postHook(app, hookEvent({ eventType: 'Notification', notificationType: 'agent_needs_input', timestamp: ago(1000) })).expect(202);
      expect(await only()).toMatchObject({ type: 'human_input', priority: 'P1', sourceState: 'pending' });
    });

    it('ignore notifications that ask for nothing', async () => {
      await postHook(app, hookEvent({ eventType: 'Notification', notificationType: 'auth_success' })).expect(202);
      await postHook(app, hookEvent({ eventType: 'Notification', notificationType: 'idle_prompt' })).expect(202);
      expect(await listItems(app)).toEqual([]);
    });

    it('raise a P2 failure on StopFailure, cleared by the next prompt', async () => {
      await postHook(app, hookEvent({ eventType: 'StopFailure', timestamp: ago(2000) })).expect(202);
      expect(await only()).toMatchObject({ type: 'agent_failure', priority: 'P2', sourceState: 'pending' });
      await postHook(app, hookEvent({ eventType: 'UserPromptSubmit', timestamp: ago(1000) })).expect(202);
      expect(await only('?filter=resolved')).toMatchObject({ type: 'agent_failure', resolution: 'auto_cleared' });
    });
  });

  describe('agent reports', () => {
    const blocker = (extra: Record<string, unknown> = {}) => ({
      type: 'human_input',
      title: 'Choose payroll retry strategy',
      description: 'Implementation is waiting for an architectural decision.\n\nOption A or B.',
      priority: 'P1',
      sourceSession: 'payroll',
      ...extra,
    });

    it('create a blocker with the reported priority', async () => {
      const { body } = await postReport(app, blocker()).expect(202);
      expect(body).toEqual({ itemId: expect.any(String), created: true });
      expect((await detail(app, body.itemId)).item).toMatchObject({
        type: 'human_input',
        priority: 'P1',
        sourceSession: 'payroll',
        sourceState: 'pending',
        description: expect.stringContaining('Option A or B.'),
      });
    });

    it('default to P2 and keep a missing session as unknown', async () => {
      const { body } = await postReport(app, { type: 'human_input', title: 'Pick a name' }).expect(202);
      expect((await detail(app, body.itemId)).item).toMatchObject({ priority: 'P2', sourceSession: null });
    });

    it('never create a second item for a retry with the same idempotency key', async () => {
      const key = 'report-0001';
      const first = (await postReport(app, blocker({ idempotencyKey: key })).expect(202)).body;
      const second = (await postReport(app, blocker({ idempotencyKey: key, title: 'Edited' })).expect(202)).body;
      expect(second).toEqual({ itemId: first.itemId, created: false });
      expect((await only()).title).toBe('Choose payroll retry strategy');
    });

    it('create exactly one item from concurrent reports with the same key', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => postReport(app, blocker({ idempotencyKey: 'parallel-01' }))),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
      expect(responses.filter((r) => r.body.created)).toHaveLength(1);
      expect(new Set(responses.map((r) => r.body.itemId)).size).toBe(1);
      await only();
    });

    it('dedupe the same title without a key, but open a new item once the old one is resolved', async () => {
      const first = (await postReport(app, blocker()).expect(202)).body;
      const again = (await postReport(app, blocker({ title: '  choose PAYROLL retry   strategy ' })).expect(202)).body;
      expect(again).toEqual({ itemId: first.itemId, created: false });

      await action(first.itemId, 'resolve');
      const later = (await postReport(app, blocker()).expect(202)).body;
      expect(later.created).toBe(true);
      expect(later.itemId).not.toBe(first.itemId);
      expect((await detail(app, first.itemId)).item.status).toBe('resolved');
    });

    it('stay pending across a restart, since only a person resolves them', async () => {
      await postReport(app, blocker()).expect(202);
      await app.close();
      app = await startInboxApp({ dataDir: app.config.dataDir, stateDir: app.config.stateDir });
      expect(await only()).toMatchObject({ sourceState: 'pending' });
    });

    it('require the hook token', async () => {
      const { body } = await postReport(app, blocker(), null).expect(401);
      expect(body.code).toBe('UNAUTHORIZED');
      await postReport(app, blocker(), 'x'.repeat(43)).expect(401);
      await postReport(app, { nonsense: true }, null).expect(401);
      expect(await listItems(app)).toEqual([]);
    });

    it('still apply the Host guard', async () => {
      await app
        .http()
        .post('/api/inbox/events/agent')
        .set('Host', 'evil.example')
        .set('Authorization', `Bearer ${app.token}`)
        .send(blocker())
        .expect(403);
    });

    it.each([
      ['an unknown field', { command: 'rm -rf /' }],
      ['a path field', { path: '/etc/passwd' }],
      ['an empty title', { title: '' }],
      ['an oversized title', { title: 'x'.repeat(201) }],
      ['an oversized description', { description: 'x'.repeat(4001) }],
      ['a control character in the title', { title: 'Choose\u0007' }],
      ['a newline in the title', { title: 'Choose\nnow' }],
      ['an escape sequence in the description', { description: 'red \u001b[31m text' }],
      ['a bidirectional override', { description: 'abc\u202etxt.exe' }],
      ['a bad priority', { priority: 'urgent' }],
      ['a bad session name', { sourceSession: '../etc' }],
      ['a short idempotency key', { idempotencyKey: 'abc' }],
      ['pull request fields on human_input', { repository: 'acme/api' }],
      ['a missing title', { title: undefined }],
      ['an unknown type', { type: 'approve_permission' }],
    ])('reject %s', async (_name, extra) => {
      const { body } = await postReport(app, blocker(extra)).expect(400);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(await listItems(app)).toEqual([]);
    });

    it('reject an oversized body', async () => {
      await postReport(app, blocker({ description: 'x'.repeat(20_000) })).expect(413);
    });

    it('store descriptions as plain text, unrendered', async () => {
      const { body } = await postReport(app, blocker({ description: '<img src=x onerror=alert(1)>' })).expect(202);
      expect((await detail(app, body.itemId)).item.description).toBe('<img src=x onerror=alert(1)>');
    });
  });
});
