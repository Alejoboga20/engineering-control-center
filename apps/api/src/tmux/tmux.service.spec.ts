import { TmuxRunner } from './tmux-runner';
import { TmuxCommandError, TmuxDuplicateSessionError, TmuxSessionNotFoundError } from './tmux.errors';
import { TmuxService } from './tmux.service';

function setup() {
  const run = jest.fn().mockResolvedValue('');
  const runner = { run, binary: '/usr/bin/tmux', serverArgs: () => ['-L', 'ecc'] };
  return { run, service: new TmuxService(runner as unknown as TmuxRunner) };
}

const failure = (stderr: string) => new TmuxCommandError(['x'], stderr, 1);

describe('TmuxService', () => {
  describe('listSessions', () => {
    it('uses a format string and parses every field', async () => {
      const { service, run } = setup();
      run.mockResolvedValue('1700000000:2:3:alpha\n1700000100:0:1:has space:odd\n');
      await expect(service.listSessions()).resolves.toEqual([
        { name: 'alpha', createdAt: new Date(1700000000000), attachedClients: 2, windows: 3 },
        { name: 'has space:odd', createdAt: new Date(1700000100000), attachedClients: 0, windows: 1 },
      ]);
      expect(run.mock.calls[0][0][0]).toBe('list-sessions');
      expect(run.mock.calls[0][0][1]).toBe('-F');
    });

    it.each([
      'no server running on /tmp/tmux-1000/default',
      'error connecting to /tmp/tmux-1000/default (No such file or directory)',
    ])('treats "%s" as an empty list', async (stderr) => {
      const { service, run } = setup();
      run.mockRejectedValue(failure(stderr));
      await expect(service.listSessions()).resolves.toEqual([]);
    });

    it('propagates other failures', async () => {
      const { service, run } = setup();
      run.mockRejectedValue(failure('protocol version mismatch'));
      await expect(service.listSessions()).rejects.toBeInstanceOf(TmuxCommandError);
    });
  });

  describe('hasSession', () => {
    it('uses an exact target', async () => {
      const { service, run } = setup();
      await expect(service.hasSession('alpha')).resolves.toBe(true);
      expect(run).toHaveBeenCalledWith(['has-session', '-t', '=alpha']);
    });

    it.each(["can't find session: =alpha", 'no server running on /tmp/x'])(
      'is false on "%s"',
      async (stderr) => {
        const { service, run } = setup();
        run.mockRejectedValue(failure(stderr));
        await expect(service.hasSession('alpha')).resolves.toBe(false);
      },
    );
  });

  describe('createSession', () => {
    it('creates a detached session, passing values as separate arguments', async () => {
      const { service, run } = setup();
      await service.createSession('alpha', '/srv/my project');
      expect(run).toHaveBeenCalledWith(['new-session', '-d', '-s', 'alpha', '-c', '/srv/my project']);
    });

    it('maps a duplicate error', async () => {
      const { service, run } = setup();
      run.mockRejectedValue(failure('duplicate session: alpha'));
      await expect(service.createSession('alpha', '/x')).rejects.toBeInstanceOf(
        TmuxDuplicateSessionError,
      );
    });
  });

  describe('killSession', () => {
    it('uses an exact target', async () => {
      const { service, run } = setup();
      await service.killSession('alpha');
      expect(run).toHaveBeenCalledWith(['kill-session', '-t', '=alpha']);
    });

    it('maps a missing session', async () => {
      const { service, run } = setup();
      run.mockRejectedValue(failure("can't find session: =alpha"));
      await expect(service.killSession('alpha')).rejects.toBeInstanceOf(TmuxSessionNotFoundError);
    });
  });

  it('builds an attach command that targets the configured server and an exact session', () => {
    const { service } = setup();
    expect(service.attachCommand('alpha')).toEqual({
      file: '/usr/bin/tmux',
      args: ['-L', 'ecc', '-u', '-T', 'RGB', 'attach-session', '-t', '=alpha'],
    });
  });

  describe('scrollPane', () => {
    it('enters copy mode to scroll up', async () => {
      const { service, run } = setup();
      run.mockResolvedValueOnce('0:0:0\n');
      await expect(service.scrollPane('alpha', -5)).resolves.toBe('scrolled');
      expect(run.mock.calls[1][0].slice(0, 4)).toEqual(['copy-mode', '-e', '-t', '=alpha:']);
      expect(run.mock.calls[1][0]).toContain('scroll-up');
    });

    it('does not enter copy mode to scroll down from the live view', async () => {
      const { service, run } = setup();
      run.mockResolvedValueOnce('0:0:0\n');
      await service.scrollPane('alpha', 5);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('leaves full-screen applications to handle scrolling', async () => {
      const { service, run } = setup();
      run.mockResolvedValueOnce('0:1:0\n');
      await expect(service.scrollPane('alpha', -5)).resolves.toBe('application');
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
