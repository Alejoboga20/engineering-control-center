/**
 * WebSocket protocol for `WS /api/sessions/:name/terminal`. Documented in docs/websocket-protocol.md.
 *
 * Text frames carry the JSON control messages below. Binary frames, sent only by the server,
 * carry raw terminal output bytes, which may split a UTF-8 sequence across frames.
 */

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** Scroll through tmux history. Negative is up, positive is down. */
  | { type: 'scroll'; lines: number };

export type TerminalExitReason = 'session-ended' | 'detached';

export type TerminalErrorCode =
  | 'INVALID_SESSION_NAME'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'ATTACH_FAILED'
  | 'PROTOCOL_ERROR'
  | 'INPUT_LIMIT_EXCEEDED';

export type ServerMessage =
  | { type: 'ready'; session: string; cols: number; rows: number }
  | { type: 'exit'; reason: TerminalExitReason; message: string }
  | { type: 'error'; code: TerminalErrorCode; message: string };

/** Application close codes. Anything else (1001, 1006, ...) is treated as a dropped connection. */
export const TerminalCloseCode = {
  Detached: 4001,
  InvalidSession: 4400,
  SessionNotFound: 4404,
  SessionBusy: 4409,
  SessionEnded: 4410,
  InputLimitExceeded: 4413,
  AttachFailed: 4500,
} as const;

export const TERMINAL_LIMITS = {
  minCols: 2,
  maxCols: 1000,
  minRows: 2,
  maxRows: 500,
  maxScrollLines: 100,
  /** Largest input message, in UTF-16 code units. Clients must split larger pastes. */
  maxInputChunk: 64 * 1024,
} as const;
