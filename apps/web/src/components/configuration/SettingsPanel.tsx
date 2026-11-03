import { useCallback } from 'react';
import type { ClaudeSettingField, ClaudeSettingsResponse } from '@ecc/shared';
import { useLoad } from '../../hooks/useLoad';
import { api, type ClaudeConfigSelection } from '../../services/api';
import { fileStatusMessage } from './fileStatus';
import { OriginBadge } from './OriginBadge';
import { EmptyMessage, ErrorMessage, LoadingMessage } from './states';

interface SettingsPanelProps {
  selection: ClaudeConfigSelection;
  search: string;
  refreshKey: number;
}

function fieldValue({ value }: ClaudeSettingField): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function McpDefinitions({ mcp }: { mcp: NonNullable<ClaudeSettingsResponse['mcpDefinitions']> }) {
  return (
    <section aria-label={mcp.relativePath} className="max-w-2xl rounded-lg border border-line bg-raised p-4">
      <h3 className="font-mono text-xs">{mcp.relativePath}</h3>
      <p className="mt-2 text-xs text-muted">
        {fileStatusMessage(mcp.status) ??
          `${mcp.serverCount} MCP server definition${mcp.serverCount === 1 ? '' : 's'}. Names, commands, URLs and environment values are not read out.`}
      </p>
    </section>
  );
}

export function SettingsPanel({ selection, search, refreshKey }: SettingsPanelProps) {
  const { scope, project } = selection;
  const load = useCallback(() => api.getClaudeSettings({ scope, project }), [scope, project]);
  const { data, loading, error } = useLoad(load, refreshKey);
  const needle = search.trim().toLowerCase();

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <p className="max-w-2xl rounded border border-line px-3 py-2 text-xs text-muted">
        Sensitive settings are intentionally hidden. Only an allowlist of safe fields is shown, and
        each file is shown separately: this is not Claude Code's effective configuration.
      </p>
      {loading && !data && <LoadingMessage>Loading settings…</LoadingMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {data?.files.map((file) => {
        const message = fileStatusMessage(file.status);
        const groups = file.groups
          .map((group) => ({
            ...group,
            fields: group.fields.filter((field) =>
              `${group.category} ${field.label}`.toLowerCase().includes(needle),
            ),
          }))
          .filter((group) => group.fields.length > 0);
        return (
          <section
            key={file.relativePath}
            aria-label={file.relativePath}
            className="max-w-2xl rounded-lg border border-line bg-raised p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono text-xs">{file.relativePath}</h3>
              <OriginBadge origin={file.origin} />
            </div>
            {message && <p className="mt-2 text-xs text-muted">{message}</p>}
            {groups.map((group) => (
              <div key={group.category} className="mt-3">
                <h4 className="text-[11px] font-medium tracking-wide text-muted uppercase">
                  {group.category}
                </h4>
                <dl className="mt-1">
                  {group.fields.map((field) => (
                    <div
                      key={field.key}
                      className="flex justify-between gap-4 border-b border-line py-1 text-xs last:border-0"
                    >
                      <dt className="text-muted">{field.label}</dt>
                      <dd className="font-mono break-all">{fieldValue(field)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
            {file.status === 'ok' && file.groups.length === 0 && (
              <EmptyMessage>No displayable settings in this file.</EmptyMessage>
            )}
            {file.hiddenFieldCount > 0 && (
              <p className="mt-3 text-[11px] text-muted">
                {file.hiddenFieldCount} other top-level setting{file.hiddenFieldCount === 1 ? '' : 's'}{' '}
                hidden.
              </p>
            )}
          </section>
        );
      })}
      {data?.mcpDefinitions && <McpDefinitions mcp={data.mcpDefinitions} />}
      {data && scope === 'global' && (
        <p className="max-w-2xl text-xs text-muted">
          User-scope MCP servers live in ~/.claude.json, which also holds account data, so it is not
          read and they are not counted.
        </p>
      )}
    </div>
  );
}
