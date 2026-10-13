---
name: sanadoq-backend
description: Project overlay for the Sanadoq API (the charity fund's books — programs, contributors, enrollments, payments, expenses, dashboard). Maps every role backend-style names to a real file here, and lists where this repo deliberately departs from backend-style (relative imports, permission-gated fund-wide data instead of per-user ownership, global AuthGuard, Neon latency, migrations shipped through an approved pipeline). Load together with backend-style before writing, reviewing or planning any change in this repo, and before answering "where does this go?".
---

# Sanadoq backend — overlay on backend-style

Load `backend-style` first. Where the two disagree, **this file wins**. The
domain rules themselves are in the README's **How the books work**; read that
section before touching revenue, arrears, terms, expenses or the dashboard.

## 1. Where Sanadoq departs from backend-style

| backend-style says                                   | Here instead                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-module imports use `src/...`                   | **Relative imports everywhere** (`../common/utils/error.util`, `../../generated/prisma/client`). Vercel's NestJS builder ships only files reached by relative imports and never rewrites aliases, so an alias boots locally and crashes in production. tsconfig has no `baseUrl`/`paths` on purpose. |
| Every query is scoped to `userId`; services start with `userId` | **There is no per-user data.** The books belong to the fund; every manager sees all of it. Access is a **permission** on the user's Role row. Services take the resource first (`programId`, then ids, then the DTO); `userId` appears only to stamp who recorded something (`recordedById`). The 404-for-missing rule still holds. |
| `@UseGuards(JwtAuthGuard)` on the controller         | `AuthGuard` is global (`APP_GUARD` in `app.module.ts`). Each controller (or route) declares `@Public()`, `@AnyAuthenticated()` or `@RequirePermission(PERMISSIONS.MANAGE_FUND)` from `src/common/decorators/access.decorator.ts`; a route with none is refused at runtime. Fund data is always `@RequirePermission`. |
| Money is `Decimal(12, 6)` with the currency in the name | Money is `Decimal(14, 2)` in the fund's single booking currency, no suffix. On the wire it is a fixed-scale string from `toMoneyString()`; input goes through `moneySchema` / `positiveMoneySchema`. **Never sum money across programs** — each program's books stand alone. |
| The pricing file rounds                               | `src/common/utils/money.util.ts` is that one place (`roundMoney`, `sumMoney`, `toMoneyString`, `toRatioString`).                                                                                                                                                                              |
| Migrations applied to every environment before done  | You never apply to production yourself. Merging to `master` runs `.github/workflows/migrate.yml` (`prisma migrate deploy` from the `neon-production` environment, after the owner approves). Apply to **your own** Neon branch with `npm run db:migrate` while developing.                     |

Building blocks backend-style lists that **do not exist here yet**: `@Trace()`,
the mask util, the timezone util, `assertOwned`/`ownedIds`/`diffLinks`, a
proxy-aware throttler guard (the login throttle uses `ThrottlerGuard` with
`TRUST_PROXY_HOPS` set in `main.ts`). Do not invent one for a single call
site; add it to `src/common/` when a second caller needs it.

## 2. Role → file

| Role in backend-style           | Sanadoq file                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| auth constants file             | `src/auth/auth.constant.ts` (permissions, token TTLs, refresh cookie, login throttle)              |
| access decorators               | `src/common/decorators/access.decorator.ts`; identity: `current-user.decorator.ts`                 |
| global guard / interceptors     | `src/auth/guards/auth.guard.ts`, `src/auth/access-check.interceptor.ts`, `src/common/interceptors/response-transform.interceptor.ts` |
| `AppException`                  | `src/common/exceptions/app.exception.ts`                                                           |
| global filter                   | `src/common/filters/http-exception.filter.ts`                                                      |
| `errorMessage`                  | `src/common/utils/error.util.ts`; Prisma error mapping: `prisma-error.util.ts`                    |
| deletion guard                  | `src/common/utils/blockers.util.ts` (`assertNoBlockers`)                                           |
| not-yet-confirmed feature       | `src/common/utils/pending-feature.util.ts` → `FEATURE_PENDING_CONFIRMATION` (501)                  |
| env contract                    | `src/common/config/env.schema.ts` + `.env.example` + README env table                              |
| shared Zod schemas              | `src/common/schemas/` (money, month, ISO date)                                                     |
| PrismaService + soft delete     | `src/prisma/prisma.service.ts` (pool constants at the top), `soft-delete.extension.ts`             |
| locale files                    | `src/i18n/en/events.json`, `src/i18n/ar/events.json` (flat keys; parity test in `src/i18n/test/`)  |
| scripts helper                  | `src/scripts/script.util.ts` (`openDatabase` prints the target before touching it)                 |
| schema layout map               | top of `prisma/schema.prisma`                                                                      |

Domain rules live in one place each — call them, never re-derive them:

| Rule                                       | Where                                                         |
| ------------------------------------------ | ------------------------------------------------------------- |
| grid vs ledger (`PERIODIC` / `TEMPORARY`)  | `programEntryMode()` in `src/programs/program.util.ts`        |
| which year a page opens on, years held     | `src/programs/program-window.service.ts`                      |
| what a subscriber owed for a month         | `owedFor()` in `src/enrollments/enrollment-term.util.ts`      |
| arrears, collection ratio, revenue figures | `src/eradat/revenue.util.ts`, `EradatArrearsService`          |
| dated subscription changes                 | `src/enrollments/enrollment-term.service.ts`                  |
| duplicate matching                         | `src/contributors/contributor-duplicate.util.ts`              |

## 3. Invariants the database enforces — keep them

- A Payment has exactly one payer: contributor, free-text name, or another
  program (CHECK). A contributor payer is enrolled in the receiving program
  (composite FK). A starred (★) cell has `amount` NULL.
- A program → program payment is **one row**: revenue of `programId`, expense
  of `payerProgramId`. Revenue totals filter on `programId`, never on
  `payerProgramId`. Never book the copy.
- Exactly one Program is protected (the fund's membership); it refuses
  delete and type changes.
- Enrollment terms are append-only, never after the current month; a second
  change in the same month replaces the first.
- Contributors are **never merged automatically** — only a reviewer merges a
  duplicate flag.

A change that relaxes one of these needs an issue with the `needs-decision`
label first.

## 4. Speed — Neon is across the internet

One query is ~190 ms from a laptop; a new connection ~2 s. So:

- Independent reads go side by side in `Promise.all` (see any `*-summary.service.ts`).
- A nested relation `select` is a second sequential query — on a hot path,
  query the relation separately inside the same `Promise.all`.
- Keep the pool constants in `prisma.service.ts`; their comments say why.

## 5. Migrations — the full path

1. Write `prisma/migrations/<UTC YYYYMMDDHHMMSS>_<snake_summary>/migration.sql`
   by hand. Open with the `-- ═══` comment block (what, why, backfill, what
   breaks without it). Guard destructive steps (`DO $$ … RAISE EXCEPTION`).
2. Edit `schema.prisma` to match; `npx prisma generate`.
3. **Expand → deploy → contract.** Vercel deploys the merged code while the
   migration may still be waiting for approval, so a migration must not break
   the code currently in production. Add columns nullable or with defaults,
   backfill, ship the code, then drop or tighten in a later PR.
4. `npm run db:migrate` against **your** Neon branch; exercise the feature.
5. CI applies every migration to a fresh Postgres 18 and runs
   `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
   A non-empty diff means `schema.prisma` and the SQL disagree — fix whichever is wrong.
6. Label the PR `migration`. After merge the owner approves
   *Migrate production database*; the card is Done only after it ran.

## 6. Scripts and the workbook

- `src/scripts/*.ts`, run with `tsx`, registered in `package.json` with a verb
  prefix (`seed:`, `verify:`, `create:`, `migrate:`). Dry run unless `--apply`;
  re-runnable; `openDatabase()` from `script.util.ts`.
- `seed:*` and `verify:workbook` read the fund's workbook, which is **not in
  the repo and must never be committed** (real names; the repo is public).
  Only the owner has it. `seed:demo` needs nothing and invents every name.
- `verify:workbook` is the proof that revenue logic still matches the sheet.
  If you change revenue, arrears or import code, ask the owner to run it.

## 7. Tests

- Unit: `src/<module>/test/*.spec.ts`, `new Service(mocks)`, assert
  `errorCode`, assert the write did not happen on a refusal.
- E2E: `test/app.e2e-spec.ts` covers guard, pipe, filter, interceptor and
  route order. CI runs it against a freshly migrated empty database, so it
  must not depend on rows other than the migrations' seeds.
- A real check against data: point `DATABASE_SCHEMA` at a throwaway schema of
  your Neon branch, `npm run db:migrate`, `npm run build`,
  `node dist/src/main` with `PORT=5071`, and drive it from the frontend.

## 8. Done means

CI green · new codes in en **and** ar · README tables (API, env, layout)
updated when you changed them · migration labelled and expand-safe · the
feature exercised against your own database · the PR lists what you did not
verify and any frontend follow-up.
