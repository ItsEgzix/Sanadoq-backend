---
name: backend-style
description: House style for any NestJS + Prisma + Zod backend — folder layout, file naming, module/controller/service shape, DTO validation, error codes and i18n, Prisma and hand-written migrations, pagination, auth and security, env validation, concurrency and idempotency, time and money, logging and personal data, lifecycle, tests, comment voice, definition of done — with reference files for inbound webhooks, WebSockets, third-party and LLM calls, cost metering, public APIs, and file uploads. Load before writing, reviewing, or extending ANY backend file, and before answering "where should this go?". If the repo has a project backend skill or CLAUDE.md, load it too — it maps the roles named here to real files.
---

# Backend house style

Apply this to every backend file you write or touch. When this document and a
generic best practice disagree, this document wins.

If you are about to write a file, first find the nearest existing file of the
same kind and match it. This document is the summary; the code is the spec.

---

## 0. The rules that matter most

1. **Every comment explains *why*, never *what*.** A comment that restates the
   code is deleted. See §18 — this is the most visible part of the style.
2. **Nothing user-facing is a raw string.** Services return `successCode`,
   throw `AppException(errorCode)`. Text lives in `src/i18n/<locale>/events.json`.
3. **Every query is scoped to `userId`.** A row someone else owns returns
   **404, never 403** — a 403 confirms the id is real.
4. **Reads use a `select` allowlist**, declared once per module as a
   `satisfies Prisma.XSelect` const. `userId` never leaves the server.
5. **Validation is Zod, at every edge, once.** HTTP bodies and queries,
   WebSocket messages, webhook fields, third-party and LLM responses. Past the
   edge, code trusts the parsed shape and never re-validates it.
6. **Controllers are wiring.** Guard, decorators, one service call, return.
   No business logic, no Prisma, no try/catch.
7. **Deletes are soft** on user-generated models. Hard delete goes through the
   unfiltered client and needs a reason in a comment.
8. **Migrations are hand-written SQL**, applied with `prisma migrate deploy`.
9. **Constants with real-world consequences live in exactly one file** —
   prices in the pricing file, cookie rules in the auth constants file, hash
   work factors in the auth helper. Two copies of a rate is a wrong bill.
10. **Fail at boot, not at 2am.** A missing operator key belongs in
    `env.schema.ts` or a service constructor, not in a lazy throw mid-request.
11. **Nothing is unbounded.** Every list has a `limit`, every outbound call has
    a timeout, every retry loop has a maximum, every upload has a size cap.
12. **Anything that can be delivered twice is idempotent.** Webhooks, background
    jobs, cost rows, and finalizers run safely a second time.

---

## 1. How this skill fits a project

This skill is project-neutral. Where it names a *role* — "the pricing file",
"the auth constants file", "the credential service" — the project's own backend
skill or `CLAUDE.md` maps that role to a real path. Load that overlay whenever
one exists; its facts beat the examples here.

### House building blocks

Every backend in this style has these in `src/common/`. If one is missing,
create it there before writing its logic inline a second time.

| Building block                                 | Job                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `AppException(code, meta?, status?)`           | the only way to throw an expected failure                          |
| `HttpExceptionFilter` (global)                 | any throw → `{ errorCode, message, timestamp, path }`, translated  |
| `ResponseTransformInterceptor` (global)        | `{ successCode, ...rest }` → `{ message, ...rest }`, translated    |
| `@CurrentUser()` + `CurrentUserPayload`        | identity from the guard, `{ userId }` only                          |
| `@Trace()`                                     | operational tracing with automatic secret masking                  |
| `assertOwned` / `ownedIds` / `diffLinks`       | ownership checks and link-set syncing                              |
| `assertNoBlockers(code, blockers)`             | 409 deletion guard with links to what blocks it                    |
| `errorMessage(err: unknown)`                   | the only way a caught `unknown` becomes a string                   |
| mask util                                      | secret/PII masking for display and logs                            |
| `validateEnv` in `common/config/env.schema.ts` | boot-time env contract                                             |
| soft-delete Prisma extension + `PrismaService` | `isDeleted: false` injected into reads                             |
| proxy-aware throttler guard                    | rate limits keyed on the real client IP, not the proxy's           |
| timezone util                                  | IANA zone validation and zoned day/hour math                       |

### Reference files — read the one that matches the task

| Before you touch…                                         | Read                              |
| --------------------------------------------------------- | --------------------------------- |
| an endpoint a third party calls (webhooks, callbacks)     | `references/webhooks.md`          |
| a `@WebSocketGateway` or any long-lived connection        | `references/realtime.md`          |
| a call to a third-party API or an LLM, or recording cost  | `references/external-services.md` |
| an endpoint authenticated by API key, not session         | `references/public-api.md`        |
| a file upload, download, or object storage                | `references/file-uploads.md`      |

### Code that predates a rule

Follow every rule in new code. Bring existing code in line only in files you
are already changing for the task, or when asked — never as an unrequested
sweep. If you notice a violation elsewhere, mention it in your report.

---

## 2. Stack — fixed choices, do not substitute

| Concern          | Choice                                        | Never                                     |
| ---------------- | --------------------------------------------- | ----------------------------------------- |
| Framework        | NestJS (`@nestjs/*`), TypeScript              | Express routes by hand                    |
| Validation       | Zod via `nestjs-zod` (`createZodDto`)         | `class-validator`, `class-transformer`    |
| ORM              | Prisma over Postgres, `pg` driver adapter     | raw SQL in services, another ORM          |
| Password hashing | `argon2` (Argon2id)                           | bcrypt, sha*, pbkdf2                      |
| Tokens           | `@nestjs/jwt`, HS256 pinned                   | in-memory sessions, opaque tokens         |
| i18n             | `nestjs-i18n`, JSON per locale                | hardcoded English                         |
| Rate limiting    | `@nestjs/throttler` + a proxy-aware guard     | bare `ThrottlerGuard` behind a proxy      |
| Config           | `@nestjs/config` + Zod `validateEnv`          | unvalidated `process.env`                 |
| WebSockets       | `ws` via Nest's `WsAdapter`                   | socket.io                                 |
| HTTP client      | global `fetch` with `AbortSignal.timeout`     | axios, got, request                       |
| Tests            | Jest, plain `new Service(mocks)`              | `Test.createTestingModule` for unit tests |
| Formatting       | Prettier: `singleQuote`, `trailingComma: all` | anything else                             |

Adding a dependency is a decision, not a reflex. Prefer the standard library
and what is already installed, and say in your report why a new one earned
its place.

---

## 3. Folder layout

```text
backend/
├── src/
│   ├── main.ts                  bootstrap: global pipe/interceptor/CORS/adapters
│   ├── app.module.ts            imports every feature module + global providers
│   ├── <feature>/               one folder per business domain (plural noun)
│   │   ├── <feature>.module.ts
│   │   ├── <feature>.controller.ts
│   │   ├── <feature>.service.ts
│   │   ├── <thing>.util.ts | .constant.ts | .types.ts | .schema.ts | .prompt.ts
│   │   ├── dto/
│   │   ├── guards/              only if the feature owns a guard
│   │   ├── services/            only when one feature has 4+ collaborator services
│   │   └── test/                *.spec.ts, mirrors the files above
│   ├── common/                  cross-cutting only; no business logic (§1)
│   ├── prisma/                  PrismaService + soft-delete extension
│   ├── i18n/<locale>/events.json
│   └── scripts/                 one-off tsx scripts, registered in package.json
├── prisma/                      schema.prisma, SCHEMA.md, migrations/
└── <data folders>/              templates and seed JSON/Markdown — data, not code
```

**Folder = plural domain (`invoices/`, `customers/`). File = singular subject
(`invoice.service.ts`, `customer.controller.ts`).** Controllers of
collection-shaped features may be plural — follow the sibling files in that
folder rather than inventing.

### File-name suffix taxonomy — the suffix declares the kind

| Suffix                                                     | Holds                                  |
| ---------------------------------------------------------- | -------------------------------------- |
| `.module.ts`                                               | Nest DI wiring only                    |
| `.controller.ts`                                           | HTTP surface                           |
| `.gateway.ts`                                              | WebSocket surface                      |
| `.service.ts`                                              | `@Injectable()` business logic         |
| `.util.ts`                                                 | pure functions, no DI, no Nest imports |
| `.constant.ts`                                             | frozen values / literal tables         |
| `.types.ts`                                                | types and interfaces only              |
| `.schema.ts`                                               | Zod schemas that are not request DTOs  |
| `.dto.ts`                                                  | request DTOs (inside `dto/`)           |
| `.prompt.ts`                                               | LLM prompt text                        |
| `.registry.ts`                                             | a lookup map of implementations        |
| `.extension.ts`                                            | Prisma client extensions               |
| `.guard.ts` `.filter.ts` `.interceptor.ts` `.decorator.ts` | their Nest kind                        |
| `.spec.ts`                                                 | tests, in the module's `test/` folder  |

A file's name promises what is inside it. Never put a service in a `.util.ts`.

### Imports

- Same module → relative: `'./dto/create-invoice.dto'`.
- Cross module → absolute from src: `'src/common/utils/error.util'`.
- Type-only imports use `import type` (`isolatedModules` is on).
- Barrels only for `dto/index.ts` in modules with many DTOs. No other
  `index.ts`.

---

## 4. Module

```ts
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
```

- `PrismaModule` is `@Global()` — importing it is habit, not requirement.
- Export a service only when another module injects it.
- Register the module in `app.module.ts`. Global providers
  (`APP_FILTER` / `APP_GUARD` / `APP_INTERCEPTOR`) live there and nowhere else,
  each with a comment when the choice is non-obvious.
- A module's JSDoc names who imports its exports and why.

---

## 5. Controller

```ts
/**
 * HTTP surface for the customer book. Every route is scoped to the
 * authenticated user and the service re-verifies ownership before touching
 * data, so a customerId belonging to another user 404s rather than leaking
 * its existence.
 */
@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post()
  async create(
    @Body() createCustomerDto: CreateCustomerDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.customerService.createCustomer(user.userId, createCustomerDto);
  }
}
```

Rules:

- `@UseGuards(JwtAuthGuard)` at **class** level when every route is
  authenticated; per-method only on mixed controllers.
- Identity comes from `@CurrentUser() user: CurrentUserPayload` — **never**
  from a body field, a param, or a header the client controls.
- `@Param('customerId')`, `@Query() query: SomeQueryDto` (a Zod DTO whenever
  there is more than one param), `@Body() dto: SomeDto`.
- Method names are HTTP-ish (`create`, `update`, `remove`, `list`); service
  methods are domain-ish (`createCustomer`, `deleteCustomer`).
- `@Throttle({ default: { limit, ttl } })` on anything brute-forceable or
  expensive, with a one-line comment saying which abuse it slows.
- Cookies are set/cleared in the controller (`@Res({ passthrough: true })`)
  using the shared attribute helpers — services never touch `Response`.
- **Static route segments are declared before `:param` routes**, with the
  comment explaining it — Nest matches in declaration order, so `'tags'` would
  otherwise be swallowed by `':customerId'`.
- No try/catch. The global filter handles it.
- The one sanctioned exception is a route whose response format a third party
  dictates (XML for a telephony provider, a bare 200 for a webhook) — see
  `references/webhooks.md`.

---

## 6. DTOs and validation

```ts
// dto/create-invoice.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  status: z.enum(['DRAFT', 'SENT']).optional(),
  dueDate: z.coerce.date(),
  note: z.string().max(2000).optional().nullable(),
});

export class CreateInvoiceDto extends createZodDto(createInvoiceSchema) {}
```

```ts
// dto/update-invoice.dto.ts — derive, never retype
const updateInvoiceSchema = createInvoiceSchema.partial();
export class UpdateInvoiceDto extends createZodDto(updateInvoiceSchema) {}
```

- **Export the schema** when another file derives from it; export the class
  always.
- Update DTO = `createSchema.partial()`. Duplicating the field list is a bug
  waiting to happen.
- Naming: `createXSchema` / `CreateXDto`, `updateXSchema` / `UpdateXDto`,
  `listXQuerySchema` / `ListXQueryDto`.
- Enum values match the Prisma enum exactly.
- Every string and every array has a `.max()`. Unbounded input is a memory
  and cost problem before it is a validation problem.
- Custom rules go through `.refine()` with a human `message`, reusing a shared
  predicate (`isValidTimeZone`, `isE164`) rather than inlining a regex twice.
- Zod schemas for non-request shapes (JSON columns, WebSocket messages,
  third-party and LLM output) live in a `.schema.ts`, and use `z.looseObject`
  when unknown keys must survive.

---

## 7. Service

```ts
// Response allowlist. userId stays server-side: it scopes the ownership checks
// and the client has no use for it.
const INVOICE_SELECT = {
  id: true,
  customerId: true,
  status: true,
  dueDate: true,
} satisfies Prisma.InvoiceSelect;

type InvoiceSummary = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

/**
 * CRUD for Invoice. An invoice always belongs to one customer of the same
 * user; the customer link is re-verified on every write that changes it.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // A row owned by another user 404s rather than 403s: a 403 would confirm the
  // id is real to whoever guessed it.
  private assertInvoiceOwned<T = Invoice>(userId: string, invoiceId: string) {
    return assertOwned<T>(
      this.prisma.invoice,
      { id: invoiceId, userId, isDeleted: false },
      'INVOICE_NOT_FOUND',
      { details: { invoiceId } },
    );
  }

  @Trace()
  async updateInvoice(userId: string, invoiceId: string, data: UpdateInvoiceDto) {
    await this.assertInvoiceOwned(userId, invoiceId);

    const invoice = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data,
      select: INVOICE_SELECT,
    });
    return { ...invoice, successCode: 'INVOICE_UPDATE_SUCCESS' };
  }
}
```

Rules:

- `constructor(private readonly x: X)` — always `private readonly`.
- **Signature starts with `userId`**: `method(userId, id, dto)`.
- Ownership is asserted **before** any write, and before touching a foreign key
  the caller supplied (`assertCustomerOwned` before attaching a customer).
  Reuse `assertOwned` / `ownedIds` / `diffLinks` instead of rewriting the check.
- Mutations return `{ ...row, successCode: 'X_ACTION_SUCCESS' }`. Pure reads
  return the data with no `successCode`.
- Expected failures `throw new AppException(code, meta, status)`. Never
  `throw new Error` for something a user can cause.
- `@Trace()` on public methods that matter operationally; when an argument is a
  secret passed as a bare string, declare it: `@Trace({ redactArgs: [0] })`.
- `private readonly logger = new Logger(ServiceName.name)` when the service
  logs (§15).
- Multi-step writes go in `this.prisma.$transaction(async (tx) => …)` with a
  comment saying what must commit or roll back together (§13).
- A method over ~60 lines is decomposed into named private methods; a service
  over ~400 lines is split into collaborators in the same folder (or a
  `services/` subfolder once there are four or more).

---

## 8. Errors, success codes, and i18n

### The contract

- `AppException(errorCode, meta?, status = 400)` — `errorCode` is a stable
  SCREAMING_SNAKE key, never prose.
- `HttpExceptionFilter` (global) turns anything thrown into
  `{ errorCode, message, timestamp, path }`. `meta` is attached **only outside
  production**; the sole exception is `details.blockers`, a whitelist the UI
  needs.
- `ResponseTransformInterceptor` (global) turns `{ successCode, ...rest }` into
  `{ message, ...rest }`.
- Both translate `events.<CODE>` and retry in English when a locale lacks the
  key, so a user never sees a bare code.
- Locale comes from `?lang=` then `Accept-Language`. Outside a request —
  WebSocket messages, background jobs, emails — use the locale stored on the
  user, or English when there is none; never the server's locale.

### Naming codes

`<DOMAIN>_<THING>_<OUTCOME>` — `INVOICE_CREATE_SUCCESS`, `CUSTOMER_NOT_FOUND`,
`TEMPLATE_IN_USE`, `AUTH_TOKEN_INVALID`, `API_KEY_MISSING`.

### Status codes

| Situation                                           | Status                                 |
| --------------------------------------------------- | -------------------------------------- |
| Bad input that Zod cannot express                   | 400                                    |
| Missing/invalid token or key                        | 401                                    |
| Authenticated but not allowed (deactivated account) | 403                                    |
| Not found **or owned by someone else**              | 404                                    |
| Already exists                                      | 409                                    |
| Still referenced by something else                  | 409 + blockers                         |
| Rate limited                                        | 429 (filter maps `ThrottlerException`) |
| A third party answered with an error or bad payload | 502                                    |
| A required provider is not configured or is down    | 503                                    |
| A third party timed out                             | 504                                    |

### Adding a code — every locale, same commit

Every new code is added to every locale the project ships. A missing
translation is a bug, not a TODO. Placeholders are `{name}` style and are fed
from `meta`:

```json
"TEMPLATE_IN_USE": "This template is used by: {names}. Remove it from each one before deleting."
```

Messages are short, sentence-cased, end with a period, and tell the user what
to do next. They never leak ids, stack traces, provider error bodies, or
internal names.

### Deletion guards

Before removing anything another record points at, collect `Blocker[]` and call
`assertNoBlockers('X_IN_USE', blockers)` — 409 with `{ blockers, names }` so the
frontend can link straight to the page where the user detaches it.

---

## 9. Prisma

### 9.1 Schema

- `schema.prisma` opens with a **layout map**: the areas of the schema in
  order, plus the two or three rules that span models. Keep it accurate.
- Comments live next to the column they explain (`//`), or as `///` doc
  comments on a model. If renaming a column would force an edit to `SCHEMA.md`,
  that text belonged in the schema instead.
- Standard columns: `id String @id @default(uuid())`,
  `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, and on
  soft-deletable models `isDeleted Boolean @default(false)` +
  `deletedAt DateTime?`.
- Model = PascalCase singular. Field = camelCase. Enum values =
  SCREAMING_SNAKE.
- Index every FK and every column a hot `where` or `orderBy` uses
  (`@@index([userId])`, `@@index([userId, createdAt])`).
- Choose the FK action deliberately and say why: `Cascade` for owned children,
  `SetNull` when history must survive the parent
  (`// SetNull: deleting a tool must not erase the record of how much it was used.`).
- Prefer nullable over `@default` when "never chose" must stay distinguishable
  from "chose this value" — a default is copied in at INSERT and freezes the
  old choice forever.
- A `Json` column always has a Zod shape contract in a `.schema.ts`, parsed at
  the one point every row passes through.
- A column that is an idempotency key (`sourceKey`, a provider event id) is
  `@unique` — the constraint is the dedupe, not a prior `findFirst`.

### 9.2 Soft delete

`PrismaService` is the `$extends`-wrapped client:
`findFirst` / `findMany` / `count` / `aggregate` / `groupBy` on the models
listed in the extension's soft-delete model list get `isDeleted: false`
injected automatically.

- Passing `isDeleted` explicitly is the per-query opt-out.
- `findUnique` is **not** filtered (its `where` only takes unique fields) — use
  `findFirst` for anything that must exclude deleted rows.
- "Delete" = `update({ data: { isDeleted: true, deletedAt: new Date() } })`,
  with a comment naming what a hard delete would break.
- `this.prisma.raw` is the unfiltered client: restore, "forget me" purges,
  retention jobs, admin "include deleted". Never for a normal read.
- A new soft-deletable model joins the extension's list in the same commit —
  otherwise its "deleted" rows keep appearing.

### 9.3 Queries

- `select` allowlist on anything returned to a client; `include` only when a
  whole related row is genuinely needed. Prisma rejects both at once.
- Every `findMany` on a user-scoped table has `userId` in the `where` **and** a
  `take` (§10).
- `Prisma.XGetPayload<{ select: typeof X_SELECT }>` for the return type — do
  not hand-write a mirror interface.
- No N+1: a loop that awaits one query per item becomes one `findMany` with
  `id: { in: ids }` or a nested `select`.
- `$queryRaw` only for what Prisma cannot express (advisory locks, window
  functions), always the tagged-template form, never `$queryRawUnsafe` with
  interpolated input.

### 9.4 Migrations — hand-written

```text
prisma/migrations/20260814120000_usage_rollup/migration.sql
```

- Folder name: `YYYYMMDDHHMMSS_snake_case_summary`.
- **Write the SQL by hand** and apply it with `npx prisma migrate deploy`.
  Migrations are reviewed SQL that carry their own backfills, and the workflow
  must not depend on a shadow database. Never `prisma migrate dev`.
- Every migration opens with a comment block: what it replaces, why, what it
  backfills, and what would break without it.
- Backfill in the same migration as the schema change, before the `DROP`, so no
  number in the UI moves.
- A destructive step guards itself (refuse to drop a column that still holds
  data nothing has copied) rather than trusting the order it was run in.
- Update `schema.prisma` to match by hand in the same commit, then run
  `npx prisma generate`.
- A migration is applied to **every** environment the project lists before the
  work is called done — or named as pending in your report.

---

## 10. Lists and pagination

One shape for every list endpoint:

```ts
// dto/list-invoices-query.dto.ts
export const listInvoicesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export class ListInvoicesQueryDto extends createZodDto(listInvoicesQuerySchema) {}
```

```ts
async listInvoices(userId: string, { cursor, limit }: ListInvoicesQueryDto) {
  // One extra row says whether another page exists without a count().
  const rows = await this.prisma.invoice.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: INVOICE_SELECT,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
```

- Response is `{ items, nextCursor }` — `nextCursor: null` means the end.
- `orderBy` always ends in `id` so ties cannot reorder between pages.
- Offset pagination (`skip: page * limit`) only where the UI genuinely needs
  page numbers, capped at `max(100)` too.
- A child list that is small **by design** (tags on one record, capped by a
  constant) may return a plain array — name the cap in a comment.
- Scripts and backfills walk tables in `take: BATCH` chunks with the same
  cursor pattern, never one unbounded `findMany`.

---

## 11. Auth and security

- **Argon2id**, parameters set explicitly so a dependency bump cannot move the
  security floor:
  `{ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }`
  (~80ms/hash). Verification reads parameters from the stored hash, so raising
  them is safe.
- **Timing:** a login for an unknown email still spends the CPU —
  `simulatePasswordCompare()` verifies a dummy hash generated at the *same*
  parameters. Without it, unknown emails answer ~20× faster and are enumerable.
- Access token: short-lived, carries `sub` only. Refresh token: long-lived,
  carries `jti` (`randomUUID()`) so two tokens minted in the same second are not
  byte-identical.
- `verify` pins `algorithms: ['HS256']` — never let the token's own header pick
  its verification. All verification failures collapse to one error code.
- Refresh tokens travel in an **httpOnly, secure cookie** and never appear in a
  response body. `SameSite` and `maxAge` come from the auth constants file; set
  and clear must share identical attributes or the browser will not delete it.
- Guards attach `request.user = { userId }` and nothing else. Every auth scheme
  (JWT, API key, WebSocket ticket) produces the same shape so `@CurrentUser()`
  services work unchanged.
- Secrets at rest: AES-256-GCM via the credential encryption service, fresh
  random IV per encryption, stored as `iv:authTag:ciphertext`.
- Hashed lookups (API keys) store `sha256` only, and show the raw value once.
- Never log a secret. `@Trace` masks object keys automatically; bare-string
  secrets need `redactArgs`.
- `path`, not `url`, in error responses — a query string can carry an OAuth
  `?code=`.
- Compare secrets with `crypto.timingSafeEqual`, never `===`.
- Behind a proxy, `trust proxy` is set to exactly the hops the deployment has —
  never a blanket `true` on a port the internet can reach directly.
- Any URL that arrives as input (webhook body, user setting, LLM output) is
  checked against an allowlist of hosts before the server fetches it — the
  server can reach things the caller cannot.

---

## 12. Configuration and environment

- `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`.
- `common/config/env.schema.ts` is a Zod object of what the app **refuses to
  boot without**, plus the shape of optional vars.
- **One guard per variable.** If a service constructor already throws a specific
  message for a var, it does *not* also go in the schema — the schema documents
  which vars are deliberately delegated, and to whom.
- `validateEnv` returns `config` **unchanged**, never the parsed object: Nest
  feeds the return value back into `process.env`, and a Zod object strips keys
  it does not declare.
- Narrow the accepted format on purpose (`/^\d+[smhd]$/` for durations) — every
  extra accepted spelling is a way for two people to disagree about the same
  value.
- Anything read at module-evaluation time must be a **function**, not a `const`
  — module constants evaluate before `.env` is read.
- In services, read config through `ConfigService`; in bootstrap-time helpers,
  `process.env` with a documented default.
- A new variable is added to `.env.example` (or the README's env table) in the
  same commit, with what it does and what happens when it is unset.

---

## 13. Concurrency and idempotency

**Background work** — fire and forget, with the status in the database:

```ts
// Fire-and-forget; status is tracked in the DB and surfaced via polling.
void this.process(document.id).catch((err) => {
  this.logger.error(`Background processing failed for ${document.id}: ${errorMessage(err)}`);
});
```

`void` is required (`no-floating-promises` is an error), the `.catch` is
required, and the work must be idempotent and claimable so it cannot run twice.

**Claim before you work.** A job, a one-time code, or a state transition is
taken with a conditional `updateMany` and proceeds only if it won:

```ts
// The conditional update is the lock: two racing workers both run this and
// exactly one sees count === 1.
const { count } = await this.prisma.document.updateMany({
  where: { id, status: 'PENDING' },
  data: { status: 'PROCESSING' },
});
if (count === 0) return; // someone else has it, or it is already done
```

Rules:

- **Dedupe with a unique constraint**, not a prior read:
  `createMany({ data, skipDuplicates: true })` or `upsert` on the unique key.
  A `findFirst` followed by `create` is a race.
- **Idempotency keys are deterministic** for once-only events
  (`order:<id>:charge`) and run-stamped where each run is real spend
  (`report:<id>:<runAt>`).
- **Counters use `{ increment: n }`**, never read-then-write.
- **Allocating the next number** (version, sequence) takes a
  `pg_advisory_xact_lock` inside the transaction, or relies on a unique
  constraint and retries once.
- **Transactions stay short and local**: no network call, no LLM call, no
  `await` on a third party inside `$transaction` — it holds a connection and
  row locks for as long as the provider takes.
- **Finalizers are safe to call twice** — a disconnect and an explicit "end"
  can both fire. Guard with a flag or a status check at the top.
- **In-memory state is per-process.** A `Map` registry, token store, or cache
  works only while the app runs as one instance; the file's JSDoc says so.
  Anything that must survive a restart or a second instance goes in the
  database.

---

## 14. Time and money

- Timestamps are stored as `DateTime` (UTC). Convert to a user's zone only at
  the edges, through the timezone util, with IANA names validated by
  `isValidTimeZone`.
- Never use the server's local time for business logic (`getHours()`,
  `toLocaleDateString()` without a zone) — the server's zone is an accident of
  where it is deployed. "Today" and day buckets are computed in the user's zone.
- Durations are integers with the unit in the name: `durationSec`, `ttlMs`.
- Money is a `Decimal` column with a fixed scale (`@db.Decimal(12, 6)`), one
  currency per column, the currency in the name (`amountUsd`). Never `Float`.
- Rounding happens in one function in the pricing file. The frontend displays
  amounts; it never computes them.

---

## 15. Logging and personal data

- One `Logger` per class: `new Logger(ClassName.name)`. No `console.log`
  outside `main.ts` and scripts.
- Levels:
  - `error` — a human should look: a failed background job, an inconsistency
    the code cannot repair.
  - `warn` — rejected or unexpected outside input, a degraded fallback taken.
  - `log` — lifecycle: connected, started, completed, with ids.
  - `debug` — detail that is off in production.
- **Log ids, not content.** User, entity, and provider ids are fine. Never log
  passwords, tokens, API keys, one-time codes, full phone numbers or emails,
  message bodies, transcripts, document text, or LLM prompts and outputs. Use
  the mask util when a value must appear at all.
- Log `errorMessage(err)` plus the ids involved. Never log a third-party SDK
  error object whole — they carry request headers, including `Authorization`.
- **Personal data has a deletion story.** Soft delete is the default, but a
  user's explicit "delete/forget my data" is a hard delete through the
  unfiltered client that also removes every derived copy — storage objects,
  embeddings, summaries, caches. The method's comment lists those copies.

---

## 16. Lifecycle — boot and shutdown

- `OnModuleInit` — set up this provider's own state (open a client, register
  itself in a registry).
- `OnApplicationBootstrap` — work that needs the whole app wired (a sync across
  modules, a warm-up). It must be idempotent, and it must not block boot on a
  third party: log and continue unless the app truly cannot serve without it.
- `main.ts` calls `app.enableShutdownHooks()`, and every provider that opened
  something (DB pool, sockets, upstream connections) closes it in
  `OnModuleDestroy` / `OnApplicationShutdown`. Long-lived connections are
  closed deliberately, not dropped when the process dies.
- Every `setInterval` / `setTimeout` owned by an object is cleared on that
  object's teardown path. Housekeeping timers call `.unref()` so they never
  hold the process open.

---

## 17. Utils, constants, registries, scripts

**Utils** are pure and DI-free (`common/utils/*.util.ts`): one exported function
per concept, JSDoc'd, unit-tested in `utils/test/`. Anything shared by three
call sites moves here.

**Constants tables** (prices, rates, rubrics, limits) live in one file that says
it is the single source of truth, with the upstream URL in a `@see`. Nothing is
fetched live; nothing else recomputes the value.

**Registries** (`.registry.ts`) are the one place a family of implementations is
wired — adding a provider means adding it to the registry and nowhere else.

**Scripts** go in `src/scripts/`, run with `tsx`, and are registered in
`package.json` under a verb-prefixed name: `seed:`, `backfill:`, `sync:`,
`verify:`, `repair:`, `reindex:`, `migrate:`, `create:`.

- Scripts that change data are **dry-run by default** and write only with
  `--apply`, printing what they would change either way.
- They are **re-runnable**: a second run finds nothing left to do.
- They walk tables in batches (§10), and print which database they are about
  to touch before touching it.

---

## 18. Comments — the house voice

This is the part most agents get wrong. The codebase is documented **inline**,
not in design docs, and the comments carry the reasoning.

**Every file that is not trivial opens with a JSDoc block** stating what it owns
and the one or two decisions a reader would otherwise question:

```ts
/**
 * The app's sole Prisma client, injected everywhere as the soft-delete-
 * filtered instance (see soft-delete.extension.ts) so ordinary reads never
 * need to remember `where: { isDeleted: false }`. Connects via the `pg`
 * driver adapter rather than Prisma's default connection string handling,
 * and manages connect/disconnect through Nest's module lifecycle.
 */
```

**Inline comments name the failure they prevent.** Compare:

```ts
// BAD — restates the code
// Check if the user is active
if (!user.isActive) throw new AppException('AUTH_ACCOUNT_DEACTIVATED');

// GOOD — says why this exists here
// Verified, but no session until an admin activates the account. Mirrors
// login() and refreshAccessToken() so OTP verification cannot be used to
// bypass deactivation.
if (!user.isActive) throw new AppException('AUTH_ACCOUNT_DEACTIVATED');
```

Conventions:

- Explain ordering when order matters (`// Ahead of the HttpException branch on purpose: ThrottlerException extends HttpException…`).
- Justify anything that looks wrong at a glance — a cast, a re-`return` from a
  constructor, a disabled lint rule, a `findFirst` where `findUnique` reads more
  naturally.
- Say what is *deliberately absent* and where it lives instead.
- Cross-reference by path or symbol: `see the model list in src/prisma/soft-delete.extension.ts`.
- Long is fine when the reasoning is load-bearing. A 20-line comment above a
  3-line function is correct if those 20 lines stop someone reverting it.
- Section separators in long files: `// ── Auth ─────` inside a schema,
  `// ═══════` above a major block.
- Prose voice: plain, direct, present tense, em dashes for asides. No hype, no
  "simply", no apologies, no TODOs left as decoration.

Never write: `// constructor`, `// getters`, `// returns the user`, or a JSDoc
that repeats the parameter names with no added information.

---

## 19. Tests

- Location: `<module>/test/<file>.spec.ts`. Utils: `common/utils/test/`.
- Unit tests construct the class directly with mock collaborators — no Nest
  testing module:

```ts
const mockPrisma = { invoice: { create: jest.fn(), findFirst: jest.fn() } };
beforeEach(() => {
  jest.clearAllMocks();
  service = new InvoiceService(mockPrisma as unknown as PrismaService);
});
```

- `describe('<Class>')` → `describe('<method>')` → `it('<behaviour and why>')`.
  Test names are sentences about behaviour, not labels:
  `it('rejects a cross-tenant customerId with CUSTOMER_NOT_FOUND before creating the invoice')`.
- Assert on `errorCode`, not message text:
  `.rejects.toMatchObject({ errorCode: 'INVOICE_NOT_FOUND' })`.
- Assert the **negative** too: the write must not have happened
  (`expect(mockPrisma.invoice.update).not.toHaveBeenCalled()`).
- Every new service method gets: happy path, ownership/cross-tenant rejection,
  and each guarded edge. Every util gets its boundary values, with the value
  named in a trailing comment (`// 15 digits`).
- Idempotent code gets a test that runs it twice and asserts one effect.
- Outbound calls are mocked at the provider service, never over the network;
  test the timeout and the error mapping, not just success.
- A tricky comment in the source deserves a test that fails if someone
  "simplifies" it away.
- E2E tests (`test/*.e2e-spec.ts`) cover what unit tests cannot see: guards,
  filters, interceptors, route order, and bootstrap wiring.

---

## 20. Tooling and TypeScript

- Prettier: `{ "singleQuote": true, "trailingComma": "all" }`. Run
  `npm run format`; never hand-format against it.
- ESLint: `recommendedTypeChecked` + prettier. `no-explicit-any` and the
  `no-unsafe-*` family are **off** — `any` is allowed at external protocol
  boundaries (webhooks, third-party JSON) and nowhere else, and it is narrowed
  or Zod-parsed before it travels further. `no-floating-promises` is an
  **error**.
- Unused vars are errors unless prefixed `_`; `const { dropped, ...rest }` is
  the idiom for removing a key.
- `strictNullChecks` and `useUnknownInCatchVariables` are on: `catch (err)` is
  `unknown` — pass it through `errorMessage(err)`.
- Prefer `satisfies` over `as` for object literals; a real `as` cast gets a
  comment explaining why it is safe.
- `readonly` on injected deps and on module-level tables.

---

## 21. Definition of done

Before you say a backend task is finished:

1. `npm run lint` and `npx tsc --noEmit` are clean.
2. `npm test` passes. Run `npm run test:e2e` too when you touched `main.ts`,
   `app.module.ts`, a guard, filter, interceptor, or route order.
3. Every new code is in every locale file.
4. Migrations are applied to every environment the project lists, or named as
   pending.
5. Behaviour changes were exercised for real — the endpoint called or the
   script run against a local database — not only unit-tested.
6. New env vars are documented (§12); README tables you changed are updated.
7. Your report says plainly what you did **not** verify and what is pending.

---

## 22. Checklists

### New feature module

1. `src/<feature>/` with `.module.ts`, `.controller.ts`, `.service.ts`, `dto/`,
   `test/`.
2. Prisma model + hand-written migration; add to the soft-delete model list if
   it carries `isDeleted`.
3. `X_SELECT` allowlist + `assertXOwned` private helper.
4. Zod create schema → `.partial()` update schema → list query schema (§10).
5. Success/error codes in every locale.
6. Register the module in `app.module.ts`.
7. Specs: happy path + cross-tenant rejection + each guard.
8. Update the README's layout table and any env-var table you added to.

### New field on an existing model

Schema (+ comment) → migration SQL (+ backfill) → Zod schema → `X_SELECT` if the
client needs it → anything that snapshots or versions the entity → tests.

### New user-facing failure

`AppException('DOMAIN_THING_OUTCOME', meta, status)` → every locale file → a
test asserting the `errorCode` → check whether it needs `blockers`.

### New third-party integration

Read `references/external-services.md`. One provider service → timeouts and
error mapping → credentials resolved per tenant → cost recorded if it is paid
→ inbound callbacks per `references/webhooks.md` → tests with the provider
mocked.

---

## 23. Smells — reject these in review

- A guard, filter, or interceptor duplicated instead of imported.
- A service reading `request` or writing `response`.
- A Prisma query with no `userId` in the `where`, or a `findMany` with no `take`.
- A returned row containing `userId`, `password`, or a raw credential.
- 403 where a 404 hides existence.
- An English string in a `throw` or a response body.
- `bcrypt`, `class-validator`, axios, `console.log` in a service, `any` past a
  protocol boundary.
- `prisma migrate dev` in an instruction or a script.
- A number that appears in two files (a rate, a TTL, a limit).
- A `fetch` with no timeout; a retry loop with no maximum.
- `JSON.parse(x) as T` with no Zod parse after it.
- A network call inside `$transaction`.
- `findFirst` then `create` where a unique constraint should dedupe.
- A log line containing a phone number, email, token, or message body.
- A comment that restates its line — or a non-obvious decision with no comment.
