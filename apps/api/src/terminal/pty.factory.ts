import { spawn } from 'node-pty';

export interface PtyProcess {
  /** Output arrives as raw bytes, leaving UTF-8 decoding to xterm.js. */
  onData(listener: (data: Buffer) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export const PTY_FACTORY = Symbol('PTY_FACTORY');

export const nodePtyFactory: PtyFactory = (file, args, options) =>
  spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.env.HOME,
    env: options.env,
    // null makes node-pty emit Buffers at runtime. Its typings only describe strings.
    encoding: null,
  }) as unknown as PtyProcess;
