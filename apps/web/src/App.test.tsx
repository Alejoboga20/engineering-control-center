import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCloseCode } from '@ecc/shared';
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
