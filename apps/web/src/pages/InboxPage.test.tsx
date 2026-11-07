import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GitHubSyncStatus, InboxItem, InboxItemDetail, InboxSummary } from '@ecc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { FakeWebSocket, installBrowserFakes } from '../test/fakes';
import { alpha, stats } from '../test/fixtures';
import { PENDING_PERMISSION_CAVEAT, UNCERTAIN_EXPLANATION } from '../components/inbox/InboxItemDetails';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('../test/fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

// One clock for the whole file, so that items built at different moments compare predictably.
const NOW = Date.now();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

function item(id: string, fields: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    type: 'human_input',
    title: `Item ${id}`,
    description: null,
    priority: 'P2',
    suggestedPriority: 'P2',
    priorityOverridden: false,
    status: 'open',
    source: 'claude',
    sourceState: 'pending',
    sourceSession: 'alpha',
    sourceAgent: 'claude-1',
    pullRequest: null,
    revision: 1,
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(1),
    lastActivityAt: hoursAgo(1),
    acknowledgedAt: null,
    resolvedAt: null,
    resolution: null,
    ...fields,
  };
}

function pullRequestItem(id: string, fields: Partial<InboxItem> = {}): InboxItem {
  return item(id, {
    type: 'pull_request',
    title: `Pull request ${id}`,
    source: 'github',
    sourceState: 'open',
    sourceSession: null,
    sourceAgent: null,
    pullRequest: {
      repository: 'acme/api',
      number: 42,
      url: 'https://github.com/acme/api/pull/42',
      author: 'octocat',
      draft: false,
      reviewState: 'review_required',
      checksState: 'passing',
      attribution: 'discovered',
    },
    ...fields,
  });
}

const github: GitHubSyncStatus = {
  configured: true,
  configurationProblem: null,
  running: false,
  pollIntervalSeconds: 180,
  lastSyncAt: hoursAgo(0.1),
  lastSuccessAt: hoursAgo(0.1),
  lastError: null,
  rateLimitedUntil: null,
  repositories: [{ repository: 'acme/api', lastSyncAt: null, lastSuccessAt: null, lastError: null }],
};

function summaryOf(fields: Partial<InboxSummary> = {}): InboxSummary {
  return {
    open: 3,
    needsAttention: 1,
    pullRequestsAwaitingReview: 2,
    acknowledged: 0,
    github,
    agentReportingAvailable: true,
    ...fields,
  };
}

type Reply = { status: number; body?: unknown };
type Route = (url: string, init?: RequestInit) => Reply | Promise<Reply> | undefined;

let listed: InboxItem[];
let summary: InboxSummary;
let route: Route;

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const reply: Reply =
      (await route(url, init)) ??
      (url === '/api/sessions'
        ? { status: 200, body: [alpha] }
        : url === '/api/system/stats'
          ? { status: 200, body: stats }
          : url.startsWith('/api/inbox?')
            ? { status: 200, body: { items: [...listed] } }
            : url === '/api/inbox/summary'
              ? { status: 200, body: summary }
              : url.startsWith('/api/inbox/') && !init?.method
                ? { status: 200, body: detailOf(url) }
                : { status: 404, body: { code: 'NOT_FOUND', message: `Not found: ${url}` } });
    return { status: reply.status, ok: reply.status < 400, json: async () => reply.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function detailOf(url: string): InboxItemDetail {
  const id = url.replace('/api/inbox/', '');
  const found = listed.find((candidate) => candidate.id === id) ?? item(id);
  return {
    item: found,
    events: [
      {
        id: `${id}-e1`,
        itemId: id,
        kind: 'item.created',
        source: 'system',
        summary: `History of ${id}`,
        occurredAt: found.createdAt,
        recordedAt: found.createdAt,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const calls = (fetchMock: ReturnType<typeof mockApi>, method?: string) =>
  fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === (method ?? 'GET'))
    .map(([url, init]) => ({ url, body: init?.body as string | undefined }));

async function inboxSocket(index = 0) {
  await waitFor(() => expect(FakeWebSocket.inboxes.length).toBeGreaterThan(index), { timeout: 3000 });
  return FakeWebSocket.inboxes[index];
}

function send(socket: FakeWebSocket, message: unknown) {
  act(() => socket.serverSend(message));
}

/** Renders the app, opens the Inbox tab, and lets the server say hello. */
async function openInbox() {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
  const socket = await inboxSocket();
  send(socket, { type: 'inbox.hello', data: { serverTime: new Date().toISOString() } });
  return socket;
}

const list = () => screen.findByRole('list', { name: 'Inbox items' });

async function rowTitles() {
  const rows = within(await list()).getAllByRole('button');
  return rows.map((row) => row.querySelector('.flex-1')?.textContent);
}

const row = (title: string) => screen.findByRole('button', { name: new RegExp(title) });

async function select(title: string) {
  await userEvent.click(await row(title));
  return within(screen.getByRole('region', { name: 'Item details' }));
}

describe('Inbox page', () => {
  beforeEach(() => {
    installBrowserFakes();
    window.location.hash = '';
    listed = [];
    summary = summaryOf();
    route = () => undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('loads, and shows what each item is about', async () => {
      listed = [
        pullRequestItem('pr', {
          pullRequest: { ...pullRequestItem('x').pullRequest!, draft: true, checksState: 'failing' },
        }),
        item('perm', { type: 'permission_request', title: 'Allow Bash?', sourceState: 'uncertain' }),
      ];
      const firstList = deferred<Reply>();
      route = (url) => (url === '/api/inbox?filter=all' ? firstList.promise : undefined);
      const fetchMock = mockApi();
      render(<App />);
      await userEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
      expect(screen.getByText('Loading the inbox…')).toBeInTheDocument();
      act(() => firstList.resolve({ status: 200, body: { items: [...listed] } }));
      const pr = within(await row('Pull request pr'));
      expect(pr.getByText('P2')).toBeInTheDocument();
      expect(pr.getByText('Pull request')).toBeInTheDocument();
      expect(pr.getByText('GitHub')).toBeInTheDocument();
      expect(pr.getByText('acme/api#42')).toBeInTheDocument();
      expect(pr.getByText('Open')).toBeInTheDocument();
      expect(pr.getByText('1h 0m ago')).toBeInTheDocument();
      expect(pr.getByText('Draft')).toBeInTheDocument();
      expect(pr.getByText('Checks failing')).toBeInTheDocument();

      const permission = within(await row('Allow Bash'));
      expect(permission.getByText('Permission request')).toBeInTheDocument();
      expect(permission.getByText('alpha')).toBeInTheDocument();
      expect(permission.getByText('Source uncertain')).toBeInTheDocument();
      expect(calls(fetchMock).map(({ url }) => url)).toEqual(
        expect.arrayContaining(['/api/inbox?filter=all', '/api/inbox/summary']),
      );
    });

    it('loads over REST even when the live connection never opens', async () => {
      listed = [item('a')];
      summary = summaryOf({ needsAttention: 3 });
      mockApi();
      render(<App />);
      await userEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
      act(() => FakeWebSocket.inboxes[0]?.serverClose(1006));
      expect(await row('Item a')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Inbox 3 open P1' })).toBeInTheDocument();
      expect(screen.getByText('Live updates disconnected. Reconnecting…')).toBeInTheDocument();
    });

    it('shows the open P1 count on the navigation tab', async () => {
      summary = summaryOf({ needsAttention: 4 });
      mockApi();
      await openInbox();
      expect(await screen.findByRole('button', { name: 'Inbox 4 open P1' })).toBeInTheDocument();
    });

    it('shows summary counts', async () => {
      mockApi();
      await openInbox();
      const strip = within(screen.getByRole('region', { name: 'Inbox summary' }));
      expect(await strip.findByText('PRs awaiting review')).toBeInTheDocument();
      expect(strip.getByText('3')).toBeInTheDocument();
      expect(strip.getByText(/Synced with GitHub/)).toBeInTheDocument();
    });

    it('sorts by priority, then actionability, then most recent activity', async () => {
      listed = [
        item('p3', { priority: 'P3', lastActivityAt: hoursAgo(0) }),
        item('p1-acknowledged', { priority: 'P1', status: 'acknowledged', lastActivityAt: hoursAgo(0) }),
        item('p2-old', { lastActivityAt: hoursAgo(9) }),
        item('p1-open', { priority: 'P1', lastActivityAt: hoursAgo(8) }),
        item('p2-new', { lastActivityAt: hoursAgo(2) }),
      ];
      mockApi();
      await openInbox();
      await waitFor(async () =>
        expect(await rowTitles()).toEqual([
          'Item p1-open',
          'Item p1-acknowledged',
          'Item p2-new',
          'Item p2-old',
          'Item p3',
        ]),
      );
    });

    it('has an empty state that names the filter', async () => {
      mockApi();
      await openInbox();
      expect(await screen.findByText('Nothing needs you right now.')).toBeInTheDocument();
    });

    it('shows the error when the inbox is unavailable', async () => {
      mockApi();
      route = (url) =>
        url.startsWith('/api/inbox?')
          ? { status: 503, body: { code: 'INBOX_UNAVAILABLE', message: 'The inbox database is unavailable.' } }
          : undefined;
      await openInbox();
      expect(await screen.findByText('The inbox database is unavailable.')).toBeInTheDocument();
    });

    it('renders untrusted text as plain text only', async () => {
      const hostile = '<img src=x onerror="alert(1)"> **bold** [link](https://evil.example)';
      listed = [item('x', { title: hostile, description: hostile })];
      mockApi();
      await openInbox();
      const details = await select('img src=x');
      expect(details.getByText(hostile, { selector: 'p' })).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
      expect(details.queryByRole('link')).not.toBeInTheDocument();
    });

    it('shows source metadata and history', async () => {
      listed = [pullRequestItem('pr')];
      mockApi();
      await openInbox();
      const details = await select('Pull request pr');
      expect(details.getByText('octocat')).toBeInTheDocument();
      expect(details.getByText('Review required')).toBeInTheDocument();
      expect(details.getByText('Discovered on GitHub')).toBeInTheDocument();
      expect(await details.findByText('History of pr')).toBeInTheDocument();
    });

    it('explains a pending permission request, since a denial sends no event', async () => {
      listed = [item('perm', { type: 'permission_request', title: 'Allow Bash?' })];
      mockApi();
      await openInbox();
      expect((await select('Allow Bash')).getByText(PENDING_PERMISSION_CAVEAT)).toBeInTheDocument();
    });

    it('explains an uncertain source state', async () => {
      listed = [item('lost', { sourceState: 'uncertain' })];
      mockApi();
      await openInbox();
      expect((await select('Item lost')).getByText(UNCERTAIN_EXPLANATION)).toBeInTheDocument();
    });
  });

  describe('filters', () => {
    it('requests the selected filter, priority and status', async () => {
      const fetchMock = mockApi();
      await openInbox();
      await screen.findByText('Nothing needs you right now.');
      await userEvent.click(screen.getByRole('tab', { name: 'Needs Attention' }));
      expect(screen.getByRole('tab', { name: 'Needs Attention' })).toHaveAttribute('aria-selected', 'true');
      await userEvent.selectOptions(screen.getByLabelText('Priority'), 'P1');
      await userEvent.selectOptions(screen.getByLabelText('Status'), 'open');
      await userEvent.click(screen.getByRole('tab', { name: 'Pull Requests' }));
      await waitFor(() =>
        expect(calls(fetchMock).map(({ url }) => url)).toEqual(
          expect.arrayContaining([
            '/api/inbox?filter=needs_attention',
            '/api/inbox?filter=needs_attention&priority=P1',
            '/api/inbox?filter=needs_attention&priority=P1&status=open',
            '/api/inbox?filter=pull_requests&priority=P1&status=open',
          ]),
        ),
      );
      expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
    });

    it('shows what the server returns for the filter', async () => {
      route = (url) =>
        url === '/api/inbox?filter=resolved'
          ? { status: 200, body: { items: [item('done', { status: 'resolved', resolution: 'auto_merged' })] } }
          : undefined;
      listed = [item('live')];
      mockApi();
      await openInbox();
      await row('Item live');
      await userEvent.click(screen.getByRole('tab', { name: 'Resolved' }));
      expect(await row('Item done')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Item live/ })).not.toBeInTheDocument();
    });
  });

  describe('links and navigation', () => {
    it('opens GitHub pull requests in a new tab without an opener', async () => {
      listed = [pullRequestItem('pr')];
      mockApi();
      await openInbox();
      const link = (await select('Pull request pr')).getByRole('link', { name: 'Open on GitHub' });
      expect(link).toHaveAttribute('href', 'https://github.com/acme/api/pull/42');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it.each([
      'http://github.com/acme/api/pull/42',
      'https://github.com.evil.example/acme/api/pull/42',
      'https://github.com@evil.example/pull/42',
      'javascript:alert(1)',
    ])('links nothing for %s', async (url) => {
      const base = pullRequestItem('pr');
      listed = [{ ...base, pullRequest: { ...base.pullRequest!, url } }];
      mockApi();
      await openInbox();
      expect((await select('Pull request pr')).queryByRole('link')).not.toBeInTheDocument();
    });

    it('opens the terminal of a running session through the session view', async () => {
      listed = [item('blocked')];
      mockApi();
      await openInbox();
      await screen.findByRole('list', { name: 'Sessions' });
      await userEvent.click((await select('Item blocked')).getByRole('button', { name: 'Open terminal' }));
      expect(window.location.hash).toBe('#/alpha');
      await waitFor(() => expect(FakeWebSocket.last?.url).toContain('/api/sessions/alpha/terminal'));
    });

    it('offers no terminal when the session is gone', async () => {
      listed = [item('orphan', { sourceSession: 'gone' })];
      mockApi();
      await openInbox();
      await screen.findByRole('list', { name: 'Sessions' });
      const details = await select('Item orphan');
      expect(details.getByText('(not running)')).toBeInTheDocument();
      expect(details.queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
    });
  });

  describe('narrow layout', () => {
    function stubMedia(matching: string[]) {
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({ matches: matching.includes(query), media: query })),
      );
    }

    function spyScroll() {
      const scrolled: { element: Element; options: unknown }[] = [];
      // jsdom has no layout, so no scrollIntoView either.
      HTMLElement.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
        scrolled.push({ element: this, options });
      };
      return scrolled;
    }

    afterEach(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    const STACKED = '(max-width: 767.98px)';
    const REDUCED = '(prefers-reduced-motion: reduce)';

    it('brings the details into view when stacked, and goes back to the item', async () => {
      stubMedia([STACKED]);
      const scrolled = spyScroll();
      listed = [item('a'), item('b', { lastActivityAt: hoursAgo(2) })];
      mockApi();
      await openInbox();
      const details = await select('Item b');
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0].element).toBe(screen.getByRole('region', { name: 'Item details' }));
      expect(scrolled[0].options).toEqual({ behavior: 'smooth', block: 'start' });

      await userEvent.click(details.getByRole('button', { name: 'Back to list' }));
      expect(scrolled).toHaveLength(2);
      expect(scrolled[1].element).toBe(await row('Item b'));
    });

    it('jumps without animation when reduced motion is preferred', async () => {
      stubMedia([STACKED, REDUCED]);
      const scrolled = spyScroll();
      listed = [item('a')];
      mockApi();
      await openInbox();
      await select('Item a');
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0].options).toEqual({ behavior: 'auto', block: 'start' });
    });

    it('does not scroll side by side', async () => {
      stubMedia([]);
      const scrolled = spyScroll();
      listed = [item('a')];
      mockApi();
      await openInbox();
      await select('Item a');
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(scrolled).toHaveLength(0);
    });
  });

  describe('actions', () => {
    it('acknowledges optimistically, then applies the server reply', async () => {
      listed = [item('a')];
      const reply = deferred<Reply>();
      route = (url, init) => (init?.method === 'POST' && url === '/api/inbox/a/acknowledge' ? reply.promise : undefined);
      mockApi();
      await openInbox();
      const details = await select('Item a');
      await userEvent.click(details.getByRole('button', { name: 'Acknowledge' }));
      expect(within(await row('Item a')).getByText('Acknowledged')).toBeInTheDocument();
      expect(details.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();

      act(() => reply.resolve({ status: 200, body: item('a', { status: 'acknowledged', revision: 2 }) }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(within(await row('Item a')).getByText('Acknowledged')).toBeInTheDocument();
    });

    it('rolls back a refused resolve and says why', async () => {
      listed = [item('a')];
      route = (url, init) =>
        init?.method === 'POST' && url === '/api/inbox/a/resolve'
          ? { status: 409, body: { code: 'INBOX_INVALID_TRANSITION', message: 'Cannot resolve.' } }
          : undefined;
      const fetchMock = mockApi();
      await openInbox();
      await userEvent.click((await select('Item a')).getByRole('button', { name: 'Resolve' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not resolve "Item a": Cannot resolve.');
      expect(within(await row('Item a')).getByText('Open')).toBeInTheDocument();
      expect(calls(fetchMock, 'POST').map(({ url }) => url)).toEqual(['/api/inbox/a/resolve']);

      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/Could not resolve/)).not.toBeInTheDocument();
    });

    it('reopens a resolved item', async () => {
      listed = [item('done', { status: 'resolved', resolution: 'manual', resolvedAt: hoursAgo(1) })];
      route = (url, init) =>
        init?.method === 'POST' && url === '/api/inbox/done/reopen'
          ? { status: 200, body: item('done', { revision: 2 }) }
          : undefined;
      mockApi();
      await openInbox();
      const details = await select('Item done');
      expect(details.getByText(/Resolved by you/)).toBeInTheDocument();
      await userEvent.click(details.getByRole('button', { name: 'Reopen' }));
      expect(within(await row('Item done')).getByText('Open')).toBeInTheDocument();
      expect(details.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    });

    it('rolls back a failed reopen', async () => {
      listed = [item('done', { status: 'resolved', resolution: 'manual', resolvedAt: hoursAgo(1) })];
      route = (url, init) => (init?.method === 'POST' ? { status: 500, body: { message: 'Boom.' } } : undefined);
      mockApi();
      await openInbox();
      await userEvent.click((await select('Item done')).getByRole('button', { name: 'Reopen' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not reopen');
      expect(within(await row('Item done')).getByText('Resolved')).toBeInTheDocument();
    });

    it('overrides the priority, re-sorts, and resets to the suggestion', async () => {
      const recent = hoursAgo(0.5);
      listed = [item('first', { priority: 'P1', suggestedPriority: 'P1' }), item('second', { lastActivityAt: recent })];
      const fetchMock = mockApi();
      route = (url, init) => {
        if (init?.method !== 'PATCH') return undefined;
        const { priority } = JSON.parse(init.body as string) as { priority: string | null };
        return {
          status: 200,
          body: item('second', {
            lastActivityAt: recent,
            priority: (priority ?? 'P2') as InboxItem['priority'],
            priorityOverridden: priority !== null,
            revision: priority === null ? 3 : 2,
          }),
        };
      };
      await openInbox();
      const details = await select('Item second');
      expect(details.getByText('Suggested: P2')).toBeInTheDocument();
      expect(details.queryByRole('button', { name: 'Reset to suggested' })).not.toBeInTheDocument();

      await userEvent.selectOptions(details.getByRole('combobox', { name: 'Priority' }), 'P1');
      await waitFor(async () => expect(await rowTitles()).toEqual(['Item second', 'Item first']));
      expect(within(await row('Item second')).getByText('Priority set manually')).toBeInTheDocument();

      await userEvent.click(details.getByRole('button', { name: 'Reset to suggested' }));
      await waitFor(async () => expect(await rowTitles()).toEqual(['Item first', 'Item second']));
      expect(calls(fetchMock, 'PATCH')).toEqual([
        { url: '/api/inbox/second', body: '{"priority":"P1"}' },
        { url: '/api/inbox/second', body: '{"priority":null}' },
      ]);
    });

    it('rolls back only what a failed action changed', async () => {
      listed = [item('a')];
      const priorityReply = deferred<Reply>();
      const acknowledgeReply = deferred<Reply>();
      route = (url, init) =>
        init?.method === 'PATCH'
          ? priorityReply.promise
          : init?.method === 'POST' && url === '/api/inbox/a/acknowledge'
            ? acknowledgeReply.promise
            : undefined;
      mockApi();
      await openInbox();
      const details = await select('Item a');
      await userEvent.selectOptions(details.getByRole('combobox', { name: 'Priority' }), 'P1');
      await userEvent.click(details.getByRole('button', { name: 'Acknowledge' }));
      expect(within(await row('Item a')).getByText('Acknowledged')).toBeInTheDocument();

      act(() => priorityReply.resolve({ status: 500, body: { message: 'Boom.' } }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the priority');
      expect(within(await row('Item a')).getByText('P2')).toBeInTheDocument();
      expect(within(await row('Item a')).getByText('Acknowledged')).toBeInTheDocument();

      act(() => acknowledgeReply.resolve({ status: 200, body: item('a', { status: 'acknowledged', revision: 2 }) }));
      expect(within(await row('Item a')).getByText('Acknowledged')).toBeInTheDocument();
    });

    it('rolls back a refused priority change', async () => {
      listed = [item('a')];
      route = (_url, init) =>
        init?.method === 'PATCH' ? { status: 400, body: { code: 'VALIDATION_FAILED', message: 'Nope.' } } : undefined;
      mockApi();
      await openInbox();
      const details = await select('Item a');
      await userEvent.selectOptions(details.getByRole('combobox', { name: 'Priority' }), 'P3');
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the priority of "Item a": Nope.');
      expect(within(await row('Item a')).getByText('P2')).toBeInTheDocument();
      expect(details.getByRole('combobox', { name: 'Priority' })).toHaveValue('P2');
    });
  });

  describe('realtime', () => {
    it('inserts created items in order, and replaces updated ones', async () => {
      listed = [item('p1', { priority: 'P1' }), item('p3', { priority: 'P3' })];
      mockApi();
      const socket = await openInbox();
      await row('Item p1');
      send(socket, { type: 'inbox.item.created', data: item('new', { lastActivityAt: hoursAgo(0) }) });
      expect(await rowTitles()).toEqual(['Item p1', 'Item new', 'Item p3']);

      send(socket, { type: 'inbox.item.updated', data: item('p3', { priority: 'P1', revision: 2, title: 'Escalated', lastActivityAt: hoursAgo(3) }) });
      expect(await rowTitles()).toEqual(['Item p1', 'Escalated', 'Item new']);
    });

    it('never shows the same item twice', async () => {
      listed = [item('a')];
      mockApi();
      const socket = await openInbox();
      await row('Item a');
      send(socket, { type: 'inbox.item.created', data: item('a', { revision: 2 }) });
      send(socket, { type: 'inbox.item.created', data: item('b', { lastActivityAt: hoursAgo(2) }) });
      send(socket, { type: 'inbox.item.created', data: item('b', { lastActivityAt: hoursAgo(2) }) });
      expect(await rowTitles()).toEqual(['Item a', 'Item b']);
    });

    it('ignores a message older than what it holds', async () => {
      listed = [item('a', { revision: 5, title: 'Current' })];
      mockApi();
      const socket = await openInbox();
      await row('Current');
      send(socket, { type: 'inbox.item.updated', data: item('a', { revision: 4, title: 'Stale' }) });
      send(socket, { type: 'inbox.item.updated', data: item('a', { revision: 5, title: 'Same revision' }) });
      expect(await rowTitles()).toEqual(['Current']);
    });

    it('keeps an update that arrives while the list is loading, if it is newer', async () => {
      const reply = deferred<Reply>();
      route = (url) => (url === '/api/inbox?filter=all' ? reply.promise : undefined);
      mockApi();
      const socket = await openInbox();
      send(socket, { type: 'inbox.item.updated', data: item('a', { revision: 3, title: 'Newer' }) });
      act(() => reply.resolve({ status: 200, body: { items: [item('a', { revision: 2, title: 'Older' })] } }));
      expect(await row('Newer')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Older/ })).not.toBeInTheDocument();
    });

    it('keeps a resolved item in All, and drops it from a filter it no longer matches', async () => {
      listed = [item('a', { priority: 'P1' }), item('b', { priority: 'P1' })];
      route = (url) => (url === '/api/inbox?filter=needs_attention' ? { status: 200, body: { items: [...listed] } } : undefined);
      mockApi();
      const socket = await openInbox();
      await row('Item a');
      const resolved = (id: string) => item(id, { priority: 'P1', status: 'resolved', resolvedAt: hoursAgo(0), revision: 2 });
      send(socket, { type: 'inbox.item.resolved', data: resolved('a') });
      expect(within(await row('Item a')).getByText('Resolved')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('tab', { name: 'Needs Attention' }));
      await row('Item b');
      send(socket, { type: 'inbox.item.resolved', data: resolved('b') });
      await waitFor(() => expect(screen.queryByRole('button', { name: /Item b/ })).not.toBeInTheDocument());
    });

    it('updates the badge after an item changes', async () => {
      mockApi();
      const socket = await openInbox();
      expect(await screen.findByRole('button', { name: 'Inbox 1 open P1' })).toBeInTheDocument();
      summary = summaryOf({ needsAttention: 2 });
      send(socket, { type: 'inbox.item.created', data: item('urgent', { priority: 'P1' }) });
      expect(await screen.findByRole('button', { name: 'Inbox 2 open P1' })).toBeInTheDocument();
    });

    it('refetches everything after reconnecting', async () => {
      listed = [item('a')];
      const fetchMock = mockApi();
      const first = await openInbox();
      await row('Item a');
      const listCalls = () => calls(fetchMock).filter(({ url }) => url.startsWith('/api/inbox?')).length;
      expect(listCalls()).toBe(2);

      act(() => first.serverClose(1006));
      expect(await screen.findByText('Live updates disconnected. Reconnecting…')).toBeInTheDocument();
      expect(await row('Item a')).toBeInTheDocument();

      listed = [item('b', { title: 'Missed while away' })];
      const second = await inboxSocket(1);
      send(second, { type: 'inbox.hello', data: { serverTime: '' } });
      expect(await row('Missed while away')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Item a/ })).not.toBeInTheDocument();
      expect(listCalls()).toBe(3);
      expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    });

    it('ignores malformed messages', async () => {
      listed = [item('a')];
      mockApi();
      const socket = await openInbox();
      await row('Item a');
      act(() => {
        socket.onmessage?.({ data: 'not json' });
        socket.onmessage?.({ data: 'null' });
        socket.serverSend({ type: 'inbox.item.created' });
        socket.serverSend({ type: 'other', data: item('x') });
      });
      expect(await rowTitles()).toEqual(['Item a']);
    });
  });

  describe('GitHub sync', () => {
    it('says when GitHub is not configured, and disables Sync now', async () => {
      summary = summaryOf({
        github: { ...github, configured: false, configurationProblem: 'ECC_GITHUB_REPOS is empty.' },
      });
      mockApi();
      await openInbox();
      expect(await screen.findByText('GitHub sync is not configured: ECC_GITHUB_REPOS is empty.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    });

    it('shows a rate limit', async () => {
      const until = new Date(Date.now() + 600_000).toISOString();
      summary = summaryOf({ github: { ...github, rateLimitedUntil: until } });
      mockApi();
      await openInbox();
      expect(await screen.findByText(/GitHub rate limit reached. Paused until/)).toBeInTheDocument();
    });

    it('shows sync failures, globally and per repository', async () => {
      summary = summaryOf({
        github: {
          ...github,
          lastError: 'Bad credentials.',
          repositories: [{ ...github.repositories[0], lastError: 'Not found.' }],
        },
      });
      mockApi();
      await openInbox();
      expect(await screen.findByText('Last GitHub sync failed: Bad credentials.')).toBeInTheDocument();
      expect(screen.getByText('acme/api: Not found.')).toBeInTheDocument();
    });

    it.each([
      ['after a sync', 'acme/api: Not found.'],
      ['after a restart', 'Not found.'],
    ])('shows a single repository failure once, %s', async (_when, globalError) => {
      summary = summaryOf({
        github: { ...github, lastError: globalError, repositories: [{ ...github.repositories[0], lastError: 'Not found.' }] },
      });
      mockApi();
      await openInbox();
      await screen.findByText(`Last GitHub sync failed: ${globalError}`);
      expect(screen.getAllByText(/Not found\./)).toHaveLength(1);
    });

    it('updates sync health from sync messages', async () => {
      mockApi();
      const socket = await openInbox();
      await screen.findByText(/Synced with GitHub/);
      send(socket, { type: 'inbox.sync.completed', data: { ...github, lastError: 'Timed out.' } });
      expect(await screen.findByText('Last GitHub sync failed: Timed out.')).toBeInTheDocument();
    });

    it('syncs now, and shows the running state it returns', async () => {
      const reply = deferred<Reply>();
      route = (url, init) => (init?.method === 'POST' && url === '/api/inbox/sync/github' ? reply.promise : undefined);
      const fetchMock = mockApi();
      await openInbox();
      await screen.findByText(/Synced with GitHub/);
      await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
      expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
      act(() => reply.resolve({ status: 202, body: { ...github, running: true } }));
      expect(await screen.findByText('Syncing with GitHub…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
      expect(calls(fetchMock, 'POST').map(({ url }) => url)).toEqual(['/api/inbox/sync/github']);
    });

    it('says when a sync is already running', async () => {
      route = (_url, init) =>
        init?.method === 'POST' ? { status: 409, body: { code: 'GITHUB_SYNC_RUNNING', message: 'Busy.' } } : undefined;
      mockApi();
      await openInbox();
      await screen.findByText(/Synced with GitHub/);
      await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('A GitHub sync is already running.');
    });
  });

  it('closes the inbox socket on unmount, and does not reconnect', async () => {
    mockApi();
    const view = render(<App />);
    const socket = await inboxSocket();
    view.unmount();
    expect(socket.closeCalls).toBe(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(FakeWebSocket.inboxes).toHaveLength(1);
  });
});
