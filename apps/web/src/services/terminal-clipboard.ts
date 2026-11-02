import type { Terminal } from '@xterm/xterm';

const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

/**
 * tmux passes mouse tracking through to the terminal, and with it on, xterm.js sends drags to the
 * application instead of selecting text. Ignoring those requests keeps drag-to-select working
 * everywhere. Wheel events do not depend on them, because they reach the application through
 * `scroll` messages.
 */
export function isMouseTrackingRequest(params: (number | number[])[]): boolean {
  return params.length > 0 && params.every((p) => MOUSE_TRACKING_MODES.has(Number(p)));
}

/** Returns the text of an OSC 52 clipboard write, or null for reads and malformed payloads. */
export function decodeOsc52(data: string): string | null {
  const encoded = data.slice(data.indexOf(';') + 1);
  if (!data.includes(';') || encoded === '' || encoded === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function copyToClipboard(text: string): void {
  // The Clipboard API exists only on HTTPS and localhost, and can reject without page focus.
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function attachClipboard(term: Terminal): void {
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, isMouseTrackingRequest);

  // Delivers copies made by tmux and by applications, such as Claude Code's /copy. Writes only:
  // reads are refused, so that programs in the terminal cannot see the browser's clipboard.
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text !== null) copyToClipboard(text);
    return true;
  });

  // Ctrl+Shift+C and Ctrl+Shift+V, since plain Ctrl+C belongs to the application in the terminal.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
    if (event.code === 'KeyC') {
      event.preventDefault();
      if (term.hasSelection()) copyToClipboard(term.getSelection());
      return false;
    }
    // Returning false leaves the browser to fire the paste event, which xterm.js handles.
    return event.code !== 'KeyV';
  });
}
