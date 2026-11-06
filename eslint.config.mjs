import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** ENG-003: the recommendation engine and catalog must stay framework- and cloud-independent. */
const forbiddenInDomain = [
  { group: ["react", "react-dom", "react/*", "next", "next/*"], message: "Domain code must not import UI frameworks (ETD ED-003)." },
  { group: ["@/app/*", "@/components/*", "@/lib/*"], message: "Domain code must not depend on the app layer." },
  { group: ["@supabase/*", "openai", "@anthropic-ai/*"], message: "Domain code must not import cloud/AI SDKs (ETD ED-003/ED-006)." },
];

const config = [
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/engine/**/*.ts", "src/catalog/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: forbiddenInDomain }],
      "no-restricted-globals": ["error", "window", "document", "localStorage", "fetch", "process"],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the injected seeded RNG (ETD ED-003)." },
        { object: "Date", property: "now", message: "Use the injected clock / PolicyContext.now (ETD ED-003)." },
      ],
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts"],
  },
];

export default config;
