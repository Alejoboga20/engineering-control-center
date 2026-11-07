import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { GitHubConfig } from '../src/config/app-config';
import { GitHubSyncService } from '../src/inbox/github-sync.service';
import { connect, TestClient } from './helpers';
import { detail, HOST, InboxTestApp, listItems, postReport, startInboxApp } from './inbox-helpers';

const TOKEN = 'github_pat_TESTTOKEN0123456789abcdef';
const REPO = 'acme/api';

interface FakePr {
  number: number;
  title?: string;
  author?: string;
  isDraft?: boolean;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt?: string;
  reviewDecision?: string | null;
  checks?: string | null;
}

/** A stand-in for api.github.com/graphql that answers the two queries the client sends. */
class FakeGitHub {
  prs = new Map<number, FakePr>();
  calls: { query: string; variables: Record<string, unknown>; authorization: string }[] = [];
  /** Answers the next calls with these responses instead, in order. */
  failures: Response[] = [];

  readonly fetch = jest.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string);
    this.calls.push({ query, variables, authorization: (init.headers as Record<string, string>).Authorization });
    const failure = this.failures.shift();
    if (failure) return failure;
    const data = this.answer(query, variables);
    // As GitHub does: a lookup that matches nothing is a null alias plus a NOT_FOUND error.
    const missing = Object.entries((data.repository ?? {}) as Record<string, unknown>).filter(([, v]) => v === null);
    const errors = missing.map(([alias]) => ({ type: 'NOT_FOUND', path: ['repository', alias], message: 'Could not resolve to a PullRequest.' }));
    return Response.json({
      data: { rateLimit: { remaining: 4999, resetAt: new Date().toISOString() }, ...data },
      ...(errors.length > 0 ? { errors } : {}),
    });
  });

  set(pr: FakePr): void {
    this.prs.set(pr.number, { ...this.prs.get(pr.number), ...pr });
  }

  private node(pr: FakePr) {
    return {
      number: pr.number,
      title: pr.title ?? `PR ${pr.number}`,
      url: `https://github.com/${REPO}/pull/${pr.number}`,
      isDraft: pr.isDraft ?? false,
      state: pr.state ?? 'OPEN',
      createdAt: pr.createdAt ?? '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      author: { login: pr.author ?? 'alejo' },
      reviewDecision: pr.reviewDecision === undefined ? 'REVIEW_REQUIRED' : pr.reviewDecision,
      commits: { nodes: [{ commit: { statusCheckRollup: pr.checks ? { state: pr.checks } : null } }] },
    };
  }

  private answer(query: string, variables: Record<string, unknown>): { repository: Record<string, unknown> } {
    if (query.includes('OpenPullRequests')) {
      const open = [...this.prs.values()]
        .filter((pr) => (pr.state ?? 'OPEN') === 'OPEN')
        .sort((a, b) => b.number - a.number);
      const start = variables.after ? Number(variables.after) : 0;
      const size = variables.first as number;
      const page = open.slice(start, start + size);
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: start + size < open.length, endCursor: String(start + size) },
            nodes: page.map((pr) => this.node(pr)),
          },
        },
      };
    }
    const repository: Record<string, unknown> = {};
    for (const [, alias, number] of query.matchAll(/(pr\d+): pullRequest\(number: (\d+)\)/g)) {
      const pr = this.prs.get(Number(number));
      repository[alias] = pr ? this.node(pr) : null;
    }
    return { repository };
  }
}

describe('Engineering Inbox: GitHub', () => {
  let app: InboxTestApp;
  let gh: FakeGitHub;
  let secrets: string;
  let tokenFile: string;
  const sockets: TestClient[] = [];

  async function start(github: Partial<GitHubConfig> = {}, keep?: InboxTestApp) {
    app = await startInboxApp(
      {
        ...(keep ? { dataDir: keep.config.dataDir, stateDir: keep.config.stateDir } : {}),
        github: { repositories: [REPO], authors: [], tokenFile, pollSeconds: 180, initialSync: 'open', ...github },
      },
      gh.fetch,
    );
  }

  const sync = () => app.running.app.get(GitHubSyncService);
  async function syncNow() {
    const { body } = await app.http().post('/api/inbox/sync/github').set('Host', HOST).expect(202);
    await sync().current();
    return body;
  }
  const summary = async () => (await app.http().get('/api/inbox/summary').set('Host', HOST).expect(200)).body;
  const prItem = async (number: number) =>
    (await listItems(app, '?filter=all')).find(
      (item) => (item.pullRequest as { number: number } | null)?.number === number,
    ) ?? (await listItems(app, '?filter=resolved')).find(
      (item) => (item.pullRequest as { number: number } | null)?.number === number,
    );

  beforeEach(async () => {
    gh = new FakeGitHub();
    secrets = mkdtempSync(join(tmpdir(), 'ecc-secrets-'));
    tokenFile = join(secrets, 'github-token');
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    await start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.ws.terminate();
    await app.close();
    rmSync(app.config.dataDir, { recursive: true, force: true });
    rmSync(app.config.stateDir, { recursive: true, force: true });
    rmSync(secrets, { recursive: true, force: true });
  });

  describe('discovery', () => {
    it('creates a P2 item per open pull request, read-only, with the token only in the header', async () => {
      gh.set({ number: 7, title: 'Add retries', author: 'alejo' });
      const status = await syncNow();
      expect(status).toMatchObject({ configured: true, running: true });

      const item = await prItem(7);
      expect(item).toMatchObject({
        type: 'pull_request',
        source: 'github',
        sourceState: 'open',
        status: 'open',
        priority: 'P2',
        title: 'Add retries',
        pullRequest: {
          repository: REPO,
          number: 7,
          url: 'https://github.com/acme/api/pull/7',
          author: 'alejo',
          draft: false,
          reviewState: 'review_required',
          checksState: 'none',
          attribution: 'discovered',
        },
      });
      expect(gh.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(gh.calls.every((call) => !/mutation/i.test(call.query))).toBe(true);
      const body = JSON.stringify(await summary());
      expect(body).not.toContain(TOKEN);
      expect((await summary()).github).toMatchObject({ running: false, lastError: null, lastSuccessAt: expect.any(String) });
    });

    it('pages through every open pull request', async () => {
      for (let number = 1; number <= 120; number += 1) gh.set({ number });
      await syncNow();
      expect(await listItems(app, '?filter=pull_requests')).toHaveLength(120);
      expect(gh.calls.filter((call) => call.query.includes('OpenPullRequests'))).toHaveLength(3);
    });

    it('never duplicates an item across repeated syncs, and changes nothing when nothing changed', async () => {
      gh.set({ number: 7 });
      await syncNow();
      const before = await prItem(7);
      await syncNow();
      await syncNow();
      expect(await listItems(app, '?filter=pull_requests')).toHaveLength(1);
      expect((await prItem(7))?.revision).toBe(before?.revision);
    });

    it('marks drafts P3 and ready pull requests P2', async () => {
      gh.set({ number: 7, isDraft: true });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ priority: 'P3', pullRequest: expect.objectContaining({ draft: true }) });
      gh.set({ number: 7, isDraft: false });
      await syncNow();
      const item = await prItem(7);
      expect(item).toMatchObject({ priority: 'P2', pullRequest: expect.objectContaining({ draft: false }) });
      expect((await detail(app, item?.id as string)).events[0]).toMatchObject({ kind: 'pr.ready_for_review' });
      expect((await summary()).pullRequestsAwaitingReview).toBe(1);
    });

    it('only imports pull requests by the configured authors', async () => {
      await app.close();
      await start({ authors: ['alejo'] }, app);
      gh.set({ number: 1, author: 'alejo' });
      gh.set({ number: 2, author: 'someone' });
      await syncNow();
      expect((await listItems(app)).map((item) => (item.pullRequest as { number: number }).number)).toEqual([1]);
    });

    it('with initial sync "new", imports only pull requests opened after the first sync', async () => {
      await app.close();
      await start({ initialSync: 'new' }, app);
      gh.set({ number: 1, createdAt: '2026-01-01T00:00:00Z' });
      await syncNow();
      expect(await listItems(app)).toEqual([]);
      gh.set({ number: 2, createdAt: new Date(Date.now() + 1000).toISOString() });
      await syncNow();
      expect((await listItems(app)).map((item) => (item.pullRequest as { number: number }).number)).toEqual([2]);
    });

    it('pushes item changes and a completed sync over the stream', async () => {
      const client = connect(app.running.port, '/api/inbox/stream');
      sockets.push(client);
      await client.waitFor(() => client.messages.length >= 1);
      gh.set({ number: 7 });
      await syncNow();
      await client.waitFor(() => client.messages.some((m) => m.type === 'inbox.sync.completed'));
      expect(client.messages.map((m) => m.type)).toEqual(['inbox.hello', 'inbox.item.created', 'inbox.sync.completed']);
    });
  });

  describe('checks and reviews', () => {
    it('escalates failing checks on the same item, and returns an acknowledged item to open', async () => {
      gh.set({ number: 7, checks: 'PENDING' });
      await syncNow();
      const id = (await prItem(7))?.id as string;
      await app.http().post(`/api/inbox/${id}/acknowledge`).set('Host', HOST).expect(200);

      gh.set({ number: 7, checks: 'FAILURE' });
      await syncNow();
      expect(await listItems(app, '?filter=pull_requests')).toHaveLength(1);
      expect(await prItem(7)).toMatchObject({
        id,
        status: 'open',
        priority: 'P1',
        suggestedPriority: 'P1',
        pullRequest: expect.objectContaining({ checksState: 'failing' }),
      });
      const kinds = (await detail(app, id)).events.map((event) => event.kind);
      expect(kinds.slice(0, 2)).toEqual(['item.reopened', 'pr.checks_failing']);
    });

    it('does not reopen for checks that keep failing, or that are only pending', async () => {
      gh.set({ number: 7, checks: 'FAILURE' });
      await syncNow();
      const id = (await prItem(7))?.id as string;
      await app.http().post(`/api/inbox/${id}/acknowledge`).set('Host', HOST).expect(200);
      await syncNow();
      gh.set({ number: 7, checks: 'PENDING', title: 'Renamed' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ status: 'acknowledged', title: 'Renamed' });
    });

    it('keeps a manual priority when checks fail, while updating the suggestion', async () => {
      gh.set({ number: 7, checks: 'SUCCESS' });
      await syncNow();
      const id = (await prItem(7))?.id as string;
      await app.http().patch(`/api/inbox/${id}`).set('Host', HOST).send({ priority: 'P3' }).expect(200);
      gh.set({ number: 7, checks: 'ERROR' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ priority: 'P3', suggestedPriority: 'P1', priorityOverridden: true });
    });

    it('records review decisions', async () => {
      gh.set({ number: 7, reviewDecision: 'CHANGES_REQUESTED' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({
        priority: 'P2',
        pullRequest: expect.objectContaining({ reviewState: 'changes_requested' }),
      });
    });
  });

  describe('merge and close', () => {
    it('resolves a merged pull request, looking up only the ones that left the open list', async () => {
      gh.set({ number: 7 });
      gh.set({ number: 8 });
      await syncNow();
      gh.set({ number: 7, state: 'MERGED' });
      gh.calls = [];
      await syncNow();
      const lookups = gh.calls.filter((call) => !call.query.includes('OpenPullRequests'));
      expect(lookups).toHaveLength(1);
      expect(lookups[0].query).toContain('pr7: pullRequest(number: 7)');
      expect(lookups[0].query).not.toContain('pr8');

      const item = await prItem(7);
      expect(item).toMatchObject({ sourceState: 'merged', status: 'resolved', resolution: 'auto_merged' });
      const kinds = (await detail(app, item?.id as string)).events.map((event) => event.kind);
      expect(kinds).toEqual(['item.resolved', 'pr.merged', 'pr.discovered']);
    });

    it('resolves a closed pull request, and reopens it when it is reopened on GitHub', async () => {
      gh.set({ number: 7 });
      await syncNow();
      gh.set({ number: 7, state: 'CLOSED' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ sourceState: 'closed', resolution: 'auto_closed' });
      gh.set({ number: 7, state: 'OPEN' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ sourceState: 'open', status: 'open', resolution: null });
    });

    it('does not reopen a pull request a person resolved while it stays open', async () => {
      gh.set({ number: 7 });
      await syncNow();
      const id = (await prItem(7))?.id as string;
      await app.http().post(`/api/inbox/${id}/resolve`).set('Host', HOST).expect(200);
      gh.set({ number: 7, title: 'New title' });
      await syncNow();
      expect(await prItem(7)).toMatchObject({ status: 'resolved', resolution: 'manual' });
    });
  });

  describe('pull requests GitHub does not find', () => {
    it('keep a tracked item, note it once, and still reconcile the rest of the batch', async () => {
      gh.set({ number: 7 });
      gh.set({ number: 8 });
      await syncNow();
      gh.prs.delete(7);
      gh.set({ number: 8, state: 'MERGED' });
      await syncNow();
      await syncNow();
      expect((await summary()).github.lastError).toBeNull();
      expect(await prItem(8)).toMatchObject({ resolution: 'auto_merged' });
      const item = await prItem(7);
      expect(item).toMatchObject({ status: 'open', sourceState: 'open' });
      const kinds = (await detail(app, item?.id as string)).events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'pr.not_found')).toHaveLength(1);
    });

    it('drop an agent report of a number GitHub does not have', async () => {
      await postReport(app, { type: 'pull_request', repository: REPO, pullRequestNumber: 9 }).expect(202);
      await syncNow();
      expect((await summary()).github.lastError).toBeNull();
      gh.set({ number: 9 });
      await syncNow();
      expect(await prItem(9)).toMatchObject({ pullRequest: expect.objectContaining({ attribution: 'discovered' }) });
    });
  });

  describe('failures', () => {
    it('logs an unexpected error for the repository, and shows only a safe message', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      gh.fetch.mockImplementationOnce(async () => Response.json({ data: { repository: { pullRequests: null } } }));
      await syncNow();
      expect((await summary()).github.lastError).toBe('acme/api: Unexpected error while syncing.');
      const logged = warn.mock.calls.map((args) => String(args[0]));
      expect(logged).toEqual(expect.arrayContaining([expect.stringMatching(/^GitHub sync of acme\/api failed: .+/)]));
      expect(logged.join('\n')).not.toContain(TOKEN);
      warn.mockRestore();
    });

    it('backs off on a rate limit, and keeps every item', async () => {
      gh.set({ number: 7 });
      await syncNow();
      const reset = Math.floor(Date.now() / 1000) + 600;
      gh.failures.push(
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
      );
      await syncNow();
      const status = (await summary()).github;
      expect(status.rateLimitedUntil).toBe(new Date(reset * 1000).toISOString());
      expect(status.lastError).toMatch(/rate limit/);
      expect(await prItem(7)).toMatchObject({ status: 'open', sourceState: 'open' });

      gh.calls = [];
      await syncNow();
      expect(gh.calls).toHaveLength(0);
    });

    it('backs off on a GraphQL RATE_LIMITED error sent with status 200', async () => {
      gh.failures.push(Response.json({ errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }));
      await syncNow();
      expect((await summary()).github.rateLimitedUntil).toEqual(expect.any(String));
    });

    it('records an API failure per repository and resolves nothing', async () => {
      gh.set({ number: 7 });
      await syncNow();
      gh.set({ number: 7, state: 'MERGED' });
      gh.failures.push(new Response('oops', { status: 502 }));
      await syncNow();
      const status = (await summary()).github;
      expect(status.lastError).toBe('acme/api: GitHub answered 502.');
      expect(status.repositories[0]).toMatchObject({ repository: REPO, lastError: 'GitHub answered 502.' });
      expect(await prItem(7)).toMatchObject({ status: 'open', sourceState: 'open' });
    });

    it('keeps items of a repository removed from the allowlist, and stops syncing it', async () => {
      gh.set({ number: 7 });
      await syncNow();
      await app.close();
      await start({ repositories: ['acme/web'] }, app);
      gh.calls = [];
      await syncNow();
      expect(gh.calls.every((call) => call.variables.name === 'web')).toBe(true);
      expect(await prItem(7)).toMatchObject({ status: 'open' });
    });

    it('answers 409 while a sync is running', async () => {
      let release: () => void = () => undefined;
      gh.fetch.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(Response.json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } })))),
      );
      await app.http().post('/api/inbox/sync/github').set('Host', HOST).expect(202);
      const { body } = await app.http().post('/api/inbox/sync/github').set('Host', HOST).expect(409);
      expect(body.code).toBe('GITHUB_SYNC_RUNNING');
      release();
      await sync().current();
    });
  });

  describe('configuration', () => {
    it.each([
      ['no repositories', { repositories: [] }, /ECC_GITHUB_REPOS/],
      ['no token file', { tokenFile: null }, /ECC_GITHUB_TOKEN_FILE is not set/],
    ])('is not configured with %s', async (_name, github, problem) => {
      await app.close();
      await start(github as Partial<GitHubConfig>, app);
      const { body } = await app.http().post('/api/inbox/sync/github').set('Host', HOST).expect(400);
      expect(body.code).toBe('GITHUB_NOT_CONFIGURED');
      expect((await summary()).github).toMatchObject({ configured: false, configurationProblem: expect.stringMatching(problem) });
      expect(gh.fetch).not.toHaveBeenCalled();
    });

    it('refuses a token file that other users can read', async () => {
      chmodSync(tokenFile, 0o644);
      expect((await summary()).github.configurationProblem).toMatch(/chmod 600/);
      await app.http().post('/api/inbox/sync/github').set('Host', HOST).expect(400);
    });

    it('refuses a token file that is a symlink', async () => {
      const link = join(secrets, 'link');
      symlinkSync(tokenFile, link);
      await app.close();
      await start({ tokenFile: link }, app);
      expect((await summary()).github.configurationProblem).toMatch(/symlink/);
    });
  });

  describe('agent reports of pull requests', () => {
    const reportPr = (extra: Record<string, unknown> = {}) =>
      postReport(app, { type: 'pull_request', repository: 'Acme/API', pullRequestNumber: 7, sourceSession: 'payroll', ...extra });

    it('link a pull request GitHub confirms, as agent_reported', async () => {
      gh.set({ number: 7 });
      const { body } = await reportPr().expect(202);
      expect(body).toEqual({ itemId: expect.any(String), created: true });
      expect((await detail(app, body.itemId)).item).toMatchObject({
        sourceSession: 'payroll',
        pullRequest: expect.objectContaining({ attribution: 'agent_reported', number: 7 }),
      });
    });

    it('mark an already discovered pull request without duplicating it', async () => {
      gh.set({ number: 7 });
      await syncNow();
      const { body } = await reportPr().expect(202);
      expect(body.created).toBe(false);
      expect(await listItems(app, '?filter=pull_requests')).toHaveLength(1);
      expect(await prItem(7)).toMatchObject({ pullRequest: expect.objectContaining({ attribution: 'agent_reported' }) });
    });

    it('keep an unconfirmed report until a sync sees the pull request', async () => {
      const { body } = await reportPr().expect(202);
      expect(body).toEqual({ itemId: null, created: false });
      expect(await listItems(app)).toEqual([]);
      gh.set({ number: 7 });
      await syncNow();
      expect(await prItem(7)).toMatchObject({
        sourceSession: 'payroll',
        pullRequest: expect.objectContaining({ attribution: 'agent_reported' }),
      });
    });

    it('record a keyless retry once, not once per retry', async () => {
      gh.set({ number: 7 });
      for (let i = 0; i < 3; i += 1) await reportPr().expect(202);
      const item = await prItem(7);
      const kinds = (await detail(app, item?.id as string)).events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'pr.reported_by_agent')).toHaveLength(1);
    });

    it('keep their idempotency keys apart from blocker reports', async () => {
      gh.set({ number: 7 });
      await reportPr({ idempotencyKey: 'shared-key-1' }).expect(202);
      const { body } = await postReport(app, { type: 'human_input', title: 'Blocked', idempotencyKey: 'shared-key-1' }).expect(202);
      expect(body).toEqual({ itemId: expect.any(String), created: true });
    });

    it('refuse a repository outside the allowlist', async () => {
      const { body } = await reportPr({ repository: 'acme/secret' }).expect(403);
      expect(body.code).toBe('REPOSITORY_NOT_ALLOWED');
      expect(gh.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing number', { pullRequestNumber: undefined }],
      ['a non-integer number', { pullRequestNumber: 1.5 }],
      ['a malformed repository', { repository: 'acme' }],
      ['a title', { title: 'not allowed here' }],
    ])('reject %s', async (_name, extra) => {
      await reportPr(extra).expect(400);
    });
  });
});
