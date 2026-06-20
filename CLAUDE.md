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
