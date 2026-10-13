# Third-party APIs, LLM calls, and cost metering

## 1. One service per provider

Every provider has exactly one place that talks to it — a `<provider>.service.ts`
(or a client class behind a registry when there are several of the same kind).
Feature code calls that service; it never builds provider URLs or headers
itself. That one place owns:

- base URL, API version pin, and auth header construction;
- timeouts and retries;
- mapping provider failures to `AppException` codes;
- parsing responses with Zod;
- reporting usage to the cost ledger when the call is paid.

## 2. Timeouts — every call

```ts
const res = await fetch(url, {
  method: 'POST',
  headers,
  body,
  signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
});
```

- No `fetch` without a `signal`. A hung provider otherwise holds a request,
  a connection, and sometimes a live user, indefinitely.
- Timeout values live in one constants file. House defaults, adjusted per
  provider with a comment saying why:

  | Kind of call                                  | Timeout |
  | --------------------------------------------- | ------- |
  | ordinary API request                          | 10 s    |
  | slow endpoint (document parsing, uploads)     | 30 s    |
  | LLM completion                                | 60 s    |

- A timeout surfaces as `<PROVIDER>_TIMEOUT` with status 504.

## 3. Retries — few, bounded, only when safe

- Retry only on a network error, a timeout, `429`, `502`, `503`, or `504`.
  Never on another `4xx` — the request itself is wrong and will fail again.
- Retry only requests that are safe to repeat: reads, or writes that carry an
  idempotency key the provider honours.
- At most **2 retries** (3 attempts), exponential backoff with jitter
  (`500 ms × 2^n + random 0–250 ms`), honouring `Retry-After` up to 10 s.
- One retry helper in `common/`, used by every provider service — not a
  hand-rolled loop per call site.
- Inside a live interaction (a caller on the line), prefer failing fast with a
  spoken or displayed fallback over a retry the user has to wait through.

## 4. Error mapping

- Log the provider's status and error body at `warn` with ids (masked per
  SKILL.md §15). Never pass the provider's message to the user.
- Throw a code the user can act on:

  | Provider outcome                              | Code pattern                          | Status |
  | --------------------------------------------- | ------------------------------------- | ------ |
  | tenant's credential missing                   | `<PROVIDER>_NOT_CONNECTED`            | 400    |
  | tenant's credential rejected (401/403)        | `<PROVIDER>_CREDENTIAL_INVALID`       | 400    |
  | operator key missing from env                 | caught at boot (SKILL.md §12)         | —      |
  | provider error or unparseable response        | `<PROVIDER>_REQUEST_FAILED`           | 502    |
  | provider rate limit after retries             | `<PROVIDER>_RATE_LIMITED`             | 503    |
  | timeout after retries                         | `<PROVIDER>_TIMEOUT`                  | 504    |

- Parse every response with Zod (`.schema.ts`); a shape mismatch is
  `<PROVIDER>_REQUEST_FAILED`, not a `TypeError` three functions later.

## 5. Credentials

- **Operator keys** (the platform's own account) come from env and are
  validated at boot.
- **Tenant credentials** (the user's own account or OAuth token) are resolved
  per call through the credential service, decrypted just in time, and never
  cached in plaintext on a long-lived object or written to a log.
- OAuth refresh happens in one place, before the call, when the token is near
  expiry — not as a reaction scattered across call sites.

## 6. LLM calls

- Every structured completion goes through the project's **one shared
  wrapper**: schema-constrained output, Zod validation of the reply, at most
  one retry on a validation failure, and an `onAttempt` hook for cost.
  Feature code supplies prompt, schema, and post-processing only.
- Prompts live in `.prompt.ts` files as exported functions or constants — not
  inline template literals in a service.
- The model id is resolved through **one resolver** (user choice → env var →
  built-in default). No model string appears at a call site.
- Untrusted text (transcripts, documents, user notes, tool output) goes in the
  user message, clearly delimited — never concatenated into the system prompt
  as if it were instructions.
- Inputs are capped before sending (characters or tokens, from constants);
  a long transcript is truncated or summarised deliberately, not sent whole
  and left to fail.
- Never parse free text with a regex when structured output is available.
- LLM output is untrusted input: validate it, and never use it as a URL, a
  query fragment, or an id without checking it against what the user owns.

## 7. Cost metering

Every paid call records what it cost, and one ledger holds every cost figure
the product shows.

- **One writer.** A single ledger service inserts cost rows; every other module
  calls it. Readers (billing pages, dashboards) only aggregate.
- **Append-only.** A cost row is never updated in place. A correction is a new
  row.
- **Idempotent.** Each row has a unique `sourceKey`; inserts use
  `createMany({ skipDuplicates: true })`, so a retried or raced write is a
  no-op. Keys are deterministic for once-only spend and run-stamped for spend
  that really happens per run (SKILL.md §13).
- **Every billed attempt counts** — including one whose payload later failed
  validation. The tokens were spent.
- **Rates are snapshotted** into the row at write time from the pricing file,
  so a later price change never rewrites history.
- **Money shape**: `Decimal(12, 6)` in one currency, rounded by the pricing
  file's one rounding function (SKILL.md §14).
- A cost builder per kind of spend converts raw usage (tokens, seconds,
  credits) into a ledger entry; the builder is pure and unit-tested.
- A cost-recording failure is logged at `error` and never breaks the user's
  request — but it is never silently swallowed either.

## 8. Tests

- Mock at the provider service, never the network.
- Cover: success, timeout (504 code), retried-then-succeeded, retried-then-failed,
  a 4xx that is not retried, a malformed response, and a missing tenant
  credential.
- For LLM wrappers: validation failure retried once, both attempts billed.
- For cost: the same `sourceKey` twice writes one row; the stored rate matches
  the pricing file at write time.
