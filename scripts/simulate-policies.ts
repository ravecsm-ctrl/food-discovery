/**
 * ENG-019 technical evaluation: run SYNTHETIC personas through each policy and compare outcomes.
 *
 * These personas are invented test fixtures, not real users. Results show whether the engine behaves
 * as designed; they say nothing about whether real people prefer adaptive recommendations (H-02).
 *
 * Usage: npm run eval:simulate [-- --write]   (--write updates docs/m1-technical-evaluation.md)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/catalog/index.ts";
import {
  DEFAULT_CONSTRAINTS,
  addExposure,
  createRng,
  createSession,
  getPolicy,
  hashString,
  recommend,
  recordReaction,
  selectNextCard,
  weightAlignment,
  type ConfirmedMeal,
  type Dish,
  type EngineDeps,
} from "../src/engine/index.ts";

const catalog = loadCatalog();
const NOW = "2026-11-06T12:00:00.000Z";
const SEEDS = 40;
const CARDS = 10;
const NOISE = 0.1; // probability a persona answers inconsistently

interface Persona {
  name: string;
  taste: Record<string, number>;
  recentMeals?: string[];
}

const PERSONAS: Persona[] = [
  { name: "Soup lover", taste: { "texture:brothy": 1, "method:simmered": 0.5, "flavor:aromatic": 0.3 } },
  { name: "Crispy & fried", taste: { "texture:crispy": 1, "method:fried": 0.7 } },
  { name: "Spice seeker", taste: { "flavor:spicy": 1, "flavor:aromatic": 0.3 } },
  { name: "Italian comfort", taste: { "cuisine:italian": 1, "ingredient:cheese": 0.6, "texture:creamy": 0.4 } },
  { name: "Noodle fan", taste: { "structure:noodles": 1, "structure:noodle_soup": 1, "ingredient:rice_noodles": 0.3 } },
  { name: "Sweet-savory grill", taste: { "method:grilled": 1, "flavor:sweet": 0.6, "flavor:smoky": 0.5 } },
  {
    name: "Fried lover, ate fried all week",
    taste: { "texture:crispy": 1, "method:fried": 0.7, "texture:brothy": 0.5 },
    recentMeals: ["dish-lechon-kawali", "dish-korean-fried-chicken", "dish-pork-tonkatsu", "dish-chicken-karaage"],
  },
];

const truth = (p: Persona, d: Dish) => weightAlignment(p.taste, d);

function topK(p: Persona, k: number): Set<string> {
  return new Set([...catalog.dishes].sort((a, b) => truth(p, b) - truth(p, a)).slice(0, k).map((d) => d.id));
}

interface Metrics {
  yesAfterColdStart: number;
  cardsAfterColdStart: number;
  shortlistTruth: number[];
  top5Hit: number;
  noMatch: number;
  sessions: number;
  distinctStructures: number[];
  friedInShortlist: number;
  shortlistItems: number;
}

function simulate(policyId: string, p: Persona): Metrics {
  const policy = getPolicy(policyId);
  const meals: ConfirmedMeal[] = (p.recentMeals ?? []).map((id, i) => ({
    id: `m${i}`,
    dishId: id,
    consumedAt: new Date(Date.parse(NOW) - (6 + i * 18) * 3_600_000).toISOString(),
    confirmed: true,
    source: "synthetic",
  }));
  const deps: EngineDeps = { catalog, policy, user: { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 }, now: NOW };
  const scores = catalog.dishes.map((d) => truth(p, d)).sort((a, b) => a - b);
  const threshold = scores[Math.floor(scores.length * 0.72)] as number;
  const best = topK(p, 5);
  const m: Metrics = { yesAfterColdStart: 0, cardsAfterColdStart: 0, shortlistTruth: [], top5Hit: 0, noMatch: 0, sessions: 0, distinctStructures: [], friedInShortlist: 0, shortlistItems: 0 };

  for (let seed = 0; seed < SEEDS; seed++) {
    const noise = createRng(hashString(`${p.name}:${seed}`));
    let s = createSession({ sessionId: `sim-${seed}`, seed, policyId, catalogVersion: catalog.catalogVersion, constraints: DEFAULT_CONSTRAINTS, now: NOW, initialBudget: CARDS });
    const shownStructures = new Set<string>();
    for (let i = 0; i < CARDS; i++) {
      const choice = selectNextCard(s, deps);
      if (!choice) break;
      const d = catalog.byId.get(choice.dishId) as Dish;
      shownStructures.add(Object.keys(d.attributes).find((k) => k.startsWith("structure:")) ?? "");
      let likes = truth(p, d) >= threshold && truth(p, d) > 0;
      if (noise() < NOISE) likes = !likes;
      if (i >= policy.nextCard.coldStartCards) {
        m.cardsAfterColdStart++;
        if (likes) m.yesAfterColdStart++;
      }
      s = recordReaction(addExposure(s, d.id, NOW), likes ? "yes" : "no", NOW);
    }
    const run = recommend(s, deps);
    m.sessions++;
    m.distinctStructures.push(shownStructures.size);
    if (run.noMatch) m.noMatch++;
    for (const item of run.items) {
      const d = catalog.byId.get(item.dishId) as Dish;
      m.shortlistTruth.push(truth(p, d));
      m.shortlistItems++;
      if ((d.attributes["method:fried"] ?? 0) >= 0.6) m.friedInShortlist++;
    }
    if (run.items.some((i) => best.has(i.dishId))) m.top5Hit++;
  }
  return m;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
const POLICY_IDS = ["baseline-fixed-v0", "adaptive-v1", "adaptive-exposure-v1", "baseline-fixed-v2", "adaptive-v2"];

const lines: string[] = [];
const out = (s = "") => {
  lines.push(s);
  console.log(s);
};

out("# M1 technical evaluation — synthetic policy simulation (ENG-019)");
out();
out(`Generated by \`npm run eval:simulate -- --write\` · catalog \`${catalog.catalogVersion}\` · ${SEEDS} seeds × ${CARDS} cards per persona and policy · ${Math.round(NOISE * 100)}% inconsistent answers.`);
out();
out("> **Synthetic personas only.** This checks that the engine behaves as designed. It is *not* evidence that real people");
out("> prefer adaptive discovery (hypothesis H-02 remains unvalidated until real-use evaluation).");
out();
out("Metrics: **Yes rate after cold start** = share of cards 4–10 the persona liked (relevance of adaptive card choice). ");
out("**Top-5 hit** = sessions whose shortlist contains one of the persona's 5 best-matching dishes. ");
out("**Mean shortlist match** = persona's hidden taste score of shortlisted dishes (−1..1). ");
out("**Variety** = distinct dish structures among the 10 cards.");
out();
out("| Persona | Policy | Yes rate after cold start | Top-5 hit | Mean shortlist match | No-match | Variety (structures/10) |");
out("|---|---|---|---|---|---|---|");
const fried: Record<string, string> = {};
for (const p of PERSONAS) {
  for (const id of POLICY_IDS) {
    const m = simulate(id, p);
    out(
      `| ${p.name} | \`${id}\` | ${pct(m.yesAfterColdStart, m.cardsAfterColdStart)} | ${pct(m.top5Hit, m.sessions)} | ${mean(m.shortlistTruth).toFixed(2)} | ${pct(m.noMatch, m.sessions)} | ${mean(m.distinctStructures).toFixed(1)} |`,
    );
    if (p.recentMeals) fried[id] = pct(m.friedInShortlist, m.shortlistItems);
  }
}
out();
out(`Exposure check — persona "${PERSONAS.at(-1)?.name}": share of shortlist items that are fried dishes: ${POLICY_IDS.map((id) => `\`${id}\` ${fried[id]}`).join(" · ")}.`);
out("The exposure penalty is capped at 0.12 utility per dish, but because U spans only about ±0.45 without stable preferences, that cap can reorder the shortlist substantially (see open issue I-03).");

if (process.argv.includes("--write")) {
  const path = fileURLToPath(new URL("../docs/m1-technical-evaluation.md", import.meta.url));
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`\nWrote ${path}`);
}
