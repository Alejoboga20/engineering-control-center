import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  CLAUDE_EVENTS_PATH,
  INBOX_STREAM_PATH,
  isValidSessionName,
  SESSION_NAME_RULES,
  ServerMessage,
  TERMINAL_LIMITS,
  TerminalCloseCode,
  TerminalErrorCode,
} from '@ecc/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { isUpgradeAllowed } from '../common/request-guard';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { TmuxService } from '../tmux/tmux.service';
import { PTY_FACTORY, PtyFactory } from './pty.factory';
import { TerminalAttachment } from './terminal-attachment';

const TERMINAL_PATH = /^\/api\/sessions\/([^/]+)\/terminal$/;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** Room for a full input chunk, whose characters may each take 3 bytes, plus JSON escaping. */
const MAX_FRAME_BYTES = TERMINAL_LIMITS.maxInputChunk * 6 + 1024;

function clampedDimension(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/**
 * Serves `WS /api/sessions/:name/terminal` directly on the HTTP server, because Nest gateways
 * cannot route on path parameters. Attachments live only in this process and exist purely to
 * enforce the one-per-session rule. Sessions themselves belong to tmux.
 */
@Injectable()
export class TerminalGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly attachments = new Map<string, TerminalAttachment>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private server: Server | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tmux: TmuxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PTY_FACTORY) private readonly spawnPty: PtyFactory,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.handleUpgrade);
    this.heartbeatTimer = setInterval(() => {
      for (const attachment of this.attachments.values()) attachment.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  /** Detaches every PTY client. Deliberately leaves all tmux sessions running. */
  beforeApplicationShutdown(): void {
    this.server?.off('upgrade', this.handleUpgrade);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const attachment of [...this.attachments.values()]) attachment.shutdown();
    this.wss.close();
  }

  private readonly handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());

    const url = new URL(req.url ?? '/', 'http://localhost');
    // Handled by ClaudeMonitoringGateway and InboxGateway, on their own listeners for this event.
    if (url.pathname === CLAUDE_EVENTS_PATH || url.pathname === INBOX_STREAM_PATH) return;

    const match = TERMINAL_PATH.exec(url.pathname);
    if (!match) {
      this.rejectUpgrade(socket, '404 Not Found');
      return;
    }
    if (!isUpgradeAllowed(req.headers, this.config)) {
      this.logger.warn(`Rejected terminal upgrade from origin "${req.headers.origin ?? ''}".`);
      this.rejectUpgrade(socket, '403 Forbidden');
      return;
    }

    let name: string | null;
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      name = null;
    }
    const cols = clampedDimension(
      url.searchParams.get('cols'),
      TERMINAL_LIMITS.minCols,
      TERMINAL_LIMITS.maxCols,
      DEFAULT_COLS,
    );
    const rows = clampedDimension(
      url.searchParams.get('rows'),
      TERMINAL_LIMITS.minRows,
      TERMINAL_LIMITS.maxRows,
      DEFAULT_ROWS,
    );

    // Accept before checking the session: browsers cannot read an upgrade failure's status or
    // body, so a useful message requires an open socket to send it on.
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws, name, cols, rows);
    });
  };

  private handleConnection(ws: WebSocket, name: string | null, cols: number, rows: number): void {
    if (!isValidSessionName(name)) {
      this.refuse(
        ws,
        'INVALID_SESSION_NAME',
        TerminalCloseCode.InvalidSession,
        `Invalid session name. ${SESSION_NAME_RULES}`,
      );
      return;
    }
    if (this.attachments.has(name)) {
      this.refuse(
        ws,
        'SESSION_BUSY',
        TerminalCloseCode.SessionBusy,
        `Session "${name}" is already open in another browser tab or window. Close it there, then reconnect.`,
      );
      return;
    }

    // The slot is claimed synchronously, so that two simultaneous connections cannot both pass.
    const attachment = new TerminalAttachment(ws, {
      session: name,
      cols,
      rows,
      tmux: this.tmux,
      spawnPty: this.spawnPty,
      onDisposed: () => {
        this.attachments.delete(name);
      },
    });
    this.attachments.set(name, attachment);
    void attachment.start();
  }

  private refuse(ws: WebSocket, code: TerminalErrorCode, closeCode: number, message: string): void {
    ws.on('error', () => ws.terminate());
    const payload: ServerMessage = { type: 'error', code, message };
    ws.send(JSON.stringify(payload));
    ws.close(closeCode, code);
  }

  private rejectUpgrade(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}
