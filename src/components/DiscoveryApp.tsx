"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCatalog } from "@/catalog";
import { ownDishMatches, searchDishes } from "@/lib/dish-search";
import {
  DEFAULT_CONSTRAINTS,
  RESTRICTION_KEYS,
  addExposure,
  buildCandidates,
  canUndo,
  continueDiscovery,
  createSession,
  currentExposure,
  effectiveCardCount,
  explainItem,
  ownDishSummary,
  getPolicy,
  quickPicks,
  readiness,
  recommend,
  recordReaction,
  recordSplitReaction,
  selectNextCard,
  undoLastReaction,
  type DiscoverySession,
  type EngineDeps,
  type OwnDish,
  type ParticipantNames,
  type TogetherMeal,
  type ReactionValue,
  type RecommendationRun,
  type RestrictionKey,
  type SafetyAssessment,
} from "@/engine";
import { startCloudBackup } from "@/lib/cloud-backup";
import { startCloudSync } from "@/lib/cloud-sync";
import { exposureRecords, rotatePolicy, runRecord, type CardTrace } from "@/lib/evaluation";
import {
  addMeal,
  appendEvalEvent,
  getAssignmentSetting,
  getProfile,
  getRestrictions,
  listEvalSessions,
  listMeals,
  setProfile,
  setRestrictions,
  upsertEvalSession,
  type EvalSessionRecord,
  type RecommendationRunRecord,
} from "@/lib/local-store";
import { DescribeDish } from "./DescribeDish";
import { DishArt } from "./DishArt";
import { DishDetails, DishLabel, RESTRICTION_LABELS, SafetyNote } from "./DishInfo";
import { RecentMealsStep } from "./RecentMealsStep";
import { Sheet } from "./Sheet";
import { TogetherMealsStep } from "./TogetherMealsStep";
import { SwipeCard } from "./SwipeCard";

type Phase = "home" | "recent-meals" | "together-setup" | "together-meals" | "discover" | "results" | "picked" | "other-meal" | "rate" | "thanks";

interface OutcomeContext {
  sessionId: string;
  dishId: string;
  mealId?: string;
}

const catalog = loadCatalog();
const nowIso = () => new Date().toISOString();
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
const newSeed = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] as number;
};
const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function depsFor(policyId: string): EngineDeps {
  return {
    catalog,
    policy: getPolicy(policyId),
    user: { stableAttributeWeights: {}, confirmedMeals: listMeals(), noveltyPreference: 0.5, varietySeeking: getProfile().varietySeeking },
    now: nowIso(),
  };
}

/** Most recent selection with no meal outcome yet (low-friction confirmation prompt, PRRD §11.6). */
function pendingOutcome(): OutcomeContext | null {
  const sessions = listEvalSessions().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const s of sessions.slice(0, 5)) {
    const lastSel = [...s.events].reverse().find((e) => e.type === "dish_selected" || e.type === "joint_decision_confirmed");
    if (!lastSel || (lastSel.type !== "dish_selected" && lastSel.type !== "joint_decision_confirmed")) continue;
    const resolved = s.events.some(
      (e) => (e.type === "meal_consumption_confirmed" || e.type === "meal_not_logged") && e.at >= lastSel.at,
    );
    if (!resolved && Date.now() - Date.parse(lastSel.at) < 36 * 3_600_000) return { sessionId: s.sessionId, dishId: lastSel.dishId };
  }
  return null;
}

export function DiscoveryApp() {
  const [phase, setPhase] = useState<Phase>("home");
  const [session, setSession] = useState<DiscoverySession | null>(null);
  const [traces, setTraces] = useState<Record<string, CardTrace>>({});
  const [runs, setRuns] = useState<RecommendationRun[]>([]);
  const [assignment, setAssignment] = useState<"rotation" | "manual">("rotation");
  const [leaving, setLeaving] = useState<ReactionValue | null>(null);
  const [announce, setAnnounce] = useState("");
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [restrictionsOpen, setRestrictionsOpen] = useState(false);
  const [restrictions, setRestrictionState] = useState<RestrictionKey[]>([]);
  const [outcome, setOutcome] = useState<OutcomeContext | null>(null);
  const [pending, setPending] = useState<OutcomeContext | null>(null);
  const [exhaustedNotice, setExhaustedNotice] = useState(false);
  /** Together Mode display names — kept in memory only, never stored or synced. */
  const [pair, setPair] = useState<ParticipantNames | null>(null);
  /** Setup chosen on the first Together screen, held until the recent-meals step finishes. */
  const [togetherSetup, setTogetherSetup] = useState<{ names: ParticipantNames; partner: RestrictionKey[] } | null>(null);
  const [disagreeOpen, setDisagreeOpen] = useState(false);
  const [jointConfirm, setJointConfirm] = useState<{ dishId: string; rank: number } | null>(null);
  const runTriggers = useRef<RecommendationRunRecord["trigger"][]>([]);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Read browser-only state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestrictionState(getRestrictions());
    setPending(pendingOutcome());
    startCloudBackup();
    startCloudSync();
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    mainRef.current?.focus();
  }, [phase]);

  const deps = useMemo(() => (session ? depsFor(session.policyId) : null), [session]);
  const exposure = session ? currentExposure(session) : null;
  const currentDish = exposure ? catalog.byId.get(exposure.dishId) ?? null : null;
  const candidates = useMemo(() => buildCandidates(catalog, session?.constraints ?? { ...DEFAULT_CONSTRAINTS, avoidedIngredients: restrictions }), [session, restrictions]);
  const ready = session && deps ? readiness(session, deps) : null;
  const latestRun = runs.at(-1) ?? null;

  /* ---------- persistence ---------- */

  const persist = useCallback(
    (s: DiscoverySession, t: Record<string, CardTrace>, rs: RecommendationRun[], asg: "rotation" | "manual") => {
      const existing = listEvalSessions().find((r) => r.sessionId === s.sessionId);
      const now = nowIso();
      const rec: EvalSessionRecord = {
        schemaVersion: 1,
        sessionId: s.sessionId,
        ...(s.mode === "together" ? { mode: "together" as const } : {}),
        policyId: s.policyId,
        assignment: asg,
        catalogVersion: s.catalogVersion,
        seed: s.seed,
        startedAt: s.startedAt,
        updatedAt: now,
        hardConstraintsActive: s.constraints.avoidedIngredients.length > 0,
        excludedByConstraints: buildCandidates(catalog, s.constraints).excluded.length,
        exposures: exposureRecords(s, t),
        recommendationRuns: rs.map((r, i) => existing?.recommendationRuns[i] ?? runRecord(r, now, runTriggers.current[i] ?? "user_request")),
        events: existing?.events ?? [],
      };
      upsertEvalSession(rec);
    },
    [],
  );

  /** Show the next card, or go to results if the round ended / nothing is left. */
  const advance = useCallback(
    (s: DiscoverySession, t: Record<string, CardTrace>, rs: RecommendationRun[], asg: "rotation" | "manual") => {
      const d = depsFor(s.policyId);
      const r = readiness(s, d);
      if (effectiveCardCount(s) > 0 && (r.roundComplete || r.exhausted)) {
        const run = recommend(s, d);
        runTriggers.current = [...runTriggers.current, r.exhausted ? "exhausted" : "round_end"];
        const nextRuns = [...rs, run];
        setSession(s);
        setTraces(t);
        setRuns(nextRuns);
        setExhaustedNotice(r.exhausted);
        persist(s, t, nextRuns, asg);
        setPhase("results");
        return;
      }
      const choice = selectNextCard(s, d);
      if (!choice) {
        setSession(s);
        setExhaustedNotice(true);
        persist(s, t, rs, asg);
        setPhase("results");
        return;
      }
      const s2 = addExposure(s, choice.dishId, d.now);
      const exp = currentExposure(s2);
      const t2 = exp ? { ...t, [exp.exposureId]: { selectionReason: choice.reason, q: choice.q } } : t;
      setSession(s2);
      setTraces(t2);
      setRuns(rs);
      persist(s2, t2, rs, asg);
    },
    [persist],
  );

  const start = useCallback(() => {
    const setting = getAssignmentSetting();
    const asg = setting === "rotation" ? "rotation" : "manual";
    const policyId = setting === "rotation" ? rotatePolicy(listEvalSessions().length) : setting;
    const policy = getPolicy(policyId);
    const s = createSession({
      sessionId: newId(),
      seed: newSeed(),
      policyId,
      catalogVersion: catalog.catalogVersion,
      constraints: { ...DEFAULT_CONSTRAINTS, avoidedIngredients: restrictions },
      now: nowIso(),
      initialBudget: policy.session.initialBudget,
    });
    runTriggers.current = [];
    setAssignment(asg);
    setExhaustedNotice(false);
    setLeaving(null);
    setProfile({ recentMealsAskedAt: nowIso() });
    if (policy.quickPicks) {
      const run = quickPicks(s, depsFor(policyId));
      if (run.items.length > 0) {
        runTriggers.current = ["quick_picks"];
        setSession(s);
        setTraces({});
        setRuns([run]);
        persist(s, {}, [run], asg);
        setPhase("results");
        setAnnounce("Here are some fresh ideas based on your recent meals.");
        return;
      }
    }
    setPhase("discover");
    advance(s, {}, [], asg);
    setAnnounce("Discovery started.");
  }, [advance, persist, restrictions]);

  /** Together Mode on one phone (PRRD J-03): both people's restrictions apply; no personal history is used. */
  const startTogether = useCallback(
    (names: ParticipantNames, partnerRestrictions: RestrictionKey[], togetherMeals: TogetherMeal[]) => {
      const setting = getAssignmentSetting();
      const asg = setting === "rotation" ? "rotation" : "manual";
      const policyId = setting === "rotation" ? rotatePolicy(listEvalSessions().length) : setting;
      const policy = getPolicy(policyId);
      const s = createSession({
        sessionId: newId(),
        seed: newSeed(),
        policyId,
        catalogVersion: catalog.catalogVersion,
        constraints: { ...DEFAULT_CONSTRAINTS, avoidedIngredients: [...new Set([...restrictions, ...partnerRestrictions])] },
        now: nowIso(),
        initialBudget: policy.session.initialBudget,
        mode: "together",
        togetherMeals,
      });
      runTriggers.current = [];
      setTogetherSetup(null);
      setPair(names);
      setAssignment(asg);
      setExhaustedNotice(false);
      setLeaving(null);
      setDisagreeOpen(false);
      setPhase("discover");
      advance(s, {}, [], asg);
      setAnnounce(`Together mode started for ${names.a} and ${names.b}.`);
    },
    [advance, restrictions],
  );

  const reactSplit = useCallback(
    (wantedBy: "a" | "b") => {
      const pendingCard = session ? currentExposure(session) : null;
      if (!session || !pendingCard || leaving || !pair) return;
      setDisagreeOpen(false);
      const s2 = recordSplitReaction(session, wantedBy, nowIso());
      advance(s2, traces, runs, assignment);
      setAnnounce(`${catalog.byId.get(pendingCard.dishId)?.name ?? ""}: only ${pair[wantedBy]} wants it.`);
    },
    [advance, assignment, leaving, pair, runs, session, traces],
  );

  const react = useCallback(
    (value: ReactionValue) => {
      const pendingCard = session ? currentExposure(session) : null;
      if (!session || !pendingCard || leaving) return;
      const dishName = catalog.byId.get(pendingCard.dishId)?.name ?? "";
      setLeaving(value);
      const commit = () => {
        setLeaving(null);
        const s2 = recordReaction(session, value, nowIso());
        advance(s2, traces, runs, assignment);
        setDisagreeOpen(false);
        setAnnounce(`${dishName}: ${value === "yes" ? (session.mode === "together" ? "You both like it" : "Sounds good") : session.mode === "together" ? "Not for you two" : "Not tonight"}.`);
      };
      if (prefersReducedMotion()) commit();
      else window.setTimeout(commit, 200);
    },
    [advance, assignment, leaving, runs, session, traces],
  );

  const undo = useCallback(() => {
    if (!session || !canUndo(session) || leaving) return;
    const s2 = undoLastReaction(session, nowIso());
    const back = currentExposure(s2);
    setSession(s2);
    persist(s2, traces, runs, assignment);
    setPhase("discover");
    setAnnounce(`Undone. Back to ${back ? catalog.byId.get(back.dishId)?.name : "the previous card"}.`);
  }, [assignment, leaving, persist, runs, session, traces]);

  const showResults = useCallback(
    (trigger: RecommendationRunRecord["trigger"]) => {
      if (!session || !deps) return;
      const run = recommend(session, deps);
      runTriggers.current = [...runTriggers.current, trigger];
      const rs = [...runs, run];
      setRuns(rs);
      persist(session, traces, rs, assignment);
      setPhase("results");
    },
    [assignment, deps, persist, runs, session, traces],
  );

  const keepDiscovering = useCallback(
    (dismissed: boolean) => {
      if (!session) return;
      const at = nowIso();
      if (dismissed) appendEvalEvent(session.sessionId, { type: "recommendations_dismissed", at, runIndex: runs.length - 1 });
      appendEvalEvent(session.sessionId, { type: "continued_discovery", at });
      const budget = getPolicy(session.policyId).session.initialBudget;
      const s2 = effectiveCardCount(session) >= session.roundEndsAt ? continueDiscovery(session, budget) : session;
      setExhaustedNotice(false);
      setPhase("discover");
      if (currentExposure(s2)) {
        setSession(s2);
        persist(s2, traces, runs, assignment);
      } else {
        advance(s2, traces, runs, assignment);
      }
    },
    [advance, assignment, persist, runs, session, traces],
  );

  const confirmJoint = useCallback(() => {
    if (!session || !jointConfirm) return;
    // One explicit shared confirmation records the joint decision (J-03 step 7). It is not a meal.
    appendEvalEvent(session.sessionId, { type: "joint_decision_confirmed", at: nowIso(), dishId: jointConfirm.dishId, rank: jointConfirm.rank, runIndex: runs.length - 1 });
    setOutcome({ sessionId: session.sessionId, dishId: jointConfirm.dishId });
    setJointConfirm(null);
    setPhase("picked");
  }, [jointConfirm, runs.length, session]);

  const choose = useCallback(
    (dishId: string, rank: number) => {
      if (!session) return;
      if (session.mode === "together") {
        setJointConfirm({ dishId, rank });
        return;
      }
      appendEvalEvent(session.sessionId, { type: "dish_selected", at: nowIso(), dishId, rank, runIndex: runs.length - 1 });
      setOutcome({ sessionId: session.sessionId, dishId });
      setPhase("picked");
    },
    [runs.length, session],
  );

  const confirmMeal = useCallback(
    (ctx: OutcomeContext, dishId: string | null, unrecognizedName: string | null, ownDish: OwnDish | null = null) => {
      const mealId = newId();
      const at = nowIso();
      addMeal({
        id: mealId,
        dishId,
        unrecognizedName,
        ownDish: dishId ? null : ownDish,
        consumedAt: at,
        confirmed: true,
        source: dishId === ctx.dishId ? "selection_confirmation" : "manual",
      });
      appendEvalEvent(ctx.sessionId, {
        type: "meal_consumption_confirmed",
        at,
        mealId,
        dishId,
        matchesSelection: dishId === ctx.dishId,
        unrecognized: dishId === null,
      });
      setOutcome({ ...ctx, mealId });
      setPending(null);
      setPhase("rate");
    },
    [],
  );

  const goHome = useCallback(() => {
    setSession(null);
    setRuns([]);
    setTraces({});
    setOutcome(null);
    setPair(null);
    setTogetherSetup(null);
    setDisagreeOpen(false);
    setJointConfirm(null);
    setPending(pendingOutcome());
    setPhase("home");
  }, []);

  /* ---------- keyboard alternative to gestures (R-003, AT-004) ---------- */
  useEffect(() => {
    if (phase !== "discover") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (detailsFor || el?.closest("input, textarea, select, dialog")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        react("yes");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        react("no");
      } else if (e.key === "u" || e.key === "U" || e.key === "Backspace") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsFor, phase, react, undo]);

  const detailsDish = detailsFor ? catalog.byId.get(detailsFor) : null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
      <p aria-live="polite" className="sr-only" data-testid="live-region">
        {announce}
      </p>

      <main ref={mainRef} tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {phase === "home" && (
          <Home
            restrictions={restrictions}
            pending={pending}
            onStart={() => setPhase("recent-meals")}
            onStartTogether={() => setPhase("together-setup")}
            onRestrictions={() => setRestrictionsOpen(true)}
            onPendingAte={(ctx) => confirmMeal(ctx, ctx.dishId, null)}
            onPendingOther={(ctx) => {
              setOutcome(ctx);
              setPhase("other-meal");
            }}
            onPendingSkip={(ctx) => {
              appendEvalEvent(ctx.sessionId, { type: "meal_not_logged", at: nowIso() });
              setPending(null);
            }}
          />
        )}

        {phase === "recent-meals" && <RecentMealsStep onContinue={start} onBack={goHome} />}

        {phase === "together-setup" && (
          <TogetherSetup
            ownRestrictions={restrictions}
            onStart={(names, partner) => {
              setTogetherSetup({ names, partner });
              setPhase("together-meals");
            }}
            onBack={goHome}
          />
        )}

        {phase === "together-meals" && togetherSetup && (
          <TogetherMealsStep
            names={togetherSetup.names}
            onContinue={(meals) => startTogether(togetherSetup.names, togetherSetup.partner, meals)}
            onBack={() => setPhase("together-setup")}
          />
        )}

        {phase === "discover" && session && (
          <section className="flex flex-1 flex-col" aria-label="Food cards">
            <header className="mb-3 flex items-center justify-between gap-2">
              <button type="button" onClick={goHome} className="rounded-full px-2 py-2 text-sm font-medium text-muted" aria-label="Leave discovery">
                ← Exit
              </button>
              <p className="text-sm font-medium text-muted" data-testid="progress">
                Card {Math.min(effectiveCardCount(session) + 1, session.roundEndsAt)} of ~{session.roundEndsAt}
              </p>
              <button
                type="button"
                onClick={() => showResults("user_request")}
                disabled={!ready?.canRequestResults}
                className="rounded-full bg-surface-2 px-3.5 py-2 text-sm font-semibold disabled:opacity-40"
              >
                See picks
              </button>
            </header>
            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.min(100, (effectiveCardCount(session) / session.roundEndsAt) * 100)}%` }}
              />
            </div>

            <div className="relative min-h-[420px] flex-1">
              <div className="absolute inset-x-4 bottom-[-8px] top-3 rounded-[28px] bg-surface-2 ring-1 ring-line" aria-hidden="true" />
              {currentDish && exposure && (
                <SwipeCard
                  key={exposure.exposureId}
                  dish={currentDish}
                  safety={candidates.byId.get(currentDish.id)?.safety ?? { status: "no_restrictions_declared", possibleConflicts: [] }}
                  leaving={leaving}
                  onSwipe={react}
                  onDetails={() => setDetailsFor(currentDish.id)}
                />
              )}
            </div>

            {ready?.promptReady && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-line" role="status" data-testid="readiness-prompt">
                <p className="text-sm">You have a few promising picks.</p>
                <button type="button" onClick={() => showResults("readiness_prompt")} className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink">
                  See them
                </button>
              </div>
            )}

            {session.mode === "together" && pair && disagreeOpen ? (
              <div className="mt-4 rounded-3xl bg-surface p-3 ring-1 ring-line" role="group" aria-labelledby="who-wants" data-testid="disagree-panel">
                <p id="who-wants" className="px-1 text-sm font-semibold">
                  Who wants {currentDish?.name ?? "it"}?
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["a", "b"] as const).map((who) => (
                    <button key={who} type="button" onClick={() => reactSplit(who)} className="h-12 rounded-full bg-surface-2 px-3 text-[15px] font-semibold">
                      Only {pair[who]}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setDisagreeOpen(false)} className="mt-1 w-full py-2 text-sm text-muted">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-[auto_1fr_1fr] items-center gap-2.5">
                <button
                  type="button"
                  onClick={undo}
                  disabled={!canUndo(session)}
                  className="grid h-14 w-14 place-items-center rounded-full bg-surface text-xl ring-1 ring-line disabled:opacity-35"
                  aria-label="Undo last reaction"
                  title="Undo (U)"
                >
                  ↶
                </button>
                <button
                  type="button"
                  onClick={() => react("no")}
                  disabled={!currentDish}
                  className="flex h-16 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-surface px-2 text-[15px] font-semibold text-no ring-2 ring-no/60 active:scale-[0.98]"
                >
                  <span aria-hidden="true">✕</span> {session.mode === "together" ? "Not for us" : "Not tonight"}
                </button>
                <button
                  type="button"
                  onClick={() => react("yes")}
                  disabled={!currentDish}
                  className="flex h-16 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-yes px-2 text-[15px] font-semibold text-white active:scale-[0.98]"
                >
                  <span aria-hidden="true">♥</span> {session.mode === "together" ? "We like it" : "Sounds good"}
                </button>
              </div>
            )}
            {session.mode === "together" && pair && !disagreeOpen && (
              <button type="button" onClick={() => setDisagreeOpen(true)} disabled={!currentDish} className="mt-2 h-11 w-full rounded-full text-[15px] font-medium text-muted ring-1 ring-line">
                We disagree on this one
              </button>
            )}
            <p className="mt-3 hidden text-center text-xs text-muted sm:block">Keyboard: ← Not tonight · → Sounds good · U Undo</p>
          </section>
        )}

        {phase === "results" && session && (
          <Results
            run={latestRun}
            exhausted={exhaustedNotice}
            safetyFor={(id) => candidates.byId.get(id)?.safety ?? { status: "no_restrictions_declared", possibleConflicts: [] }}
            onChoose={choose}
            names={session.mode === "together" ? pair : null}
            onKeepDiscovering={keepDiscovering}
            onUndo={canUndo(session) ? undo : undefined}
            onStartOver={goHome}
          />
        )}

        {phase === "picked" && outcome && (
          <Picked
            dishId={outcome.dishId}
            partnerName={session?.mode === "together" ? (pair?.b ?? null) : null}
            onAte={() => confirmMeal(outcome, outcome.dishId, null)}
            onOther={() => setPhase("other-meal")}
            onNotLogging={() => {
              appendEvalEvent(outcome.sessionId, { type: "meal_not_logged", at: nowIso() });
              goHome();
            }}
            onLater={goHome}
            onBack={runs.length > 0 ? () => setPhase("results") : undefined}
          />
        )}

        {phase === "other-meal" && outcome && (
          <OtherMeal onCancel={() => setPhase(session ? "picked" : "home")} onConfirm={(dishId, name, own) => confirmMeal(outcome, dishId, name, own)} />
        )}

        {phase === "rate" && outcome?.mealId && (
          <Rate
            onRate={(rating) => {
              appendEvalEvent(outcome.sessionId, { type: "satisfaction_recorded", at: nowIso(), mealId: outcome.mealId as string, rating });
              setPhase("thanks");
            }}
            onSkip={() => setPhase("thanks")}
          />
        )}

        {phase === "thanks" && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="font-display text-3xl font-semibold">Noted — thank you.</p>
            <p className="max-w-xs text-muted">Recent meals you confirm can help future suggestions add some variety.</p>
            <button type="button" onClick={goHome} className="mt-2 rounded-full bg-accent px-6 py-3 font-semibold text-accent-ink">
              Back to start
            </button>
          </section>
        )}
      </main>

      <Sheet open={!!jointConfirm} onClose={() => setJointConfirm(null)} title="Your pick together?">
        {jointConfirm && pair && (
          <div data-testid="joint-confirm">
            <p>
              Make <strong>{catalog.byId.get(jointConfirm.dishId)?.name}</strong> tonight&apos;s pick for {pair.a} and {pair.b}?
            </p>
            <p className="mt-1 text-sm text-muted">Confirm together on this screen. Choosing isn&apos;t the same as eating — you can log your meal later.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={confirmJoint} className="rounded-full bg-accent px-5 py-2.5 font-semibold text-accent-ink">
                Yes, it&apos;s our pick
              </button>
              <button type="button" onClick={() => setJointConfirm(null)} className="rounded-full px-4 py-2.5 font-semibold text-muted ring-1 ring-line">
                Not yet
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={!!detailsDish} onClose={() => setDetailsFor(null)} title={detailsDish?.name ?? ""}>
        {detailsDish && (
          <DishDetails dish={detailsDish} safety={candidates.byId.get(detailsDish.id)?.safety ?? { status: "no_restrictions_declared", possibleConflicts: [] }} />
        )}
      </Sheet>

      <RestrictionsSheet
        open={restrictionsOpen}
        value={restrictions}
        onClose={() => setRestrictionsOpen(false)}
        onSave={(keys) => {
          setRestrictions(keys);
          setRestrictionState(keys);
          setRestrictionsOpen(false);
        }}
      />
    </div>
  );
}

/* ================= sub-screens ================= */

function Home(props: {
  restrictions: RestrictionKey[];
  pending: OutcomeContext | null;
  onStart: () => void;
  onStartTogether: () => void;
  onRestrictions: () => void;
  onPendingAte: (ctx: OutcomeContext) => void;
  onPendingOther: (ctx: OutcomeContext) => void;
  onPendingSkip: (ctx: OutcomeContext) => void;
}) {
  const pendingDish = props.pending ? catalog.byId.get(props.pending.dishId) : null;
  return (
    <section className="flex flex-1 flex-col">
      <header className="flex items-center justify-between py-2">
        <span className="text-sm font-semibold tracking-wide text-muted">Food Discovery</span>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Prototype</span>
      </header>

      {props.pending && pendingDish && (
        <div className="mt-3 rounded-3xl bg-surface p-4 ring-1 ring-line" data-testid="pending-outcome">
          <p className="font-medium">Did you end up eating {pendingDish.name}?</p>
          <p className="mt-0.5 text-sm text-muted">Optional — it helps suggestions avoid too much repetition.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => props.onPendingAte(props.pending as OutcomeContext)} className="rounded-full bg-yes px-4 py-2 text-sm font-semibold text-white">
              Yes, I ate it
            </button>
            <button type="button" onClick={() => props.onPendingOther(props.pending as OutcomeContext)} className="rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold">
              Something else
            </button>
            <button type="button" onClick={() => props.onPendingSkip(props.pending as OutcomeContext)} className="rounded-full px-3 py-2 text-sm text-muted">
              Don&apos;t log
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col justify-center py-8">
        <div className="relative mx-auto mb-8 h-44 w-full max-w-[18rem]" aria-hidden="true">
          {["dish-chicken-pho", "dish-margherita-pizza", "dish-chicken-adobo"].map((id, i) => {
            const d = catalog.byId.get(id);
            if (!d) return null;
            return (
              <div
                key={id}
                className="absolute inset-y-0 w-36 overflow-hidden rounded-3xl shadow-xl ring-4 ring-surface"
                style={{ left: `${i * 26}%`, transform: `rotate(${(i - 1) * 8}deg) translateY(${i === 1 ? -6 : 6}px)`, zIndex: i === 1 ? 2 : 1 }}
              >
                <DishArt dish={d} label={false} />
              </div>
            );
          })}
        </div>
        <h1 className="font-display text-[2.6rem] font-semibold leading-[1.05]">What sounds good tonight?</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-muted">
          React to a few dishes. We&apos;ll learn what you&apos;re in the mood for right now and suggest one to three ideas.
        </p>
        <button
          type="button"
          onClick={props.onStart}
          className="mt-8 h-14 rounded-full bg-accent text-lg font-semibold text-accent-ink shadow-lg shadow-accent/25 active:scale-[0.99]"
        >
          Start discovering
        </button>
        <button type="button" onClick={props.onStartTogether} className="mt-3 h-12 rounded-full bg-surface text-[15px] font-semibold ring-1 ring-line">
          Decide together on this phone
        </button>
        <button type="button" onClick={props.onRestrictions} className="mt-3 h-12 rounded-full bg-surface text-[15px] font-medium ring-1 ring-line">
          Dietary restrictions{props.restrictions.length > 0 ? ` · ${props.restrictions.length} avoided` : ""}
        </button>
        <p className="mt-2 text-center text-xs text-muted">Optional. No account needed.</p>
      </div>

      <footer className="flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
        <span>Dish info is general — not verified for any recipe or restaurant.</span>
        <span className="ml-3 flex shrink-0 gap-3">
          <Link href="/data" className="font-semibold underline underline-offset-2">
            Your data
          </Link>
          <Link href="/lab" className="font-semibold underline underline-offset-2">
            Lab
          </Link>
        </span>
      </footer>
    </section>
  );
}

function Results(props: {
  run: RecommendationRun | null;
  exhausted: boolean;
  safetyFor: (dishId: string) => SafetyAssessment;
  onChoose: (dishId: string, rank: number) => void;
  /** Together Mode names; null for solo. */
  names: ParticipantNames | null;
  onKeepDiscovering: (dismissed: boolean) => void;
  onUndo?: () => void;
  onStartOver: () => void;
}) {
  const run = props.run;
  const noMatch = !run || run.noMatch;
  const quick = run?.source === "quick_picks";
  const together = props.names !== null;
  const heading = noMatch ? "No strong match yet" : quick ? "Fresh ideas for today" : together ? `Picks for ${props.names?.a} & ${props.names?.b}` : run.kind === "ready" ? "Here's what sounds good" : "A few early ideas";
  const sub = noMatch
    ? "Nothing stood out from your reactions so far. That's fine — try a few more dishes."
    : quick
      ? "A change from what you've eaten recently. Not feeling these? Swipe a few dishes and we'll learn what you're in the mood for."
      : together
        ? `Based on the ${run.effectiveCards} card${run.effectiveCards === 1 ? "" : "s"} you reacted to together${run.kind === "ready" ? "" : " — more cards will sharpen these"}. Ranked so neither of you gets something you didn't want.`
        : run.kind === "ready"
        ? `Based on your ${run.effectiveCards} reactions this session.`
        : `Based on only ${run.effectiveCards} reaction${run.effectiveCards === 1 ? "" : "s"} — more cards will sharpen these.`;
  return (
    <section className="flex flex-1 flex-col" aria-labelledby="results-title" data-testid="results">
      <h1 id="results-title" className="mt-4 font-display text-[2.1rem] font-semibold leading-tight">
        {heading}
      </h1>
      <p className="mt-2 text-muted">{sub}</p>
      {props.exhausted && <p className="mt-2 text-sm text-muted">You&apos;ve seen every available dish in this prototype catalog.</p>}
      {run && run.excludedByConstraints > 0 && (
        <p className="mt-2 text-sm text-muted">
          {run.excludedByConstraints} dish{run.excludedByConstraints === 1 ? " was" : "es were"} hidden because of {together ? "your dietary restrictions (both of you)" : "your dietary restrictions"}.
        </p>
      )}

      {!noMatch && run && (
        <ol className="mt-5 space-y-4">
          {run.items.map((item) => {
            const d = catalog.byId.get(item.dishId);
            if (!d) return null;
            const reasons = explainItem(item, catalog, run.source, props.names ?? undefined).filter((r) => r.code !== "FULFILLMENT_UNVERIFIED");
            return (
              <li key={item.dishId} className="overflow-hidden rounded-3xl bg-surface ring-1 ring-line" data-testid="recommendation">
                <div className="flex gap-4 p-4">
                  <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl">
                    <DishArt dish={d} compact />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-xl font-semibold leading-tight">{d.name}</h2>
                    <DishLabel dish={d} />
                    <p className="text-sm text-muted">{d.tags.join(", ")}</p>
                    <ul className="mt-2 space-y-1 text-[14px] leading-snug">
                      {reasons.map((r) => (
                        <li key={r.code} className="flex gap-1.5">
                          <span aria-hidden="true" className="text-accent">•</span>
                          {r.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="space-y-3 px-4 pb-4">
                  <SafetyNote safety={props.safetyFor(item.dishId)} />
                  <button
                    type="button"
                    onClick={() => props.onChoose(item.dishId, item.rank)}
                    className="h-12 w-full rounded-full bg-accent font-semibold text-accent-ink"
                  >
                    {together ? `Pick ${d.name} together` : `Choose ${d.name}`}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-6 space-y-2 pb-4">
        {!props.exhausted && (
          <button type="button" onClick={() => props.onKeepDiscovering(!noMatch)} className="h-12 w-full rounded-full bg-surface font-semibold ring-1 ring-line">
            {noMatch ? "Keep discovering" : quick ? "Swipe to refine" : "None of these — keep discovering"}
          </button>
        )}
        {props.onUndo && (
          <button type="button" onClick={props.onUndo} className="h-11 w-full rounded-full text-sm font-medium text-muted">
            ↶ Undo last reaction
          </button>
        )}
        <button type="button" onClick={props.onStartOver} className="h-11 w-full rounded-full text-sm font-medium text-muted">
          Start over
        </button>
      </div>
    </section>
  );
}

function Picked(props: {
  dishId: string;
  /** Together Mode: the partner's meal is never logged to this phone's history (R-017). */
  partnerName?: string | null;
  onAte: () => void;
  onOther: () => void;
  onNotLogging: () => void;
  onLater: () => void;
  onBack?: () => void;
}) {
  const d = catalog.byId.get(props.dishId);
  if (!d) return null;
  return (
    <section className="flex flex-1 flex-col" data-testid="picked">
      <div className="mt-4 h-56 overflow-hidden rounded-[28px]">
        <DishArt dish={d} />
      </div>
      <p className="mt-5 text-sm font-semibold uppercase tracking-wide text-muted">{props.partnerName ? "Your pick together" : "Tonight\u2019s pick"}</p>
      <h1 className="font-display text-[2.2rem] font-semibold leading-tight">{d.name}</h1>
      <p className="mt-2 text-muted">
        Enjoy! Picking a dish doesn&apos;t record it as eaten. If you like, tell us what you actually had — now or next time you open the app.
      </p>
      {props.partnerName && (
        <p className="mt-2 text-sm text-muted" data-testid="partner-note">
          Only your own meal is logged on this phone — {props.partnerName}&apos;s isn&apos;t saved.
        </p>
      )}
      <div className="mt-6 space-y-2">
        <button type="button" onClick={props.onAte} className="h-12 w-full rounded-full bg-yes font-semibold text-white">
          I ate this
        </button>
        <button type="button" onClick={props.onOther} className="h-12 w-full rounded-full bg-surface font-semibold ring-1 ring-line">
          I ate something else
        </button>
        <button type="button" onClick={props.onLater} className="h-12 w-full rounded-full bg-surface-2 font-semibold">
          Haven&apos;t eaten yet — ask me later
        </button>
        <div className="flex justify-center gap-2 pt-1">
          {props.onBack && (
            <button type="button" onClick={props.onBack} className="rounded-full px-3 py-2 text-sm text-muted">
              Back to picks
            </button>
          )}
          <button type="button" onClick={props.onNotLogging} className="rounded-full px-3 py-2 text-sm text-muted">
            Don&apos;t log this meal
          </button>
        </div>
      </div>
    </section>
  );
}

function OtherMeal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (dishId: string | null, name: string | null, ownDish: OwnDish | null) => void }) {
  const [q, setQ] = useState("");
  const [describing, setDescribing] = useState<string | null>(null);
  const matches = searchDishes(catalog, q, 8);
  const mine = useMemo(() => ownDishMatches(listMeals(), q), [q]);
  if (describing) {
    return (
      <section className="flex flex-1 flex-col pt-4">
        <h1 className="font-display text-3xl font-semibold">Describe {describing}</h1>
        <div className="mt-3">
          <DescribeDish
            name={describing}
            saveLabel="Log it"
            onSave={(d) => onConfirm(null, describing, d)}
            onSkip={() => onConfirm(null, describing, null)}
            skipLabel="Skip — just log the name"
          />
        </div>
        <button type="button" onClick={() => setDescribing(null)} className="mt-auto h-11 rounded-full text-sm text-muted">
          Back
        </button>
      </section>
    );
  }
  return (
    <section className="flex flex-1 flex-col pt-4">
      <h1 className="font-display text-3xl font-semibold">What did you eat?</h1>
      <label htmlFor="meal-search" className="mt-4 text-sm font-medium">
        Search dishes
      </label>
      <input
        id="meal-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="e.g. Sinigang"
        autoComplete="off"
        className="mt-1 h-12 rounded-2xl bg-surface px-4 text-[16px] ring-1 ring-line"
      />
      <ul className="mt-3 space-y-1.5">
        {matches.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onConfirm(d.id, null, null)} className="flex w-full items-center gap-3 rounded-2xl bg-surface p-2 text-left ring-1 ring-line">
              <span className="h-11 w-11 overflow-hidden rounded-xl">
                <DishArt dish={d} compact />
              </span>
              <span className="font-medium">{d.name}</span>
            </button>
          </li>
        ))}
        {mine.map((m) => (
          <li key={`own-${m.name}`}>
            <button type="button" onClick={() => onConfirm(null, m.name, m.ownDish)} className="w-full rounded-2xl bg-surface p-3 text-left ring-1 ring-line">
              <span className="font-medium">{m.name}</span>
              <span className="block text-xs text-muted">Your dish · {ownDishSummary(m.ownDish)}</span>
            </button>
          </li>
        ))}
      </ul>
      {q.trim().length >= 2 && !mine.some((m) => m.name.toLowerCase() === q.trim().toLowerCase()) && (
        <button type="button" onClick={() => setDescribing(q.trim())} className="mt-3 h-12 rounded-full bg-surface-2 px-4 text-sm font-semibold">
          Log &ldquo;{q.trim()}&rdquo; — not in the list
        </button>
      )}
      <button type="button" onClick={onCancel} className="mt-auto h-11 rounded-full text-sm text-muted">
        Cancel
      </button>
    </section>
  );
}

function Rate({ onRate, onSkip }: { onRate: (n: number) => void; onSkip: () => void }) {
  const labels = ["Didn't enjoy it", "Not great", "It was OK", "Enjoyed it", "Loved it"];
  return (
    <section className="flex flex-1 flex-col justify-center" aria-labelledby="rate-title">
      <h1 id="rate-title" className="font-display text-3xl font-semibold">
        How was it?
      </h1>
      <p className="mt-2 text-muted">Optional. Skipping is completely fine.</p>
      <div className="mt-6 grid gap-2" role="group" aria-label="Satisfaction rating">
        {labels.map((l, i) => (
          <button key={l} type="button" onClick={() => onRate(i + 1)} className="flex h-12 items-center justify-between rounded-2xl bg-surface px-4 font-medium ring-1 ring-line">
            <span>{l}</span>
            <span className="text-muted" aria-hidden="true">
              {i + 1}/5
            </span>
          </button>
        ))}
      </div>
      <button type="button" onClick={onSkip} className="mt-4 h-11 rounded-full text-sm text-muted">
        Skip
      </button>
    </section>
  );
}

function RestrictionsSheet(props: { open: boolean; value: RestrictionKey[]; onClose: () => void; onSave: (v: RestrictionKey[]) => void }) {
  const [draft, setDraft] = useState<RestrictionKey[]>(props.value);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (props.open) setDraft(props.value);
  }, [props.open, props.value]);
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Dietary restrictions">
      <p className="text-[15px] text-muted">
        Dishes known to contain what you avoid are hidden. Many dishes have incomplete ingredient information, so we can never confirm a dish is
        free of something — always check with whoever prepares your food.
      </p>
      <fieldset className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="sr-only">Ingredients to avoid</legend>
        {RESTRICTION_KEYS.map((k) => (
          <label key={k} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl bg-surface-2 px-4">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={draft.includes(k)}
              onChange={(e) => setDraft(e.target.checked ? [...draft, k] : draft.filter((x) => x !== k))}
            />
            <span className="text-[15px]">{RESTRICTION_LABELS[k]}</span>
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-xs text-muted">Remembered on this phone only — never included in GitHub backups, backup files or evaluation exports. Applies to new discovery sessions.</p>
      <button type="button" onClick={() => props.onSave(draft)} className="mt-4 h-12 w-full rounded-full bg-accent font-semibold text-accent-ink">
        Save
      </button>
    </Sheet>
  );
}

/** Together Mode setup (PRRD J-03). Names stay in memory; the partner's restrictions apply to this session only. */
function TogetherSetup(props: { ownRestrictions: RestrictionKey[]; onStart: (names: ParticipantNames, partnerRestrictions: RestrictionKey[]) => void; onBack: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [partner, setPartner] = useState<RestrictionKey[]>([]);
  const toggle = (k: RestrictionKey) => setPartner((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));
  return (
    <section className="flex flex-1 flex-col pt-3" aria-labelledby="together-title" data-testid="together-setup">
      <button type="button" onClick={props.onBack} className="self-start rounded-full py-2 text-sm font-medium text-muted">
        ← Back
      </button>
      <h1 id="together-title" className="mt-2 font-display text-[2rem] font-semibold leading-tight">
        Decide together
      </h1>
      <p className="mt-2 text-muted">Swipe as a pair on this phone. When you disagree on a dish, say who wants it — picks are ranked so neither of you gets something you didn&apos;t want.</p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <label className="text-sm font-semibold">
          Your name
          <input value={a} onChange={(e) => setA(e.target.value)} placeholder="You" maxLength={20} autoComplete="off" className="mt-1 h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px] font-normal" />
        </label>
        <label className="text-sm font-semibold">
          Partner&apos;s name
          <input value={b} onChange={(e) => setB(e.target.value)} placeholder="Partner" maxLength={20} autoComplete="off" className="mt-1 h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px] font-normal" />
        </label>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold">Anything your partner avoids?</legend>
        <p className="text-xs text-muted">
          Used for this session only, then forgotten.
          {props.ownRestrictions.length > 0 ? " Your saved restrictions apply too." : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {RESTRICTION_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={partner.includes(k)}
              onClick={() => toggle(k)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${partner.includes(k) ? "bg-ink text-surface ring-ink" : "bg-surface ring-line"}`}
            >
              {RESTRICTION_LABELS[k].split(" (")[0]}
            </button>
          ))}
        </div>
      </fieldset>

      <p className="mt-5 text-xs text-muted">Together mode doesn&apos;t use either person&apos;s saved meal history — next you can say what you&apos;ve eaten recently, for tonight only. Names aren&apos;t saved.</p>

      <div className="mt-auto pb-2 pt-6">
        <button
          type="button"
          onClick={() => props.onStart({ a: a.trim() || "You", b: b.trim() || "Partner" }, partner)}
          className="h-14 w-full rounded-full bg-accent text-lg font-semibold text-accent-ink"
        >
          Next
        </button>
      </div>
    </section>
  );
}
