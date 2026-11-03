import type { Terminal } from '@xterm/xterm';

/**
 * xterm.js sends the same carriage return for Enter and Shift+Enter, so an application cannot tell
 * them apart. Sends ESC CR instead, the sequence Claude Code documents for terminals where it sets
 * up Shift+Enter itself. It passes through tmux unchanged. Claims every event type of the key,
 * because xterm.js would otherwise send a carriage return as well on keypress.
 */
export function handleShiftEnter(term: Terminal, event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  if (event.type === 'keydown') {
    event.preventDefault();
    term.input('\x1b\r', true);
  }
  return true;
}
