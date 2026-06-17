/**
 * ToastHost — renders active toast notifications in the app shell.
 *
 * Mount once at the shell level (devSys adds the slot in Part 1 App.tsx).
 * Subscribes to toastEvents; each toast auto-dismisses after ~4.5s.
 * Tapping a toast with a noteId navigates to that note.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getToasts,
  subscribeToasts,
  dismissToast,
  type ToastMessage,
} from '../lib/toastEvents.js';

// Action button rendered inline inside a toast (e.g. Undo). Dismisses on tap then calls fn.
function ToastAction({ toast }: { toast: ToastMessage }) {
  const action = toast.action;
  if (!action) return null;
  return (
    <button
      className="toast__action"
      onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); action.fn(); }}
    >
      {action.label}
    </button>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>(getToasts);
  const navigate = useNavigate();

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          role="status"
          onClick={() => {
            dismissToast(toast.id);
            if (toast.noteId) navigate(`/note/${toast.noteId}`);
          }}
        >
          <span className="toast__message">{toast.message}</span>
          <ToastAction toast={toast} />
          <button
            className="toast__close"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
