import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathInside, ProjectDirectoriesService } from './project-directories.service';

describe('ProjectDirectoriesService', () => {
  let base: string;
  let root: string;
  let outside: string;
  let service: ProjectDirectoriesService;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ecc-dirs-')));
    root = join(base, 'projects');
    outside = join(base, 'private');
    mkdirSync(join(root, 'payroll', 'nested'), { recursive: true });
    mkdirSync(join(root, '.cache'));
    mkdirSync(join(root, 'bad#(touch x)'));
    mkdirSync(`${root}-sibling`);
    mkdirSync(outside);
    writeFileSync(join(root, 'file.txt'), '');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, 'payroll'), join(root, 'alias'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    service = new ProjectDirectoriesService({ projectRoots: [root] });
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const code = (path: string) =>
    service.resolveWorkingDirectory(path).then(
      () => 'accepted',
      (error: { getResponse(): { code: string } }) => error.getResponse().code,
    );

  it('accepts the root and directories inside it', async () => {
    await expect(service.resolveWorkingDirectory(root)).resolves.toBe(root);
    await expect(service.resolveWorkingDirectory(join(root, 'payroll/nested'))).resolves.toBe(
      join(root, 'payroll/nested'),
    );
  });

  it('returns the canonical path of a symlink that stays inside the root', async () => {
    await expect(service.resolveWorkingDirectory(join(root, 'alias'))).resolves.toBe(
      join(root, 'payroll'),
    );
  });

  it('rejects path traversal', async () => {
    expect(await code(`${root}/../private`)).toBe('WORKING_DIRECTORY_NOT_ALLOWED');
    expect(await code(`${root}/payroll/../../private`)).toBe('WORKING_DIRECTORY_NOT_ALLOWED');
  });

  it('rejects a symlink that escapes the root', async () => {
    expect(await code(join(root, 'escape'))).toBe('WORKING_DIRECTORY_NOT_ALLOWED');
  });

  it('rejects a sibling directory sharing the root as a name prefix', async () => {
    expect(await code(`${root}-sibling`)).toBe('WORKING_DIRECTORY_NOT_ALLOWED');
  });

  it('rejects relative, missing, dangling, and non-directory paths', async () => {
    expect(await code('projects/payroll')).toBe('INVALID_WORKING_DIRECTORY');
    expect(await code(join(root, 'nope'))).toBe('INVALID_WORKING_DIRECTORY');
    expect(await code(join(root, 'dangling'))).toBe('INVALID_WORKING_DIRECTORY');
    expect(await code(join(root, 'file.txt'))).toBe('INVALID_WORKING_DIRECTORY');
    expect(await code(`${root}/payroll\0`)).toBe('INVALID_WORKING_DIRECTORY');
  });

  it('rejects names tmux would expand as a format', async () => {
    expect(await code(join(root, 'bad#(touch x)'))).toBe('INVALID_WORKING_DIRECTORY');
  });

  it('fails closed when no root exists', async () => {
    const empty = new ProjectDirectoriesService({ projectRoots: [join(base, 'absent')] });
    await expect(empty.resolveWorkingDirectory(root)).rejects.toMatchObject({ status: 403 });
    await expect(empty.listProjects()).resolves.toEqual({ roots: [], directories: [] });
  });

  it('lists only safe, visible directories inside the roots', async () => {
    const { roots, directories } = await service.listProjects();
    expect(roots).toEqual([root]);
    expect(directories.map((directory) => directory.path)).toEqual([join(root, 'payroll')]);
  });

  it('isPathInside does not confuse names beginning with dots for traversal', () => {
    expect(isPathInside('/a', '/a/..hidden')).toBe(true);
    expect(isPathInside('/a', '/a/b/c')).toBe(true);
    expect(isPathInside('/a', '/ab')).toBe(false);
    expect(isPathInside('/a', '/')).toBe(false);
  });
});
