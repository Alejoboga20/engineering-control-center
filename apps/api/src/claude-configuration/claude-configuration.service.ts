import { Injectable } from '@nestjs/common';
import type {
  ClaudeConfigFileStatus,
  ClaudeConfigProject,
  ClaudeConfigScope,
  ClaudeConfigScopesResponse,
  ClaudeHookFileSummary,
  ClaudeHookRegistration,
  ClaudeHooksResponse,
  ClaudeResourceDetail,
  ClaudeResourceListResponse,
  ClaudeResourceSummary,
  ClaudeSettingsFile,
  ClaudeSettingsResponse,
} from '@ecc/shared';
import { basename } from 'node:path';
import { ApiError } from '../common/api-error';
import { ProjectDirectoriesService } from '../sessions/project-directories.service';
import {
  ClaudeConfigurationDiscoveryService,
  DiscoveryReport,
  LocatedConfigFile,
  LocatedResource,
  parseResourceId,
  projectIdOf,
  ScopeContext,
} from './claude-configuration-discovery.service';
import {
  parseSettingsJson,
  safeAgentFrontmatter,
  safeRuleFrontmatter,
  safeSkillFrontmatter,
  SafeFrontmatter,
  sanitizeSettings,
  summarizeHooks,
} from './claude-configuration.sanitizer';
import { ConfinedRead, readConfinedFile } from './confined-file';
import { MarkdownDocument, MAX_FRONTMATTER_BYTES, parseMarkdownDocument } from './frontmatter';

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;

export interface ScopeSelection {
  scope?: ClaudeConfigScope;
  project?: string;
}

function safeFieldsOf(resource: LocatedResource, document: MarkdownDocument): SafeFrontmatter {
  if (resource.category === 'agent') return safeAgentFrontmatter(document.data);
  if (resource.category === 'skill') return safeSkillFrontmatter(document.data);
  return resource.knowledgeType === 'rule' ? safeRuleFrontmatter(document.data) : {};
}

/** Only includes what the file states. The name falls back to the file or directory name. */
function buildSummary(
  resource: LocatedResource,
  read: ConfinedRead,
  document: MarkdownDocument | null,
): ClaudeResourceSummary {
  const summary: ClaudeResourceSummary = {
    id: resource.id,
    category: resource.category,
    name: resource.fallbackName,
    origin: resource.origin,
    relativePath: resource.relativePath,
    hasContent: read.status === 'ok',
    frontmatter: document?.frontmatter ?? 'none',
  };
  if (resource.knowledgeType) summary.knowledgeType = resource.knowledgeType;
  if (read.status === 'too-large' || read.status === 'unreadable' || read.status === 'unsafe') {
    summary.unavailable = read.status;
  }
  if (!document) return summary;

  const { name, description, model, tools, disallowedTools, metadata } = safeFieldsOf(resource, document);
  if (name) summary.name = name;
  if (description) summary.description = description;
  if (model) summary.model = model;
  if (tools) summary.tools = tools;
  if (disallowedTools) summary.disallowedTools = disallowedTools;
  if (metadata) summary.metadata = metadata;
  return summary;
}

@Injectable()
export class ClaudeConfigurationService {
  constructor(
    private readonly discovery: ClaudeConfigurationDiscoveryService,
    private readonly projects: ProjectDirectoriesService,
  ) {}

  async listScopes(): Promise<ClaudeConfigScopesResponse> {
    const global = await this.discovery.globalContext();
    return {
      global: {
        available: global.root !== null,
        label: this.discovery.globalLabel(),
      },
      projects: await this.listProjects(),
    };
  }

  listAgents(selection: ScopeSelection): Promise<ClaudeResourceListResponse> {
    return this.listResources(selection, (context, report) =>
      this.discovery.discoverAgents(context, report),
    );
  }

  listSkills(selection: ScopeSelection): Promise<ClaudeResourceListResponse> {
    return this.listResources(selection, (context, report) =>
      this.discovery.discoverSkills(context, report),
    );
  }

  listKnowledge(selection: ScopeSelection): Promise<ClaudeResourceListResponse> {
    return this.listResources(selection, (context, report) =>
      this.discovery.discoverKnowledge(context, report),
    );
  }

  async getResource(id: string): Promise<ClaudeResourceDetail> {
    const notFound = () =>
      new ApiError(404, 'CLAUDE_RESOURCE_NOT_FOUND', 'No such configuration resource.');
    const parsed = parseResourceId(id);
    if (!parsed) throw notFound();

    const context =
      parsed.token === 'global'
        ? await this.discovery.globalContext()
        : await this.projectContextOf(parsed.token).catch(() => {
            throw notFound();
          });
    const report = new DiscoveryReport();
    const resources =
      parsed.category === 'agent'
        ? await this.discovery.discoverAgents(context, report)
        : parsed.category === 'skill'
          ? await this.discovery.discoverSkills(context, report)
          : await this.discovery.discoverKnowledge(context, report);
    const resource = resources.find((candidate) => candidate.id === id);
    if (!resource) throw notFound();

    const read = await readConfinedFile(resource.canonicalPath, { maxFileBytes: MAX_MARKDOWN_BYTES });
    if (read.status === 'too-large') {
      throw new ApiError(413, 'CLAUDE_RESOURCE_TOO_LARGE', 'This file is over the 1 MiB display limit.');
    }
    if (read.status === 'missing') throw notFound();
    if (read.status !== 'ok') {
      throw new ApiError(403, 'CLAUDE_RESOURCE_UNREADABLE', 'This file cannot be read safely.');
    }
    const document = parseMarkdownDocument(read.text);
    return {
      ...buildSummary(resource, read, document),
      body: document.body,
      modifiedAt: read.modifiedAt,
    };
  }

  async listHooks(selection: ScopeSelection): Promise<ClaudeHooksResponse> {
    const context = await this.resolveContext(selection);
    const registrations: ClaudeHookRegistration[] = [];
    const files: ClaudeHookFileSummary[] = [];
    for (const file of await this.discovery.locateSettingsFiles(context)) {
      const { status, settings } = await this.readJson(file);
      const summary = settings ? summarizeHooks(settings) : null;
      files.push({
        origin: file.origin,
        relativePath: file.relativePath,
        status,
        unrecognizedEventCount: summary?.unrecognizedEventCount ?? 0,
        allHooksDisabled: summary?.allHooksDisabled ?? false,
      });
      for (const registration of summary?.registrations ?? []) {
        registrations.push({ ...registration, origin: file.origin, relativePath: file.relativePath });
      }
    }
    return { registrations, files };
  }

  async getSettings(selection: ScopeSelection): Promise<ClaudeSettingsResponse> {
    const context = await this.resolveContext(selection);
    const files: ClaudeSettingsFile[] = [];
    for (const file of await this.discovery.locateSettingsFiles(context)) {
      const { status, settings } = await this.readJson(file);
      files.push({
        origin: file.origin,
        relativePath: file.relativePath,
        status,
        ...(settings ? sanitizeSettings(settings) : { groups: [], hiddenFieldCount: 0 }),
      });
    }
    if (context.scope === 'global') return { files };

    const mcp = await this.discovery.locateMcpDefinitions(context);
    const { status, settings } = await this.readJson(mcp);
    const servers = settings?.mcpServers;
    return {
      files,
      mcpDefinitions: {
        relativePath: mcp.relativePath,
        status,
        serverCount:
          typeof servers === 'object' && servers !== null ? Object.keys(servers).length : 0,
      },
    };
  }

  private async listResources(
    selection: ScopeSelection,
    discover: (context: ScopeContext, report: DiscoveryReport) => Promise<LocatedResource[]>,
  ): Promise<ClaudeResourceListResponse> {
    const context = await this.resolveContext(selection);
    const report = new DiscoveryReport();
    const located = await discover(context, report);
    const items: ClaudeResourceSummary[] = [];
    for (const resource of located) items.push(await this.summarize(resource));
    items.sort(
      (a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath),
    );
    return {
      items,
      skippedSymlinks: report.skippedSymlinks,
      unreadable: report.unreadable,
      truncated: report.truncated,
    };
  }

  /** Reads no more than the head of each file, so listing never holds bodies in memory. */
  private async summarize(resource: LocatedResource): Promise<ClaudeResourceSummary> {
    const read = await readConfinedFile(resource.canonicalPath, {
      maxFileBytes: MAX_MARKDOWN_BYTES,
      readBytes: MAX_FRONTMATTER_BYTES,
    });
    return buildSummary(resource, read, read.status === 'ok' ? parseMarkdownDocument(read.text) : null);
  }

  private async readJson(
    file: LocatedConfigFile,
  ): Promise<{ status: ClaudeConfigFileStatus; settings: Record<string, unknown> | null }> {
    if (!file.canonicalPath) return { status: file.status ?? 'missing', settings: null };
    const read = await readConfinedFile(file.canonicalPath, { maxFileBytes: MAX_SETTINGS_BYTES });
    if (read.status !== 'ok') return { status: read.status, settings: null };
    const settings = parseSettingsJson(read.text);
    return settings ? { status: 'ok', settings } : { status: 'invalid', settings: null };
  }

  private async resolveContext({ scope = 'global', project }: ScopeSelection): Promise<ScopeContext> {
    if (scope === 'global') {
      if (project !== undefined) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'The global scope does not take a project.');
      }
      return this.discovery.globalContext();
    }
    if (project === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The project scope requires a project.');
    }
    return this.projectContextOf(project);
  }

  /** Projects are looked up among those currently approved, so an ID outlives no root. */
  private async projectContextOf(projectId: string): Promise<ScopeContext> {
    const paths = await this.approvedProjectPaths();
    const path = paths.find((candidate) => projectIdOf(candidate) === projectId);
    if (!path) {
      throw new ApiError(404, 'CLAUDE_PROJECT_NOT_FOUND', 'No such project under the configured roots.');
    }
    return this.discovery.projectContext(path);
  }

  private async approvedProjectPaths(): Promise<string[]> {
    const { roots, directories } = await this.projects.listProjects();
    return [...new Set([...roots, ...directories.map((directory) => directory.path)])];
  }

  private async listProjects(): Promise<ClaudeConfigProject[]> {
    const { roots, directories } = await this.projects.listProjects();
    const named = new Map(directories.map((directory) => [directory.path, directory.name]));
    const projects: ClaudeConfigProject[] = [];
    for (const path of new Set([...roots, ...named.keys()])) {
      const hasConfiguration = await this.discovery.hasProjectConfiguration(path);
      // A root is mostly a container, so it is listed only when it is configured itself.
      if (!named.has(path) && !hasConfiguration) continue;
      projects.push({
        id: projectIdOf(path),
        name: named.get(path) ?? basename(path),
        path,
        hasConfiguration,
      });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }
}
