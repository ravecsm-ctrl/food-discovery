# Food Discovery App — Engineering Guide

Authoritative specs: **PRRD V1.0** (product behavior — wins on conflict) and **ETD V1.0** (engineering design).
Current authorized scope: **M0 + M1 (ENG-001 … ENG-019)** plus the owner-approved memory update
(on-device data + private-GitHub backup, recent-meals opener, taste fatigue v2, quick picks, cuisine/style labels — see notes §5).
Implementation notes, deviations and open issues: `docs/m1-implementation-notes.md`.

## Principles
- Smallest complete behavior → test → measure → improve → expand.
- The engine (`src/engine`) is pure TypeScript: no React/Next, browser APIs, env vars, `Math.random`, or `Date.now`.
  Clock, seed and policy are injected. Same inputs + policy + seed ⇒ same output. ESLint enforces this.
- Hard dietary exclusions run **before** ranking and can never be overridden by a score.
- Unknown ≠ zero. Missing ingredient data is never a safety claim; missing meals never mean "not eaten".
- A **No** means "not tonight" (session only), never a permanent dislike. A **Yes** is not a long-term favorite.
- Selecting a dish ≠ eating it ≠ enjoying it. Selection, consumption and satisfaction are separate events.
- Explanations come only from reason codes + real evidence. Never show scores as percentages/compatibility.
- Ordinary swipes never call AI or any network service.
- Scoring coefficients are provisional, versioned policies (`src/engine/policy.ts`). Change values by adding a new policy id.

## Out of scope until explicitly authorized
Supabase/any server DB, deployment other than the GitHub Pages workflow, auth/accounts, cuisine filter chips, Together/Individual (couples) modes, realtime,
restaurant/delivery APIs, payments, weekly forecast, ML infra, paid AI calls, social/gamification,
History/Me screens, strong-preference (permanent) feedback UI. Do not add placeholder scaffolding for these.
Do not invent product features or relax approved behavior; escalate scope/privacy/safety questions.

## Layout
- `src/catalog/` — `dishes.json` (versioned prototype catalog) + zod validator (`schema.ts`).
- `src/engine/` — similarity, eligibility, scoring, exposure, card selection, shortlist, reasons, session reducer.
- `src/lib/` — on-device store, evaluation records, recent-meal helpers, GitHub backup (token stays on device, never in backups).
- `src/app/`, `src/components/` — Next.js App Router UI (mobile-first).
- `scripts/` — catalog validation and offline policy simulation (run with Node type stripping).
- `tests/e2e/` — Playwright browser tests.

## Conventions
- Node 24 LTS (`.nvmrc`), npm, exact-pinned dependencies (`--save-exact`).
- Engine-relative imports use explicit `.ts` extensions so scripts run directly in Node.
- Reference PRRD `R-xxx`/`AT-xxx` and ETD `ENG-xxx`/`ALG-xxx` IDs in tests and commit messages.
- Images: only rights-cleared assets with recorded provenance. Otherwise use the labelled illustration placeholder.

## Required checks (run before claiming anything works)
```bash
npm run lint           # ESLint incl. domain-boundary rules
npm run typecheck      # tsc --noEmit (strict)
npm test               # Vitest unit tests (engine + catalog)
npm run catalog:validate
npm run build          # production build
npm run test:e2e       # Playwright (needs a build; first run: npx playwright install chromium)
npm run verify         # all of the above in order
npm run export         # static site in out/ (GitHub Pages publishes main automatically)
```
