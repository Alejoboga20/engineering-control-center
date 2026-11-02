import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { TERMINAL_LIMITS, TerminalCloseCode } from '@ecc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from '../components/TerminalView';
import { chunkInput } from '../services/terminal-socket';
import { FakeWebSocket, installBrowserFakes, terminals } from '../test/fakes';
import { RETRY_DELAYS_MS } from './useTerminal';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('../test/fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const noop = () => {};

async function mount(onSessionEnded: () => void = noop) {
  const view = render(
    <TerminalView session="alpha" onTerminate={noop} onSessionEnded={onSessionEnded} />,
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  return view;
}

const status = () => screen.getByRole('status');
const parseSent = (socket: FakeWebSocket) => socket.sent.map((raw) => JSON.parse(raw));

describe('terminal connection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installBrowserFakes();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('moves from connecting to connected, and enables input', async () => {
    await mount();
    expect(status()).toHaveTextContent('Connecting');
    expect(FakeWebSocket.last.url).toMatch(/\/api\/sessions\/alpha\/terminal\?cols=80&rows=24$/);

    act(() => FakeWebSocket.last.serverReady());
    expect(status()).toHaveTextContent('Connected');
    expect(terminals[0].focus).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('never opens a competing socket under StrictMode double mounting', async () => {
    render(
      <StrictMode>
        <TerminalView session="alpha" onTerminate={noop} onSessionEnded={noop} />
      </StrictMode>,
    );
    await act(() => vi.advanceTimersByTimeAsync(5));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('sends keystrokes and resizes, and writes binary output', async () => {
    await mount();
    const socket = FakeWebSocket.last;
    act(() => socket.serverReady());
    socket.sent.length = 0;

    act(() => terminals[0].type('claude\r'));
    act(() => terminals[0].emitResize(120, 40));
    expect(parseSent(socket)).toEqual([
      { type: 'input', data: 'claude\r' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);

    const bytes = new Uint8Array([104, 105]);
    act(() => socket.serverOutput(bytes));
    expect(Array.from(terminals[0].writes[0])).toEqual([104, 105]);
  });

  it('retries automatically after a dropped connection, reusing the terminal', async () => {
    await mount();
    const first = FakeWebSocket.last;
    act(() => first.serverReady());

    act(() => first.serverClose(1006));
    expect(status()).toHaveTextContent('Reconnecting');
    expect(terminals[0].options.disableStdin).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] + 1));
    const second = FakeWebSocket.last;
    expect(second).not.toBe(first);
    expect(second.url).toContain('/api/sessions/alpha/terminal');

    act(() => second.serverReady());
    expect(status()).toHaveTextContent('Connected');
    expect(terminals).toHaveLength(1);
    expect(terminals[0].resets).toBe(2); // tmux repaints the screen on every attach.
    expect(terminals[0].options.disableStdin).toBe(false);
  });

  it('stops retrying eventually, and offers a manual reconnect', async () => {
    await mount();
    for (const delay of RETRY_DELAYS_MS) {
      act(() => FakeWebSocket.last.serverClose(1006));
      await act(() => vi.advanceTimersByTimeAsync(delay + 1));
    }
    const countBeforeGivingUp = FakeWebSocket.instances.length;
    act(() => FakeWebSocket.last.serverClose(1006));
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(FakeWebSocket.instances).toHaveLength(countBeforeGivingUp);
    expect(status()).toHaveTextContent('Disconnected');
    expect(screen.getByRole('alert')).toHaveTextContent('keeps running in tmux');

    await act(async () => {
      screen.getByRole('button', { name: 'Reconnect' }).click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(countBeforeGivingUp + 1);
  });

  it('shows the busy message and does not retry by itself', async () => {
    await mount();
    act(() => {
      FakeWebSocket.last.serverSend({
        type: 'error',
        code: 'SESSION_BUSY',
        message: 'Session "alpha" is already open in another browser tab.',
      });
      FakeWebSocket.last.serverClose(TerminalCloseCode.SessionBusy);
    });
    expect(status()).toHaveTextContent('In use elsewhere');
    expect(screen.getByRole('alert')).toHaveTextContent('already open in another');
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('reports an ended session, with nothing to reconnect to', async () => {
    const onEnded = vi.fn();
    await mount(onEnded);
    act(() => FakeWebSocket.last.serverReady());
    act(() => {
      FakeWebSocket.last.serverSend({ type: 'exit', reason: 'session-ended', message: 'Gone.' });
      FakeWebSocket.last.serverClose(TerminalCloseCode.SessionEnded);
    });
    expect(status()).toHaveTextContent('Session ended');
    expect(onEnded).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('disconnects on request without retrying, and reconnects without creating anything', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await mount();
    const first = FakeWebSocket.last;
    act(() => first.serverReady());

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(first.closeCalls).toBe(1);
    expect(status()).toHaveTextContent('Disconnected');
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(FakeWebSocket.instances).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(FakeWebSocket.last.url).toContain('/api/sessions/alpha/terminal');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('releases the socket and terminal on unmount without reconnecting', async () => {
    const { unmount } = await mount();
    const socket = FakeWebSocket.last;
    act(() => socket.serverReady());
    unmount();
    expect(socket.closeCalls).toBe(1);
    expect(terminals[0].disposed).toBe(true);
    socket.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('turns wheel movement into coalesced scroll messages', async () => {
    await mount();
    const socket = FakeWebSocket.last;
    act(() => socket.serverReady());
    socket.sent.length = 0;
    const wheel = (deltaY: number) =>
      terminals[0].wheelHandler!(new WheelEvent('wheel', { deltaY, deltaMode: 0 }));
    expect(wheel(-36)).toBe(false);
    wheel(-36);
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(parseSent(socket)).toEqual([{ type: 'scroll', lines: -4 }]);
  });

  it('leaves Ctrl+C to the terminal, and handles Ctrl+Shift+C as copy', async () => {
    await mount();
    const handler = terminals[0].keyHandler!;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    terminals[0].hasSelection.mockReturnValue(true);
    terminals[0].getSelection.mockReturnValue('selected');

    expect(handler(new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    const copy = new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(handler(copy)).toBe(false);
    expect(writeText).toHaveBeenCalledWith('selected');
    expect(handler(new KeyboardEvent('keydown', { code: 'KeyV', ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe('chunkInput', () => {
  it('splits large pastes without exceeding the limit or losing data', () => {
    const text = 'x'.repeat(TERMINAL_LIMITS.maxInputChunk * 2 + 5);
    const chunks = chunkInput(text);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= TERMINAL_LIMITS.maxInputChunk)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('keeps surrogate pairs together', () => {
    const chunks = chunkInput('ab😀cd', 3);
    expect(chunks.join('')).toBe('ab😀cd');
    expect(chunks[0]).toBe('ab');
    expect(chunks[1]).toBe('😀c');
  });
});
