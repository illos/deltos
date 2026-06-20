# deltos — project instructions

These are binding instructions for every session working on **deltos**. They load
each session, so they override default behavior and any contradicting recalled memory.

## ⛔ User review of real code happens ON THE LIVE SITE — never a local/preview server

When code is ready for **Jim (the user) to review, dogfood, or feel-test**, it is
**deployed to the live site** and he reviews it there:

- **Live site:** **https://deltos.blackgate.studio** (the Cloudflare deployment —
  Worker + prod D1 + PWA).
- **`live = dev`** for this project: the live Cloudflare deployment **IS** the
  development / review / dogfood environment. There is no separate protected prod.
  So **"deploy it" / "push it live" always means deploy to Cloudflare**, and the
  live URL is where Jim reviews.
- **NEVER hand Jim a local or preview server for reviewing real code** — not
  `vite dev`, not `wrangler dev`, not a `tailscale serve` / `devbox.*.ts.net:84xx`
  URL, not any localhost/tailnet preview. **The deploy is the review step.** When a
  feature is ready for his eyes: deploy to `deltos.blackgate.studio` (standing
  Cloudflare/Wrangler deploy auth covers it), then give Jim the **live URL**.
- **Scope:** this bans local/preview servers for **Jim's review only**. The team's
  own automated checks (headless browser smoke, `wrangler dev` for unit/integration
  testing, CDP runs) may still run locally — those are not user review. The line is:
  *anything Jim is asked to look at = the live deployed site.*

**Why:** Jim reviews real, deployed code at the real URL on his own device. Local
previews diverge from prod, add a hop, and are simply not how he works. He has asked
for this repeatedly — treat any urge to spin up a preview for his review as a bug.

## 🗑️ Files, data, and accounts are DISPOSABLE until Jim says otherwise

This is a pre-real-users dev/dogfood phase. **All app data, files, accounts, and the
prod D1 database are disposable** (Jim, 2026-06-20). Do NOT spend effort preserving,
migrating, or recovering data or accounts:

- **Bias to the CLEANEST end state**, not preservation. Wiping the database, dropping
  rows, deleting accounts, and re-registering fresh are all **low-risk and fine** when
  they get to a cleaner result faster than a careful migration/recovery.
- When a user account gets into a bad state (e.g. a locked-out test account), **do not
  do delicate D1 surgery to save it** — just make a fresh account or reset the data.
  The fix is in the CODE; the account/data is throwaway.
- Engineering discipline still applies to the CODE and to migration *correctness as a
  pattern* (don't teach bad habits) — but the *data itself* carries no value to protect.

**Behavioral — STOP doing these** (Jim has corrected this more than once):
- Do NOT reassure Jim that "your data is safe / nothing is lost." He doesn't care; it
  reads as missing the point.
- Do NOT have him check Trash, refresh-to-recover, or preserve anything *for the sake
  of recovery*. There is nothing to recover.
- Do NOT gate a bug triage on "did it mutate the data or just hide it?" *as a
  data-recovery question*. A regression is a CODE bug — diagnose it from the CODE and
  fix it. (Asking him to reproduce a bug — "create a note, back out, does it vanish?"
  — is fine; that's diagnosis, not data-preservation. The difference is the framing.)
- When data gets into a bad state: wipe and recreate. Never nurse it.

**This flips to preservation-first the moment Jim says real users exist** (then data is
sacred, destructive resets are off the table). Until that explicit signal, default to
disposable. See [[pre-real-users-clean-state-bias]].
