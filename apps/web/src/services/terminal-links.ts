import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal } from '@xterm/xterm';

/** Only web pages open. Programs can print anything, including javascript: and file: links. */
export function isOpenableUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Opens in a new tab that gets no handle on the dashboard and no referrer from it. */
export function openLink(uri: string): void {
  if (isOpenableUrl(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
}

/**
 * Makes links in the terminal open on click: URLs found in the text, and OSC 8 hyperlinks, whose
 * visible text can differ from their target. Hovering shows the real target as a tooltip.
 */
export function attachLinks(term: Terminal): void {
  const hover = (_event: MouseEvent, uri: string) => {
    if (term.element) term.element.title = uri;
  };
  const leave = () => {
    term.element?.removeAttribute('title');
  };
  // xterm.js also activates a link when a drag starts and ends on it, which is a text selection.
  const activate = (_event: MouseEvent, uri: string) => {
    if (!term.hasSelection()) openLink(uri);
  };

  term.options.linkHandler = { activate, hover, leave };
  term.loadAddon(new WebLinksAddon(activate, { hover, leave }));
}
