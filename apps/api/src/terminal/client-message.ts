import { ClientMessage, TERMINAL_LIMITS } from '@ecc/shared';

function inRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Validates an untrusted control frame. Returns null when it is not a known, well-formed message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;

  switch (message.type) {
    case 'input':
      return typeof message.data === 'string' && message.data.length <= TERMINAL_LIMITS.maxInputChunk
        ? { type: 'input', data: message.data }
        : null;
    case 'resize':
      return inRange(message.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols) &&
        inRange(message.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows)
        ? { type: 'resize', cols: message.cols, rows: message.rows }
        : null;
    case 'scroll':
      return inRange(message.lines, -TERMINAL_LIMITS.maxScrollLines, TERMINAL_LIMITS.maxScrollLines) &&
        message.lines !== 0
        ? { type: 'scroll', lines: message.lines }
        : null;
    default:
      return null;
  }
}
