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
import { CLAUDE_EVENTS_PATH, ClaudeMonitorMessage } from '@ecc/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { isUpgradeAllowed } from '../common/request-guard';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ClaudeHookCredentialsService } from './claude-hook-credentials.service';
import { ClaudeStateService } from './claude-state.service';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Serves `WS /api/claude/events` on the shared HTTP server, under the same Host and Origin checks
 * as terminals. It only pushes: every connection gets a snapshot, then changes.
 */
@Injectable()
export class ClaudeMonitoringGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ClaudeMonitoringGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly state: ClaudeStateService,
    private readonly credentials: ClaudeHookCredentialsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.handleUpgrade);
    this.unsubscribe = this.state.onChange((data) => {
      this.broadcast({ type: 'claude.status.changed', data });
    });
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
    if (pathname !== CLAUDE_EVENTS_PATH) return;

    if (!isUpgradeAllowed(req.headers, this.config)) {
      this.logger.warn(`Rejected monitor upgrade from origin "${req.headers.origin ?? ''}".`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.handleConnection(ws));
  };

  private async handleConnection(ws: WebSocket): Promise<void> {
    ws.on('error', () => ws.terminate());
    ws.on('close', () => this.clients.delete(ws));
    ws.on('pong', () => this.alive.add(ws));
    this.alive.add(ws);

    let sessions: Awaited<ReturnType<ClaudeStateService['snapshot']>> = [];
    try {
      sessions = await this.state.snapshot();
    } catch (error) {
      this.logger.warn(`Could not build a snapshot: ${(error as Error).message}`);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    // No await between building and subscribing, so that no change can fall between the two.
    this.send(ws, {
      type: 'claude.status.snapshot',
      data: { ingestionAvailable: this.credentials.available, sessions },
    });
    this.clients.add(ws);
  }

  private broadcast(message: ClaudeMonitorMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  private send(client: WebSocket, message: ClaudeMonitorMessage): void {
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      // It reconnects and receives a new snapshot, which beats a long queue of old statuses.
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
