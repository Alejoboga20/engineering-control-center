import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCloseCode, type ClaudeSessionStatus } from '@ecc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { FakeWebSocket, installBrowserFakes } from './test/fakes';
import { alpha, beta, projects, stats } from './test/fixtures';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./test/fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;

function mockApi(sessions: unknown[], handler: Handler = () => undefined) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const reply =
      handler(url, init) ??
      (url === '/api/sessions'
        ? { status: 200, body: [...sessions] }
        : url === '/api/system/stats'
          ? { status: 200, body: stats }
          : url === '/api/projects'
            ? { status: 200, body: projects }
            : { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } });
    return {
      status: reply.status,
      ok: reply.status < 400,
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openedSocket() {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  return FakeWebSocket.last;
}

describe('App', () => {
  beforeEach(() => {
    installBrowserFakes();
    window.location.hash = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('session list', () => {
    it('shows a loading state, and then the sessions', async () => {
      mockApi([alpha, beta]);
      render(<App />);
      expect(screen.getByText('Loading sessions…')).toBeInTheDocument();
      const list = await screen.findByRole('list', { name: 'Sessions' });
      expect(within(list).getByText('alpha')).toBeInTheDocument();
      expect(within(list).getByText('beta')).toBeInTheDocument();
      expect(within(list).getByText(/3 windows · 1 attached/)).toBeInTheDocument();
    });

    it('shows an empty state', async () => {
      mockApi([]);
      render(<App />);
      expect(await screen.findByText('No tmux sessions yet.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create a session' })).toBeInTheDocument();
    });

    it('shows the API error message', async () => {
      mockApi([], (url) =>
        url === '/api/sessions'
          ? { status: 503, body: { code: 'TMUX_UNAVAILABLE', message: 'tmux is not installed.' } }
          : undefined,
      );
      render(<App />);
      expect(await screen.findByText('tmux is not installed.')).toBeInTheDocument();
    });

    it('shows an error when the server cannot be reached', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      render(<App />);
      expect((await screen.findAllByText('Cannot reach the server.')).length).toBeGreaterThan(0);
      expect(screen.getByText('Server unreachable')).toBeInTheDocument();
    });

    it('disables sessions whose names the dashboard cannot manage', async () => {
      mockApi([{ ...alpha, name: 'has space', manageable: false }]);
      render(<App />);
      const item = await screen.findByRole('button', { name: /has space/ });
      expect(item).toBeDisabled();
    });
  });

  describe('session selection', () => {
    it('opens a terminal for the selected session and moves when switching', async () => {
      mockApi([alpha, beta]);
      render(<App />);
      await userEvent.click(await screen.findByRole('button', { name: /alpha/ }));
      const first = await openedSocket();
      expect(first.url).toContain('/api/sessions/alpha/terminal');
      expect(screen.getByRole('heading', { name: 'alpha' })).toBeInTheDocument();
      expect(window.location.hash).toBe('#/alpha');

      await userEvent.click(screen.getByRole('button', { name: /beta/ }));
      await waitFor(() => expect(FakeWebSocket.last.url).toContain('/api/sessions/beta/terminal'));
      expect(first.closeCalls).toBe(1);
    });

    it('restores the selected session from the URL', async () => {
      window.location.hash = '#/beta';
      mockApi([alpha, beta]);
      render(<App />);
      expect((await openedSocket()).url).toContain('/api/sessions/beta/terminal');
    });
  });

  describe('session creation', () => {
    const openDialog = async () => {
      await userEvent.click(await screen.findByRole('button', { name: 'New session' }));
      return screen.findByRole('dialog', { name: 'New session' });
    };

    it('creates a session, refreshes the list, and opens its terminal', async () => {
      const sessions = [alpha];
      const fetchMock = mockApi(sessions, (url, init) => {
        if (url === '/api/sessions' && init?.method === 'POST') {
          sessions.push({ ...alpha, name: 'payroll' });
          return { status: 201, body: { ...alpha, name: 'payroll' } };
        }
        return undefined;
      });
      render(<App />);
      const dialog = await openDialog();
      await screen.findByText(/Must be inside: \/home\/dev\/projects/);

      await userEvent.type(within(dialog).getByLabelText('Session name'), 'payroll');
      await userEvent.type(
        within(dialog).getByLabelText('Working directory'),
        '/home/dev/projects/payroll',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(post![1]!.body as string)).toEqual({
        name: 'payroll',
        workingDirectory: '/home/dev/projects/payroll',
      });
      expect(await screen.findByRole('button', { name: /payroll/ })).toBeInTheDocument();
      expect((await openedSocket()).url).toContain('/api/sessions/payroll/terminal');
    });

    it('validates the name before allowing submission', async () => {
      mockApi([]);
      render(<App />);
      const dialog = await openDialog();
      await userEvent.type(within(dialog).getByLabelText('Session name'), 'bad name;');
      await userEvent.type(within(dialog).getByLabelText('Working directory'), '/x');
      expect(within(dialog).getByText(/Use 1-64 letters/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    });

    it('keeps the dialog open and shows the server error on failure', async () => {
      mockApi([], (url, init) =>
        init?.method === 'POST'
          ? {
              status: 403,
              body: {
                code: 'WORKING_DIRECTORY_NOT_ALLOWED',
                message: 'Working directory is outside the configured project roots.',
              },
            }
          : undefined,
      );
      render(<App />);
      const dialog = await openDialog();
      await userEvent.type(within(dialog).getByLabelText('Session name'), 'alpha');
      await userEvent.type(within(dialog).getByLabelText('Working directory'), '/etc');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('outside the configured');
      expect(FakeWebSocket.instances).toHaveLength(0);
    });
  });

  describe('session termination', () => {
    it('only deletes after explicit confirmation, with a warning', async () => {
      const sessions = [alpha];
      const fetchMock = mockApi(sessions, (url, init) => {
        if (init?.method === 'DELETE') {
          sessions.length = 0;
          return { status: 204 };
        }
        return undefined;
      });
      const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
      render(<App />);
      await userEvent.click(await screen.findByRole('button', { name: /alpha/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Terminate' }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('may stop Claude Code');
      expect(deletes()).toHaveLength(0);

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(deletes()).toHaveLength(0);

      await userEvent.click(screen.getByRole('button', { name: 'Terminate' }));
      await userEvent.click(screen.getByRole('button', { name: 'Terminate session' }));
      await waitFor(() => expect(deletes()).toHaveLength(1));
      expect(deletes()[0][0]).toBe('/api/sessions/alpha');
      expect(await screen.findByText('No tmux sessions yet.')).toBeInTheDocument();
    });
  });

  it('shows system statistics in the top bar and on the server page', async () => {
    mockApi([]);
    render(<App />);
    expect(await screen.findByRole('meter', { name: 'RAM' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('meter', { name: 'Disk' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('Server online')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('1d 1h')).toBeInTheDocument();
  });

  describe('Claude Code status', () => {
    const working: ClaudeSessionStatus = {
      tmuxSession: 'alpha',
      state: 'working',
      monitored: true,
      reason: null,
      instanceCount: 1,
      claudeSessionId: 'claude-1',
      lastEvent: 'UserPromptSubmit',
      lastEventAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    async function monitorSocket(index = 0) {
      await waitFor(() => expect(FakeWebSocket.monitors.length).toBeGreaterThan(index), {
        timeout: 3000,
      });
      return FakeWebSocket.monitors[index];
    }

    function snapshot(socket: FakeWebSocket, sessions: ClaudeSessionStatus[], ingestion = true) {
      act(() =>
        socket.serverSend({
          type: 'claude.status.snapshot',
          data: { ingestionAvailable: ingestion, sessions },
        }),
      );
    }

    function changed(socket: FakeWebSocket, status: ClaudeSessionStatus) {
      act(() => socket.serverSend({ type: 'claude.status.changed', data: status }));
    }

    async function sessionRow(name: RegExp) {
      return within(await screen.findByRole('button', { name }));
    }

    it.each([
      ['working', 'Working'],
      ['needs_attention', 'Needs Attention'],
      ['idle', 'Idle'],
      ['offline', 'Offline'],
      ['unknown', 'Unknown'],
    ] as const)('labels the %s state in text', async (state, label) => {
      mockApi([alpha]);
      render(<App />);
      snapshot(await monitorSocket(), [{ ...working, state }]);
      expect((await sessionRow(/alpha/)).getByText(label)).toBeInTheDocument();
    });

    it('shows Unknown before any status arrives, and for sessions without one', async () => {
      mockApi([alpha, beta]);
      render(<App />);
      const row = await sessionRow(/beta/);
      expect(row.getByText('Unknown')).toBeInTheDocument();
      snapshot(await monitorSocket(), [working]);
      expect((await sessionRow(/beta/)).getByText('Unknown')).toBeInTheDocument();
    });

    it('never infers activity from tmux attachment', async () => {
      mockApi([{ ...alpha, attachedClients: 3 }]);
      render(<App />);
      snapshot(await monitorSocket(), []);
      expect((await sessionRow(/alpha/)).getByText('Unknown')).toBeInTheDocument();
    });

    it('updates a session immediately when a status event arrives', async () => {
      mockApi([alpha, beta]);
      render(<App />);
      const socket = await monitorSocket();
      snapshot(socket, [working]);
      expect((await sessionRow(/alpha/)).getByText('Working')).toBeInTheDocument();
      changed(socket, { ...working, state: 'needs_attention', lastEvent: 'PermissionRequest' });
      expect((await sessionRow(/alpha/)).getByText('Needs Attention')).toBeInTheDocument();
      expect((await sessionRow(/beta/)).getByText('Unknown')).toBeInTheDocument();
    });

    it('ignores malformed messages', async () => {
      mockApi([alpha]);
      render(<App />);
      const socket = await monitorSocket();
      snapshot(socket, [working]);
      act(() => {
        socket.onmessage?.({ data: 'not json' });
        socket.onmessage?.({ data: new ArrayBuffer(1) });
        socket.serverSend({ type: 'something.else', data: {} });
      });
      expect((await sessionRow(/alpha/)).getByText('Working')).toBeInTheDocument();
    });

    it('drops to Unknown on disconnect, rather than showing a stale state', async () => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      const socket = await monitorSocket();
      snapshot(socket, [working]);
      expect((await sessionRow(/alpha/)).getByText('Working')).toBeInTheDocument();
      act(() => socket.serverClose(1006));
      expect((await sessionRow(/alpha/)).getByText('Unknown')).toBeInTheDocument();
      expect(screen.getByText(/live connection to the server was lost/)).toBeInTheDocument();
    });

    it('reconnects, and lets the new snapshot replace everything', async () => {
      mockApi([alpha, beta]);
      render(<App />);
      const first = await monitorSocket();
      snapshot(first, [working, { ...working, tmuxSession: 'beta', state: 'idle' }]);
      act(() => first.serverClose(1006));

      const second = await monitorSocket(1);
      snapshot(second, [{ ...working, state: 'idle' }]);
      expect((await sessionRow(/alpha/)).getByText('Idle')).toBeInTheDocument();
      expect((await sessionRow(/beta/)).getByText('Unknown')).toBeInTheDocument();
    });

    it('leaves the terminal connection alone when a status event arrives', async () => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      const terminal = await openedSocket();
      act(() => terminal.serverReady());
      changed(await monitorSocket(), working);
      expect(await screen.findByLabelText('Claude Code status')).toHaveTextContent('Working');
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(terminal.closeCalls).toBe(0);
    });

    it('shows state, last event, activity and availability for the selected session', async () => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      snapshot(await monitorSocket(), [working]);
      const details = within(await screen.findByLabelText('Claude Code status'));
      expect(details.getByText('Working')).toBeInTheDocument();
      expect(details.getByText('Last event: UserPromptSubmit')).toBeInTheDocument();
      expect(details.getByText('Last activity: just now')).toBeInTheDocument();
      expect(details.getByText('Monitoring: active')).toBeInTheDocument();
    });

    it.each([
      [{ state: 'unknown', monitored: false, reason: 'no-events' }, /ECC_TMUX_SESSION=alpha claude/],
      [{ state: 'unknown', reason: 'stale' }, /no longer reliable/],
      [{ state: 'unknown', reason: 'insufficient-events' }, /do not establish a state/],
      [{ state: 'unknown', reason: 'multiple-instances', instanceCount: 2 }, /2 Claude Code instances/],
      [{ state: 'needs_attention' }, /may already be resolved/],
    ] as const)('explains %j', async (fields, explanation) => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      snapshot(await monitorSocket(), [{ ...working, ...fields }]);
      expect(await screen.findByText(explanation)).toBeInTheDocument();
    });

    it('says that monitoring is not available for a session with no events', async () => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      snapshot(await monitorSocket(), []);
      expect(await screen.findByText('Monitoring: not available')).toBeInTheDocument();
    });

    it('explains when the server cannot accept events at all', async () => {
      window.location.hash = '#/alpha';
      mockApi([alpha]);
      render(<App />);
      snapshot(await monitorSocket(), [], false);
      expect(await screen.findByText(/could not prepare its hook credentials/)).toBeInTheDocument();
    });

    it('closes the monitor socket on unmount, and does not reconnect', async () => {
      mockApi([alpha]);
      const view = render(<App />);
      const socket = await monitorSocket();
      view.unmount();
      expect(socket.closeCalls).toBe(1);
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(FakeWebSocket.monitors).toHaveLength(1);
    });
  });

  it('refreshes the list when an attached session ends', async () => {
    window.location.hash = '#/alpha';
    const sessions = [alpha];
    mockApi(sessions);
    render(<App />);
    const socket = await openedSocket();
    act(() => socket.serverReady());
    sessions.length = 0;
    act(() => {
      socket.serverSend({ type: 'exit', reason: 'session-ended', message: 'Session ended now.' });
      socket.serverClose(TerminalCloseCode.SessionEnded);
    });
    expect(await screen.findByText('No tmux sessions yet.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Session ended now.');
  });
});
