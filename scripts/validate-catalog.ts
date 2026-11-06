/** ENG-004: validate the catalog from the command line. Exit code 1 on any error. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../src/catalog/schema.ts";

const path = process.argv[2] ?? fileURLToPath(new URL("../src/catalog/dishes.json", import.meta.url));
const result = validateCatalog(JSON.parse(readFileSync(path, "utf8")));
if (!result.ok) {
  console.error(`✗ ${path} is invalid:`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
const { catalog } = result;
const byCuisine = new Map<string, number>();
for (const d of catalog.dishes) byCuisine.set(d.cuisine, (byCuisine.get(d.cuisine) ?? 0) + 1);
console.log(`✓ ${catalog.catalogVersion} (${catalog.status}): ${catalog.dishes.length} dish variants`);
console.log(`  ${[...byCuisine].map(([c, n]) => `${c}=${n}`).join(", ")}`);
