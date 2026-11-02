import { Logger } from '@nestjs/common';
import { ServerMessage, TerminalCloseCode, TerminalErrorCode } from '@ecc/shared';
import { WebSocket } from 'ws';
import { buildTmuxEnv } from '../tmux/tmux-env';
import { TmuxService } from '../tmux/tmux.service';
import { parseClientMessage } from './client-message';
import { PtyFactory, PtyProcess } from './pty.factory';

export const ATTACHMENT_LIMITS = {
  /** Pause reading from the PTY above this much unsent output. tmux then throttles its client. */
  outputHighWaterBytes: 1024 * 1024,
  outputLowWaterBytes: 256 * 1024,
  drainPollMs: 25,
  /** PTY writes cannot be observed draining, so sustained input is capped instead. */
  maxInputCharsPerSecond: 4 * 1024 * 1024,
  /** How long a closing socket gets to finish its close handshake. */
  closeGraceMs: 500,
};

export interface AttachmentOptions {
  session: string;
  cols: number;
  rows: number;
  tmux: TmuxService;
  spawnPty: PtyFactory;
  onDisposed: () => void;
}

/**
 * Bridges one WebSocket to one `tmux attach-session` client running in a PTY.
 *
 * Disposal only ever affects that client. A tmux client that loses its terminal detaches, leaving
 * the session and everything running in it alone. This class must never call kill-session.
 */
export class TerminalAttachment {
  private readonly logger = new Logger(TerminalAttachment.name);
  private pty: PtyProcess | null = null;
  private ptySubscriptions: { dispose(): void }[] = [];
  private disposed = false;
  private alive = true;

  private outputPaused = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  private inputWindowStart = 0;
  private inputWindowChars = 0;

  private cols: number;
  private rows: number;

  private inScrollback = false;
  /** Input held back while tmux leaves copy mode. Non-null only during that transition. */
  private heldInput: string[] | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: AttachmentOptions,
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
    ws.on('message', this.handleMessage);
    ws.on('close', this.handleSocketClose);
    ws.on('error', this.handleSocketError);
    ws.on('pong', this.handlePong);
  }

  /** Verifies the session and attaches. Never creates a session. */
  async start(): Promise<void> {
    const { session, cols, rows, tmux, spawnPty } = this.options;
    let exists: boolean;
    try {
      exists = await tmux.hasSession(session);
    } catch (error) {
      this.logger.error(`Could not query tmux: ${(error as Error).message}`);
      this.fail('ATTACH_FAILED', TerminalCloseCode.AttachFailed, 'Could not query tmux.');
      return;
    }
    if (this.disposed) return;
    if (!exists) {
      this.fail(
        'SESSION_NOT_FOUND',
        TerminalCloseCode.SessionNotFound,
        `Session "${session}" does not exist.`,
      );
      return;
    }

    try {
      const { file, args } = tmux.attachCommand(session);
      this.pty = spawnPty(file, args, { cols, rows, env: buildTmuxEnv() });
    } catch (error) {
      this.logger.error(`Could not spawn PTY: ${(error as Error).message}`);
      this.fail('ATTACH_FAILED', TerminalCloseCode.AttachFailed, 'Could not start a terminal.');
      return;
    }
    this.ptySubscriptions = [
      this.pty.onData(this.handleOutput),
      this.pty.onExit(() => void this.handlePtyExit()),
    ];
    this.send({ type: 'ready', session, cols, rows });
  }

  /** Called periodically. Drops connections that vanished without a close, such as a sleeping laptop. */
  heartbeat(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.alive) {
      this.logger.warn(`No heartbeat from client of "${this.options.session}", dropping it.`);
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  /** Used on backend shutdown. The tmux session stays running. */
  shutdown(): void {
    this.closeSocket(1001, 'Server restarting');
    this.dispose();
  }

  private readonly handleOutput = (data: Buffer): void => {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data, { binary: true });
    if (!this.outputPaused && this.ws.bufferedAmount >= ATTACHMENT_LIMITS.outputHighWaterBytes) {
      this.outputPaused = true;
      this.pty?.pause();
      this.drainTimer = setInterval(this.checkDrain, ATTACHMENT_LIMITS.drainPollMs);
    }
  };

  private readonly checkDrain = (): void => {
    if (this.ws.bufferedAmount > ATTACHMENT_LIMITS.outputLowWaterBytes) return;
    this.stopDrainTimer();
    this.outputPaused = false;
    this.pty?.resume();
  };

  private readonly handleMessage = (raw: Buffer, isBinary: boolean): void => {
    this.alive = true;
    if (this.disposed || !this.pty) return;
    const message = isBinary ? null : parseClientMessage(raw.toString('utf8'));
    if (!message) {
      this.send({
        type: 'error',
        code: 'PROTOCOL_ERROR',
        message: 'Ignored a malformed terminal message.',
      });
      return;
    }
    switch (message.type) {
      case 'input':
        this.handleInput(message.data);
        break;
      case 'resize':
        this.cols = message.cols;
        this.rows = message.rows;
        this.pty.resize(message.cols, message.rows);
        break;
      case 'scroll':
        void this.handleScroll(message.lines);
        break;
    }
  };

  private handleInput(data: string): void {
    const now = Date.now();
    if (now - this.inputWindowStart >= 1000) {
      this.inputWindowStart = now;
      this.inputWindowChars = 0;
    }
    this.inputWindowChars += data.length;
    if (this.inputWindowChars > ATTACHMENT_LIMITS.maxInputCharsPerSecond) {
      this.fail(
        'INPUT_LIMIT_EXCEEDED',
        TerminalCloseCode.InputLimitExceeded,
        'Too much input at once. The paste was interrupted. Reconnect to continue.',
      );
      return;
    }

    if (this.heldInput) {
      this.heldInput.push(data);
    } else if (this.inScrollback) {
      this.inScrollback = false;
      this.heldInput = [data];
      void this.options.tmux
        .cancelScroll(this.options.session)
        .catch(() => undefined) // Scrolling back to the bottom had already left copy mode.
        .then(this.flushHeldInput);
    } else {
      this.pty?.write(data);
    }
  }

  private readonly flushHeldInput = (): void => {
    const held = this.heldInput ?? [];
    this.heldInput = null;
    for (const data of held) this.pty?.write(data);
  };

  private async handleScroll(lines: number): Promise<void> {
    if (lines < 0) this.inScrollback = true;
    try {
      const result = await this.options.tmux.scrollPane(this.options.session, lines);
      if (result === 'scrolled') return;
      this.inScrollback = false;
      const key = result === 'mouse' ? this.wheelSequence(lines) : lines < 0 ? '\x1b[A' : '\x1b[B';
      this.pty?.write(key.repeat(Math.abs(lines)));
    } catch (error) {
      // The session may have ended between the wheel event and this call.
      this.logger.debug(`Scroll failed: ${(error as Error).message}`);
    }
  }

  /** An SGR wheel event at the center of the terminal. tmux delivers it to the application. */
  private wheelSequence(lines: number): string {
    const button = lines < 0 ? 64 : 65;
    return `\x1b[<${button};${Math.ceil(this.cols / 2)};${Math.ceil(this.rows / 2)}M`;
  }

  private async handlePtyExit(): Promise<void> {
    if (this.disposed) return;
    const { session, tmux } = this.options;
    // Forget the dead PTY now, so that disposal does not signal a recycled pid.
    this.releasePty(false);

    const stillExists = await tmux.hasSession(session).catch(() => false);
    if (this.disposed) return;
    if (stillExists) {
      this.send({ type: 'exit', reason: 'detached', message: 'Detached from the session.' });
      this.closeSocket(TerminalCloseCode.Detached, 'Detached');
    } else {
      this.send({
        type: 'exit',
        reason: 'session-ended',
        message: `Session "${session}" has ended.`,
      });
      this.closeSocket(TerminalCloseCode.SessionEnded, 'Session ended');
    }
    this.dispose();
  }

  private readonly handleSocketClose = (): void => this.dispose();

  private readonly handleSocketError = (error: Error): void => {
    this.logger.warn(`WebSocket error on "${this.options.session}": ${error.message}`);
    this.ws.terminate();
    this.dispose();
  };

  private readonly handlePong = (): void => {
    this.alive = true;
  };

  private fail(code: TerminalErrorCode, closeCode: number, message: string): void {
    this.send({ type: 'error', code, message });
    this.closeSocket(closeCode, code);
    this.dispose();
  }

  private send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private closeSocket(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
    if (this.ws.readyState !== WebSocket.CLOSED && !this.closeTimer) {
      // A client that never answers must not hold a socket open, or block server shutdown.
      this.closeTimer = setTimeout(() => this.ws.terminate(), ATTACHMENT_LIMITS.closeGraceMs);
      this.closeTimer.unref();
    }
  }

  private stopDrainTimer(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private releasePty(kill: boolean): void {
    for (const subscription of this.ptySubscriptions) subscription.dispose();
    this.ptySubscriptions = [];
    const pty = this.pty;
    this.pty = null;
    if (!pty || !kill) return;
    try {
      pty.kill(); // SIGHUP makes the tmux client detach. The session is unaffected.
    } catch {
      // Already exited.
    }
  }

  /** Idempotent. Releases everything this attachment owns, and frees the session for reattaching. */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopDrainTimer();
    this.heldInput = null;
    this.releasePty(true);
    this.ws.off('message', this.handleMessage);
    this.ws.off('close', this.handleSocketClose);
    this.ws.off('pong', this.handlePong);
    // handleSocketError stays attached: an unhandled 'error' event would crash the process.
    this.options.onDisposed();
  }
}
