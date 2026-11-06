/**
 * Convert structured reason codes + evidence into plain-language explanations (ENG-015, R-013, PRRD §10.9).
 * Every sentence must be backed by a code AND the evidence that produced it; nothing is invented.
 */
import type { RecommendationItem } from "./recommend.ts";
import type { Catalog } from "./types.ts";

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

export function explainItem(item: RecommendationItem, catalog: Catalog): Explanation[] {
  const out: Explanation[] = [];
  for (const code of item.reasonCodes) {
    switch (code) {
      case "CURRENT_SESSION_POSITIVE": {
        const liked = item.evidence.likedSimilar[0];
        if (!liked) break;
        const name = catalog.byId.get(liked.dishId)?.name ?? "a dish";
        if (liked.dishId === item.dishId) {
          out.push({ code, text: `You said "sounds good" to this just now.` });
        } else if (liked.sharedAttributes.length > 0) {
          out.push({ code, text: `Like ${name}, which you liked just now, it's ${liked.sharedAttributes.map(attributeWord).join(" and ")}.` });
        } else {
          out.push({ code, text: `Similar to ${name}, which you liked just now.` });
        }
        break;
      }
      case "STABLE_PREFERENCE_MATCH":
        out.push({ code, text: "Matches food preferences you've set." });
        break;
      case "RECENT_FOOD_VARIETY":
        out.push({ code, text: "A change from the meals you've confirmed this week." });
        break;
      case "NOVELTY_EXPLORATION":
        out.push({ code, text: "Something different from what you've logged before." });
        break;
      case "INSUFFICIENT_EVIDENCE":
        out.push({ code, text: "Early pick — based on only a few reactions so far." });
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
