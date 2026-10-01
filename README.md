# Sanadoq API — Eradat (الإيرادات)

NestJS + Prisma 7 + Postgres API for the fund's revenue books. Every revenue
stream is a **Program** — the fund's own membership (protected), مواساة,
جامع السعيد, each campaign. Each human is one **Person**, linked to the
programs they pay into by a **ProgramEnrollment** that carries that program's
pledge. **Payments** come from an enrolled person, another program, or a
free-text name for someone who is in no directory at all.

## Run it

```bash
npm install
npm run db:migrate             # prisma migrate deploy — migrations are hand-written SQL
npm run db:generate
npm run create:user -- --email you@example.org --name "Your Name" --apply   # first account; prints a one-time password
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

## Layout

| Path                | Owns                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `src/auth/`         | Login, refresh, logout, password change; `AuthGuard`; permissions (`auth.constant.ts`)            |
| `src/users/`        | The account list: create, switch on/off, reset another's password                                 |
| `src/programs/`     | Programs; protection rules for the fund's membership program; entry mode (`program.util.ts`)      |
| `src/cycles/`       | Each program's own cycles; `resolveWindow` — which years a program's books open on and accept     |
| `src/people/`       | People directory; the duplicate review queue — matching rules in `person-duplicate.util.ts`       |
| `src/enrollments/`  | Who is in which program, with that program's pledge and previous subscription                     |
| `src/payments/`     | Monthly cells (amount / ★ / clear) and dated ledger entries                                       |
| `src/eradat/`       | Read side: per-program summary, grid lines, transfer lines, ledger; formulas in `revenue.util.ts` |
| `src/common/`       | `AppException`, global filter/interceptor, env schema, access decorators, money/date schemas      |
| `src/prisma/`       | `PrismaService` (soft-delete filtered) + extension                                                |
| `src/scripts/`      | `create:user`, `seed:demo`, `migrate:legacy-eradat` — all dry-run unless `--apply`                |
| `src/i18n/{en,ar}/` | Every success/error message, in English and Arabic                                                |
| `prisma/`           | `schema.prisma` (layout map at the top) and the hand-written baseline migration                   |

## How the books work

- **Entry mode.** A `PERIODIC` program with cycles keeps the monthly grid of
  the workbook (one cell per payer per month, ★ = paid but recorded under
  another month, counts 0). Every other program keeps a dated ledger.
- **Payers.** Exactly one of: an enrolled person, another program, or a
  free-text name — enforced by a CHECK. A person payer must be enrolled in the
  receiving program — enforced by a composite foreign key.
- **Program → program payments** (the fund paying مواساة or a campaign) are
  revenue of the receiving program only, never of the payer. They show as
  "paid to other programs" on the payer's summary.
  `TODO(expenses)`: once an Expenses module exists, the same transaction must
  also be booked as the payer's expense, linked to the payment.
- **Collection ratio** is per program: the sum of its enrollments' pledges ÷
  that year's payments by enrolled people. Transfers and one-off gifts are
  revenue but answer no pledge, so they stay out of the ratio.
- **Duplicates are never merged automatically.** Saving a person, and
  `POST /people/duplicates/scan`, raise review flags; a person merges or
  dismisses each one. Merging moves the other record's enrollments (and, by
  the FK's `ON UPDATE CASCADE`, its payments) and retires its account number.

## API

| Method & path                                                                                           | Does                                                |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/password`; `GET /auth/me`                   | Session                                             |
| `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/password`                                       | Accounts                                            |
| `GET/POST /programs`, `GET/PATCH/DELETE /programs/:id`                                                  | Programs (the protected one refuses delete/reshape) |
| `GET/POST …/:id/cycles`, `GET …/cycles/current`, `PATCH …/cycles/:cid`, `POST …/cycles/:cid/activate`   | A program's cycles                                  |
| `GET/POST …/:id/enrollments`, `PATCH/DELETE …/enrollments/:eid`, `POST …/enrollments/:eid/mark-dormant` | Enrollments                                         |
| `PUT/DELETE …/:id/cells/people/:personId/:year/:month`                                                  | A person's grid cell                                |
| `PUT/DELETE …/:id/cells/programs/:payerProgramId/:year/:month`                                          | Another program's grid cell                         |
| `POST …/:id/payments`, `DELETE …/:id/payments/:paymentId`                                               | Dated ledger entries                                |
| `GET …/:id/summary`, `…/lines`, `…/transfer-lines`, `…/payments`                                        | Read side                                           |
| `GET/POST /people`, `GET/PATCH/DELETE /people/:id`                                                      | People                                              |
| `GET /people/duplicates`, `POST …/scan`, `POST …/:fid/merge`, `POST …/:fid/dismiss`                     | Duplicate review                                    |

(`…` = `/programs`.)

## Deliberately not built yet

Each has a service method that throws `FEATURE_PENDING_CONFIRMATION` (501)
and a disabled control in the UI, so implementing it replaces one `throw`:

- Advance payments — `PaymentService.recordAdvancePayment`. Writes outside a program's current cycle are refused meanwhile.
- Dormant reactivation — `EnrollmentService.reactivateEnrollment` (the only DORMANT → ACTIVE path).
- Mid-cycle rate changes — `EnrollmentService.scheduleRateChange`.
- Collector assignment — `EnrollmentService.assignCollector`.
- Expenses (المصروفات) — not started; see `TODO(expenses)` on `Payment.payerProgramId`.
