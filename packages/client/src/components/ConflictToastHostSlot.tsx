/**
 * TOAST-HOST MOUNT SLOT — Part 2 coordination point (pilot-reserved).
 *
 * Placeholder for the app-wide conflict ToastHost that gruntSys2 builds for Part 2 (conflict-as-
 * version: the non-blocking *"Sync conflict on '<note title>' — your version was kept"* toast — see
 * acceptance row CAV-8 and docs/design/part2-conflict-version-data-model.md). The local-first shell
 * (Part 1a) mounts this slot in App.tsx so Part 2 fills it WITHOUT touching the shell layout or
 * contending on App.tsx.
 *
 * Renders nothing today. gruntSys2: replace the body with the real ToastHost; keep the mount point.
 */
export function ConflictToastHostSlot() {
  return null;
}
