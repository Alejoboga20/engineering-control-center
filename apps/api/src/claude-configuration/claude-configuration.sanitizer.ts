import type {
  ClaudeHookRegistration,
  ClaudeMetadataValue,
  ClaudeSettingField,
  ClaudeSettingGroup,
} from '@ecc/shared';

/**
 * Everything here is an allowlist. Unknown fields are dropped rather than redacted, since no
 * redaction of arbitrary shell commands or free-form settings can be trusted.
 */

type Json = Record<string, unknown>;

const MAX_TEXT = 2048;
const MAX_LIST = 100;
/** Excludes URLs, paths and ARNs, which can name accounts or internal hosts. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9 ._[\]-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_*.:-]{1,128}$/;

/** From the Claude Code hooks reference. Other names may be anything, so they are only counted. */
const HOOK_EVENTS = new Set([
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated',
  'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact',
  'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult',
  'SessionEnd',
]);
const HOOK_HANDLER_TYPES = new Set(['command', 'http', 'mcp_tool', 'prompt', 'agent']);
const PERMISSION_MODES = new Set([
  'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual',
]);

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(source: Json, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, MAX_TEXT) : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function enumerated(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function textList(value: unknown): string[] | undefined {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (!items) return undefined;
  const list = items
    .map((item: unknown) => (typeof item === 'string' ? item.trim().slice(0, MAX_TEXT) : ''))
    .filter(Boolean)
    .slice(0, MAX_LIST);
  return list.length > 0 ? list : undefined;
}

/** Splits outside parentheses, so that `Bash(a, b), Read` is two entries. */
function splitOutsideParentheses(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** Keeps tool names. The specifier in `Bash(curl -H "Authorization: ..." *)` is a permission rule. */
export function toolNames(value: unknown): string[] | undefined {
  const raw = typeof value === 'string' ? splitOutsideParentheses(value) : value;
  if (!Array.isArray(raw)) return undefined;
  const names = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().split('(', 1)[0];
    if (TOOL_NAME.test(name)) names.add(name);
    if (names.size >= MAX_LIST) break;
  }
  return names.size > 0 ? [...names] : undefined;
}

export interface SafeFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  metadata?: Record<string, ClaudeMetadataValue>;
}

function collectMetadata(
  entries: [string, ClaudeMetadataValue | undefined][],
): Record<string, ClaudeMetadataValue> | undefined {
  const present = entries.filter(
    (entry): entry is [string, ClaudeMetadataValue] => entry[1] !== undefined,
  );
  return present.length > 0 ? Object.fromEntries(present) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** `hooks`, `mcpServers` and `initialPrompt` are deliberately absent. */
export function safeAgentFrontmatter(data: Json): SafeFrontmatter {
  return {
    name: text(own(data, 'name')),
    description: text(own(data, 'description')),
    model: identifier(own(data, 'model')),
    tools: toolNames(own(data, 'tools')),
    disallowedTools: toolNames(own(data, 'disallowedTools')),
    metadata: collectMetadata([
      ['permissionMode', enumerated(own(data, 'permissionMode'), PERMISSION_MODES)],
      ['maxTurns', finite(own(data, 'maxTurns'))],
      ['skills', textList(own(data, 'skills'))],
      ['memory', identifier(own(data, 'memory'))],
      ['background', bool(own(data, 'background'))],
      ['isolation', identifier(own(data, 'isolation'))],
      ['color', identifier(own(data, 'color'))],
      ['effort', identifier(own(data, 'effort'))],
    ]),
  };
}

/** `hooks` is deliberately absent. */
export function safeSkillFrontmatter(data: Json): SafeFrontmatter {
  return {
    name: text(own(data, 'name')),
    description: text(own(data, 'description')),
    model: identifier(own(data, 'model')),
    tools: toolNames(own(data, 'allowed-tools')),
    disallowedTools: toolNames(own(data, 'disallowed-tools')),
    metadata: collectMetadata([
      ['when_to_use', text(own(data, 'when_to_use'))],
      ['argument-hint', text(own(data, 'argument-hint'))],
      ['disable-model-invocation', bool(own(data, 'disable-model-invocation'))],
      ['user-invocable', bool(own(data, 'user-invocable'))],
      ['effort', identifier(own(data, 'effort'))],
      ['context', identifier(own(data, 'context'))],
      ['agent', identifier(own(data, 'agent'))],
      ['background', bool(own(data, 'background'))],
      ['paths', textList(own(data, 'paths'))],
      ['shell', identifier(own(data, 'shell'))],
      ['license', text(own(data, 'license'))],
      ['compatibility', text(own(data, 'compatibility'))],
    ]),
  };
}

/** `paths` is the only field Claude Code reads from a rule. */
export function safeRuleFrontmatter(data: Json): SafeFrontmatter {
  return { metadata: collectMetadata([['paths', textList(own(data, 'paths'))]]) };
}

export interface HookSummary {
  registrations: Omit<ClaudeHookRegistration, 'origin' | 'relativePath'>[];
  unrecognizedEventCount: number;
  allHooksDisabled: boolean;
}

/** Structure only: never commands, arguments, URLs, headers, prompts or matchers. */
export function summarizeHooks(settings: Json): HookSummary {
  const hooks = own(settings, 'hooks');
  const summary: HookSummary = {
    registrations: [],
    unrecognizedEventCount: 0,
    allHooksDisabled: own(settings, 'disableAllHooks') === true,
  };
  if (!isObject(hooks)) return summary;

  for (const event of Object.keys(hooks)) {
    if (!HOOK_EVENTS.has(event)) {
      summary.unrecognizedEventCount++;
      continue;
    }
    const groups = own(hooks, event);
    if (!Array.isArray(groups)) continue;
    const handlers = groups.flatMap((group: unknown) => {
      const list = isObject(group) ? own(group, 'hooks') : undefined;
      return Array.isArray(list) ? list.filter(isObject) : [];
    });
    const types = handlers.map((handler) => {
      const type = own(handler, 'type');
      return typeof type === 'string' && HOOK_HANDLER_TYPES.has(type) ? type : 'other';
    });
    summary.registrations.push({
      event,
      handlerCount: handlers.length,
      matcherGroupCount: groups.length,
      handlerTypes: [...new Set(types)].sort(),
    });
  }
  return summary;
}

function count(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return isObject(value) ? Object.keys(value).length : undefined;
}

type FieldReader = (settings: Json) => string | number | boolean | undefined;

interface FieldRule {
  key: string;
  label: string;
  read: FieldReader;
}

const direct =
  (key: string, read: (value: unknown) => string | number | boolean | undefined): FieldReader =>
  (settings) =>
    read(own(settings, key));

function permissionList(name: string): FieldReader {
  return (settings) => {
    const permissions = own(settings, 'permissions');
    return isObject(permissions) ? count(own(permissions, name)) : undefined;
  };
}

function hookTotals(settings: Json, field: 'events' | 'handlers'): number | undefined {
  if (!isObject(own(settings, 'hooks'))) return undefined;
  const { registrations } = summarizeHooks(settings);
  return field === 'events'
    ? registrations.length
    : registrations.reduce((total, registration) => total + registration.handlerCount, 0);
}

/**
 * Every field a settings file can show. A top-level key outside these rules is only counted as
 * hidden, however harmless it looks.
 */
const SETTING_RULES: { category: string; source: string[]; fields: FieldRule[] }[] = [
  {
    category: 'Model',
    source: ['model', 'effortLevel', 'alwaysThinkingEnabled'],
    fields: [
      { key: 'model', label: 'Model', read: direct('model', identifier) },
      { key: 'effortLevel', label: 'Effort level', read: direct('effortLevel', identifier) },
      {
        key: 'alwaysThinkingEnabled',
        label: 'Always use extended thinking',
        read: direct('alwaysThinkingEnabled', bool),
      },
    ],
  },
  {
    category: 'Interface',
    source: ['theme', 'outputStyle', 'language', 'editorMode', 'spinnerTipsEnabled', 'verbose', 'statusLine'],
    fields: [
      { key: 'theme', label: 'Theme', read: direct('theme', identifier) },
      { key: 'outputStyle', label: 'Output style', read: direct('outputStyle', identifier) },
      { key: 'language', label: 'Language', read: direct('language', identifier) },
      { key: 'editorMode', label: 'Editor mode', read: direct('editorMode', identifier) },
      { key: 'spinnerTipsEnabled', label: 'Spinner tips', read: direct('spinnerTipsEnabled', bool) },
      { key: 'verbose', label: 'Verbose output', read: direct('verbose', bool) },
      {
        key: 'statusLine',
        label: 'Custom status line configured',
        read: (settings) => (isObject(own(settings, 'statusLine')) ? true : undefined),
      },
    ],
  },
  {
    category: 'Behavior',
    source: ['autoCompactEnabled', 'autoMemoryEnabled', 'includeGitInstructions', 'respectGitignore', 'cleanupPeriodDays'],
    fields: [
      { key: 'autoCompactEnabled', label: 'Automatic compaction', read: direct('autoCompactEnabled', bool) },
      { key: 'autoMemoryEnabled', label: 'Automatic memory', read: direct('autoMemoryEnabled', bool) },
      { key: 'includeGitInstructions', label: 'Git instructions included', read: direct('includeGitInstructions', bool) },
      { key: 'respectGitignore', label: 'Respect .gitignore', read: direct('respectGitignore', bool) },
      { key: 'cleanupPeriodDays', label: 'Cleanup period (days)', read: direct('cleanupPeriodDays', finite) },
    ],
  },
  {
    category: 'Permissions',
    source: ['permissions'],
    fields: [
      {
        key: 'permissions.defaultMode',
        label: 'Default mode',
        read: (settings) => {
          const permissions = own(settings, 'permissions');
          return isObject(permissions)
            ? enumerated(own(permissions, 'defaultMode'), PERMISSION_MODES)
            : undefined;
        },
      },
      { key: 'permissions.allow', label: 'Allow rules', read: permissionList('allow') },
      { key: 'permissions.ask', label: 'Ask rules', read: permissionList('ask') },
      { key: 'permissions.deny', label: 'Deny rules', read: permissionList('deny') },
    ],
  },
  {
    category: 'Hooks',
    source: ['hooks', 'disableAllHooks'],
    fields: [
      { key: 'hooks.events', label: 'Events with hooks', read: (settings) => hookTotals(settings, 'events') },
      { key: 'hooks.handlers', label: 'Hook handlers', read: (settings) => hookTotals(settings, 'handlers') },
      { key: 'disableAllHooks', label: 'All hooks disabled', read: direct('disableAllHooks', bool) },
    ],
  },
  {
    category: 'MCP',
    source: ['mcpServers', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'],
    fields: [
      { key: 'mcpServers', label: 'MCP servers defined here', read: direct('mcpServers', count) },
      { key: 'enableAllProjectMcpServers', label: 'All project MCP servers enabled', read: direct('enableAllProjectMcpServers', bool) },
      { key: 'enabledMcpjsonServers', label: 'Approved .mcp.json servers', read: direct('enabledMcpjsonServers', count) },
      { key: 'disabledMcpjsonServers', label: 'Rejected .mcp.json servers', read: direct('disabledMcpjsonServers', count) },
    ],
  },
  {
    category: 'Plugins',
    source: ['enabledPlugins'],
    fields: [
      {
        key: 'enabledPlugins',
        label: 'Enabled plugins',
        read: (settings) => {
          const plugins = own(settings, 'enabledPlugins');
          return isObject(plugins)
            ? Object.values(plugins).filter((enabled) => enabled === true).length
            : undefined;
        },
      },
    ],
  },
];

const KNOWN_SETTINGS = new Set(SETTING_RULES.flatMap((rule) => rule.source));

export function sanitizeSettings(settings: Json): {
  groups: ClaudeSettingGroup[];
  hiddenFieldCount: number;
} {
  const groups: ClaudeSettingGroup[] = [];
  for (const rule of SETTING_RULES) {
    const fields: ClaudeSettingField[] = [];
    for (const { key, label, read } of rule.fields) {
      const value = read(settings);
      if (value !== undefined) fields.push({ key, label, value });
    }
    if (fields.length > 0) groups.push({ category: rule.category, fields });
  }
  return {
    groups,
    hiddenFieldCount: Object.keys(settings).filter((key) => !KNOWN_SETTINGS.has(key)).length,
  };
}

/** Never includes the parse error, because V8 quotes the file's content in it. */
export function parseSettingsJson(text_: string): Json | null {
  try {
    const value: unknown = JSON.parse(text_.replace(/^\uFEFF/, ''));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

