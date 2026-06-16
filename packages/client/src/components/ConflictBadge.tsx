/**
 * ConflictBadge — small persistent indicator for a note that has an unresolved sync conflict.
 *
 * Purely presentational. Wire into the note list (HomeView) and/or the editor header
 * by passing onClick to open the conflict view.
 */
interface ConflictBadgeProps {
  onClick?: () => void;
  className?: string;
}

export function ConflictBadge({ onClick, className = '' }: ConflictBadgeProps) {
  return (
    <span
      className={`conflict-badge ${className}`.trim()}
      title="Sync conflict — tap to resolve"
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      aria-label="This note has a sync conflict"
    >
      ⚡
    </span>
  );
}
