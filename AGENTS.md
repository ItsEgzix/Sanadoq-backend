# Sanadoq API — instructions for agents

NestJS 11 + Prisma 7 + Zod 4 on Postgres 18 (Neon). It replaces a charity
fund's Excel workbook: revenue, expenses and a dashboard per program. The
frontend is a separate repo, `ItsEgzix/Sanadoq-frontend`, and reads this API.

Read [README.md](README.md) before changing anything about the books — **How
the books work** is the domain spec (programs, payers, ★ cells, arrears, the
collection ratio, running totals, balance). Team workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Load these skills

| Before you…                                         | Load                                              |
| --------------------------------------------------- | ------------------------------------------------- |
| write, review or move any backend file              | `backend-style`, then `sanadoq-backend` (overlay) |
| start work on an issue                              | `start-task`                                      |
| open a pull request                                 | `open-pr`                                         |
| file a bug, feature or decision                     | `new-task`                                        |

`backend-style` is the house style; `sanadoq-backend` maps it onto this repo
and **overrides it** where they disagree (imports, ownership, guards).

## Commands

```bash
npm run start:dev                 # http://localhost:5050 (the frontend runs on 5000)
npm run lint                      # eslint --fix; CI runs the same rules without --fix
npx tsc --noEmit                  # types
npm test                          # unit tests (jest, src/**/test/*.spec.ts)
npm run test:e2e                  # wiring tests; boots against DATABASE_URL, writes nothing
npm run build                     # prisma generate + nest build — what Vercel runs
npm run db:migrate                # prisma migrate deploy, against YOUR database only
```

## Rules that bite

1. **Relative imports only** — `'../common/utils/error.util'`, never
   `'src/...'` or `'generated/...'`. Vercel ships only what relative imports
   reach; an alias crashes production at boot. `tsc` rejects aliases here.
2. **Migrations are hand-written SQL** in
   `prisma/migrations/YYYYMMDDHHMMSS_snake_name/migration.sql`, opening with a
   comment block, with `schema.prisma` edited to match in the same commit.
   Never run `prisma migrate dev`, `migrate reset` or `db push`.
3. **Migrations reach production through the pipeline, not your terminal.**
   Merging to `master` runs *Migrate production database*, which waits for
   approval. Vercel deploys the new code at the same moment, so every
   migration must work with the code already in production
   (expand → deploy → contract). Never point `db:migrate` at production.
4. **Every user-facing message is a code** in both
   `src/i18n/en/events.json` and `src/i18n/ar/events.json`, same commit.
   `src/i18n/test/events.spec.ts` fails otherwise.
5. **Money is `Prisma.Decimal` → fixed-scale string** (`money.util.ts`),
   never a JS number, and **never summed across programs**.
6. **Every route declares access** — `@Public()`, `@AnyAuthenticated()` or
   `@RequirePermission(PERMISSIONS.MANAGE_FUND)`; the global `AuthGuard`
   refuses a route that declares nothing.
7. **The database is ~190 ms away.** Run independent reads with
   `Promise.all`; do not nest relation `select`s on hot paths.
8. **Data scripts are dry runs unless `--apply`**, and print which database
   they will touch. The workbook (`CHARITY FUND 2026-2029 (1).xlsx`) holds
   real people's data: it is never committed — this repo is public.
9. **An API shape change is a contract change.** Label the PR `api-contract`
   and open the matching frontend issue (`open-pr` does both).

## Definition of done

CI green (lint, types, unit tests, build, migrations on a fresh Postgres,
schema drift, e2e) · new codes in en and ar · README tables updated if you
changed routes, env vars or layout · behaviour exercised for real against
your own database · the PR says what you did not verify.
