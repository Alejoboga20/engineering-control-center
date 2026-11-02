import { TERMINAL_LIMITS, type ClientMessage, type ServerMessage } from '@ecc/shared';

export function terminalUrl(session: string, cols: number, rows: number): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = `/api/sessions/${encodeURIComponent(session)}/terminal`;
  return `${scheme}//${window.location.host}${path}?cols=${cols}&rows=${rows}`;
}

export function sendMessage(socket: WebSocket | null, message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Large pastes must be split, because the server rejects any single oversized input message. */
export function chunkInput(data: string, size: number = TERMINAL_LIMITS.maxInputChunk): string[] {
  if (data.length <= size) return [data];
  const chunks: string[] = [];
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + size, data.length);
    // Do not separate the two halves of a surrogate pair.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}
