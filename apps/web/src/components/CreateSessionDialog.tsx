import { useEffect, useState, type FormEvent } from 'react';
import {
  isValidSessionName,
  SESSION_NAME_RULES,
  type CreateSessionRequest,
  type ProjectsResponse,
} from '@ecc/shared';
import { api } from '../services/api';
import { Modal } from './Modal';

interface CreateSessionDialogProps {
  onCreate: (request: CreateSessionRequest) => Promise<void>;
  onClose: () => void;
}

const INPUT_CLASS =
  'w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-[13px] outline-none focus:border-accent';

export function CreateSessionDialog({ onCreate, onClose }: CreateSessionDialogProps) {
  const [name, setName] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    api.listProjects().then(
      (result) => {
        if (active) setProjects(result);
      },
      (cause: Error) => {
        if (active) setError(cause.message);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const nameIsInvalid = name !== '' && !isValidSessionName(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name, workingDirectory });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the session.');
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New session" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <div>
          <label htmlFor="session-name" className="mb-1 block text-xs text-muted">
            Session name
          </label>
          <input
            id="session-name"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={nameIsInvalid}
            className={INPUT_CLASS}
          />
          {nameIsInvalid && <p className="mt-1 text-xs text-red-300">{SESSION_NAME_RULES}</p>}
        </div>
        <div>
          <label htmlFor="working-directory" className="mb-1 block text-xs text-muted">
            Working directory
          </label>
          <input
            id="working-directory"
            list="project-directories"
            autoComplete="off"
            spellCheck={false}
            value={workingDirectory}
            onChange={(event) => setWorkingDirectory(event.target.value)}
            className={INPUT_CLASS}
          />
          <datalist id="project-directories">
            {projects?.roots.map((root) => <option key={root} value={root} />)}
            {projects?.directories.map((directory) => (
              <option key={directory.path} value={directory.path} />
            ))}
          </datalist>
          {projects && (
            <p className="mt-1 text-xs break-all text-muted">
              {projects.roots.length > 0
                ? `Must be inside: ${projects.roots.join(', ')}`
                : 'No project root exists. Check ECC_PROJECT_ROOTS on the server.'}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !isValidSessionName(name) || workingDirectory === ''}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
