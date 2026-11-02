import { execFile } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { buildTmuxEnv } from './tmux-env';
import { TmuxCommandError, TmuxUnavailableError } from './tmux.errors';

const COMMAND_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Executes tmux with an argument array and no shell. Never receives raw user commands. */
@Injectable()
export class TmuxRunner {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** The flags selecting the tmux server, which every invocation must include. */
  serverArgs(): string[] {
    return this.config.tmuxSocket ? ['-L', this.config.tmuxSocket] : [];
  }

  get binary(): string {
    return this.config.tmuxBin;
  }

  run(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.config.tmuxBin,
        [...this.serverArgs(), ...args],
        {
          shell: false,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: buildTmuxEnv(),
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EACCES') {
            reject(new TmuxUnavailableError());
            return;
          }
          reject(new TmuxCommandError(args, stderr, typeof code === 'number' ? code : null));
        },
      );
    });
  }
}
