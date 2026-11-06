/**
 * Catalog data format and validators (ENG-004, R-026, R-027).
 * Invalid records are rejected with path-specific, human-readable errors.
 */
import { z } from "zod";
import { ATTRIBUTE_KINDS, DISH_STYLES, RESTRICTION_KEYS } from "../engine/types.ts";
import type { Catalog, Dish } from "../engine/types.ts";

const SLUG = /^[a-z][a-z0-9_]*$/;
const MULTI_VALUED_KINDS = ATTRIBUTE_KINDS.filter((k) => k !== "richness" && k !== "cuisine");

/** Minimum sensory attributes required for a dish to be recommendable (ETD §4.3 integrity rules). */
export const REQUIRED_KINDS = ["ingredient", "method", "flavor", "texture", "structure"] as const;

const attributeKey = z.string().refine(
  (key) => {
    const [kind, slug, ...rest] = key.split(":");
    return rest.length === 0 && (MULTI_VALUED_KINDS as readonly string[]).includes(kind ?? "") && SLUG.test(slug ?? "");
  },
  { message: `attribute key must be "<kind>:<slug>" with kind in ${MULTI_VALUED_KINDS.join(", ")}` },
);

const unit = z.number().min(0).max(1);

export const DishSchema = z
  .object({
    id: z.string().regex(/^dish-[a-z0-9-]+$/, "id must look like dish-<kebab-case>"),
    familyId: z.string().regex(/^[a-z0-9-]+$/).nullable(),
    name: z.string().min(2).max(60),
    cuisine: z.string().regex(SLUG),
    style: z.enum(DISH_STYLES),
    description: z.string().min(20).max(140),
    tags: z.array(z.string().min(2).max(20)).min(1).max(4),
    richness: unit,
    recognizability: unit,
    illustration: z.string().min(1).max(8),
    attributes: z.record(attributeKey, unit.refine((v) => v > 0, "attribute strength must be > 0 (omit unknown attributes instead of using 0)")),
    ingredients: z.array(
      z.object({
        key: z.enum(RESTRICTION_KEYS),
        presence: z.enum(["confirmed_present", "possible", "unknown"]),
      }),
    ),
  })
  .strict()
  .superRefine((dish, ctx) => {
    for (const kind of REQUIRED_KINDS) {
      if (!Object.keys(dish.attributes).some((k) => k.startsWith(`${kind}:`))) {
        ctx.addIssue({ code: "custom", path: ["attributes"], message: `missing required ${kind} attribute` });
      }
    }
    const keys = dish.ingredients.map((i) => i.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["ingredients"], message: `duplicate ingredient claim: ${dup}` });
  });

export const CatalogFileSchema = z
  .object({
    catalogVersion: z.string().min(1),
    status: z.enum(["draft", "published", "retired"]),
    provenance: z
      .object({
        attributeEvidence: z.enum(["curated", "verified_source", "inferred", "unknown"]),
        reviewStatus: z.string(),
        note: z.string(),
        styleNote: z.string(),
        media: z.string(),
      })
      .strict(),
    dishes: z.array(DishSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    file.dishes.forEach((d, i) => {
      if (seenIds.has(d.id)) ctx.addIssue({ code: "custom", path: ["dishes", i, "id"], message: `duplicate dish id ${d.id}` });
      const n = d.name.toLowerCase();
      if (seenNames.has(n)) ctx.addIssue({ code: "custom", path: ["dishes", i, "name"], message: `duplicate dish name ${d.name}` });
      seenIds.add(d.id);
      seenNames.add(n);
    });
  });

export type CatalogValidationResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; errors: string[] };

/** Validate unknown input and build an immutable, indexed Catalog. */
export function validateCatalog(input: unknown): CatalogValidationResult {
  const parsed = CatalogFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`),
    };
  }
  const dishes: Dish[] = parsed.data.dishes.map((d) => deepFreeze({ ...d }));
  const catalog: Catalog = {
    catalogVersion: parsed.data.catalogVersion,
    status: parsed.data.status,
    attributeEvidence: parsed.data.provenance.attributeEvidence,
    dishes: Object.freeze(dishes),
    byId: new Map(dishes.map((d) => [d.id, d])),
  };
  return { ok: true, catalog };
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
