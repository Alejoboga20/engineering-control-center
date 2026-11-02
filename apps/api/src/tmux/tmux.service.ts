import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isValidSessionName } from '@ecc/shared';
import { TmuxRunner } from './tmux-runner';
import {
  TmuxCommandError,
  TmuxDuplicateSessionError,
  TmuxSessionNotFoundError,
} from './tmux.errors';

export interface TmuxSession {
  name: string;
  createdAt: Date;
  attachedClients: number;
  windows: number;
}

/**
 * - `scrolled`: tmux moved through its own history.
 * - `mouse`: the application tracks the mouse, so the caller must forward wheel events.
 * - `keys`: a full-screen application without mouse tracking, so the caller must send arrow keys.
 */
export type ScrollResult = 'scrolled' | 'mouse' | 'keys';

/**
 * Session names go last and numbers first: tmux forbids `:` in a name, so everything after the
 * third colon is the name, whatever else it contains.
 */
const LIST_FORMAT = '#{session_created}:#{session_attached}:#{session_windows}:#{session_name}';
const LIST_LINE = /^(\d+):(\d+):(\d+):(.+)$/;

const NO_SERVER = /no server running|error connecting to|server exited/i;
const SESSION_MISSING = /can't find session|session not found/i;
const DUPLICATE_SESSION = /duplicate session/i;

const MIN_TMUX_VERSION = 3.2;

/** tmux matches `-t name` by prefix and glob. The `=` prefix requires an exact match. */
function exactSession(name: string): string {
  return `=${name}`;
}

/** The active pane of a session, in the form tmux needs for a pane target. */
function exactPane(name: string): string {
  return `=${name}:`;
}

function isMissingSession(error: unknown): boolean {
  return (
    error instanceof TmuxCommandError &&
    (NO_SERVER.test(error.stderr) || SESSION_MISSING.test(error.stderr))
  );
}

@Injectable()
export class TmuxService implements OnModuleInit {
  private readonly logger = new Logger(TmuxService.name);

  constructor(private readonly runner: TmuxRunner) {}

  async onModuleInit(): Promise<void> {
    try {
      const output = await this.runner.run(['-V']);
      const version = Number(/(\d+\.\d+)/.exec(output)?.[1]);
      this.logger.log(`Using ${output.trim()}`);
      if (version < MIN_TMUX_VERSION) {
        this.logger.error(`tmux ${MIN_TMUX_VERSION} or newer is required to attach terminals.`);
      }
    } catch (error) {
      this.logger.error(`tmux check failed: ${(error as Error).message}`);
    }
  }

  isValidSessionName(name: unknown): name is string {
    return isValidSessionName(name);
  }

  async listSessions(): Promise<TmuxSession[]> {
    let output: string;
    try {
      output = await this.runner.run(['list-sessions', '-F', LIST_FORMAT]);
    } catch (error) {
      // tmux exits with an error when its server is not running, which just means no sessions.
      if (error instanceof TmuxCommandError && NO_SERVER.test(error.stderr)) return [];
      throw error;
    }
    return output.split('\n').flatMap((line) => {
      const match = LIST_LINE.exec(line);
      if (!match) return [];
      return [
        {
          name: match[4],
          createdAt: new Date(Number(match[1]) * 1000),
          attachedClients: Number(match[2]),
          windows: Number(match[3]),
        },
      ];
    });
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.runner.run(['has-session', '-t', exactSession(name)]);
      return true;
    } catch (error) {
      if (isMissingSession(error)) return false;
      throw error;
    }
  }

  async createSession(name: string, workingDirectory: string): Promise<void> {
    try {
      await this.runner.run(['new-session', '-d', '-s', name, '-c', workingDirectory]);
    } catch (error) {
      if (error instanceof TmuxCommandError && DUPLICATE_SESSION.test(error.stderr)) {
        throw new TmuxDuplicateSessionError(name);
      }
      throw error;
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.runner.run(['kill-session', '-t', exactSession(name)]);
    } catch (error) {
      if (isMissingSession(error)) throw new TmuxSessionNotFoundError(name);
      throw error;
    }
  }

  /**
   * Arguments for the client process run inside the PTY. It never creates a session, and killing
   * it only detaches. `-u` forces UTF-8, and `-T RGB` enables 24-bit color for this client alone,
   * without changing any server option.
   */
  attachCommand(name: string): { file: string; args: string[] } {
    return {
      file: this.runner.binary,
      args: [
        ...this.runner.serverArgs(),
        '-u',
        '-T',
        'RGB',
        'attach-session',
        '-t',
        exactSession(name),
      ],
    };
  }

  /**
   * tmux keeps the browser terminal on its alternate screen, so xterm.js collects no scrollback of
   * its own. History normally lives in tmux, and this drives its copy mode. Full-screen applications
   * have no tmux history, so they handle scrolling themselves. See ScrollResult.
   */
  async scrollPane(name: string, lines: number): Promise<ScrollResult> {
    const pane = exactPane(name);
    const state = await this.runner.run([
      'display-message',
      '-p',
      '-t',
      pane,
      '#{pane_in_mode}:#{alternate_on}:#{mouse_any_flag}',
    ]);
    const [inMode, alternate, mouse] = state.trim().split(':');
    if (inMode !== '1') {
      // Mouse first: arrow keys mean something else to these applications. In Claude Code they
      // recall previous prompts, while wheel events scroll its transcript.
      if (mouse === '1') return 'mouse';
      if (alternate === '1') return 'keys';
    }

    const count = String(Math.abs(lines));
    if (lines < 0) {
      await this.runner.run([
        'copy-mode',
        '-e',
        '-t',
        pane,
        ';',
        'send-keys',
        '-X',
        '-N',
        count,
        '-t',
        pane,
        'scroll-up',
      ]);
    } else if (inMode === '1') {
      await this.runner.run(['send-keys', '-X', '-N', count, '-t', pane, 'scroll-down']);
    }
    return 'scrolled';
  }

  /** Leaves copy mode so that typing reaches the application. */
  async cancelScroll(name: string): Promise<void> {
    await this.runner.run(['send-keys', '-X', '-t', exactPane(name), 'cancel']);
  }
}
