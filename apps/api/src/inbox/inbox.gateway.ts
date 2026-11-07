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
import { INBOX_STREAM_PATH, InboxMessage } from '@ecc/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { isUpgradeAllowed } from '../common/request-guard';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { InboxService } from './inbox.service';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Serves `WS /api/inbox/stream` on the shared HTTP server, under the same Host and Origin checks
 * as terminals. It only pushes. SQLite is the source of truth: every connection starts with
 * `inbox.hello`, after which the client fetches the list, so a missed message costs nothing.
 */
@Injectable()
export class InboxGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(InboxGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly inbox: InboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.handleUpgrade);
    this.unsubscribe = this.inbox.onChange((message) => this.broadcast(message));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  beforeApplicationShutdown(): void {
    this.server?.off('upgrade', this.handleUpgrade);
    this.unsubscribe?.();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) client.terminate();
    this.wss.close();
  }

  private readonly handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== INBOX_STREAM_PATH) return;

    if (!isUpgradeAllowed(req.headers, this.config)) {
      this.logger.warn(`Rejected Inbox upgrade from origin "${req.headers.origin ?? ''}".`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
  };

  private handleConnection(ws: WebSocket): void {
    ws.on('error', () => ws.terminate());
    ws.on('close', () => this.clients.delete(ws));
    ws.on('pong', () => this.alive.add(ws));
    this.alive.add(ws);
    // Subscribed in the same tick as the hello, so no change can fall between the client's
    // snapshot request and its first update.
    this.clients.add(ws);
    this.send(ws, { type: 'inbox.hello', data: { serverTime: new Date().toISOString() } });
  }

  private broadcast(message: InboxMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  private send(client: WebSocket, message: InboxMessage): void {
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      // It reconnects, receives a new hello and refetches, which beats a long queue.
      client.terminate();
      return;
    }
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!this.alive.has(client)) {
        client.terminate();
        continue;
      }
      this.alive.delete(client);
      client.ping();
    }
  }
}
