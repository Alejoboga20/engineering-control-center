import { useEffect, useState } from 'react';
import type { ClaudeConfigScope } from '@ecc/shared';
import { HooksPanel } from '../components/configuration/HooksPanel';
import { ResourceExplorer } from '../components/configuration/ResourceExplorer';
import { SettingsPanel } from '../components/configuration/SettingsPanel';
import { EmptyMessage, ErrorMessage, LoadingMessage } from '../components/configuration/states';
import { useLoad } from '../hooks/useLoad';
import { api } from '../services/api';

type Category = 'agents' | 'skills' | 'knowledge' | 'hooks' | 'settings';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'settings', label: 'Settings' },
];

const CONTROL = 'rounded border border-line bg-surface px-2 py-1 text-xs';

export function ConfigurationPage() {
  const [category, setCategory] = useState<Category>('agents');
  const [scope, setScope] = useState<ClaudeConfigScope>('global');
  const [project, setProject] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const scopes = useLoad(api.getClaudeConfigScopes, refreshKey);
  const projects = scopes.data?.projects;

  // Prefers a project with configuration. A project that went away stops being selected.
  useEffect(() => {
    if (!projects) return;
    setProject((current) =>
      projects.some((candidate) => candidate.id === current)
        ? current
        : (projects.find((candidate) => candidate.hasConfiguration) ?? projects[0])?.id ?? null,
    );
  }, [projects]);

  // Ignored in the global scope, so that projects arriving do not reload what is on screen.
  const selection = { scope, project: scope === 'project' ? project : null };
  const projectMissing = scope === 'project' && project === null;
  const panelProps = { selection, search, refreshKey };

  const changeCategory = (next: Category) => {
    setCategory(next);
    setSearch('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold">Claude Configuration</h2>
          <span className="rounded bg-overlay px-1.5 py-0.5 text-[10px] tracking-wide text-muted uppercase">
            Read-only
          </span>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Scope
            <select
              className={CONTROL}
              value={scope}
              onChange={(event) => setScope(event.target.value as ClaudeConfigScope)}
            >
              <option value="global">Global</option>
              <option value="project">Project</option>
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            Project
            <select
              className={`${CONTROL} max-w-52`}
              value={project ?? ''}
              disabled={scope !== 'project' || !projects?.length}
              onChange={(event) => setProject(event.target.value)}
            >
              {!projects?.length && <option value="">None</option>}
              {projects?.map((candidate) => (
                <option key={candidate.id} value={candidate.id} title={candidate.path}>
                  {candidate.name}
                  {candidate.hasConfiguration ? '' : ' (no configuration)'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="rounded border border-line px-2 py-1 text-xs hover:border-accent hover:text-accent md:ml-auto"
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <nav aria-label="Configuration categories" className="flex flex-wrap gap-1">
            {CATEGORIES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => changeCategory(id)}
                aria-current={category === id ? 'page' : undefined}
                className={`rounded px-2 py-1 text-xs ${
                  category === id ? 'bg-overlay text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <input
            type="search"
            aria-label="Filter"
            placeholder="Filter…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${CONTROL} min-w-0 flex-1 md:ml-auto md:max-w-56`}
          />
        </div>
      </header>
      {scopes.error && <ErrorMessage>{scopes.error}</ErrorMessage>}
      {projectMissing ? (
        scopes.loading ? (
          <LoadingMessage>Loading projects…</LoadingMessage>
        ) : scopes.error ? null : (
          <EmptyMessage>No projects were found under the configured project roots.</EmptyMessage>
        )
      ) : category === 'hooks' ? (
        <HooksPanel {...panelProps} />
      ) : category === 'settings' ? (
        <SettingsPanel {...panelProps} />
      ) : (
        <ResourceExplorer list={category} {...panelProps} />
      )}
    </div>
  );
}
