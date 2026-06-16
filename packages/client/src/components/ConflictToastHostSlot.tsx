/**
 * TOAST-HOST MOUNT SLOT — Part 2 conflict toast (app-wide).
 * Wires gruntSys2's ToastHost into the shell slot devSys left in App.tsx.
 */
import { ToastHost } from './ToastHost.js';

export function ConflictToastHostSlot() {
  return <ToastHost />;
}
