import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeResourceSummary } from '@ecc/shared';
import request from 'supertest';
import { AppConfig } from '../src/config/app-config';
import { readConfinedFile } from '../src/claude-configuration/confined-file';
import { RunningApp, startApp, testConfig, TEST_ORIGIN } from './helpers';

const HOST = 'localhost:4999';
const SECRET = 'S3CRET-VALUE';

const AGENT = `---
name: builder
description: Builds things
model: inherit
tools: 'Read, Bash(curl -H "x: ${SECRET}":*)'
hooks:
  Stop:
    - hooks:
        - type: command
          command: ${SECRET}
mcpServers:
  db:
    env:
      TOKEN: ${SECRET}
---

# Builder instructions
`;

const SETTINGS = JSON.stringify({
  model: 'opus',
  theme: 'dark',
  env: { ANTHROPIC_API_KEY: SECRET },
  apiKeyHelper: `/bin/${SECRET}`,
  statusLine: { type: 'command', command: SECRET },
  permissions: { defaultMode: 'plan', allow: [`Bash(${SECRET}:*)`, 'Read'] },
  enabledPlugins: { [`${SECRET}@market`]: true },
  hooks: {
    SessionStart: [{ matcher: SECRET, hooks: [{ type: 'command', command: `${SECRET} --flag` }] }],
    PermissionRequest: [{ hooks: [{ type: 'http', url: `https://${SECRET}.example` }] }],
    [SECRET]: [{ hooks: [{ type: 'command', command: 'x' }] }],
  },
});

describe('Claude configuration API', () => {
  let base: string;
  let globalDir: string;
  let projectsRoot: string;
  let project: string;
  let outside: string;
  let running: RunningApp;
  let config: AppConfig;

  const http = () => request(running.app.getHttpServer());
  const get = (path: string) => http().get(`/api/claude/config${path}`).set('Host', HOST);

  function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  async function start(overrides: Partial<AppConfig> = {}) {
    if (running) await running.app.close();
    config = testConfig({ claudeConfigDir: globalDir, projectRoots: [projectsRoot], ...overrides });
    running = await startApp(config);
  }

  const projectId = (path: string) =>
    createHash('sha256').update(`project\0${realpathSync(path)}`).digest('hex').slice(0, 16);
  const query = (path = project) => `?scope=project&project=${projectId(path)}`;
  const names = (items: ClaudeResourceSummary[]) => items.map((item) => item.name);
  const list = async (category: string, suffix = '') =>
    (await get(`/${category}${suffix}`).expect(200)).body as {
      items: ClaudeResourceSummary[];
      skippedSymlinks: number;
      truncated: boolean;
    };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ecc-config-')));
    globalDir = join(base, 'home', '.claude');
    projectsRoot = join(base, 'projects');
    project = join(projectsRoot, 'payroll');
    outside = join(base, 'outside');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });

    write(join(outside, 'secret.md'), `---\nname: stolen\n---\n${SECRET}`);
    write(join(globalDir, 'CLAUDE.md'), '# Global instructions');
    write(join(globalDir, 'agents', 'builder.md'), AGENT);
    write(join(globalDir, 'skills', 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: Deploys\nhooks:\n  Stop: ${SECRET}\n---\nDeploy steps`);
    write(join(globalDir, 'skills', 'deploy', 'helper.md'), `helper ${SECRET}`);
    write(join(globalDir, 'rules', 'style.md'), '---\npaths:\n  - src/**\n---\nUse tabs');
    write(join(globalDir, 'settings.json'), SETTINGS);
    write(join(globalDir, 'projects', 'x', 'transcript.md'), SECRET);
    write(join(globalDir, 'history.jsonl'), SECRET);
    write(join(globalDir, '.credentials.json'), SECRET);

    write(join(project, 'CLAUDE.md'), '# Project instructions');
    write(join(project, 'CLAUDE.local.md'), '# Local instructions');
    write(join(project, 'README.md'), `readme ${SECRET}`);
    write(join(project, '.env'), `TOKEN=${SECRET}`);
    write(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { db: { env: { TOKEN: SECRET } }, api: {} } }));
    write(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: builder\ndescription: Same name\n---\nReview');
    write(join(project, '.claude', 'skills', 'test', 'SKILL.md'), 'No frontmatter skill');
    write(join(project, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', hooks: { Stop: [{ hooks: [{ type: 'command', command: SECRET }] }] } }));
    write(join(project, '.claude', 'settings.local.json'), JSON.stringify({ verbose: true }));
    mkdirSync(join(projectsRoot, 'empty'));
    await start();
  });

  afterEach(async () => {
    await running.app.close();
    chmodSync(join(globalDir, 'agents'), 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  describe('scopes', () => {
    it('lists global and approved projects, and which have configuration', async () => {
      const { body } = await get('/scopes').expect(200);
      expect(body.global.available).toBe(true);
      expect(JSON.stringify(body.global)).not.toContain(base);
      expect(body.projects).toEqual([
        { id: projectId(join(projectsRoot, 'empty')), name: 'empty', path: join(projectsRoot, 'empty'), hasConfiguration: false },
        { id: projectId(project), name: 'payroll', path: project, hasConfiguration: true },
      ]);
    });

    it('reports a missing global directory, with empty categories', async () => {
      await start({ claudeConfigDir: join(base, 'nonexistent') });
      expect((await get('/scopes').expect(200)).body.global.available).toBe(false);
      expect((await list('agents')).items).toEqual([]);
      expect((await get('/settings').expect(200)).body.files[0].status).toBe('missing');
    });
  });

  describe('agents', () => {
    it('extracts only allowlisted metadata', async () => {
      const { items } = await list('agents');
      expect(items).toEqual([
        {
          id: expect.stringMatching(/^agent\.global\.[a-f0-9]{32}$/),
          category: 'agent',
          name: 'builder',
          origin: 'global',
          relativePath: 'agents/builder.md',
          description: 'Builds things',
          model: 'inherit',
          tools: ['Read', 'Bash'],
          hasContent: true,
          frontmatter: 'valid',
        },
      ]);
    });

    it('returns the body without frontmatter, with a timestamp', async () => {
      const [{ id }] = (await list('agents')).items;
      const { body, text } = await get(`/resources/${id}`).expect(200);
      expect(body.body).toBe('# Builder instructions\n');
      expect(body.modifiedAt).toEqual(expect.any(String));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(base);
    });

    it('labels resources by origin, keeping same-named ones apart by path', async () => {
      const { items: projectAgents } = await list('agents', query());
      expect(projectAgents[0]).toMatchObject({
        name: 'builder',
        origin: 'project',
        relativePath: '.claude/agents/reviewer.md',
      });
      const [globalAgent] = (await list('agents')).items;
      expect(globalAgent.id).not.toBe(projectAgents[0].id);
    });

    it('finds agents in subdirectories, as Claude Code does', async () => {
      write(join(globalDir, 'agents', 'team', 'qa.md'), 'QA');
      expect(names((await list('agents')).items)).toEqual(['builder', 'qa']);
    });

    it('falls back to the file name, and keeps the body, on invalid frontmatter', async () => {
      write(join(globalDir, 'agents', 'broken.md'), `---\nname: [oops ${SECRET}\n---\nStill here`);
      const item = (await list('agents')).items.find((candidate) => candidate.name === 'broken')!;
      expect(item.frontmatter).toBe('invalid');
      const { body, text } = await get(`/resources/${item.id}`).expect(200);
      expect(body.body).toBe('Still here');
      expect(text).not.toContain(SECRET);
    });

    it('sees external changes on the next request', async () => {
      write(join(globalDir, 'agents', 'new.md'), 'New');
      expect(names((await list('agents')).items)).toContain('new');
      unlinkSync(join(globalDir, 'agents', 'new.md'));
      expect(names((await list('agents')).items)).not.toContain('new');
    });

    it('marks an unreadable directory safely', async () => {
      if (process.getuid?.() === 0) return;
      chmodSync(join(globalDir, 'agents'), 0o000);
      const { body, text } = await get('/agents').expect(200);
      expect(body.items).toEqual([]);
      expect(body.unreadable).toBe(1);
      expect(text).not.toContain(base);
    });
  });

  describe('skills', () => {
    it('lists SKILL.md and nothing else from the directory', async () => {
      const { items } = await list('skills');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        name: 'deploy',
        description: 'Deploys',
        relativePath: 'skills/deploy/SKILL.md',
      });
      const { body, text } = await get(`/resources/${items[0].id}`).expect(200);
      expect(body.body).toBe('Deploy steps');
      expect(text).not.toContain(SECRET);
    });

    it('names a Skill after its directory when the file does not say', async () => {
      expect((await list('skills', query())).items[0]).toMatchObject({
        name: 'test',
        frontmatter: 'none',
      });
    });

    it('finds Skills synced from claude.ai', async () => {
      write(join(globalDir, 'skills', 'synced', 'bucket', 'pdf', 'SKILL.md'), '---\ndescription: PDF\n---\nx');
      write(join(globalDir, 'skills', 'synced', 'bucket', 'pdf', 'other.md'), SECRET);
      const { items, ...rest } = await list('skills');
      expect(names(items)).toEqual(['deploy', 'pdf']);
      expect(rest.skippedSymlinks).toBe(0);
    });
  });

  describe('knowledge', () => {
    it('lists global instructions and rules', async () => {
      const { items } = await list('knowledge');
      expect(items.map((item) => [item.relativePath, item.knowledgeType, item.origin])).toEqual([
        ['CLAUDE.md', 'instructions', 'global'],
        ['rules/style.md', 'rule', 'global'],
      ]);
      expect(items[1].metadata).toEqual({ paths: ['src/**'] });
    });

    it('marks CLAUDE.local.md as local, and does not scan the repository', async () => {
      const { items } = await list('knowledge', query());
      expect(items.map((item) => [item.relativePath, item.origin])).toEqual([
        ['CLAUDE.local.md', 'local'],
        ['CLAUDE.md', 'project'],
      ]);
    });

    it('includes .claude/CLAUDE.md and AGENTS.md', async () => {
      write(join(project, '.claude', 'CLAUDE.md'), 'a');
      write(join(project, 'AGENTS.md'), 'b');
      const paths = (await list('knowledge', query())).items.map((item) => item.relativePath);
      expect(paths).toEqual(expect.arrayContaining(['.claude/CLAUDE.md', 'AGENTS.md']));
    });

    it('allows the documented CLAUDE.md link to AGENTS.md, but no other', async () => {
      unlinkSync(join(project, 'CLAUDE.md'));
      write(join(project, 'AGENTS.md'), 'shared');
      symlinkSync('AGENTS.md', join(project, 'CLAUDE.md'));
      expect((await list('knowledge', query())).items.map((item) => item.relativePath)).toContain('CLAUDE.md');

      unlinkSync(join(project, 'CLAUDE.md'));
      symlinkSync('README.md', join(project, 'CLAUDE.md'));
      const { items, skippedSymlinks } = await list('knowledge', query());
      expect(items.map((item) => item.relativePath)).not.toContain('CLAUDE.md');
      expect(skippedSymlinks).toBe(1);
    });

    it('shows knowledge directories only when an administrator configures them', async () => {
      const shared = join(base, 'kb');
      write(join(shared, 'guide.md'), 'Guide');
      write(join(shared, 'deep', 'more.md'), 'More');
      write(join(shared, 'notes.txt'), SECRET);
      write(join(shared, '.hidden', 'x.md'), SECRET);
      write(join(project, 'docs', 'kb', 'local.md'), 'Local KB');
      write(join(project, 'docs', 'other.md'), SECRET);

      expect((await list('knowledge')).items.map((item) => item.relativePath)).not.toContain('kb/guide.md');
      await start({ claudeKnowledgeDirs: { global: [shared], project: ['docs/kb'] } });

      const globalItems = (await list('knowledge')).items;
      expect(globalItems.filter((item) => item.knowledgeType === 'knowledge-directory').map((item) => item.relativePath).sort()).toEqual(['kb/deep/more.md', 'kb/guide.md']);
      const projectItems = (await list('knowledge', query())).items;
      expect(projectItems.filter((item) => item.knowledgeType === 'knowledge-directory').map((item) => item.relativePath)).toEqual(['docs/kb/local.md']);
    });

    it('limits result counts', async () => {
      for (let index = 0; index < 505; index++) {
        writeFileSync(join(globalDir, 'rules', `r${index}.md`), 'x');
      }
      const { items, truncated } = await list('knowledge');
      expect(items.length).toBeLessThanOrEqual(501);
      expect(truncated).toBe(true);
    });
  });

  describe('hooks', () => {
    it('returns structure only, with no command contents', async () => {
      const { body, text } = await get('/hooks').expect(200);
      expect(body.registrations).toEqual([
        { event: 'SessionStart', handlerCount: 1, matcherGroupCount: 1, handlerTypes: ['command'], origin: 'global', relativePath: 'settings.json' },
        { event: 'PermissionRequest', handlerCount: 1, matcherGroupCount: 1, handlerTypes: ['http'], origin: 'global', relativePath: 'settings.json' },
      ]);
      expect(body.files[0]).toMatchObject({ status: 'ok', unrecognizedEventCount: 1 });
      expect(text).not.toContain(SECRET);
    });

    it('labels project and local files', async () => {
      const { body } = await get(`/hooks${query()}`).expect(200);
      expect(body.registrations).toEqual([
        expect.objectContaining({ event: 'Stop', origin: 'project', relativePath: '.claude/settings.json' }),
      ]);
      expect(body.files.map((file: { origin: string; status: string }) => [file.origin, file.status])).toEqual([
        ['project', 'ok'],
        ['local', 'ok'],
      ]);
    });
  });

  describe('settings', () => {
    it('returns allowlisted fields and no secrets', async () => {
      const { body, text } = await get('/settings').expect(200);
      expect(body.files).toHaveLength(1);
      const fields = Object.fromEntries(
        body.files[0].groups.flatMap((group: { fields: { key: string; value: unknown }[] }) =>
          group.fields.map((field) => [field.key, field.value]),
        ),
      );
      expect(fields).toMatchObject({
        model: 'opus',
        theme: 'dark',
        statusLine: true,
        'permissions.defaultMode': 'plan',
        'permissions.allow': 2,
        enabledPlugins: 1,
        'hooks.handlers': 2,
      });
      expect(body.files[0].hiddenFieldCount).toBe(2);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(base);
    });

    it('counts .mcp.json servers without returning them', async () => {
      const { body, text } = await get(`/settings${query()}`).expect(200);
      expect(body.mcpDefinitions).toEqual({ relativePath: '.mcp.json', status: 'ok', serverCount: 2 });
      expect(body.files.map((file: { origin: string }) => file.origin)).toEqual(['project', 'local']);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('"db"');
    });

    it('reports invalid JSON without quoting the file', async () => {
      write(join(globalDir, 'settings.json'), `{"token": "${SECRET}"`);
      const { body, text } = await get('/settings').expect(200);
      expect(body.files[0]).toMatchObject({ status: 'invalid', groups: [] });
      expect(text).not.toContain(SECRET);
      expect((await get('/hooks').expect(200)).body.files[0].status).toBe('invalid');
    });

    it('reports a missing file', async () => {
      unlinkSync(join(globalDir, 'settings.json'));
      expect((await get('/settings').expect(200)).body.files[0].status).toBe('missing');
    });

    it('refuses an oversized file', async () => {
      write(join(globalDir, 'settings.json'), `{"a":"${'x'.repeat(1024 * 1024)}"}`);
      expect((await get('/settings').expect(200)).body.files[0].status).toBe('too-large');
    });

    it('refuses settings linked outside the scope', async () => {
      write(join(outside, 'settings.json'), JSON.stringify({ model: 'stolen' }));
      unlinkSync(join(globalDir, 'settings.json'));
      symlinkSync(join(outside, 'settings.json'), join(globalDir, 'settings.json'));
      const { body, text } = await get('/settings').expect(200);
      expect(body.files[0].status).toBe('unsafe');
      expect(text).not.toContain('stolen');
    });
  });

  describe('large files', () => {
    it('lists an oversized file as unavailable, and refuses its content', async () => {
      write(join(globalDir, 'agents', 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
      const huge = (await list('agents')).items.find((item) => item.name === 'huge')!;
      expect(huge).toMatchObject({ hasContent: false, unavailable: 'too-large' });
      const { body } = await get(`/resources/${huge.id}`).expect(413);
      expect(body.code).toBe('CLAUDE_RESOURCE_TOO_LARGE');
    });

    it('refuses binary content', async () => {
      write(join(globalDir, 'agents', 'binary.md'), 'a\0b');
      const item = (await list('agents')).items.find((candidate) => candidate.name === 'binary')!;
      expect(item.unavailable).toBe('unsafe');
      await get(`/resources/${item.id}`).expect(403);
    });
  });

  describe('symlink escapes', () => {
    it.each([
      ['an agent file', () => join(globalDir, 'agents', 'link.md')],
      ['a rule file', () => join(globalDir, 'rules', 'link.md')],
    ])('does not follow %s out of the scope', async (_label, linkPath) => {
      symlinkSync(join(outside, 'secret.md'), linkPath());
      const category = linkPath().includes('agents') ? 'agents' : 'knowledge';
      const response = await get(`/${category}`).expect(200);
      expect(response.body.skippedSymlinks).toBe(1);
      expect(response.text).not.toContain('stolen');
    });

    it('does not follow a link to a sensitive file inside the same directory tree', async () => {
      symlinkSync(join(globalDir, '.credentials.json'), join(globalDir, 'agents', 'creds.md'));
      symlinkSync(join(globalDir, 'projects', 'x', 'transcript.md'), join(globalDir, 'agents', 'chat.md'));
      symlinkSync(join(project, '.env'), join(project, '.claude', 'agents', 'env.md'));
      expect(names((await list('agents')).items)).toEqual(['builder']);
      expect(names((await list('agents', query())).items)).toEqual(['builder']);
    });

    it('does not follow a linked category directory, or a linked .claude', async () => {
      rmSync(join(project, '.claude', 'agents'), { recursive: true });
      symlinkSync(join(globalDir, 'projects'), join(project, '.claude', 'agents'));
      expect((await list('agents', query())).items).toEqual([]);

      const other = join(projectsRoot, 'hostile');
      mkdirSync(other);
      symlinkSync(globalDir, join(other, '.claude'));
      await start();
      for (const category of ['agents', 'skills', 'knowledge']) {
        expect((await list(category, query(other))).items).toEqual([]);
      }
      const settings = await get(`/settings${query(other)}`).expect(200);
      expect(settings.body.files[0].status).toBe('unsafe');
    });

    it('does not follow a linked Skill directory or SKILL.md', async () => {
      mkdirSync(join(outside, 'evil'));
      write(join(outside, 'evil', 'SKILL.md'), SECRET);
      symlinkSync(join(outside, 'evil'), join(globalDir, 'skills', 'evil'));
      mkdirSync(join(globalDir, 'skills', 'inner'));
      symlinkSync(join(outside, 'secret.md'), join(globalDir, 'skills', 'inner', 'SKILL.md'));
      const { items, skippedSymlinks } = await list('skills');
      expect(names(items)).toEqual(['deploy']);
      expect(skippedSymlinks).toBe(2);
    });

    it('counts a broken or circular link, without failing', async () => {
      symlinkSync(join(base, 'nothing'), join(globalDir, 'agents', 'broken.md'));
      symlinkSync(join(globalDir, 'agents', 'loop.md'), join(globalDir, 'agents', 'loop.md'));
      const { items, skippedSymlinks } = await list('agents');
      expect(names(items)).toEqual(['builder']);
      expect(skippedSymlinks).toBe(2);
    });

    it('does not offer a project linked out of the project roots', async () => {
      const escaped = join(base, 'private-repo');
      write(join(escaped, 'CLAUDE.md'), SECRET);
      symlinkSync(escaped, join(projectsRoot, 'link'));
      const { body } = await get('/scopes').expect(200);
      expect(body.projects.map((candidate: { name: string }) => candidate.name)).not.toContain('link');
      await get(`/knowledge?scope=project&project=${projectId(escaped)}`).expect(404);
    });

    it('follows links only into approved targets, and only to allowed file types', async () => {
      const dotfiles = join(base, 'dotfiles');
      write(join(dotfiles, 'agents', 'mine.md'), '---\nname: mine\n---\nFrom dotfiles');
      write(join(dotfiles, 'agents', 'notes.txt'), SECRET);
      write(join(dotfiles, 'skills', 'spec', 'SKILL.md'), 'Spec');
      write(join(dotfiles, 'secret.json'), SECRET);
      rmSync(join(globalDir, 'agents'), { recursive: true });
      symlinkSync(join(dotfiles, 'agents'), join(globalDir, 'agents'));
      symlinkSync(join(dotfiles, 'skills', 'spec'), join(globalDir, 'skills', 'spec'));
      mkdirSync(join(globalDir, 'skills', 'bad'));
      symlinkSync(join(dotfiles, 'secret.json'), join(globalDir, 'skills', 'bad', 'SKILL.md'));

      expect((await list('agents')).items).toEqual([]);
      await start({ claudeSymlinkTargets: [dotfiles] });

      const agents = (await list('agents')).items;
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ name: 'mine', relativePath: 'agents/mine.md' });
      expect((await get(`/resources/${agents[0].id}`).expect(200)).body.body).toBe('From dotfiles');
      expect(names((await list('skills')).items)).toEqual(['deploy', 'spec']);
    });

    it('refuses a file swapped for a link after discovery', async () => {
      const target = join(globalDir, 'agents', 'builder.md');
      unlinkSync(target);
      symlinkSync(join(outside, 'secret.md'), target);
      expect(await readConfinedFile(target, { maxFileBytes: 1024 })).toEqual({ status: 'unsafe' });
    });

    it('refuses a path whose parent became a link after discovery', async () => {
      const inner = join(base, 'swap');
      mkdirSync(join(inner, 'real'), { recursive: true });
      write(join(outside, 'file.md'), SECRET);
      symlinkSync(outside, join(inner, 'link'));
      expect(await readConfinedFile(join(inner, 'link', 'file.md'), { maxFileBytes: 1024 })).toEqual({
        status: 'unsafe',
      });
    });
  });

  describe('request validation', () => {
    it.each([
      '/agents?scope=everything',
      '/agents?scope=project',
      '/agents?scope=global&project=0123456789abcdef',
      '/agents?scope=project&project=../../etc',
      '/agents?scope=project&project=/etc/passwd',
      '/agents?scope=global&scope=project',
      '/agents?path=/etc',
      '/agents?root=/etc',
    ])('rejects %s', async (path) => {
      const { body } = await get(path).expect(400);
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a project that is not under the configured roots', async () => {
      const { body, text } = await get(`/agents?scope=project&project=${projectId(outside)}`).expect(404);
      expect(body.code).toBe('CLAUDE_PROJECT_NOT_FOUND');
      expect(text).not.toContain(base);
    });

    it.each([
      'agent.global.00000000000000000000000000000000',
      'agent.0123456789abcdef.00000000000000000000000000000000',
      '..%2F..%2Fetc%2Fpasswd',
      '%2Fetc%2Fpasswd',
      'agents%2Fbuilder.md',
      'knowledge.global.short',
      'other.global.00000000000000000000000000000000',
    ])('returns 404 for the resource ID %s', async (id) => {
      const { body, text } = await get(`/resources/${id}`).expect(404);
      expect(body.code).toBe('CLAUDE_RESOURCE_NOT_FOUND');
      expect(text).not.toContain(base);
    });

    it('forgets a resource once its file is gone', async () => {
      const [{ id }] = (await list('agents')).items;
      unlinkSync(join(globalDir, 'agents', 'builder.md'));
      await get(`/resources/${id}`).expect(404);
    });

    it('applies the dashboard Host and Origin checks', async () => {
      await http().get('/api/claude/config/agents').set('Host', 'evil.example').expect(403);
      await http()
        .get('/api/claude/config/agents')
        .set('Host', HOST)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await http().get('/api/claude/config/agents').set('Host', HOST).set('Origin', TEST_ORIGIN).expect(200);
    });

    it('keeps responses out of browser caches', async () => {
      const { headers } = await get('/settings').expect(200);
      expect(headers['cache-control']).toBe('no-store');
    });
  });

  describe('read-only behavior', () => {
    function snapshot(directory: string): Record<string, string> {
      const files: Record<string, string> = {};
      for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
        const path = join(entry.parentPath, entry.name);
        if (entry.isFile()) {
          files[path] = `${statSync(path).mtimeMs}:${statSync(path).mode}:${readFileSync(path, 'base64')}`;
        } else {
          files[path] = 'other';
        }
      }
      return files;
    }

    it.each(['post', 'put', 'patch', 'delete'] as const)('has no %s endpoints', async (method) => {
      const [{ id }] = (await list('agents')).items;
      for (const path of ['scopes', 'agents', 'skills', 'knowledge', 'hooks', 'settings', `resources/${id}`]) {
        await http()[method](`/api/claude/config/${path}`).set('Host', HOST).send({}).expect(404);
      }
    });

    it('changes nothing on disk when every endpoint is used', async () => {
      const before = snapshot(base);
      const scopes = (await get('/scopes').expect(200)).body;
      expect(scopes.projects.length).toBeGreaterThan(0);
      for (const suffix of ['', query()]) {
        for (const category of ['agents', 'skills', 'knowledge']) {
          for (const item of (await list(category, suffix)).items) {
            await get(`/resources/${item.id}`).expect(200);
          }
        }
        await get(`/hooks${suffix}`).expect(200);
        await get(`/settings${suffix}`).expect(200);
      }
      expect(snapshot(base)).toEqual(before);
    });
  });
});
