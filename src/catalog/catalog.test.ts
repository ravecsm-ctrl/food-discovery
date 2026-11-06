import { describe, expect, it } from "vitest";
import raw from "./dishes.json" with { type: "json" };
import { loadCatalog, validateCatalog } from "./index.ts";

const FIXTURE_DISHES = [
  "Chicken Adobo",
  "Pork Tonkatsu",
  "Chicken Pho",
  "Chicken Tinola",
  "Margherita Pizza",
  "Shrimp Sinigang",
  "Tofu Sisig",
  "Spaghetti Carbonara",
  "Grilled Salmon",
  "Vegetable Curry",
];

/** Loosely-typed mutable copy of the raw catalog file, for negative validation tests. */
type RawDish = { id: string; attributes: Record<string, number>; ingredients: unknown[]; [k: string]: unknown };
type RawFile = { dishes: [RawDish, RawDish, ...RawDish[]] };

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe("catalog (ENG-004, ENG-006, R-026)", () => {
  it("bundled catalog passes validation (40–250 variants)", () => {
    const c = loadCatalog();
    expect(c.dishes.length).toBeGreaterThanOrEqual(40);
    expect(c.dishes.length).toBeLessThanOrEqual(250);
  });

  it("covers every required cuisine group", () => {
    const cuisines = new Set(loadCatalog().dishes.map((d) => d.cuisine));
    for (const c of ["filipino", "japanese", "italian", "korean", "chinese"]) expect(cuisines).toContain(c);
    const sea = ["thai", "vietnamese", "malaysian", "indonesian", "singaporean"].filter((c) => cuisines.has(c));
    expect(sea.length).toBeGreaterThanOrEqual(3);
  });

  it("contains all ETD §10.1 named fixture dishes", () => {
    const names = new Set(loadCatalog().dishes.map((d) => d.name));
    for (const n of FIXTURE_DISHES) expect(names).toContain(n);
  });

  it("never claims ingredient absence (no 'absent' state exists)", () => {
    for (const d of loadCatalog().dishes) for (const i of d.ingredients) expect(["confirmed_present", "possible", "unknown"]).toContain(i.presence);
  });

  it("is frozen so ranking cannot mutate it", () => {
    const d = loadCatalog().dishes[0]!;
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.attributes)).toBe(true);
  });

  it.each([
    ["out-of-range strength", (f: RawFile) => (f.dishes[0].attributes["flavor:sour"] = 1.5), "dishes.0.attributes"],
    ["unknown attribute kind", (f: RawFile) => (f.dishes[0].attributes["mood:happy"] = 0.5), "dishes.0.attributes"],
    ["missing method attribute", (f: RawFile) => delete f.dishes[0].attributes["method:braised"], "missing required method"],
    ["duplicate id", (f: RawFile) => (f.dishes[1].id = f.dishes[0].id), "duplicate dish id"],
    ["unknown restriction key", (f: RawFile) => f.dishes[0].ingredients.push({ key: "msg", presence: "possible" }), "dishes.0.ingredients"],
    ["invented 'absent' presence", (f: RawFile) => f.dishes[0].ingredients.push({ key: "peanut", presence: "absent" }), "presence"],
    ["zero strength stands in for unknown", (f: RawFile) => (f.dishes[0].attributes["flavor:sweet"] = 0), "omit unknown attributes"],
    ["unexpected field", (f: RawFile) => (f.dishes[0].priceVerified = true), "dishes.0"],
  ])("rejects %s with a clear error", (_label, mutate, expected) => {
    const f = clone(raw) as unknown as RawFile;
    mutate(f);
    const r = validateCatalog(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(expected);
  });
});
