import { useCallback } from 'react';
import { useLoad } from '../../hooks/useLoad';
import { api, type ClaudeConfigSelection } from '../../services/api';
import { fileStatusMessage } from './fileStatus';
import { OriginBadge } from './OriginBadge';
import { EmptyMessage, ErrorMessage, LoadingMessage } from './states';

interface HooksPanelProps {
  selection: ClaudeConfigSelection;
  search: string;
  refreshKey: number;
}

export function HooksPanel({ selection, search, refreshKey }: HooksPanelProps) {
  const { scope, project } = selection;
  const load = useCallback(() => api.getClaudeHooks({ scope, project }), [scope, project]);
  const { data, loading, error } = useLoad(load, refreshKey);
  const needle = search.trim().toLowerCase();
  const rows = (data?.registrations ?? []).filter((row) => row.event.toLowerCase().includes(needle));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {loading && !data && <LoadingMessage>Loading hooks…</LoadingMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {data && data.registrations.length === 0 && (
        <EmptyMessage>No hooks registered in these settings files.</EmptyMessage>
      )}
      {data && data.registrations.length > 0 && rows.length === 0 && (
        <EmptyMessage>Nothing matches this search.</EmptyMessage>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full max-w-3xl text-left text-xs">
            <thead className="text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="py-1.5 pr-4 font-medium">Event</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Handlers</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Type</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Scope</th>
                <th scope="col" className="py-1.5 font-medium">File</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.relativePath}:${row.event}`} className="border-b border-line/60">
                  <td className="py-1.5 pr-4 font-mono">{row.event}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{row.handlerCount}</td>
                  <td className="py-1.5 pr-4">{row.handlerTypes.join(', ') || '—'}</td>
                  <td className="py-1.5 pr-4"><OriginBadge origin={row.origin} /></td>
                  <td className="py-1.5 font-mono text-muted">{row.relativePath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <ul className="mt-4 max-w-3xl space-y-1 text-xs text-muted">
          {data.files.map((file) => {
            const message = fileStatusMessage(file.status);
            return (
              <li key={file.relativePath}>
                <span className="font-mono">{file.relativePath}</span>: {message ?? 'Read.'}
                {file.allHooksDisabled && ' disableAllHooks is set in this file.'}
                {file.unrecognizedEventCount > 0 &&
                  ` ${file.unrecognizedEventCount} unrecognized event name(s) not shown.`}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 max-w-3xl text-xs text-muted">
        Commands, arguments, URLs, headers, prompts and matchers are never sent to the browser. Hooks
        defined in plugins, managed settings, or agent and Skill frontmatter are not included.
      </p>
    </div>
  );
}
