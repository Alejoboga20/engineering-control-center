import { useState } from 'react';
import { Modal } from './Modal';

interface TerminateSessionDialogProps {
  session: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function TerminateSessionDialog({
  session,
  onConfirm,
  onClose,
}: TerminateSessionDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not terminate the session.');
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`Terminate session "${session}"?`} onClose={onClose}>
      <p className="mb-3 text-[13px] leading-relaxed text-muted">
        This kills the tmux session and may stop Claude Code and any other process running in it.
        Unsaved work in those processes will be lost, and this cannot be undone. To leave them
        running, use Disconnect instead.
      </p>
      {error && (
        <p role="alert" className="mb-3 rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void confirm()}
          className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-40"
        >
          {submitting ? 'Terminating…' : 'Terminate session'}
        </button>
      </div>
    </Modal>
  );
}
