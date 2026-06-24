#!/usr/bin/env bash
# Pre-flight gate — must pass before any plugin PR merges (task #72).
# Runs: vitest suite → strict prod build (tsc + vite/wrangler) → entry-bundle gz check.
#
# The entry-bundle gz check enforces [[plugins-lazy-past-first-paint]]:
# plugin runtimes must be loaded on demand, never bundled into the entry chunk.
#
# Baseline: 147 KB gz (A1 plugin spine, 2026-06-24). Ceiling = baseline + 5 KB to
# catch runtime-code leaks at KB-scale while absorbing tiny manifest accretion.
# To raise deliberately: update ENTRY_BUNDLE_GZ_CEILING_KB below and document why.
set -euo pipefail

ENTRY_BUNDLE_GZ_CEILING_KB=152

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 1. Tests (vitest — all packages) ─────────────────────────────────────────
echo "▶ [1/3] tests..."
pnpm -r test

# ── 2. Strict prod build (tsc + vite/wrangler dry-run, all packages) ──────────
# shared: tsc emit · worker: tsc --noEmit + wrangler --dry-run · client: tsc --noEmit + vite build
# This is the gap that vitest-green ≠ deploy-clean ([[green-gate-needs-prod-typecheck]]).
echo "▶ [2/3] strict prod build (shared → worker → client)..."
pnpm -r build

# ── 3. Entry-bundle gz size check ─────────────────────────────────────────────
# Find the Vite entry chunk — named index-<hash>.js under client/dist/assets/.
# Integer KB arithmetic is sufficient for a ceiling check.
echo "▶ [3/3] entry-bundle gz size check (ceiling: ${ENTRY_BUNDLE_GZ_CEILING_KB} KB)..."

ENTRY=$(ls "$ROOT/packages/client/dist/assets/index-"*.js 2>/dev/null | head -1)
if [[ -z "$ENTRY" ]]; then
  echo "✗ no entry chunk found — did the client build succeed?" >&2
  exit 1
fi

GZ_BYTES=$(gzip -c "$ENTRY" | wc -c)
GZ_KB_INT=$((GZ_BYTES / 1024))

printf "  entry: %s\n" "$(basename "$ENTRY")"
printf "  size:  %d KB gz  (ceiling: %d KB)\n" "$GZ_KB_INT" "$ENTRY_BUNDLE_GZ_CEILING_KB"

if [[ "$GZ_KB_INT" -gt "$ENTRY_BUNDLE_GZ_CEILING_KB" ]]; then
  cat >&2 <<EOF
✗ FAIL: entry bundle ${GZ_KB_INT} KB gz exceeds ceiling ${ENTRY_BUNDLE_GZ_CEILING_KB} KB.
  Likely cause: plugin runtime or heavy import leaked into the entry chunk.
  Fix: ensure the import is behind a dynamic import() so Vite splits it into a lazy chunk.
  To raise the ceiling deliberately: update ENTRY_BUNDLE_GZ_CEILING_KB in scripts/preflight.sh
  and document the reason in the commit message.
EOF
  exit 1
fi

echo "✓ entry bundle OK (${GZ_KB_INT} KB ≤ ${ENTRY_BUNDLE_GZ_CEILING_KB} KB)"
echo "✓ preflight PASS"
