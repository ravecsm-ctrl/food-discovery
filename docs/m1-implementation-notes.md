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
| 006 | Initial fixture dataset | Done (draft, pending human review) | 195 variants (catalog-v0.3-draft, see §6), all ETD §10.1 fixtures present |
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

- **I-01 Catalog review.** The 195 dishes (55 original + 140 added in §6), their attributes and ingredient claims are drafts written by the engineering agent, not human-reviewed (`reviewStatus: pending_human_review`). They need culinary and Filipino-context review before any user test. TD-007 rights verification applies if photos are added.
- **I-02 No real photography.** Cards use labelled emoji-on-gradient illustrations. PRRD K-19 notes images affect swipe data, so consistent rights-cleared photography is needed before meaningful preference evaluation.
- **I-03 Exposure magnitude.** The ETD cap of 0.12 assumes U spans −1..1. Without stable preferences, U spans only about ±0.45, so the cap reorders shortlists strongly: in the simulation, fried dishes in a fried-lover's shortlist fell from 33% to 5% after a fried-heavy week. This needs a product decision before arm D is evaluated with people. The ETD parameters are unchanged.
- **I-04 Top-5 hit trade-off.** `adaptive-v1` raises card relevance and shortlist match, but for some personas its top-5 hit rate is below the baseline's (e.g. Spice seeker 75% vs 95%), because the baseline sweeps more of the catalog. The weights are tunable (TD-008) but should be tuned on real sessions, not synthetic ones.
- **I-05 Interruption recovery.** Reloading the page mid-session loses the in-progress session. The evaluation record is kept. Resume is R-007 P0 work for M2, when there is persistence.
- **I-06 Restrictions storage.** Avoided ingredients are kept in `sessionStorage` (this tab only) and never written to evaluation records. Confirmed meals and evaluation records are in `localStorage` on this device only, with a "Clear all" button in the Lab. There is no consent flow because nothing leaves the device. Revisit in M2.
- **I-07 Dev-only audit warnings.** `npm audit` reports 0 production vulnerabilities and 8 moderate ones in dev tooling (minimatch via ESLint 9). They were left as-is: `--force` would install breaking major versions.
- **I-08 ESLint 9.39.5** is marked end-of-life by npm. It was chosen because `eslint-plugin-react` does not yet declare ESLint 10 support. Upgrade when the Next.js ESLint config supports v10.

---

## 5. Update: memory, taste fatigue and labels (authorized by product owner, 2026-11-06)

Scope: you asked for five things, and this update delivers all of them. Steps 1–2 bring forward part of M2 (persistent personal records and meal logging) without Supabase or accounts. The cuisine filter chips are deliberately postponed until the catalog grows.

| # | Capability | Implementation | Tests |
|---|---|---|---|
| 1 | Save data like padel-os | Data stays on the phone (`localStorage`, with persistent storage requested). Optional automatic one-way backup to the person's **private** GitHub repo, as one JSON file with every version kept, plus restore, keep-this-phone-or-restore choice on connect, file export/import, and the `/data` page | `backup-format.test.ts`; e2e with a simulated GitHub: refuses public repos, never saves the token, restores |
| 2 | "Your last 3 meals" opener | Optional step after "Start discovering": search a dish or type free text, pick a rough time ("Last night" …). Meals already logged in the last 3 days are shown, so you only add new ones. Removing a meal = correction | e2e: add 3 meals, skip, free-text meal |
| 3 | Taste fatigue v2 | `src/engine/fatigue.ts` (D-09) | `fatigue.test.ts` (13 tests) |
| 4 | Quick picks | Up to 3 fresh, diverse ideas from recent meals before any swiping (D-10); "Swipe to refine" continues into adaptive cards | unit + e2e |
| 5 | Cuisine + style labels | Card / results / details show "Filipino · Comfort food". Style is one of 6 editorial labels (D-08) | unit (schema) + e2e |

### Deviations / design decisions
- **D-08 Style labels.** The catalog (v0.2) adds a required `style` field: comfort, light_fresh, hearty, street_food, rich_indulgent or sharing. These are editorial judgments and need review, like the rest of the catalog. They are also features the fatigue model uses. Older policies ignore them, because their similarity weights don't include `style`.
- **D-09 Taste fatigue v2** replaces the ETD §8.5 similarity heuristic for the new policies:
  - **Load per attribute:** fatigue is tracked per quality (flavor, texture, method, main ingredient, style, cuisine, structure). Each confirmed meal adds a load that halves about every 24 h, inside a 4-day window.
  - **Staples ignored:** rice, vegetables, "rice meal" and "savory" never drive fatigue.
  - **Dish fatigue:** the weighted share of a dish's qualities that you ate recently.
  - **Penalty:** 0.15 × fatigue × coverage × variety-seeking × (1 − tonight's positive appetite). Coverage = number of meals ÷ 3, capped at 1. Tonight's "yes" therefore beats history (PRRD §10.4).
  - **Card order:** dishes eaten in the window go to the back of the queue in *both* card policies, and adaptive cold-start cards avoid heavily fatigued dishes. "I like routine" turns this reordering off.
  - **Status:** a provisional model grounded in sensory-specific-satiety research. It is not validated for individuals.
- **D-10 Quick picks** recommend without any swipe evidence. That is allowed by PRRD §10.3 (early tentative results), but they are always labelled "Based only on your recent meals — swipe to refine". They require at least one recognized recent meal, so free-text-only history yields no picks rather than ungrounded ones.
- **D-11 Persistence approach.** Instead of the ETD's Supabase/auth design, this uses on-device storage plus an optional backup to a private GitHub repo you own, the same approach as padel-os. That fits one or two people on their own phones. It is **not** the multi-user P0 architecture, and M2/M3 for couples on separate devices would still need a server.
- **Policies:** new sessions rotate between `baseline-fixed-v2` and `adaptive-v2`. Both use fatigue v2 and quick picks, so only card selection differs between the arms. Older policies stay available in the Lab, and older records stay readable.

### Open issues added
- **I-09 Simulation can't judge fatigue.** The synthetic personas have no taste fatigue of their own, so for a "fried lover who ate fried all week" the fatigue policy *looks* worse: top-5 hit rate drops, and the no-match rate is 13%. Whether fatigue helps can only be learned from real meals and ratings. The Lab records both.
- **I-10 (resolved 2026-11-06, owner decision).** Dietary restrictions are now remembered on the phone (`localStorage`). They are never included in the GitHub backup, backup files or evaluation exports, so after a restore on a new phone you set them again. "Your data" shows them and offers a "Forget" button.
- **I-11 One extra tap before the first card.** The recent-meals step adds a tap before the first card. It is optional ("Skip — start swiping"), so PRRD §5.2 is still met.
- **I-12 Rough meal times.** Recalled meal times are approximate ("Last night" = 7:30 pm yesterday) and flagged `timeApprox`.

## 6. Update: catalog expansion to 195 dishes (requested by product owner, 2026-11-07)

- **catalog-v0.3-draft** adds 140 dishes from the owner's cuisine list: Filipino (Manam-style plus silogs, crunchy sisig, fried liempo, adobo variants), Italian (incl. common Philippine pizza-chain styles such as four cheese, gambas, meat lover's, Hawaiian), Chinese (incl. American-Chinese quick-service staples: orange chicken, chow mein, fried rice), Japanese, Korean, Western/continental (incl. burgers and panini/sandwiches) and Vietnamese.
- New cuisine label `western`. Restaurant menus were used only as inspiration for *which generic dishes* to include; dish names are generic, and no brand names, menu text or photos were copied.
- Same conservative claim rules as v0.2: `confirmed_present` only for a dish-defining ingredient; everything else `possible`; no absence claims. Squid, octopus and oyster-sauce dishes list `shellfish` as `possible`. All labels are AI-drafted and `pending_human_review` (I-01).
- **Performance fix (no behavior change):** the fixed-baseline sequence was recomputed O(n³) on every swipe (~700 ms/card on a laptop at 195 dishes). It is now built incrementally (O(n²)) and memoized per catalog/eligible-set/seed (~2 ms/card). Verified identical to the previous order for several seeds and constraint sets.
- Tests: session-exhaustion tests now use the catalog size instead of a hard-coded 55/100; ALG-012 now allows a second item only when it is genuinely close (similarity ≥ 0.5) to the single liked dish — with v0.3, Truffle Cream Pasta legitimately joins Mushroom Risotto. The 3-item cap and no-padding rule are unchanged.

## 7. M2 — Persistence, Accounts and Memory with Supabase (approved by product owner, 2026-11-07)

**Gate:** the M1 real-use check (ENG-019, ETD §9.5 gate 12) was **waived by the product owner** ("we don't necessarily need 2 weeks to test it out"). Recorded here as an owner decision, not as evidence the check passed.

| Task | Status | Evidence |
|---|---|---|
| ENG-020 migrations | Done | `supabase/migrations/*_m2_core.sql`; reference data generated from the catalog (`npm run db:reference`), drift test |
| ENG-021 grants, RLS, RPCs | Done | All tables: RLS on, no grants to `anon`/`authenticated`; 8 reviewed `SECURITY DEFINER` functions with `auth.uid()` checks and empty `search_path`; negative tests (direct table access, other users' sessions/meals, anon callers, reused idempotency keys) |
| ENG-022 guest + persistent identity | Done | Supabase anonymous user → add email (same user id, data kept); sign-in elsewhere by 6-digit email code; guest cloud copy deleted when a phone signs into another account (no stranded data) |
| ENG-023 session persistence | Done | `sync_session`: optimistic concurrency (`SESSION_VERSION_CONFLICT`), idempotency keys (AT-027), append-only exposures/reactions, undo = invalidation (R-007) |
| ENG-024 preferences | Done | Variety setting synced (`save_preferences`) |
| ENG-025 meal logging & correction | Done | "Your data" → Edit (dish and time); `save_meal` records `meal_corrected` events; delete |
| ENG-026 exposure after correction | Done | Taste fatigue is recomputed from meals on every use; DB test shows corrected meal changes the derived load |
| ENG-027 consent & deletion | Done | Consent before any cloud write (`CONSENT_REQUIRED`), withdrawal; `delete_my_account` deletes all personal rows + the auth identity, tracked in `deletion_requests` (AT-031) |

**Deviations**
- **D-12 No Next.js API server.** ETD ED-005 routes browser → Next.js API → RPC. The app is a static GitHub Pages site (no server deployment is authorized), so the browser calls the Supabase RPCs directly with the public publishable key. The security boundary is unchanged in substance: tables are not readable or writable by API roles, and every operation is a narrowly scoped database function that derives the owner from the verified token. Tested by negative access tests. Revisit if server-only logic (rate limiting, secrets, AI) is ever needed.
- **D-13 Engine stays on the device.** ED-004 makes the backend authoritative for session state. For solo sessions the device runs the engine and the server is authoritative for *persisted* state (versions, ownership, append-only history). Couples modes (M3) will need server-authoritative sessions.
- **D-14 Reduced schema.** Households, invitations, decision proposals, fulfillment events, media assets and the full §4.3 food-knowledge schema are not created (M3/M4). `dish_variants` holds dish identity only; attributes stay in the versioned JSON catalog. No `dietary_restrictions` table: restrictions remain device-only (owner decision 2026-11-06), which is stricter than the ETD.
- **D-15 Local-first sync.** The phone keeps working offline; a three-way merge (`src/lib/sync-plan.ts`, ledger as base) reconciles meals, sessions and preferences. If the same meal is edited on two devices before syncing, the device syncing last wins.
- **D-16 Email codes instead of links.** Supabase email templates send a 6-digit code; links would open Safari instead of the home-screen app on iPhone. On the free plan this requires the custom SMTP sender (I-17).

**Open issues**
- **I-13 Email delivery limits.** Supabase's built-in email sender is rate-limited and meant for testing (a few emails per hour). Fine for 1–2 people; a custom SMTP sender would be needed beyond that.
- **I-14 Guest abuse protection.** Anonymous sign-ins are on without CAPTCHA (private prototype). Add CAPTCHA before sharing the link widely.
- **I-15 GitHub backup overlap.** The private-GitHub backup still works alongside the account. Decide later whether to retire it.
- **I-16 Database tests use PGlite** (Postgres 18 in WebAssembly) with a stub of Supabase's `auth` schema; production is Supabase Postgres 17. After `db push`, a smoke check against the real project is still required (docs/m2-supabase-setup.md).
- **I-17 Email sender.** Supabase's free plan only allows custom (6-digit code) email templates with a custom SMTP sender. Emails are sent through the owner's Gmail (app password entered by the owner in the Supabase dashboard; never stored in this repo). Gmail limits apply; deleting the Google app password stops all app email without affecting anything else.

**Live verification (2026-11-07, project `tvwezplvsvdzsqqmdukw`):** migrations applied with `supabase db push`; auth settings with `supabase config push`. As a stranger, every table read/insert and every RPC returned *permission denied*; with two real guest accounts: no write before consent, duplicate request deduplicated, the second guest could not see, edit or delete the first guest's meal, direct table reads denied with a valid token, and `delete_my_account` completed. A real code email was delivered through Gmail.

## 8. M3 step 1 — Together Mode on one phone (approved by product owner, 2026-11-07)

Scope: ENG-028 (Together Mode) and the Together part of ENG-032 (joint ranking) and ENG-033 (final approval, shared-screen form). Not in this step: invitations, Individual Mode across devices, realtime, households (ENG-029–031, 034–035).

| Rule (PRRD/ETD) | Implementation | Evidence |
|---|---|---|
| J-03.2 one shared reaction per card | "We like it" / "Not for us" (and swipes) record one unattributed reaction | engine + DB tests (AT-013) |
| J-03.3–4 optional disagreement, attributed | "We disagree on this one" → "Only {name}": two attributed reactions in one action group; one Undo removes both | engine + DB + browser tests (AT-014) |
| ETD §8.10 joint ranking | `Joint = 0.65 × mean(Ua, Ub) + 0.35 × min(Ua, Ub)` (`JOINT_V0`); each Uj = shared reactions + that person's attributed ones; a one-sided "no" doesn't remove a dish, a shared one does | `together.test.ts` |
| ETD §8.10 shared Yes ≠ two individual Yes | Stored once with scope `shared`; explained as "you both said yes", never BOTH_PARTICIPANTS_LIKED | engine + DB tests |
| J-03.7 one explicit shared confirmation | "Pick … together" → confirmation sheet → `joint_decision_confirmed` (session state `decision_confirmed`); not a meal | DB + browser tests (AT-020) |
| R-017 meal ownership | Only the phone owner can log their own meal afterwards; the partner's is never saved | browser test |
| R-022 private by default | Together Mode uses **no personal history** (no meal history, taste fatigue or stored preferences) because both people see the screen | engine test (identical results with/without history) |
| R-023 restrictions | Owner's saved restrictions + partner's restrictions (session only, then forgotten) are hard exclusions before ranking | engine + browser tests |
| Privacy | Names stay in memory only; partner restrictions never stored or synced; cloud stores only whether avoidances were active | browser + DB tests |

**Database:** migration `20261107000300_together_mode.sql` — partner = participant slot 2 with no account; shared card exposures; reaction uniqueness per (card, participant, sequence); a trigger rejects active shared and individual reactions on the same card; `fd_session_json` round-trips disagreement codes (`"a"`/`"b"`). Solo sessions are unchanged.

**Evaluation:** the Lab's card-policy comparison counts solo sessions only (Together sessions use a different, joint objective).

**Deviations / open issues**
- **D-17** Together Mode ignores taste fatigue and recent meals (privacy on a shared screen). A future option: an optional, session-only "what have you two eaten recently?" question.
- **I-18** "We disagree" records only who wanted the dish, not strength of feeling. Revisit if real use shows people want "only Sam, and Rave really doesn't".

**Live verification (2026-11-07):** migration applied with `supabase db push` after owner approval. With temporary guests: a Together session (shared vote, undone disagreement, joint decision) round-tripped exactly with no names stored and no meal created; another guest could neither overwrite nor see it; the new internal helpers return *permission denied* to signed-in users; test guests deleted.
