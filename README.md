# Food Discovery — M1 local intelligence prototype

A mobile-first web prototype that helps you work out what you want to eat. You react to food cards, and it suggests one to three dishes with plain-language reasons.
Everything runs locally. There is no account, no cloud service, and no AI calls.

## Run it

Requires Node 24 LTS (see `.nvmrc`).

```bash
npm install
npm run build
npm start                      # http://localhost:3000
```

Development mode with hot reload: `npm run dev`.
The prototype evaluation tool is at http://localhost:3000/lab.

## Put it on your phone (like padel-os)

```bash
npm run export                 # builds a static folder: out/
```

Upload the **contents of `out/`** to any static HTTPS host, for example Netlify Drop, Cloudflare Pages, or GitHub Pages.
For a GitHub Pages *project* site (`https://<user>.github.io/<repo>/`), build with the sub-path instead:
`BASE_PATH=/<repo> npm run export`.
Then open the URL in Safari on your phone → Share → **Add to Home Screen**.

Notes: anyone with the URL can open the app. Your reactions, meals and restrictions stay in your phone's
browser storage and are never uploaded. There is no offline mode yet, so it needs a connection to open.

## Test it

```bash
npx playwright install chromium   # first time only
npm run verify                    # lint → typecheck → unit tests → build → browser tests
npm run catalog:validate          # validate src/catalog/dishes.json
npm run eval:simulate             # synthetic policy comparison (add -- --write to update docs)
```

## Where things are

- `src/engine/` — pure TypeScript recommendation engine (similarity, eligibility, scoring, card policies, shortlist, reasons)
- `src/catalog/` — versioned draft dish catalog + validator
- `src/components/`, `src/app/` — UI (Next.js App Router)
- `src/lib/` — local-only evaluation records and meal memory
- `docs/` — implementation notes, deviations, evaluation results, usability protocol
- `CLAUDE.md` — engineering rules and scope limits
