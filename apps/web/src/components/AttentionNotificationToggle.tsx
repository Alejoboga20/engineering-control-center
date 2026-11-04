import type { AttentionNotificationControl } from '../hooks/useAttentionNotifications';

export function AttentionNotificationToggle({ control }: { control: AttentionNotificationControl }) {
  return (
    <button
      type="button"
      onClick={control.toggle}
      disabled={control.busy || control.unavailableReason !== null}
      aria-label="Attention notifications"
      aria-pressed={control.on}
      title={
        control.unavailableReason ??
        (control.on
          ? 'Notifying you when a session needs attention. Click to turn off.'
          : 'Notify me when a session needs attention.')
      }
      className={`rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:text-inherit ${
        control.on ? 'text-accent' : 'text-muted'
      }`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill={control.on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
        <path d="M10.5 20a1.7 1.7 0 0 0 3 0" />
      </svg>
    </button>
  );
}
