# M0 + M1 implementation notes

Scope: ETD ENG-001 … ENG-019 (local solo intelligence prototype). Governing docs: PRRD V1.0 (authoritative), ETD V1.0.

## 1. Task status

| ENG | Task | Status | Evidence |
|---|---|---|---|
| 001 | Pin runtime, package manager, framework, test versions | Done | Node 24.22.0 LTS (`.nvmrc`), npm 11.19.1, exact versions in `package.json` + lockfile |
| 002 | Minimal repo, strict TS, test commands | Done (single package — D-01) | `npm run lint/typecheck/test/test:e2e/verify` |
| 003 | Domain/contract boundaries | Done | ESLint `no-restricted-imports/globals/properties` on `src/engine`, `src/catalog`; boundary unit test |
| 004 | Catalog format + validators | Done | `src/catalog/schema.ts`; 8 negative validation tests; `npm run catalog:validate` |
| 005 | Policy config + seeded RNG | Done | `src/engine/policy.ts`, `src/engine/rng.ts`; ALG-011 determinism tests |
| 006 | Initial fixture dataset | Done (draft, pending human review) | 55 variants, all ETD §10.1 fixtures present |
| 007 | Test workflow + CI checks | Done locally; CI file inactive until pushed to GitHub | `.github/workflows/ci.yml`, `npm run verify` |
| 008 | Food vectors + similarity | Done | symmetry/bounds/neighbour fixtures |
| 009 | Hard eligibility | Done | ALG-009/010/016, property test across policies/seeds, e2e shellfish test |
| 010 | Stable/current preference scoring | Done | ALG-002/003/005 |
| 011 | Optional exposure heuristic | Done (engine + local confirmed meals) | ALG-006/007/008, dedupe, 7-day window |
| 012 | Fixed-order baseline | Done | reaction-independent, repeatable |
| 013 | Adaptive next-card policy | Done (D-05) | order responds to reactions; v1 > v0 test |
| 014 | Shortlist 1–3 + no-match | Done | ALG-012/013, near-duplicate test, readiness tests |
| 015 | Reason codes + explanations | Done | grounded-explanation tests |
| 016 | Solo card UI | Done | gesture/button/keyboard e2e on mobile + desktop |
| 017 | Undo | Done | unit + e2e |
| 018 | Local measurement + outcome capture | Done | Lab page, JSON/CSV export, event separation tests |
| 019 | Technical + usability evaluation | **Partial** | Synthetic technical evaluation done (`docs/m1-technical-evaluation.md`). Real-use usability evaluation **not run** — needs people; protocol in `docs/m1-usability-protocol.md` |

## 2. Requirement coverage at prototype depth

| Requirement | What M1 does | Not yet (later milestone) |
|---|---|---|
| R-003 cards | image-led card, labelled placeholder art, buttons = swipe = arrow keys, details without voting, live-region announcements, reduced motion | strong-preference menu (needs persistence), WCAG audit (ENG-042) |
| R-004 adaptive | `adaptive-v1` Q-policy, seeded tie-break | learned policies |
| R-005 early/continue | "See picks" after 1 reaction, readiness prompt ≥3 cards, round ends at ~10, keep discovering | — |
| R-007 undo | multi-step undo; invalidated evidence kept for evaluation | resume after reload/interruption |
| R-008 separate signals | P / C / X / N / R kept separate in `ScoreBreakdown` | persistent stable preferences (M2) |
| R-009 / R-023 constraints | confirmed-present exclusion before ranking; "possible"/unknown never become safety claims; warning on card and results | persistent, private restriction records (M2) |
| R-010 / R-013 shortlist + explanations | 1–3 diverse items, honest no-match, tentative labelling, code-backed sentences, no percentages | — |
| R-012 exposure | confirmed meals only, 48 h half-life, 7-day window, cap 0.12 | meal correction UI, History screen (M2) |
| R-014 / R-031 comparison | policy rotation, per-policy summary with denominators, JSON/CSV export | cost/ops telemetry (M4) |
| R-016 event separation | `dish_selected`, `meal_consumption_confirmed`, `satisfaction_recorded`, `meal_not_logged` are separate; selection never creates a meal | — |

Out of scope and **not** implemented (no placeholders): DB/Supabase, auth/accounts, couples modes, realtime,
fulfillment/restaurant/delivery links, payments, forecast, AI calls, History/Me navigation.

## 3. Deviations from the ETD (engineering only — no product behavior changed)

- **D-01 Single package instead of a monorepo.** The engine lives in `src/engine` and is framework-free, enforced by lint and a test, as ETD ED-003 requires. Splitting it into packages later is mechanical.
- **D-02 Extended catalog format.** The ETD `DishVariant` type has no per-dish ingredient claims or evidence status. The catalog adds `ingredients[{key, presence}]` (mirroring the `ingredient_claims` table), `cuisine`, `richness`, `recognizability`, `tags` and `illustration`, plus catalog-level provenance. There is deliberately no "absent" presence state.
- **D-03 Current-appetite normalization.** ETD §8.4 divides by Σ|w| over *all* reactions, so unrelated No reactions dilute a direct Yes. In the unit test, one Yes on Pho followed by 5 unrelated No reactions gives C(Pho) < 0.2, and the person's liked dish drops out of the shortlist. The default is now a similarity-kernel weighted average: k = ((sim − 0.15)/0.85)², with a prior of 0.5. The ETD-literal mode stays available (`normalization: "global"`) and has a test.
- **D-04 Novelty N.** The ETD does not define it. N = (2·noveltyPreference − 1) × (1 − max similarity to confirmed meals), and N = 0 when there is no meal history or the preference is the neutral 0.5. In practice it is inactive in M1, because there is no novelty-preference UI.
- **D-05 Next-card term normalization.** Taken literally, ETD §8.8 maps appeal to (U+1)/2 and information to 1−|C|. Appeal differences between candidates are then tiny, and the information term favors dishes with no evidence at all, i.e. unrelated ones. In simulation the adaptive policy then behaves almost like the baseline (`adaptive-v0`). `adaptive-v1` keeps the ETD weights (0.60 / 0.25 / 0.15) but min-max normalizes each term across candidates, and multiplies uncertainty by how much evidence exists. `adaptive-v0` is kept for reference and excluded from rotation.
- **D-06 Baseline definition.** `baseline-fixed-v0` uses a fixed, diverse, reaction-independent card order and the *same* shortlist ranker as the adaptive policies. That isolates card selection, which is what H-02 tests. It sits between PRRD arms A and B.
- **D-07 Fulfillment status.** No availability data exists, so status is `unverified` (any/cook) or `search_only` (dine-out/delivery). No fulfillment UI exists, because it is M4.

## 4. Open issues for product/engineering decision

- **I-01 Catalog review.** The 55 dishes, their attributes and ingredient claims are drafts written by the engineering agent, not human-reviewed (`reviewStatus: pending_human_review`). They need culinary and Filipino-context review before any user test. TD-007 rights verification applies if photos are added.
- **I-02 No real photography.** Cards use labelled emoji-on-gradient illustrations. PRRD K-19 notes images affect swipe data, so consistent rights-cleared photography is needed before meaningful preference evaluation.
- **I-03 Exposure magnitude.** The ETD cap of 0.12 assumes U spans −1..1. Without stable preferences, U spans only about ±0.45, so the cap reorders shortlists strongly: in the simulation, fried dishes in a fried-lover's shortlist fell from 33% to 5% after a fried-heavy week. This needs a product decision before arm D is evaluated with people. The ETD parameters are unchanged.
- **I-04 Top-5 hit trade-off.** `adaptive-v1` raises card relevance and shortlist match, but for some personas its top-5 hit rate is below the baseline's (e.g. Spice seeker 75% vs 95%), because the baseline sweeps more of the catalog. The weights are tunable (TD-008) but should be tuned on real sessions, not synthetic ones.
- **I-05 Interruption recovery.** Reloading the page mid-session loses the in-progress session. The evaluation record is kept. Resume is R-007 P0 work for M2, when there is persistence.
- **I-06 Restrictions storage.** Avoided ingredients are kept in `sessionStorage` (this tab only) and never written to evaluation records. Confirmed meals and evaluation records are in `localStorage` on this device only, with a "Clear all" button in the Lab. There is no consent flow because nothing leaves the device. Revisit in M2.
- **I-07 Dev-only audit warnings.** `npm audit` reports 0 production vulnerabilities and 8 moderate ones in dev tooling (minimatch via ESLint 9). They were left as-is: `--force` would install breaking major versions.
- **I-08 ESLint 9.39.5** is marked end-of-life by npm. It was chosen because `eslint-plugin-react` does not yet declare ESLint 10 support. Upgrade when the Next.js ESLint config supports v10.
