import { STYLE_LABELS, attributeWord, cuisineName, type Dish, type RestrictionKey, type SafetyAssessment } from "@/engine";

export const RESTRICTION_LABELS: Record<RestrictionKey, string> = {
  shellfish: "Shellfish (shrimp, crab, etc.)",
  fish: "Fish",
  pork: "Pork",
  beef: "Beef",
  chicken: "Chicken",
  egg: "Egg",
  dairy: "Dairy / milk",
  gluten: "Gluten / wheat",
  peanut: "Peanut",
  tree_nut: "Tree nuts",
  soy: "Soy",
  sesame: "Sesame",
};

const shortLabel = (k: RestrictionKey) => (RESTRICTION_LABELS[k].split(" (")[0] ?? k).split(" /")[0]?.toLowerCase() ?? k;

export const cuisineLabel = cuisineName;

/** "Filipino · Comfort food" — identity line shown on cards and results. */
export function DishLabel({ dish, className = "" }: { dish: Dish; className?: string }) {
  return (
    <p className={`text-[12px] font-semibold uppercase tracking-wide text-accent ${className}`} data-testid="dish-label">
      {cuisineName(dish.cuisine)} · {STYLE_LABELS[dish.style]}
    </p>
  );
}

/** Safety note shown only when the person has declared avoidances. Never claims safety. */
export function SafetyNote({ safety }: { safety: SafetyAssessment }) {
  if (safety.status === "no_restrictions_declared") return null;
  const text =
    safety.status === "possible_conflict"
      ? `May contain ${safety.possibleConflicts.map(shortLabel).join(", ")} — check before ordering.`
      : "Not verified free of your avoided ingredients — check before ordering.";
  return (
    <p className="flex items-start gap-1.5 rounded-xl bg-warn-bg px-3 py-2 text-[13px] leading-snug text-warn-ink" data-testid="safety-note">
      <span aria-hidden="true">⚠︎</span>
      <span>{text}</span>
    </p>
  );
}

function attrsOf(dish: Dish, kind: string): string[] {
  return Object.entries(dish.attributes)
    .filter(([k]) => k.startsWith(`${kind}:`))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => attributeWord(k));
}

export function DishDetails({ dish, safety }: { dish: Dish; safety: SafetyAssessment }) {
  const rows: Array<[string, string]> = [
    ["Cuisine", cuisineLabel(dish.cuisine)],
    ["Style", `${STYLE_LABELS[dish.style]} (editorial label)`],
    ["Main components", attrsOf(dish, "ingredient").join(", ")],
    ["Cooking method", attrsOf(dish, "method").join(", ")],
    ["Flavor", attrsOf(dish, "flavor").join(", ")],
    ["Texture", attrsOf(dish, "texture").join(", ")],
    ["Richness", dish.richness >= 0.75 ? "Rich" : dish.richness >= 0.45 ? "Medium" : "Light"],
  ];
  const confirmed = dish.ingredients.filter((i) => i.presence === "confirmed_present").map((i) => shortLabel(i.key));
  const possible = dish.ingredients.filter((i) => i.presence === "possible").map((i) => shortLabel(i.key));
  return (
    <div className="space-y-4 text-[15px]">
      <p className="text-muted">{dish.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="rounded-2xl bg-surface-2 p-4 text-[14px] leading-relaxed">
        <h3 className="mb-1 font-semibold">Ingredient notes</h3>
        {confirmed.length > 0 && <p>Contains (by definition): {confirmed.join(", ")}.</p>}
        {possible.length > 0 && <p>Often made with: {possible.join(", ")}.</p>}
        <p className="mt-2 text-muted">
          This describes a typical version of the dish, not any specific recipe or restaurant. We never confirm a dish is free of an
          ingredient — always check with whoever prepares your food.
        </p>
      </div>
      <SafetyNote safety={safety} />
      <p className="text-[12px] text-muted">Image: illustration placeholder (no licensed photo yet).</p>
    </div>
  );
}
