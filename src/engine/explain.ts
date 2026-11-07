/**
 * Convert structured reason codes + evidence into plain-language explanations (ENG-015, R-013, PRRD §10.9).
 * Every sentence must be backed by a code AND the evidence that produced it; nothing is invented.
 */
import type { RecommendationItem } from "./recommend.ts";
import type { Catalog, DishStyle } from "./types.ts";

export const STYLE_LABELS: Record<DishStyle, string> = {
  comfort: "Comfort food",
  light_fresh: "Light & fresh",
  hearty: "Hearty",
  street_food: "Street food",
  rich_indulgent: "Rich & indulgent",
  sharing: "Sharing / party",
};

const STYLE_PHRASES: Record<string, string> = {
  comfort: "comfort food",
  light_fresh: "light, fresh food",
  hearty: "hearty meals",
  street_food: "street food",
  rich_indulgent: "rich food",
  sharing: "sharing dishes",
};

/** "middle_eastern" → "Middle Eastern". */
export function cuisineName(c: string): string {
  return c
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "method:fried" → "fried food", "style:comfort" → "comfort food", "cuisine:filipino" → "Filipino food". */
export function recentPhrase(attr: string): string {
  const [kind, slug = ""] = attr.split(":");
  if (kind === "style") return STYLE_PHRASES[slug] ?? slug.replaceAll("_", " ");
  if (kind === "cuisine") return `${cuisineName(slug)} food`;
  return `${attributeWord(attr)} food`;
}

/** Adjective qualities share one "food" ("fried, crispy food"); styles/cuisines stay noun phrases. */
export function varietyPhrase(attrs: string[]): string {
  const adjectives = attrs.filter((a) => !a.startsWith("style:") && !a.startsWith("cuisine:")).map(attributeWord);
  const nouns = attrs.filter((a) => a.startsWith("style:") || a.startsWith("cuisine:")).map(recentPhrase);
  const parts = [...(adjectives.length ? [`${adjectives.join(", ")} food`] : []), ...nouns];
  return joinAnd(parts);
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

const ATTRIBUTE_WORDS: Record<string, string> = {
  "texture:brothy": "brothy",
  "texture:crispy": "crispy",
  "texture:creamy": "creamy",
  "texture:saucy": "saucy",
  "texture:tender": "tender",
  "texture:chewy": "chewy",
  "texture:soft": "soft",
  "texture:crunchy": "crunchy",
  "flavor:sour": "sour",
  "flavor:spicy": "spicy",
  "flavor:sweet": "sweet",
  "flavor:savory": "savory",
  "flavor:umami": "umami-rich",
  "flavor:garlicky": "garlicky",
  "flavor:aromatic": "aromatic",
  "flavor:gingery": "gingery",
  "flavor:smoky": "smoky",
  "flavor:herbal": "herby",
  "flavor:nutty": "nutty",
  "flavor:spiced": "warmly spiced",
  "flavor:fresh": "fresh",
  "flavor:peppery": "peppery",
  "flavor:earthy": "earthy",
  "method:fried": "fried",
  "method:grilled": "grilled",
  "method:braised": "braised",
  "method:simmered": "simmered",
  "method:stir_fried": "stir-fried",
  "method:baked": "baked",
  "method:steamed": "steamed",
};

export function attributeWord(attr: string): string {
  return ATTRIBUTE_WORDS[attr] ?? (attr.split(":")[1] ?? attr).replaceAll("_", " ");
}

export interface Explanation {
  code: string;
  text: string;
}

/** Display names for Together Mode participants ("a" = phone owner, "b" = partner). */
export interface ParticipantNames {
  a: string;
  b: string;
}

export function explainItem(
  item: RecommendationItem,
  catalog: Catalog,
  source: "reactions" | "quick_picks" = "reactions",
  names?: ParticipantNames,
): Explanation[] {
  const out: Explanation[] = [];
  for (const code of item.reasonCodes) {
    switch (code) {
      case "SHARED_SESSION_POSITIVE": {
        const liked = item.evidence.likedSimilar[0];
        if (!liked) break;
        const name = catalog.byId.get(liked.dishId)?.name ?? "a dish";
        if (liked.dishId === item.dishId) out.push({ code, text: "You both said yes to this." });
        else if (liked.sharedAttributes.length > 0)
          out.push({ code, text: `Like ${name}, which you both said yes to, it's ${liked.sharedAttributes.map(attributeWord).join(" and ")}.` });
        else out.push({ code, text: `Similar to ${name}, which you both said yes to.` });
        break;
      }
      case "CURRENT_SESSION_POSITIVE": {
        const liked = item.evidence.likedSimilar[0];
        if (!liked) break;
        const name = catalog.byId.get(liked.dishId)?.name ?? "a dish";
        const who = liked.by && names ? names[liked.by] : null;
        if (who) {
          if (liked.dishId === item.dishId) out.push({ code, text: `${who} wanted this one.` });
          else if (liked.sharedAttributes.length > 0)
            out.push({ code, text: `Like ${name}, which ${who} wanted, it's ${liked.sharedAttributes.map(attributeWord).join(" and ")}.` });
          else out.push({ code, text: `Similar to ${name}, which ${who} wanted.` });
          break;
        }
        if (liked.dishId === item.dishId) {
          out.push({ code, text: `You said "sounds good" to this just now.` });
        } else if (liked.sharedAttributes.length > 0) {
          out.push({ code, text: `Like ${name}, which you liked just now, it's ${liked.sharedAttributes.map(attributeWord).join(" and ")}.` });
        } else {
          out.push({ code, text: `Similar to ${name}, which you liked just now.` });
        }
        break;
      }
      case "STABLE_PREFERENCE_MATCH": {
        // Grounded in rated meals only (taste-v0): name the qualities, never invent a habit.
        const from = item.evidence.stableFrom ?? [];
        const words = from.map((a) => (a.startsWith("cuisine:") ? cuisineName(a.slice(8)) : attributeWord(a)));
        out.push({ code, text: words.length > 0 ? `You've rated ${joinAnd(words)} dishes highly.` : "Similar to meals you've rated highly." });
        break;
      }
      case "RECENT_FOOD_VARIETY":
        if (item.evidence.varietyFrom.length > 0) {
          out.push({ code, text: `A change from the ${varietyPhrase(item.evidence.varietyFrom)} you've had recently.` });
        } else {
          out.push({ code, text: "A change from the meals you've confirmed this week." });
        }
        break;
      case "MEAL_TIME_FIT": {
        const mt = item.evidence.mealTime;
        if (!mt) break;
        const phrase = { breakfast: "breakfast", lunch: "lunch", merienda: "an afternoon merienda", dinner: "dinner", late_night: "a late-night bite" }[mt];
        out.push({ code, text: `A good fit for ${phrase}.` });
        break;
      }
      case "NOVELTY_EXPLORATION":
        out.push({ code, text: "Something different from what you've logged before." });
        break;
      case "INSUFFICIENT_EVIDENCE":
        out.push({
          code,
          text: source === "quick_picks" ? "Based only on your recent meals — swipe to refine." : "Early pick — based on only a few reactions so far.",
        });
        break;
      case "FULFILLMENT_UNVERIFIED":
        out.push({ code, text: "Where to get it hasn't been checked." });
        break;
      default:
        break;
    }
  }
  return out;
}
