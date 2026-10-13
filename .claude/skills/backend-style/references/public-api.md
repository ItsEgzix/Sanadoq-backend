# Public API — endpoints authenticated by API key

The public API is a separate surface for machines (customers' scripts,
integrations), with its own module, auth, limits, and compatibility promise.

## Shape

- Its own module (`public-api/`) and a versioned prefix: `@Controller('v1/...')`.
  The app's internal routes never double as public ones.
- The controller calls **existing domain services** — the public API adds no
  business logic of its own, only a narrower, stable projection of it.
- Responses use their own `select` allowlists, separate from the internal
  ones, so an internal field added for the frontend never leaks into a public
  contract.
- Same error envelope and codes as the internal API; same locale handling.

## Keys

- `ApiKeyGuard` reads the key from `Authorization: Bearer <key>` (or one
  documented header), hashes it with `sha256`, and looks up the hash. The raw
  key is shown once at creation and never stored.
- Keys carry a short visible prefix (`sk_live_…`) and the last four characters
  are stored separately for display.
- The guard attaches the same `request.user = { userId }` shape as JWT, so
  `@CurrentUser()` and every service work unchanged.
- Revoked or expired keys fail with the same 401 code as unknown keys.
- Record `lastUsedAt` on the key, throttled (at most once a minute) so every
  request is not a write.

## Limits

- Rate-limit **per key**, not per IP (a customer's servers share IPs; attackers
  rotate them). A per-key throttler guard sits beside `ApiKeyGuard`.
- The limit is a named constant with a comment on who it protects.
- List endpoints follow SKILL.md §10 with the same `max(100)` cap.

## Compatibility promise

Once a `v1` endpoint ships, other people's code depends on it.

- Allowed in place: adding an optional request field, adding a response field,
  adding an endpoint, adding an error code.
- Not allowed in place: removing or renaming a field, changing a type or an
  enum value, making an optional field required, changing a status code or a
  pagination shape. Those need `v2` beside `v1`.
- Every public endpoint is listed in one document (README section or
  `PUBLIC_API.md`) with request, response, and error codes; update it in the
  same commit as the endpoint.

## Tests

- No key, malformed key, revoked key → one 401 code.
- Another tenant's resource id → 404.
- Throttle: the (limit + 1)th request in the window → 429.
- The response contains exactly the public fields — a test that fails when an
  internal field leaks in.
