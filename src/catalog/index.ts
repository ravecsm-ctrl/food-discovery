import raw from "./dishes.json" with { type: "json" };
import { validateCatalog } from "./schema.ts";
import type { Catalog } from "../engine/types.ts";

let cached: Catalog | null = null;

/** Load and validate the bundled prototype catalog. Throws if the data is invalid. */
export function loadCatalog(): Catalog {
  if (cached) return cached;
  const result = validateCatalog(raw);
  if (!result.ok) {
    throw new Error(`Catalog failed validation:\n${result.errors.join("\n")}`);
  }
  cached = result.catalog;
  return cached;
}

export { validateCatalog } from "./schema.ts";
