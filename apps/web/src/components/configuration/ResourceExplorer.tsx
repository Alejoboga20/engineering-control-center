import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClaudeKnowledgeType, ClaudeResourceSummary } from '@ecc/shared';
import { useLoad } from '../../hooks/useLoad';
import { api, type ClaudeConfigSelection, type ClaudeResourceListName } from '../../services/api';
import { OriginBadge } from './OriginBadge';
import { ResourceDetails } from './ResourceDetails';
import { EmptyMessage, ErrorMessage, LoadingMessage } from './states';

const KNOWLEDGE_GROUPS: { type: ClaudeKnowledgeType; label: string }[] = [
  { type: 'instructions', label: 'Instructions' },
  { type: 'rule', label: 'Rules' },
  { type: 'knowledge-directory', label: 'Knowledge directories' },
];

const NOUNS: Record<ClaudeResourceListName, string> = {
  agents: 'agents',
  skills: 'Skills',
  knowledge: 'instruction or knowledge files',
};

function matches(item: ClaudeResourceSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [item.name, item.description ?? '', item.relativePath].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

function ResourceRow(props: {
  item: ClaudeResourceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { item } = props;
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={props.selected ? 'true' : undefined}
        className={`w-full rounded px-2 py-1.5 text-left ${
          props.selected ? 'bg-overlay' : 'hover:bg-raised'
        }`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[13px]">{item.name}</span>
          <OriginBadge origin={item.origin} />
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted">
          {item.description ?? item.relativePath}
        </span>
      </button>
    </li>
  );
}

interface ResourceExplorerProps {
  list: ClaudeResourceListName;
  selection: ClaudeConfigSelection;
  search: string;
  refreshKey: number;
}

export function ResourceExplorer({ list, selection, search, refreshKey }: ResourceExplorerProps) {
  const { scope, project } = selection;
  const load = useCallback(
    () => api.listClaudeResources(list, { scope, project }),
    [list, scope, project],
  );
  const { data, loading, error } = useLoad(load, refreshKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => setSelectedId(null), [list, scope, project]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const visible = useMemo(() => items.filter((item) => matches(item, search)), [items, search]);
  // Selecting by lookup means a file deleted before a refresh simply stops being selected.
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const rows = (rowItems: ClaudeResourceSummary[]) => (
    <ul>
      {rowItems.map((item) => (
        <ResourceRow
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          onSelect={() => setSelectedId(item.id)}
        />
      ))}
    </ul>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <section
        aria-label="Resources"
        className="max-h-64 shrink-0 overflow-y-auto border-b border-line p-2 md:max-h-none md:w-80 md:border-r md:border-b-0"
      >
        {loading && !data && <LoadingMessage>Loading {NOUNS[list]}…</LoadingMessage>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {data && items.length === 0 && <EmptyMessage>No {NOUNS[list]} found here.</EmptyMessage>}
        {items.length > 0 && visible.length === 0 && (
          <EmptyMessage>Nothing matches this search.</EmptyMessage>
        )}
        {list === 'knowledge'
          ? KNOWLEDGE_GROUPS.map(({ type, label }) => {
              const group = visible.filter((item) => item.knowledgeType === type);
              return group.length === 0 ? null : (
                <div key={type} className="mb-2">
                  <h4 className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                    {label}
                  </h4>
                  {rows(group)}
                </div>
              );
            })
          : rows(visible)}
        {data && data.skippedSymlinks > 0 && (
          <p className="mt-2 px-2 text-[11px] text-amber-300">
            {data.skippedSymlinks} symlink{data.skippedSymlinks === 1 ? '' : 's'} not followed,
            because the target is not approved. See ECC_CLAUDE_SYMLINK_TARGETS.
          </p>
        )}
        {data && data.unreadable > 0 && (
          <p className="mt-2 px-2 text-[11px] text-amber-300">
            {data.unreadable} location{data.unreadable === 1 ? '' : 's'} could not be read.
          </p>
        )}
        {data?.truncated && (
          <p className="mt-2 px-2 text-[11px] text-amber-300">Too many files: this list is partial.</p>
        )}
      </section>
      <section aria-label="Resource details" className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
        {selected ? (
          <ResourceDetails key={selected.id} resource={selected} refreshKey={refreshKey} />
        ) : (
          <EmptyMessage>Select an item to read it.</EmptyMessage>
        )}
      </section>
    </div>
  );
}
