# M2 — connecting the Supabase project

One-time setup. Steps marked **(owner)** need the product owner; nobody else should handle the
database password or the service-role key.

## 1. Create the project (owner)
1. Sign up at supabase.com (free plan).
2. New project → name `food-discovery`, region **Southeast Asia (Singapore)**, strong database password (keep it in a password manager).
3. Project Settings → API: copy the **Project URL** and the **publishable / anon key**. These two are public by design.
   Never share the `service_role` / secret key.

## 2. Link the CLI (owner types the password)
```bash
~/.local/bin/supabase login            # opens the browser to authorize the CLI
cd ~/food-discovery && ~/.local/bin/supabase link --project-ref <ref>   # asks for the database password
```

## 3. Apply schema and auth settings
```bash
~/.local/bin/supabase db push --dry-run   # review which migrations will run
~/.local/bin/supabase db push
~/.local/bin/supabase config push         # shows a diff of auth settings and asks to confirm
```
`config push` turns on guest (anonymous) sign-in, sets the allowed site URL and installs the
6-digit-code email templates from `supabase/config.toml`.

## 4. Configure the app build
- Local: `.env.local` (git-ignored) with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- GitHub Pages: repository **variables** (not secrets) `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; the workflow passes them to the build.

## 5. Smoke check against the real project (I-16)
- As a signed-out caller, `select * from meal_records` via the REST API must return 401/permission denied.
- In the app: Your data → Save my food history → agree; check that a meal appears in the
  Supabase table editor (as the owner), then "Stop & delete my cloud data" and check it is gone.

## After each catalog version bump
```bash
npm run db:reference && ~/.local/bin/supabase db push
```
A unit test fails if the current catalog has no matching reference migration.
