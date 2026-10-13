# Sanadoq API — the fund's books

NestJS + Prisma 7 + Postgres API for the fund's books: revenue (الإيرادات),
expenses (المصروفات) and a dashboard per program. Every revenue stream is a
**Program** — the fund's own membership (protected), مواساة, جامع السعيد, each
campaign. Each human is one **Contributor**, linked to the programs they pay
into by a **ProgramEnrollment** that carries that program's pledge and a dated
history of it (**EnrollmentTerm**). **Payments** come from an enrolled
contributor, another program, or a free-text name for someone who is in no
directory at all. **Expenses** are a program's payouts, one sheet of lines
(beneficiaries and purposes) with a cell per month.

New to the project? Start with [CONTRIBUTING.md](CONTRIBUTING.md) — setup,
the board, and how a change reaches production. Rules for code agents (and
the skills they load) are in [AGENTS.md](AGENTS.md).

## Run it

```bash
npm install
npm run db:migrate             # prisma migrate deploy — migrations are hand-written SQL
npm run db:generate
npm run create:user -- --email you@example.org --name "Your Name" --apply   # first account; prints a one-time password
npm run seed:contributors -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   # the real contributors from the workbook; omit --apply for a dry run
npm run seed:fund-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply    # the fund's revenue sheet (الايرادات)
npm run seed:mwa-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply     # مواساة's revenue sheet, into a program مواساة
npm run seed:mwa-expenses -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   # مواساة's expense sheet (مصروفات مواساه)
npm run verify:workbook -- --file "../CHARITY FUND 2026-2029 (1).xlsx"             # read-only: row-by-row diff of the database against the workbook
npm run seed:demo -- --apply   # optional demo data; omit --apply for a dry run
npm run start:dev              # http://localhost:5050
```

| Variable              | Required | Default                 | Notes                                                                    |
| --------------------- | -------- | ----------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`        | yes      | —                       | `postgres://` URL (Neon's pooled string). Not `prisma+postgres://`.      |
| `JWT_SECRET`          | yes      | —                       | 32+ chars; signs access and refresh tokens. Changing it signs all out.   |
| `DATABASE_SCHEMA`     | no       | `public`                | Run against an isolated schema of the same database (tests, checks).     |
| `PORT`                | no       | `5050`                  | 5000 is the frontend; `prisma dev` takes 5001.                           |
| `CORS_ORIGIN`         | no       | `http://localhost:5000` | The frontend's origin; credentials are allowed for exactly this origin.  |
| `TRUST_PROXY_HOPS`    | no       | `0`                     | Proxies in front of the API, so the login throttle sees real client IPs. |
| `LEGACY_DATABASE_URL` | no       | —                       | Only for `migrate:legacy-eradat` (old Member-shaped data).               |

Tests: `npm test` (unit), `npm run test:e2e` (boots the app against `DATABASE_URL`/`DATABASE_SCHEMA`; writes nothing).

## Access

Sign-in is email + password (Argon2id). The access token is short-lived and
held in memory by the frontend; the refresh token is an httpOnly cookie scoped
to `/auth`. Every route declares `@Public()`, `@AnyAuthenticated()` or
`@RequirePermission(...)`; the global `AuthGuard` refuses a route that declares
nothing. Authorisation checks a **permission** held by the user's **Role** row —
never a specific user — so a second role (say, a collector) is an `INSERT INTO
"Role"`, not a code change. Today there is one role, `FUND_MANAGER`, holding
`MANAGE_FUND`, and every account has it. Accounts are switched off, never deleted.

The guard's account check (active, not revoked, permission held) is a database
read. On writes it finishes before the handler runs; on `GET`s it runs beside the
handler and `AccessCheckInterceptor` holds the response until it passes, so a
revoked token still gets nothing back but reads skip a round trip.

## Speed

The database is remote (Neon), so latency is round trips, not query cost: one
is ~190 ms from the dev machine and a new connection ~2 s. Hot paths therefore
run independent queries side by side instead of nesting `select`s (Prisma runs a
nested relation as a second query, after the first), and the `pg` pool keeps
connections for 5 minutes instead of pg's 10 seconds — see the constants at the
top of `src/prisma/prisma.service.ts`. Keep both in mind when adding a read.

## Layout

| Path                | Owns                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/auth/`         | Login, refresh, logout, password change; `AuthGuard`; permissions (`auth.constant.ts`)                  |
| `src/users/`        | The account list: create, switch on/off, reset another's password                                       |
| `src/programs/`     | Programs; protection rules for the fund's membership program; entry mode (`program.util.ts`); the year window every page opens on (`program-window.service.ts`) |
| `src/contributors/` | Contributors directory; the duplicate review queue — matching rules in `contributor-duplicate.util.ts`  |
| `src/enrollments/`  | Who is in which program, with that program's pledge and previous subscription; each subscription's dated terms — joining, dormant, reactivated, a pledge from a month (`enrollment-term.service.ts`, rules in `enrollment-term.util.ts`) |
| `src/payments/`     | Monthly cells (amount / ★ / clear) and dated ledger entries                                             |
| `src/eradat/`       | Revenue read side: per-program summary, grid lines, transfer lines, ledger; formulas in `revenue.util.ts` |
| `src/expenses/`     | A program's expense sheet: lines, monthly cells, its summary, and payments it made to other programs    |
| `src/dashboard/`    | One read with a year's revenue, expenses and balance                                                    |
| `src/common/`       | `AppException`, global filter/interceptor, env schema, access decorators, money/date schemas            |
| `src/prisma/`       | `PrismaService` (soft-delete filtered) + extension                                                      |
| `src/scripts/`      | `create:user`, `seed:*` (workbook imports — sheet reading in `books-import.util.ts` and `expense-import.util.ts`), `verify:workbook`, `migrate:legacy-eradat` — all dry-run unless `--apply` |
| `src/i18n/{en,ar}/` | Every success/error message, in English and Arabic                                                      |
| `prisma/`           | `schema.prisma` (layout map at the top) and the hand-written SQL migrations                             |

## How the books work

- **Program types.** A `PERIODIC` program is an annual subscription its
  members renew (the fund's membership, مواساة): it keeps the monthly grid of
  the workbook (one cell per payer per month, ★ = paid but recorded under
  another month, counts 0) and a yearly pledge per member. A `TEMPORARY`
  program takes open donations from anyone, inside the fund or not — someone
  in hospital, this Ramadan's families — in a dated ledger, with no enrolling
  and no pledges. `programEntryMode()` in `src/programs/program.util.ts` reads
  the type.
- **No cycles.** Every year stands on its own and any year can be written:
  the fund opens the next year when it comes (paying ahead is simply next
  year's cells) and goes back to fix old ones. Each page has a year picker
  over the years the books hold, with arrows to any other.
- **Payers.** Exactly one of: an enrolled contributor, another program, or a
  free-text name — enforced by a CHECK. A contributor payer must be enrolled in the
  receiving program — enforced by a composite foreign key.
- **Program → program payments** (the fund paying مواساة or a campaign) are
  one Payment row seen from both sides: revenue of the receiving program, and
  an expense of the paying one, which its expense sheet reads from the same
  row. Never summed into the payer's revenue.
- **Subscription history.** Each periodic enrollment has dated terms: from
  this month on, ACTIVE or DORMANT at this yearly pledge. The first term is
  the month they joined. Marking dormant, reactivating and a new pledge each
  start from a month (default January of this year, the fund's usual choice),
  are appended in date order and never after this month; a second change in
  the same month replaces the first. A pledge can change mid-year only once
  the months before it are paid at the old pledge. Editing the pledge in
  place is a correction of the latest term.
- **Collection ratio (نسبة التحصيل)** is per program and year: payments by its
  subscribers ÷ what their pledges expected for the year — the workbook's own
  figure (782,800 ÷ 1,121,700 = 69.8% for the fund in 2026). Transfers and
  one-off gifts are revenue but answer no pledge, so they stay out of it.
- **Running totals (الإجمالي)** are the typed previous subscription (paid
  before this system held the books) plus every payment in any year — the
  workbook's BH column.
- **Arrears (العجز)** are per periodic program and per year: for each month of
  the year that has ended and that a subscriber's terms say was ACTIVE, the
  pledge in effect ÷ 12, less what they paid in the year. A month is owed once
  it is over; each January starts from zero; a mid-year joiner owes from the
  month they joined; a dormant member still owes the months before they were
  frozen. `owedFor()` in `enrollment-term.util.ts` and `arrears()` in
  `revenue.util.ts` are the rule, and `EradatArrearsService` feeds both
  `GET …/lines?behind=true` and the summary's `arrears`.
- **Balance** on the dashboard is each year's own money in less money out.
  Previous subscriptions stay out: they are revenue from before these books,
  with none of that era's spending beside them.
- **Duplicates are never merged automatically.** Saving a contributor, and
  `POST /contributors/duplicates/scan`, raise review flags; a reviewer merges or
  dismisses each one. Merging moves the other record's enrollments (and, by
  the FK's `ON UPDATE CASCADE`, its payments) and retires its account number.
  The one exception is `seed:contributors`, asked to fold the workbook's
  cross-sheet repeats (same first two names, same serial) before inserting,
  keeping the oldest account number.

## API

| Method & path                                                                                                 | Does                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/password`; `GET /auth/me`                         | Session                                             |
| `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/password`                                             | Accounts                                            |
| `GET/POST /programs`, `GET/PATCH/DELETE /programs/:id`                                                        | Programs (the protected one refuses delete/reshape) |
| `GET/POST …/:id/enrollments`, `PATCH/DELETE …/enrollments/:eid`                                               | Enrollments (PATCH corrects the pledge)             |
| `GET …/enrollments/:eid/terms`, `POST …/enrollments/:eid/mark-dormant`, `…/reactivate`, `…/rate-changes`      | A subscription's dated history and its changes      |
| `PUT/DELETE …/:id/cells/contributors/:contributorId/:year/:month`                                             | A contributor's grid cell                           |
| `PUT/DELETE …/:id/cells/programs/:payerProgramId/:year/:month`                                                | Another program's grid cell                         |
| `POST …/:id/payments`, `DELETE …/:id/payments/:paymentId`                                                     | Dated ledger entries                                |
| `GET …/:id/summary`, `…/lines`, `…/transfer-lines`, `…/payments`                                              | Revenue read side                                   |
| `GET/POST …/:id/expense-lines`, `PATCH/DELETE …/expense-lines/:lid`, `GET …/:id/expense-summary`              | The expense sheet and its summary                   |
| `PUT/DELETE …/:id/expense-lines/:lid/cells/:year/:month`                                                      | One expense cell                                    |
| `GET …/:id/dashboard`                                                                                         | Revenue, expenses and balance for a year            |
| `GET/POST /contributors`, `GET/PATCH/DELETE /contributors/:id`                                                | Contributors                                        |
| `GET /contributors/duplicates`, `GET …/open-count`, `POST …/scan`, `POST …/:fid/merge`, `POST …/:fid/dismiss` | Duplicate review (`open-count` feeds the badge)     |

(`…` = `/programs`.)

## Deliberately not built yet

Each has a service method that throws `FEATURE_PENDING_CONFIRMATION` (501)
and a disabled control in the UI, so implementing it replaces one `throw`:

- Collector assignment — `EnrollmentService.assignCollector`.

Not decided with the fund, so not imported: the fund's own expense sheet
(المصروفات), which rolls مواساة and the campaigns into the fund's spending,
and the campaign and جامع السعيد rows of الايرادات; the frozen balances on
الحسابات الخاملة; pledges for مواساة (its sheet keeps none, so they import
as 0).
