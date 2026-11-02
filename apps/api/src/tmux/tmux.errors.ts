export class TmuxUnavailableError extends Error {
  constructor(message = 'tmux is not installed or could not be executed.') {
    super(message);
  }
}

export class TmuxCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`tmux ${args[0] ?? ''} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }
}

export class TmuxSessionNotFoundError extends Error {
  constructor(readonly session: string) {
    super(`Session "${session}" does not exist.`);
  }
}

export class TmuxDuplicateSessionError extends Error {
  constructor(readonly session: string) {
    super(`Session "${session}" already exists.`);
  }
}
