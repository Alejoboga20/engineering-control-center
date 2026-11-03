import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ClaudeConfigOrigin,
  ClaudeConfigScope,
  ClaudeKnowledgeType,
  ClaudeResourceCategory,
} from '@ecc/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { isPathInside } from '../sessions/project-directories.service';

const MAX_RESOURCES_PER_CATEGORY = 500;
const MAX_DIRECTORY_ENTRIES = 2000;
const MAX_MARKDOWN_DEPTH = 5;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
const INSTRUCTION_FILES: { segments: string[]; origin: ClaudeConfigOrigin }[] = [
  { segments: ['CLAUDE.md'], origin: 'project' },
  { segments: ['.claude', 'CLAUDE.md'], origin: 'project' },
  { segments: ['AGENTS.md'], origin: 'project' },
  { segments: ['CLAUDE.local.md'], origin: 'local' },
];

/** A scope's canonical root, or null when its directory does not exist. */
export interface ScopeContext {
  scope: ClaudeConfigScope;
  /** `global`, or a project ID. */
  token: string;
  root: string | null;
}

/** A file that discovery approved. `canonicalPath` stays on the server. */
export interface LocatedResource {
  id: string;
  category: ClaudeResourceCategory;
  origin: ClaudeConfigOrigin;
  relativePath: string;
  canonicalPath: string;
  fallbackName: string;
  knowledgeType?: ClaudeKnowledgeType;
}

/** A settings-like file at a fixed location. */
export interface LocatedConfigFile {
  origin: ClaudeConfigOrigin;
  relativePath: string;
  /** Null when the file is absent, or `status` says why it cannot be used. */
  canonicalPath: string | null;
  status: 'missing' | 'unsafe' | 'unreadable' | null;
}

export class DiscoveryReport {
  skippedSymlinks = 0;
  unreadable = 0;
  truncated = false;
}

interface ResolvedEntry {
  canonical: string;
  kind: 'file' | 'directory';
}

export function projectIdOf(canonicalPath: string): string {
  return createHash('sha256').update(`project\0${canonicalPath}`).digest('hex').slice(0, 16);
}

const RESOURCE_ID = /^(agent|skill|knowledge)\.(global|[a-f0-9]{16})\.[a-f0-9]{32}$/;

export function parseResourceId(
  id: string,
): { category: ClaudeResourceCategory; token: string } | null {
  const match = RESOURCE_ID.exec(id);
  return match ? { category: match[1] as ClaudeResourceCategory, token: match[2] } : null;
}

/**
 * Finds configuration files in fixed locations. There is no operation taking a path from a caller:
 * a resource can only be reached by discovering it again, so the allowlist is enforced on every read.
 *
 * Symlinks are followed only into directories an administrator approved, because a cloned
 * repository can contain a link to anything the backend user can read.
 */
@Injectable()
export class ClaudeConfigurationDiscoveryService {
  constructor(
    @Inject(APP_CONFIG)
    private readonly config: Pick<
      AppConfig,
      'claudeConfigDir' | 'claudeKnowledgeDirs' | 'claudeSymlinkTargets'
    >,
  ) {}

  globalLabel(): string {
    return this.config.claudeConfigDir === join(homedir(), '.claude')
      ? '~/.claude'
      : '$CLAUDE_CONFIG_DIR';
  }

  async globalContext(): Promise<ScopeContext> {
    const root = await this.directoryRoot(this.config.claudeConfigDir);
    return { scope: 'global', token: 'global', root };
  }

  /** `canonicalPath` must come from ProjectDirectoriesService. */
  projectContext(canonicalPath: string): ScopeContext {
    return { scope: 'project', token: projectIdOf(canonicalPath), root: canonicalPath };
  }

  async hasProjectConfiguration(canonicalPath: string): Promise<boolean> {
    const candidates = ['.claude', '.mcp.json', ...INSTRUCTION_FILES.map((file) => file.segments[0])];
    for (const candidate of candidates) {
      const found = await lstat(join(canonicalPath, candidate)).then(
        () => true,
        () => false,
      );
      if (found) return true;
    }
    return false;
  }

  async discoverAgents(context: ScopeContext, report: DiscoveryReport): Promise<LocatedResource[]> {
    if (!context.root) return [];
    const targets = await this.symlinkTargets();
    const segments = [...this.claudeSegments(context), 'agents'];
    const found: LocatedResource[] = [];
    const directory = await this.resolvePath(context.root, segments, targets, report);
    if (directory?.kind !== 'directory') return found;
    await this.walkMarkdown(directory.canonical, segments.join('/'), targets, report, (file) => {
      found.push(
        this.locate(context, 'agent', 'agent', file.relativePath, file.canonical, 'project'),
      );
      return found.length;
    });
    return found;
  }

  async discoverSkills(context: ScopeContext, report: DiscoveryReport): Promise<LocatedResource[]> {
    if (!context.root) return [];
    const targets = await this.symlinkTargets();
    const segments = [...this.claudeSegments(context), 'skills'];
    const directory = await this.resolvePath(context.root, segments, targets, report);
    if (directory?.kind !== 'directory') return [];

    const found: LocatedResource[] = [];
    const relativeRoot = segments.join('/');
    for (const name of await this.listNames(directory.canonical, report)) {
      if (name === 'synced' && context.scope === 'global') {
        await this.discoverSyncedSkills(context, directory.canonical, relativeRoot, targets, report, found);
        continue;
      }
      await this.addSkill(context, directory.canonical, relativeRoot, name, targets, report, found);
    }
    return found;
  }

  async discoverKnowledge(context: ScopeContext, report: DiscoveryReport): Promise<LocatedResource[]> {
    if (!context.root) return [];
    const targets = await this.symlinkTargets();
    const found: LocatedResource[] = [];
    await this.addInstructions(context, targets, report, found);

    const segments = [...this.claudeSegments(context), 'rules'];
    const rules = await this.resolvePath(context.root, segments, targets, report);
    if (rules?.kind === 'directory') {
      await this.walkMarkdown(rules.canonical, segments.join('/'), targets, report, (file) => {
        found.push(this.locate(context, 'knowledge', 'rule', file.relativePath, file.canonical, 'project'));
        return found.length;
      });
    }
    await this.addKnowledgeDirectories(context, targets, report, found);
    return found;
  }

  /** The settings files that exist for a scope, in the order Claude Code documents them. */
  async locateSettingsFiles(context: ScopeContext): Promise<LocatedConfigFile[]> {
    return context.scope === 'global'
      ? [await this.locateConfigFile(context, ['settings.json'], 'global')]
      : [
          await this.locateConfigFile(context, ['.claude', 'settings.json'], 'project'),
          await this.locateConfigFile(context, ['.claude', 'settings.local.json'], 'local'),
        ];
  }

  locateMcpDefinitions(context: ScopeContext): Promise<LocatedConfigFile> {
    return this.locateConfigFile(context, ['.mcp.json'], 'project');
  }

  private claudeSegments(context: ScopeContext): string[] {
    return context.scope === 'project' ? ['.claude'] : [];
  }

  private async locateConfigFile(
    context: ScopeContext,
    segments: string[],
    origin: ClaudeConfigOrigin,
  ): Promise<LocatedConfigFile> {
    const relativePath = segments.join('/');
    const missing = { origin, relativePath, canonicalPath: null };
    if (!context.root) return { ...missing, status: 'missing' };

    const report = new DiscoveryReport();
    const entry = await this.resolvePath(context.root, segments, await this.symlinkTargets(), report);
    if (report.skippedSymlinks > 0) return { ...missing, status: 'unsafe' };
    if (report.unreadable > 0) return { ...missing, status: 'unreadable' };
    if (!entry) return { ...missing, status: 'missing' };
    if (entry.kind !== 'file' || !entry.canonical.endsWith('.json')) {
      return { ...missing, status: 'unsafe' };
    }
    return { origin, relativePath, canonicalPath: entry.canonical, status: null };
  }

  private async addInstructions(
    context: ScopeContext,
    targets: string[],
    report: DiscoveryReport,
    found: LocatedResource[],
  ): Promise<void> {
    const root = context.root!;
    const files =
      context.scope === 'global'
        ? [{ segments: ['CLAUDE.md'], origin: 'global' as const }]
        : INSTRUCTION_FILES;
    // `ln -s AGENTS.md CLAUDE.md` is a documented setup, and stays among these same files.
    const instructionPaths = new Set(files.map((file) => join(root, ...file.segments)));
    for (const { segments, origin } of files) {
      const entry = await this.resolvePath(root, segments, targets, report, instructionPaths);
      if (entry?.kind === 'file' && entry.canonical.endsWith('.md')) {
        found.push(this.locate(context, 'knowledge', 'instructions', segments.join('/'), entry.canonical, origin));
      }
    }
  }

  private async addKnowledgeDirectories(
    context: ScopeContext,
    targets: string[],
    report: DiscoveryReport,
    found: LocatedResource[],
  ): Promise<void> {
    const origin = context.scope === 'global' ? 'global' : 'project';
    const directories =
      context.scope === 'global'
        ? await Promise.all(
            this.config.claudeKnowledgeDirs.global.map(async (configured) => ({
              label: basename(configured),
              canonical: await this.directoryRoot(configured),
            })),
          )
        : await Promise.all(
            this.config.claudeKnowledgeDirs.project.map(async (configured) => {
              const entry = await this.resolvePath(context.root!, configured.split('/'), targets, report);
              return {
                label: configured,
                canonical: entry?.kind === 'directory' ? entry.canonical : null,
              };
            }),
          );
    for (const { label, canonical } of directories) {
      if (!canonical) continue;
      await this.walkMarkdown(canonical, label, targets, report, (file) => {
        found.push(this.locate(context, 'knowledge', 'knowledge-directory', file.relativePath, file.canonical, origin));
        return found.length;
      });
    }
  }

  /** claude.ai skills are synced to `skills/synced/<bucket>/<name>/SKILL.md`. */
  private async discoverSyncedSkills(
    context: ScopeContext,
    skillsDirectory: string,
    relativeRoot: string,
    targets: string[],
    report: DiscoveryReport,
    found: LocatedResource[],
  ): Promise<void> {
    const synced = await this.resolvePath(skillsDirectory, ['synced'], targets, report);
    if (synced?.kind !== 'directory') return;
    for (const bucket of await this.listNames(synced.canonical, report)) {
      const entry = await this.resolvePath(synced.canonical, [bucket], targets, report);
      if (entry?.kind !== 'directory') continue;
      const relative = `${relativeRoot}/synced/${bucket}`;
      for (const name of await this.listNames(entry.canonical, report)) {
        await this.addSkill(context, entry.canonical, relative, name, targets, report, found);
      }
    }
  }

  /** Only `SKILL.md` is ever looked at. A skill's supporting files stay out of reach. */
  private async addSkill(
    context: ScopeContext,
    parent: string,
    relativeRoot: string,
    name: string,
    targets: string[],
    report: DiscoveryReport,
    found: LocatedResource[],
  ): Promise<void> {
    if (found.length >= MAX_RESOURCES_PER_CATEGORY) {
      report.truncated = true;
      return;
    }
    const directory = await this.resolvePath(parent, [name], targets, report);
    if (directory?.kind !== 'directory') return;
    const file = await this.resolvePath(directory.canonical, ['SKILL.md'], targets, report);
    if (file?.kind !== 'file' || !file.canonical.endsWith('.md')) return;
    found.push(
      this.locate(context, 'skill', 'skill', `${relativeRoot}/${name}/SKILL.md`, file.canonical, 'project', name),
    );
  }

  private locate(
    context: ScopeContext,
    category: ClaudeResourceCategory,
    kind: ClaudeKnowledgeType | 'agent' | 'skill',
    relativePath: string,
    canonicalPath: string,
    origin: ClaudeConfigOrigin,
    fallbackName = basename(relativePath).replace(/\.md$/i, ''),
  ): LocatedResource {
    const hash = createHash('sha256')
      .update(`${context.root}\0${relativePath}`)
      .digest('hex')
      .slice(0, 32);
    return {
      id: `${category}.${context.token}.${hash}`,
      category,
      origin: context.scope === 'global' ? 'global' : origin,
      relativePath,
      canonicalPath,
      fallbackName: kind === 'instructions' ? basename(relativePath) : fallbackName,
      ...(category === 'knowledge' ? { knowledgeType: kind as ClaudeKnowledgeType } : {}),
    };
  }

  /** Bounded in depth and size. `add` returns the number of resources so far. */
  private async walkMarkdown(
    directory: string,
    relativeRoot: string,
    targets: string[],
    report: DiscoveryReport,
    add: (file: { relativePath: string; canonical: string }) => number,
  ): Promise<void> {
    const visited = new Set<string>();
    const walk = async (current: string, relative: string, depth: number): Promise<boolean> => {
      if (visited.has(current)) return true;
      visited.add(current);
      for (const name of await this.listNames(current, report)) {
        if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue;
        const entry = await this.resolvePath(current, [name], targets, report);
        if (!entry) continue;
        const childRelative = `${relative}/${name}`;
        if (entry.kind === 'directory') {
          if (depth < MAX_MARKDOWN_DEPTH && !(await walk(entry.canonical, childRelative, depth + 1))) {
            return false;
          }
        } else if (name.toLowerCase().endsWith('.md') && entry.canonical.toLowerCase().endsWith('.md')) {
          if (add({ relativePath: childRelative, canonical: entry.canonical }) >= MAX_RESOURCES_PER_CATEGORY) {
            report.truncated = true;
            return false;
          }
        }
      }
      return true;
    };
    await walk(directory, relativeRoot, 1);
  }

  private async listNames(directory: string, report: DiscoveryReport): Promise<string[]> {
    try {
      const names = await readdir(directory);
      if (names.length > MAX_DIRECTORY_ENTRIES) report.truncated = true;
      return names.sort().slice(0, MAX_DIRECTORY_ENTRIES);
    } catch {
      report.unreadable++;
      return [];
    }
  }

  /**
   * Walks from a canonical directory through literal names, applying the symlink policy at every
   * step. Returns null when something is absent, not a regular file or directory, or refused.
   */
  private async resolvePath(
    start: string,
    segments: string[],
    symlinkTargets: string[],
    report: DiscoveryReport,
    allowedLinkFiles?: Set<string>,
  ): Promise<ResolvedEntry | null> {
    let current = start;
    let kind: ResolvedEntry['kind'] = 'directory';
    for (const segment of segments) {
      if (kind !== 'directory') return null;
      const path = join(current, segment);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          const target = await realpath(path);
          const approved =
            symlinkTargets.some((root) => isPathInside(root, target)) ||
            allowedLinkFiles?.has(target) === true;
          if (!approved) {
            report.skippedSymlinks++;
            return null;
          }
          current = target;
          const followed = await stat(target);
          if (!followed.isFile() && !followed.isDirectory()) return null;
          kind = followed.isDirectory() ? 'directory' : 'file';
        } else if (info.isFile() || info.isDirectory()) {
          current = path;
          kind = info.isDirectory() ? 'directory' : 'file';
        } else {
          return null;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') report.skippedSymlinks++;
        else if (code === 'ENOENT' && (await isBrokenLink(path))) report.skippedSymlinks++;
        else if (code !== 'ENOENT' && code !== 'ENOTDIR') report.unreadable++;
        return null;
      }
    }
    return { canonical: current, kind };
  }

  private async symlinkTargets(): Promise<string[]> {
    const targets = await Promise.all(
      this.config.claudeSymlinkTargets.map((target) => realpath(target).catch(() => null)),
    );
    return targets.filter((target) => target !== null);
  }

  /** A configured root is trusted, so links in it are resolved. It must still be a directory. */
  private async directoryRoot(configured: string): Promise<string | null> {
    try {
      const canonical = await realpath(configured);
      return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }
}

async function isBrokenLink(path: string): Promise<boolean> {
  return lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );
}
