# Inbound webhooks and provider callbacks

An endpoint a third party calls — payment events, telephony status callbacks,
OAuth redirects, recording-ready notices. The caller is a machine you do not
control, it retries, and its request format is not yours to choose.

## Authentication

- Authenticate with the **provider's signature**, never with a session or JWT.
  The guard sits at class level on a controller that holds only webhook routes.
- Verify with the **tenant's own secret** when each tenant has their own
  provider account: resolve the tenant from the body first (the number called,
  the account id, a stored resource id), then verify with that tenant's secret.
- Rebuild the signed URL from the configured public base URL
  (`API_DOMAIN + request.originalUrl`), not from the `Host` header — behind a
  proxy the host the app sees is not the one the provider signed.
- Any failure — missing signature, unknown tenant, mismatch — returns **one
  uniform 403** with one error code. Saying which part failed tells an attacker
  which numbers or accounts exist.
- Log the rejection at `warn` with the path and the provider's id for the
  event, never the signature or the body.
- The guard attaches the resolved tenant to the request so the handler never
  resolves it a second time.

## Handling

- **Reply fast.** Providers time out in seconds and then retry. Do the minimum
  durable work (record the event, flip a status), return, and push the rest
  into fire-and-forget background work (SKILL.md §13).
- **Idempotent by construction.** The same event arrives more than once and
  out of order. Dedupe on the provider's event id with a unique column, or make
  the transition conditional (`updateMany where status = previous`) so a
  late or repeated event cannot move state backwards.
- **Narrow the body before use.** `body: any` is allowed at this boundary, but
  pick out the fields you need, check their types, and Zod-parse anything that
  travels further than the handler.
- **Never fetch a URL from the body blindly.** A callback that hands you a URL
  (a recording, a file) is checked against the provider's host allowlist
  first; a mismatch is logged and ignored with a 200 so the provider stops
  retrying.
- **Unknown or irrelevant events get a 200**, not an error — an error only
  makes the provider retry something you will never handle.
- Throttle the controller generously but do throttle it: a signature check
  still costs a DB lookup per request.

## Response format

When the provider dictates the response body (XML for a voice provider, plain
text, an empty 200), the route takes `@Res()` and writes the response itself:

```ts
res.type('text/xml');
res.send(twiml.toString());
```

This bypasses the global interceptor, so it is the one place a controller may
wrap its body in try/catch — to map an unexpected throw to an `AppException`
rather than let a half-written response escape. Keep everything else in the
service, as usual.

## Tokens handed to the provider

When the webhook response tells the provider to open a follow-up connection
(a media stream, a redirect), never embed a raw `userId`. Mint a **single-use,
short-lived token** bound to the tenant and the provider's resource id, and
consume it exactly once on the follow-up connection.

## Tests

- Signature: valid passes; missing, wrong tenant, and tampered body all give
  the same 403 and the same code.
- Replay: the same event twice produces one effect.
- Out of order: a late "in progress" after "completed" does not move state
  back.
- A URL from a foreign host is ignored and never fetched.
