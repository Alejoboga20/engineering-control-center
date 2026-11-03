import { parseMarkdownDocument } from './frontmatter';
import {
  parseSettingsJson,
  safeAgentFrontmatter,
  safeRuleFrontmatter,
  safeSkillFrontmatter,
  sanitizeSettings,
  summarizeHooks,
  toolNames,
} from './claude-configuration.sanitizer';

describe('parseMarkdownDocument', () => {
  it('separates frontmatter from the body', () => {
    const document = parseMarkdownDocument('---\nname: a\n---\n\n# Body\n');
    expect(document).toEqual({ frontmatter: 'valid', data: { name: 'a' }, body: '# Body\n' });
  });

  it('handles CRLF and a byte order mark', () => {
    const document = parseMarkdownDocument('﻿---\r\nname: a\r\n---\r\nBody');
    expect(document.data).toEqual({ name: 'a' });
    expect(document.body).toBe('Body');
  });

  it('treats a file with no frontmatter as all body', () => {
    expect(parseMarkdownDocument('# Title\n\n---\n')).toEqual({
      frontmatter: 'none',
      data: {},
      body: '# Title\n\n---\n',
    });
  });

  it.each([
    ['invalid YAML', '---\nname: [unclosed\n---\nBody'],
    ['a non-mapping', '---\n- a\n- b\n---\nBody'],
    ['a scalar', '---\njust text\n---\nBody'],
  ])('keeps the body but no metadata for %s', (_label, source) => {
    expect(parseMarkdownDocument(source)).toEqual({ frontmatter: 'invalid', data: {}, body: 'Body' });
  });

  it('accepts the unquoted colons that Claude Code accepts', () => {
    const document = parseMarkdownDocument(
      '---\nname: a\ndescription: Use when: deploying, "really"\nmodel: opus\n---\nBody',
    );
    expect(document.frontmatter).toBe('valid');
    expect(document.data).toEqual({
      name: 'a',
      description: 'Use when: deploying, "really"',
      model: 'opus',
    });
  });

  it('never returns unterminated frontmatter as body, since it can hold commands', () => {
    const document = parseMarkdownDocument('---\nhooks: {Stop: secret-command}\n\nText');
    expect(document.frontmatter).toBe('invalid');
    expect(document.body).toBe('');
  });

  it('survives YAML alias expansion attacks', () => {
    const bomb = ['---', 'a: &a [x,x,x,x,x,x,x,x,x]', ...'bcdefgh'.split('').map((key, index) =>
      `${key}: &${key} [${Array(9).fill(`*${'abcdefgh'[index]}`).join(',')}]`), '---', 'Body'].join('\n');
    expect(parseMarkdownDocument(bomb)).toMatchObject({ frontmatter: 'invalid', body: 'Body' });
  });
});

describe('toolNames', () => {
  it('accepts a comma-separated string and a list', () => {
    expect(toolNames('Read, Grep, Bash')).toEqual(['Read', 'Grep', 'Bash']);
    expect(toolNames(['Read', 'Edit'])).toEqual(['Read', 'Edit']);
    expect(toolNames('Read Grep')).toEqual(['Read', 'Grep']);
  });

  it('drops permission specifiers, which can embed commands and secrets', () => {
    const names = toolNames('Bash(curl -H "Authorization: Bearer s3cret", *), Agent(worker, other), Read');
    expect(names).toEqual(['Bash', 'Agent', 'Read']);
  });

  it('ignores anything that is not a tool name', () => {
    expect(toolNames(['ok', 'rm -rf /', 3, null])).toEqual(['ok']);
    expect(toolNames({ a: 1 })).toBeUndefined();
    expect(toolNames(7)).toBeUndefined();
  });
});

describe('frontmatter allowlists', () => {
  const dangerous = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl secret' }] }] },
    mcpServers: { db: { command: 'psql', env: { TOKEN: 'secret' } } },
    initialPrompt: 'secret prompt',
    apiKey: 'secret',
  };

  it('keeps only known agent fields', () => {
    const safe = safeAgentFrontmatter({
      name: 'builder',
      description: 'Builds',
      model: 'inherit',
      tools: 'Read, Bash(rm:*)',
      maxTurns: 5,
      background: true,
      permissionMode: 'plan',
      ...dangerous,
    });
    expect(safe).toEqual({
      name: 'builder',
      description: 'Builds',
      model: 'inherit',
      tools: ['Read', 'Bash'],
      disallowedTools: undefined,
      metadata: { maxTurns: 5, background: true, permissionMode: 'plan' },
    });
    expect(JSON.stringify(safe)).not.toContain('secret');
  });

  it('keeps only known Skill fields', () => {
    const safe = safeSkillFrontmatter({
      description: 'Does',
      'allowed-tools': 'Bash(deploy --token abc) Read',
      'user-invocable': false,
      ...dangerous,
    });
    expect(safe.tools).toEqual(['Bash', 'Read']);
    expect(safe.metadata).toEqual({ 'user-invocable': false });
    expect(JSON.stringify(safe)).not.toMatch(/secret|abc/);
  });

  it('keeps only paths from a rule', () => {
    expect(safeRuleFrontmatter({ paths: 'src/**, test/**', name: 'x' })).toEqual({
      metadata: { paths: ['src/**', 'test/**'] },
    });
  });

  it('omits a model that could name an account or host', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x';
    expect(safeAgentFrontmatter({ model: arn }).model).toBeUndefined();
    expect(safeAgentFrontmatter({ model: 'https://internal.example/m' }).model).toBeUndefined();
    expect(safeAgentFrontmatter({ model: 'claude-opus-5-5[1m]' }).model).toBe('claude-opus-5-5[1m]');
  });

  it('rejects unexpected types, and inherited names', () => {
    const safe = safeAgentFrontmatter({ name: { a: 1 }, description: 7, maxTurns: 'x', model: ['m'] });
    expect(safe).toMatchObject({ name: undefined, description: undefined, model: undefined });
    expect(safe.metadata).toBeUndefined();
    expect(safeAgentFrontmatter(JSON.parse('{"__proto__":{"name":"x"}}')).name).toBeUndefined();
  });
});

describe('summarizeHooks', () => {
  const settings = {
    hooks: {
      Stop: [
        { matcher: 'secret-matcher', hooks: [{ type: 'command', command: 'curl -H "x: secret" evil' }] },
        { hooks: [{ type: 'http', url: 'https://secret.example', headers: { a: 'secret' } }] },
      ],
      PreToolUse: [{ hooks: [{ type: 'weird', command: 'secret' }, 'not-an-object'] }],
      'secret-event-name': [{ hooks: [{ type: 'command', command: 'x' }] }],
      Notification: 'malformed',
      SessionEnd: [{ hooks: 'malformed' }, null],
    },
  };

  it('returns structure only', () => {
    const summary = summarizeHooks(settings);
    expect(summary.registrations).toEqual([
      { event: 'Stop', handlerCount: 2, matcherGroupCount: 2, handlerTypes: ['command', 'http'] },
      { event: 'PreToolUse', handlerCount: 1, matcherGroupCount: 1, handlerTypes: ['other'] },
      { event: 'SessionEnd', handlerCount: 0, matcherGroupCount: 2, handlerTypes: [] },
    ]);
    expect(summary.unrecognizedEventCount).toBe(1);
    expect(JSON.stringify(summary)).not.toMatch(/secret|curl|evil/);
  });

  it('copes with no hooks, and reports disableAllHooks', () => {
    expect(summarizeHooks({ disableAllHooks: true })).toEqual({
      registrations: [],
      unrecognizedEventCount: 0,
      allHooksDisabled: true,
    });
    expect(summarizeHooks({ hooks: [] }).registrations).toEqual([]);
  });
});

describe('sanitizeSettings', () => {
  const field = (result: ReturnType<typeof sanitizeSettings>, key: string) =>
    result.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === key)?.value;

  it('shows allowlisted fields, grouped', () => {
    const result = sanitizeSettings({
      model: 'opus',
      theme: 'dark',
      verbose: false,
      statusLine: { type: 'command', command: 'secret-status' },
      enabledPlugins: { a: true, b: false, c: true },
      permissions: { defaultMode: 'plan', allow: ['Bash(secret:*)', 'Read'], deny: [] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'secret' }] }] },
      enabledMcpjsonServers: ['secret-server'],
    });
    expect(result.groups.map((group) => group.category)).toEqual([
      'Model', 'Interface', 'Permissions', 'Hooks', 'MCP', 'Plugins',
    ]);
    expect(field(result, 'model')).toBe('opus');
    expect(field(result, 'statusLine')).toBe(true);
    expect(field(result, 'enabledPlugins')).toBe(2);
    expect(field(result, 'permissions.defaultMode')).toBe('plan');
    expect(field(result, 'permissions.allow')).toBe(2);
    expect(field(result, 'hooks.handlers')).toBe(1);
    expect(field(result, 'enabledMcpjsonServers')).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('hides everything else, and only counts it', () => {
    const result = sanitizeSettings({
      apiKeyHelper: '/secret/helper',
      env: { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret' },
      awsAuthRefresh: 'secret',
      someFutureField: 'secret',
    });
    expect(result).toEqual({ groups: [], hiddenFieldCount: 4 });
  });

  it('omits allowlisted fields with values it cannot vouch for', () => {
    const result = sanitizeSettings({
      model: 'https://user:secret@proxy.example/model',
      theme: { custom: 'secret' },
      permissions: { defaultMode: 'secret-mode' },
      verbose: 'secret',
    });
    expect(result.groups).toEqual([]);
  });

  it('does not quote the file when JSON is invalid', () => {
    expect(parseSettingsJson('{"token": "secret"')).toBeNull();
    expect(parseSettingsJson('[1]')).toBeNull();
    expect(parseSettingsJson('{"a":1}')).toEqual({ a: 1 });
  });
});
