/** The read-only Claude Code configuration explorer. Nothing here carries raw settings. */

export type ClaudeConfigScope = 'global' | 'project';

/** Where a resource comes from. `local` means personal to a project, normally not in Git. */
export type ClaudeConfigOrigin = 'global' | 'project' | 'local';

export type ClaudeResourceCategory = 'agent' | 'skill' | 'knowledge';

export type ClaudeKnowledgeType = 'instructions' | 'rule' | 'knowledge-directory';

export type ClaudeMetadataValue = string | number | boolean | string[];

export interface ClaudeConfigProject {
  /** Opaque. Callers select projects by this, never by path. */
  id: string;
  name: string;
  path: string;
  hasConfiguration: boolean;
}

export interface ClaudeConfigScopesResponse {
  global: {
    available: boolean;
    /** How the directory is known, such as `~/.claude`. Not a resolved path. */
    label: string;
  };
  projects: ClaudeConfigProject[];
}

export interface ClaudeResourceSummary {
  /** Opaque, and only meaningful for a resource that discovery can still find. */
  id: string;
  category: ClaudeResourceCategory;
  name: string;
  origin: ClaudeConfigOrigin;
  /** Relative to the scope's root. Never absolute. */
  relativePath: string;
  knowledgeType?: ClaudeKnowledgeType;
  description?: string;
  model?: string;
  /** Tool names only. Permission specifiers such as `Bash(git push:*)` are reduced to `Bash`. */
  tools?: string[];
  disallowedTools?: string[];
  /** Allowlisted frontmatter fields actually present in the file. */
  metadata?: Record<string, ClaudeMetadataValue>;
  hasContent: boolean;
  frontmatter: 'none' | 'valid' | 'invalid';
  /** Why the content cannot be read, when `hasContent` is false. */
  unavailable?: 'too-large' | 'unreadable' | 'unsafe';
}

export interface ClaudeResourceDetail extends ClaudeResourceSummary {
  /** Markdown after the frontmatter. The frontmatter itself is never returned. */
  body: string;
  modifiedAt?: string;
}

export interface ClaudeDiscoveryNotes {
  /** Symlinks not followed, because their targets are not approved. */
  skippedSymlinks: number;
  /** Directories or files that the backend user is not permitted to read. */
  unreadable: number;
  /** True when the result limit was reached. */
  truncated: boolean;
}

export interface ClaudeResourceListResponse extends ClaudeDiscoveryNotes {
  items: ClaudeResourceSummary[];
}

export type ClaudeConfigFileStatus =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'too-large'
  | 'unreadable'
  | 'unsafe';

export interface ClaudeHookRegistration {
  event: string;
  handlerCount: number;
  matcherGroupCount: number;
  /** For example `command` or `http`. A type this version does not recognize is `other`. */
  handlerTypes: string[];
  origin: ClaudeConfigOrigin;
  relativePath: string;
}

export interface ClaudeHookFileSummary {
  origin: ClaudeConfigOrigin;
  relativePath: string;
  status: ClaudeConfigFileStatus;
  /** Events with names that this version does not recognize. Their names are not returned. */
  unrecognizedEventCount: number;
  allHooksDisabled: boolean;
}

export interface ClaudeHooksResponse {
  registrations: ClaudeHookRegistration[];
  files: ClaudeHookFileSummary[];
}

export interface ClaudeSettingField {
  key: string;
  label: string;
  value: string | number | boolean;
}

export interface ClaudeSettingGroup {
  category: string;
  fields: ClaudeSettingField[];
}

export interface ClaudeSettingsFile {
  origin: ClaudeConfigOrigin;
  relativePath: string;
  status: ClaudeConfigFileStatus;
  groups: ClaudeSettingGroup[];
  /** Top-level settings present in the file and intentionally not shown. */
  hiddenFieldCount: number;
}

export interface ClaudeSettingsResponse {
  files: ClaudeSettingsFile[];
  /** The project's `.mcp.json`, when looking at a project. Only a count is read from it. */
  mcpDefinitions?: {
    relativePath: string;
    status: ClaudeConfigFileStatus;
    serverCount: number;
  };
}
