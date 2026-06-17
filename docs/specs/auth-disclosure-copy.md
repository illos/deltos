# Auth Disclosure Copy — planSys pass

**Status:** COPY-READY (planSys, 2026-06-17) for the auth-pivot routes (@ff47df8 seams). For gruntSys2 to drop
into the disclosure seams + **secSys's at-rest-disclosure-clause review leg**. Bar (held throughout): **honest,
warm, plain-language, lock-screen-grade — never overclaim security** (no "encrypted/secure" where it's
device/OS-level only; no biometric framing). Pairs with the security model (`auth-pivot-security-model`) +
spec `docs/specs/auth-pivot-password.md`.

> **DEPENDENCY FLAG:** blocks B + C assume the confirmed default **phrase-clears/re-enrolls-2FA** (pending an
> explicit user nod, built as default). If the user flips 2FA to unbypassable, **drop the "turns off
> two-factor" clauses** from B and C. The username public/private nod does not affect this copy.

---

## A. At-rest residual-risk — at sign-up (brief reaffirm OK on the login/unlock screen)
*secSys-required clause: device/OS-only protection, local-read attacker, not E2EE.*

**Heading:** How your notes are kept
**Body:** Your notes live on this device and sync to your account, so they're on all your devices. On this
device they're protected by your device's own security — they **aren't end-to-end encrypted**, so anyone who
can unlock or read this device can read your notes. Treat them the way you'd treat notes in any everyday notes
app.

*(Honest, calm, gives agency; "not end-to-end encrypted" is the precise residual risk; no overclaim. E2EE is
a v2 path — do not promise it here.)*

---

## B. Recovery phrase = master key — the phrase screen at sign-up
*The phrase is the single master recovery; it can reset password AND clear 2FA → as powerful as full access.*

**Heading:** Save your recovery phrase
**Body:** This phrase is the **master key to your account**. If you ever forget your password, it's the only
way back in — and it can reset your password and turn off two-factor authentication, so it's as powerful as
full access to your account. **We can't recover it for you, and we'll never show it again.** Write it down and
keep it somewhere safe.
**Acknowledge (checkbox, required to continue):** I've saved my recovery phrase somewhere safe.

*(Carries the one-way-derivation truth — "never show it again / can't recover it"; the 2FA-bypass power stated
plainly so the user guards it accordingly; the required ack is the robust phrase-capture gate.)*

---

## C. Reset with recovery phrase — the reset screen
**Inline note (above/under the confirm):** Resetting with your recovery phrase sets a new password, turns off
two-factor (you can set it up again afterward), and signs you out on every device. 

*(Honest about revoke-all + 2FA clear; "set it up again afterward" reassures it's not permanent loss.)*

---

## D. (Optional) 2FA setup microcopy — anti-lockout reassurance
**Line on the 2FA-enable screen:** If you ever lose your authenticator, your recovery phrase can turn off
two-factor and get you back in.

*(Reinforces the never-locked-out posture; optional — include if the seam exists.)*

---

## Placement summary (for gruntSys2)
- **A** → sign-up establishment + a brief reaffirm acceptable on login/unlock.
- **B** → the recovery-phrase screen at sign-up (with the required ack).
- **C** → the reset-with-phrase screen.
- **D** → the optional 2FA-enable screen.
All establishment paths must carry an honest disclosure (secSys gate) — A is the universal one; B is specific
to the phrase screen.
