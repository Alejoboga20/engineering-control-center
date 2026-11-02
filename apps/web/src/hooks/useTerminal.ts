import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { TERMINAL_LIMITS, TerminalCloseCode } from '@ecc/shared';
import { attachClipboard } from '../services/terminal-clipboard';
import {
  chunkInput,
  parseServerMessage,
  sendMessage,
  terminalUrl,
} from '../services/terminal-socket';

export type TerminalStatus =
  | 'connecting'
  | 'connected'
  /** The connection dropped and another attempt is scheduled. */
  | 'reconnecting'
  /** Not connected. The user can reconnect. */
  | 'disconnected'
  /** Another tab or window holds the session. The user can retry. */
  | 'busy'
  /** The session no longer exists, so there is nothing to reconnect to. */
  | 'ended';

export interface TerminalState {
  status: TerminalStatus;
  message: string | null;
}

export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const WHEEL_FLUSH_MS = 50;
const PIXELS_PER_LINE = 18;

const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

/**
 * Owns one xterm.js instance and its WebSocket for the lifetime of the selected session.
 * Reconnecting replaces only the socket. tmux redraws the whole screen on attach, so no output
 * needs to be stored or replayed.
 */
export function useTerminal(
  session: string,
  containerRef: RefObject<HTMLElement | null>,
  onSessionEnded?: () => void,
) {
  const [state, setState] = useState<TerminalState>({ status: 'connecting', message: null });
  const controls = useRef({ reconnect: () => {}, disconnect: () => {} });
  const onEnded = useRef(onSessionEnded);
  onEnded.current = onSessionEnded;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      scrollback: 1000,
      macOptionIsMeta: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    attachClipboard(term);

    const safeFit = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // The renderer may not be measurable yet. The next resize corrects it.
        }
      }
    };
    safeFit();

    let socket: WebSocket | null = null;
    let disposed = false;
    let attempts = 0;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleConnect = (delay: number) => {
      clearTimeout(connectTimer);
      connectTimer = setTimeout(connect, delay);
    };

    function connect() {
      socket?.close();
      setState({ status: attempts > 0 ? 'reconnecting' : 'connecting', message: null });
      const ws = new WebSocket(terminalUrl(session, term.cols, term.rows));
      ws.binaryType = 'arraybuffer';
      socket = ws;
      let lastServerMessage: string | null = null;

      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (ws !== socket) return;
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data));
          return;
        }
        const message = parseServerMessage(event.data);
        if (message?.type === 'ready') {
          attempts = 0;
          term.reset();
          term.options.disableStdin = false;
          setState({ status: 'connected', message: null });
          // The layout may have changed since the URL was built.
          safeFit();
          sendMessage(ws, { type: 'resize', cols: term.cols, rows: term.rows });
          term.focus();
        } else if (message?.type === 'exit' || message?.type === 'error') {
          lastServerMessage = message.message;
        }
      };

      ws.onclose = (event) => {
        if (ws !== socket || disposed) return;
        socket = null;
        term.options.disableStdin = true;

        switch (event.code) {
          case TerminalCloseCode.SessionBusy:
            setState({ status: 'busy', message: lastServerMessage });
            return;
          case TerminalCloseCode.SessionEnded:
          case TerminalCloseCode.SessionNotFound:
          case TerminalCloseCode.InvalidSession:
            setState({ status: 'ended', message: lastServerMessage });
            onEnded.current?.();
            return;
          case TerminalCloseCode.Detached:
          case TerminalCloseCode.InputLimitExceeded:
          case TerminalCloseCode.AttachFailed:
            setState({ status: 'disconnected', message: lastServerMessage });
            return;
        }

        // Anything else is a dropped connection, such as a backend restart or a broken tunnel.
        if (attempts < RETRY_DELAYS_MS.length) {
          setState({ status: 'reconnecting', message: 'Connection lost. Reconnecting.' });
          scheduleConnect(RETRY_DELAYS_MS[attempts++]);
        } else {
          setState({
            status: 'disconnected',
            message: 'Connection lost. The session keeps running in tmux.',
          });
        }
      };
    }

    const inputSubscription = term.onData((data) => {
      for (const chunk of chunkInput(data)) sendMessage(socket, { type: 'input', data: chunk });
    });
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      sendMessage(socket, { type: 'resize', cols, rows });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(safeFit, 60);
    });
    observer.observe(container);

    let pendingPixels = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    const flushWheel = () => {
      wheelTimer = undefined;
      const lines = Math.trunc(pendingPixels / PIXELS_PER_LINE);
      if (lines === 0) return;
      pendingPixels -= lines * PIXELS_PER_LINE;
      const max = TERMINAL_LIMITS.maxScrollLines;
      sendMessage(socket, { type: 'scroll', lines: Math.max(-max, Math.min(max, lines)) });
    };
    term.attachCustomWheelEventHandler((event) => {
      pendingPixels += event.deltaMode === 1 ? event.deltaY * PIXELS_PER_LINE : event.deltaY;
      wheelTimer ??= setTimeout(flushWheel, WHEEL_FLUSH_MS);
      return false;
    });

    controls.current = {
      reconnect: () => {
        attempts = 0;
        scheduleConnect(0);
      },
      disconnect: () => {
        clearTimeout(connectTimer);
        const ws = socket;
        socket = null;
        ws?.close();
        term.options.disableStdin = true;
        setState({
          status: 'disconnected',
          message: 'Disconnected. The session keeps running in tmux.',
        });
      },
    };

    // Deferred so that React StrictMode's mount, unmount, mount never opens a socket that would
    // compete with the second mount for the session's single attachment.
    scheduleConnect(0);

    return () => {
      disposed = true;
      clearTimeout(connectTimer);
      clearTimeout(resizeTimer);
      clearTimeout(wheelTimer);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      socket?.close();
      socket = null;
      term.dispose();
    };
  }, [session, containerRef]);

  const reconnect = useCallback(() => controls.current.reconnect(), []);
  const disconnect = useCallback(() => controls.current.disconnect(), []);

  return { ...state, reconnect, disconnect };
}
