import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ClaudeConfigScopesResponse,
  ClaudeHooksResponse,
  ClaudeResourceDetail,
  ClaudeResourceListResponse,
  ClaudeResourceSummary,
  ClaudeSettingsResponse,
} from '@ecc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { installBrowserFakes } from '../test/fakes';
import { stats } from '../test/fixtures';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('../test/fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const PROJECT_ID = 'aaaaaaaaaaaaaaaa';

const scopes: ClaudeConfigScopesResponse = {
  global: { available: true, label: '~/.claude' },
  projects: [
    { id: 'bbbbbbbbbbbbbbbb', name: 'bare', path: '/p/bare', hasConfiguration: false },
    { id: PROJECT_ID, name: 'payroll', path: '/p/payroll', hasConfiguration: true },
  ],
};

const builder: ClaudeResourceSummary = {
  id: 'agent.global.1',
  category: 'agent',
  name: 'builder',
  origin: 'global',
  relativePath: 'agents/builder.md',
  description: 'Builds features',
  model: 'inherit',
  tools: ['Read', 'Bash'],
  hasContent: true,
  frontmatter: 'valid',
};
const reviewer: ClaudeResourceSummary = {
  ...builder,
  id: 'agent.global.2',
  name: 'reviewer',
  relativePath: 'agents/reviewer.md',
  description: 'Reviews changes',
};

function resourceList(items: ClaudeResourceSummary[]): ClaudeResourceListResponse {
  return { items, skippedSymlinks: 0, unreadable: 0, truncated: false };
}

type Reply = { status: number; body?: unknown };
let replies: Record<string, Reply | (() => Reply) | undefined>;

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    const configured = replies[url];
    const reply: Reply =
      (typeof configured === 'function' ? configured() : configured) ??
      (url === '/api/sessions'
        ? { status: 200, body: [] }
        : url === '/api/system/stats'
          ? { status: 200, body: stats }
          : url === '/api/claude/config/scopes'
            ? { status: 200, body: scopes }
            : url.startsWith('/api/claude/config/hooks')
              ? { status: 200, body: { registrations: [], files: [] } }
              : url.startsWith('/api/claude/config/settings')
                ? { status: 200, body: { files: [] } }
                : url.startsWith('/api/claude/config/')
                  ? { status: 200, body: resourceList([]) }
                  : { status: 404, body: { code: 'NOT_FOUND', message: `Not found: ${url}` } });
    return { status: reply.status, ok: reply.status < 400, json: async () => reply.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openConfiguration() {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Configuration' }));
  return screen.findByRole('heading', { name: 'Claude Configuration' });
}

const category = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Configuration categories' })).getByRole('button', { name });

const GLOBAL_AGENTS = '/api/claude/config/agents?scope=global';

describe('Configuration page', () => {
  beforeEach(() => {
    installBrowserFakes();
    window.location.hash = '';
    replies = {};
    mockApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is reachable from the navigation, and starts on global agents', async () => {
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder]) };
    await openConfiguration();
    expect(screen.getByRole('button', { name: 'Configuration' })).toHaveAttribute('aria-current', 'page');
    expect(category('Agents')).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('button', { name: /builder/ })).toBeInTheDocument();
  });

  it('keeps session navigation working', async () => {
    await openConfiguration();
    await userEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.queryByRole('heading', { name: 'Claude Configuration' })).not.toBeInTheDocument();
  });

  it('switches category, and requests only what that category needs', async () => {
    const fetchMock = mockApi();
    await openConfiguration();
    for (const [name, path] of [
      ['Skills', 'skills'],
      ['Knowledge', 'knowledge'],
      ['Hooks', 'hooks'],
      ['Settings', 'settings'],
    ]) {
      await userEvent.click(category(name));
      expect(category(name)).toHaveAttribute('aria-current', 'page');
      await waitFor(() =>
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
          `/api/claude/config/${path}?scope=global`,
        ),
      );
    }
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('selects a scope and a project, preferring a configured project', async () => {
    const fetchMock = mockApi();
    await openConfiguration();
    const projectSelect = screen.getByLabelText('Project');
    expect(projectSelect).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
        `/api/claude/config/agents?scope=project&project=${PROJECT_ID}`,
      ),
    );
    expect(projectSelect).toBeEnabled();
    expect(projectSelect).toHaveValue(PROJECT_ID);
    expect(screen.getByRole('option', { name: 'bare (no configuration)' })).toBeInTheDocument();

    await userEvent.selectOptions(projectSelect, 'bbbbbbbbbbbbbbbb');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
        '/api/claude/config/agents?scope=project&project=bbbbbbbbbbbbbbbb',
      ),
    );
  });

  it('explains when there are no projects', async () => {
    replies['/api/claude/config/scopes'] = { status: 200, body: { ...scopes, projects: [] } };
    await openConfiguration();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    expect(await screen.findByText(/No projects were found/)).toBeInTheDocument();
  });

  it('shows the error, not an empty list, when scopes cannot be loaded', async () => {
    replies['/api/claude/config/scopes'] = {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    };
    await openConfiguration();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error.');
    expect(screen.queryByText(/No projects were found/)).not.toBeInTheDocument();
  });

  it('clears the selected resource when the scope changes', async () => {
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder]) };
    replies['/api/claude/config/resources/agent.global.1'] = {
      status: 200,
      body: { ...builder, body: 'Instructions' },
    };
    await openConfiguration();
    await userEvent.click(await screen.findByRole('button', { name: /builder/ }));
    expect(await screen.findByText('Instructions')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    await waitFor(() => expect(screen.queryByText('Instructions')).not.toBeInTheDocument());
  });

  it('filters by name, description and path', async () => {
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder, reviewer]) };
    await openConfiguration();
    await screen.findByRole('button', { name: /builder/ });
    const filter = screen.getByRole('searchbox', { name: 'Filter' });

    await userEvent.type(filter, 'REVIEWS');
    expect(screen.queryByRole('button', { name: /builder/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reviewer/ })).toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'agents/builder');
    expect(screen.getByRole('button', { name: /builder/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reviewer/ })).not.toBeInTheDocument();

    await userEvent.clear(filter);
    await userEvent.type(filter, 'nothing-like-this');
    expect(screen.getByText('Nothing matches this search.')).toBeInTheDocument();
  });

  it('shows metadata, path, scope and rendered Markdown for a selected resource', async () => {
    const detail: ClaudeResourceDetail = {
      ...builder,
      metadata: { maxTurns: 5, background: true },
      body: '# Heading\n\nSome **bold** text.\n\n| a |\n| - |\n| b |',
      modifiedAt: '2026-01-02T03:04:05.000Z',
    };
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder]) };
    replies['/api/claude/config/resources/agent.global.1'] = { status: 200, body: detail };
    await openConfiguration();
    await userEvent.click(await screen.findByRole('button', { name: /builder/ }));

    const article = within(await screen.findByRole('article', { name: 'builder details' }));
    expect(article.getByText('agents/builder.md')).toBeInTheDocument();
    expect(article.getByText('Global')).toBeInTheDocument();
    expect(article.getByText('inherit')).toBeInTheDocument();
    expect(article.getByText('Read, Bash')).toBeInTheDocument();
    expect(article.getByText('maxTurns')).toBeInTheDocument();
    expect(await article.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(article.getByText('bold').tagName).toBe('STRONG');
    expect(article.getByRole('table')).toBeInTheDocument();
    expect(article.getByText('Modified')).toBeInTheDocument();
  });

  it('never activates HTML, scripts or remote images from Markdown', async () => {
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder]) };
    replies['/api/claude/config/resources/agent.global.1'] = {
      status: 200,
      body: {
        ...builder,
        body: [
          '<script>window.pwned = true</script>',
          '<img src=x onerror="window.pwned = true">',
          '![tracker](https://evil.example/pixel.png)',
          '[bad](javascript:alert(1))',
          '[good](https://example.com/)',
        ].join('\n\n'),
      },
    };
    await openConfiguration();
    await userEvent.click(await screen.findByRole('button', { name: /builder/ }));
    const markdown = await screen.findByTestId('markdown');

    expect(markdown.querySelector('script, img, iframe')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(markdown).toHaveTextContent('[image: tracker]');
    expect(within(markdown).getByText('bad').getAttribute('href') ?? '').not.toContain('javascript');
    const good = within(markdown).getByRole('link', { name: 'good' });
    expect(good).toHaveAttribute('href', 'https://example.com/');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('warns about invalid frontmatter, and explains an unavailable file', async () => {
    const broken = { ...builder, frontmatter: 'invalid' as const, hasContent: false, unavailable: 'too-large' as const };
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([broken]) };
    const fetchMock = mockApi();
    await openConfiguration();
    await userEvent.click(await screen.findByRole('button', { name: /builder/ }));
    expect(await screen.findByText(/frontmatter could not be parsed/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('over the 1 MiB');
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      '/api/claude/config/resources/agent.global.1',
    );
  });

  it('shows loading, empty and error states', async () => {
    let release: (reply: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => (release = resolve));
    const fetchMock = mockApi();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== GLOBAL_AGENTS) return original(url, init);
      const reply = await pending;
      return { status: reply.status, ok: reply.status < 400, json: async () => reply.body } as Response;
    });
    await openConfiguration();
    expect(screen.getByRole('status')).toHaveTextContent('Loading agents');
    release({ status: 200, body: resourceList([]) });
    expect(await screen.findByText('No agents found here.')).toBeInTheDocument();

    replies['/api/claude/config/skills?scope=global'] = {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    };
    await userEvent.click(category('Skills'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error.');
  });

  it('reports symlinks not followed, and partial results', async () => {
    replies[GLOBAL_AGENTS] = {
      status: 200,
      body: { items: [builder], skippedSymlinks: 2, unreadable: 1, truncated: true },
    };
    await openConfiguration();
    expect(await screen.findByText(/2 symlinks not followed/)).toHaveTextContent('ECC_CLAUDE_SYMLINK_TARGETS');
    expect(screen.getByText(/1 location could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/this list is partial/)).toBeInTheDocument();
  });

  it('refresh reads the filesystem again', async () => {
    const lists = [resourceList([builder]), resourceList([builder, reviewer])];
    let calls = 0;
    replies[GLOBAL_AGENTS] = () => ({ status: 200, body: lists[Math.min(calls++, 1)] });
    await openConfiguration();
    await screen.findByRole('button', { name: /builder/ });
    expect(screen.queryByRole('button', { name: /reviewer/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: /reviewer/ })).toBeInTheDocument();
  });

  it('groups knowledge files by type', async () => {
    const knowledge = (id: string, name: string, knowledgeType: ClaudeResourceSummary['knowledgeType']) => ({
      ...builder,
      id,
      name,
      category: 'knowledge' as const,
      knowledgeType,
      description: undefined,
      relativePath: `${name}.md`,
    });
    replies['/api/claude/config/knowledge?scope=global'] = {
      status: 200,
      body: resourceList([
        knowledge('k1', 'CLAUDE.md', 'instructions'),
        knowledge('k2', 'style', 'rule'),
        knowledge('k3', 'guide', 'knowledge-directory'),
      ]),
    };
    await openConfiguration();
    await userEvent.click(category('Knowledge'));
    expect(await screen.findByRole('heading', { name: 'Instructions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge directories' })).toBeInTheDocument();
  });

  it('shows hook registrations in a table, with no commands', async () => {
    const hooks: ClaudeHooksResponse = {
      registrations: [
        { event: 'SessionStart', handlerCount: 2, matcherGroupCount: 1, handlerTypes: ['command'], origin: 'global', relativePath: 'settings.json' },
        { event: 'Stop', handlerCount: 1, matcherGroupCount: 1, handlerTypes: ['http'], origin: 'global', relativePath: 'settings.json' },
      ],
      files: [{ origin: 'global', relativePath: 'settings.json', status: 'ok', unrecognizedEventCount: 1, allHooksDisabled: true }],
    };
    replies['/api/claude/config/hooks?scope=global'] = { status: 200, body: hooks };
    await openConfiguration();
    await userEvent.click(category('Hooks'));
    const row = within((await screen.findByText('SessionStart')).closest('tr')!);
    expect(row.getByText('2')).toBeInTheDocument();
    expect(row.getByText('command')).toBeInTheDocument();
    expect(row.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText(/disableAllHooks is set/)).toBeInTheDocument();
    expect(screen.getByText(/1 unrecognized event/)).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter' }), 'stop');
    expect(screen.queryByText('SessionStart')).not.toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('shows sanitized settings by group, with a notice about hidden values', async () => {
    const settings: ClaudeSettingsResponse = {
      files: [
        {
          origin: 'project',
          relativePath: '.claude/settings.json',
          status: 'ok',
          hiddenFieldCount: 3,
          groups: [
            { category: 'Model', fields: [{ key: 'model', label: 'Model', value: 'opus' }] },
            { category: 'Interface', fields: [{ key: 'verbose', label: 'Verbose output', value: false }] },
          ],
        },
        { origin: 'local', relativePath: '.claude/settings.local.json', status: 'invalid', groups: [], hiddenFieldCount: 0 },
      ],
      mcpDefinitions: { relativePath: '.mcp.json', status: 'ok', serverCount: 2 },
    };
    replies[`/api/claude/config/settings?scope=project&project=${PROJECT_ID}`] = { status: 200, body: settings };
    await openConfiguration();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    await userEvent.click(category('Settings'));

    expect(screen.getByText(/Sensitive settings are intentionally hidden/)).toBeInTheDocument();
    const file = within(await screen.findByRole('region', { name: '.claude/settings.json' }));
    expect(file.getByText('opus')).toBeInTheDocument();
    expect(file.getByText('No')).toBeInTheDocument();
    expect(file.getByText(/3 other top-level settings/)).toBeInTheDocument();
    expect(file.getByText('Project')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '.claude/settings.local.json' })).toHaveTextContent('Not valid JSON');
    expect(screen.getByText(/2 MCP server definitions/)).toBeInTheDocument();
  });

  it('has no controls that could change anything', async () => {
    replies[GLOBAL_AGENTS] = { status: 200, body: resourceList([builder]) };
    replies['/api/claude/config/resources/agent.global.1'] = { status: 200, body: { ...builder, body: 'Text' } };
    const fetchMock = mockApi();
    await openConfiguration();
    await userEvent.click(await screen.findByRole('button', { name: /builder/ }));
    await screen.findByText('Text');

    const page = screen.getByRole('heading', { name: 'Claude Configuration' }).closest('header')!.parentElement!;
    for (const name of [/edit/i, /save/i, /delete/i, /upload/i, /install/i, /enable/i, /disable/i, /run/i]) {
      expect(within(page).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(page.querySelector('input[type="file"], textarea, [contenteditable]')).toBeNull();
    const configRequests = fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/claude/config'));
    expect(configRequests.every(([, init]) => init === undefined)).toBe(true);
  });
});
