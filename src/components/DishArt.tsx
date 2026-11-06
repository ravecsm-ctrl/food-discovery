import type { Dish } from "@/engine";

/**
 * Clearly labelled illustration placeholder (PRRD §9.5): no licensed photographs exist yet,
 * so we never show scraped or unverified images. Decorative only — the dish name is real text.
 */
const PALETTES: Record<string, [string, string]> = {
  filipino: ["#ffb347", "#e8572a"],
  japanese: ["#ffd6c9", "#c8102e"],
  italian: ["#d8efc6", "#c0392b"],
  korean: ["#ffc2d1", "#d62f4f"],
  chinese: ["#ffe08a", "#c62828"],
  thai: ["#c9f2c7", "#2e8b57"],
  vietnamese: ["#e3f6c8", "#3f8f3f"],
  malaysian: ["#ffe3a3", "#c56a12"],
  singaporean: ["#fff0c2", "#d17b0f"],
  indonesian: ["#ffd29a", "#a63d10"],
  international: ["#cfe8f3", "#2f6f8f"],
};

export function DishArt({ dish, compact = false, label = true }: { dish: Dish; compact?: boolean; label?: boolean }) {
  const [from, to] = PALETTES[dish.cuisine] ?? ["#eee", "#999"];
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: `radial-gradient(120% 90% at 30% 20%, ${from} 0%, ${to} 100%)` }}
      aria-hidden="true"
      data-testid="dish-art"
    >
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.9) 1.2px, transparent 0)",
          backgroundSize: compact ? "10px 10px" : "18px 18px",
        }}
      />
      <div className="absolute inset-0 grid place-items-center">
        <span
          className="select-none drop-shadow-[0_10px_18px_rgba(0,0,0,0.25)]"
          style={{ fontSize: compact ? "2.4rem" : "clamp(5rem, 28vw, 8.5rem)", lineHeight: 1 }}
        >
          {dish.illustration}
        </span>
      </div>
      {label && !compact && (
        <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
          Illustration · no photo yet
        </span>
      )}
    </div>
  );
}
