import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppConfig } from '../src/config/app-config';
import { GitHubClient } from '../src/inbox/github.client';
import { TmuxRunner } from '../src/tmux/tmux-runner';
import { hookToken, RunningApp, startApp, testConfig } from './helpers';

export const HOST = 'localhost:4999';

export interface InboxTestApp {
  running: RunningApp;
  config: AppConfig;
  token: string;
  /** tmux sessions that the fake tmux reports, each created long before any event. */
  sessions: string[];
  github: GitHubClient;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** Boots the whole app with a fake tmux and a GitHub client whose fetch the test controls. */
export async function startInboxApp(
  overrides: Partial<AppConfig> = {},
  fetchMock: jest.Mock = jest.fn(async () => {
    throw new Error('GitHub must not be called in this test');
  }),
  sessions = ['payroll', 'billing'],
): Promise<InboxTestApp> {
  const config = testConfig(overrides);
  const run = jest.fn(async (args: string[]) =>
    args[0] === 'list-sessions' ? sessions.map((name) => `1000000000:0:1:${name}\n`).join('') : '',
  );
  const github = new GitHubClient();
  github.fetch = fetchMock as unknown as typeof fetch;
  const running = await startApp(config, [
    { token: TmuxRunner, value: { run, binary: 'tmux', serverArgs: () => [] } },
    { token: GitHubClient, value: github },
  ]);
  return {
    running,
    config,
    token: hookToken(config),
    sessions,
    github,
    http: () => request(running.app.getHttpServer()),
    close: () => running.app.close(),
  };
}

export function hookEvent(overrides: Record<string, unknown> = {}) {
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

export function postHook(app: InboxTestApp, body: unknown) {
  return app
    .http()
    .post('/api/claude/hooks')
    .set('Host', HOST)
    .set('Authorization', `Bearer ${app.token}`)
    .send(body as object);
}

export function postReport(app: InboxTestApp, body: unknown, bearer: string | null = app.token) {
  const req = app.http().post('/api/inbox/events/agent').set('Host', HOST);
  if (bearer) req.set('Authorization', `Bearer ${bearer}`);
  return req.send(body as object);
}

export async function listItems(app: InboxTestApp, query = '') {
  const { body } = await app.http().get(`/api/inbox${query}`).set('Host', HOST).expect(200);
  return body.items as Record<string, unknown>[];
}

export async function detail(app: InboxTestApp, id: string) {
  const { body } = await app.http().get(`/api/inbox/${id}`).set('Host', HOST).expect(200);
  return body as { item: Record<string, unknown>; events: Record<string, unknown>[] };
}

/** Milliseconds ago, as the ISO timestamp a hook would carry. */
export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
