# WebSocket gateways and long-lived connections

Gateways use raw `ws` through Nest's `WsAdapter` (set once in `main.ts`), one
`@WebSocketGateway({ path: '/<name>-stream' })` per surface, in a
`<feature>.gateway.ts` file.

## Authentication — in the handshake

- Browsers cannot set headers on a WebSocket, so the credential arrives as a
  query parameter: a short-lived access token (`?token=`) for app users, or a
  single-use ticket for machine callers. Never a raw `userId`.
- `handleConnection` verifies it before anything else, then applies the same
  ownership rule as HTTP: the resource named in the handshake (`?callId=`) must
  belong to the verified user.
- Failure sends one message and closes:

  ```ts
  private closeWithError(client: WebSocket, code: string): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'error', code }));
    }
    client.close();
  }
  ```

  Codes are stable `snake_case` strings (`missing_params`, `invalid_token`,
  `not_found`, `forbidden`) the frontend switches on. Like HTTP, prefer
  `not_found` over `forbidden` when the resource belongs to someone else.
- Tokens are not in logs; a query string is part of the request URL, so log
  the path only.

## Messages — validate every one

Every inbound message is untrusted input:

```ts
// inbound-message.schema.ts
export const inboundMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), agentId: z.string().uuid().optional() }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('end') }),
]);
```

```ts
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  return this.send(client, { type: 'error', code: 'parse_error' });
}
const result = inboundMessageSchema.safeParse(parsed);
if (!result.success) {
  return this.send(client, { type: 'error', code: 'invalid_message' });
}
```

- `JSON.parse(raw) as T` is not validation.
- Set `maxPayload` on the gateway options so one message cannot be arbitrarily
  large.
- A message handler never throws out: an exception in a `ws` listener is
  unhandled. Wrap the handler body, log with ids, and send an error code.
- Outbound messages are typed with a discriminated union in a `.types.ts`, the
  same way.

## State and teardown

- Per-connection state lives in a `Map<WebSocket, Session>` on the gateway, or
  in a registry service when other modules need it.
- Everything a session allocates — timers, upstream sockets, buffers — is
  released in one `finalize` path, called from `handleDisconnect`, from an
  explicit "end" message, and from the upstream socket closing. `finalize` is
  safe to call twice (SKILL.md §13).
- Work that must happen once at the end (persisting a transcript, recording
  cost) runs in `finalize` behind the once-only guard, with `void … .catch`.
- The file's JSDoc says that the state is in-memory and therefore
  single-instance, and names what would have to move to a shared store to run
  two instances.

## Relaying to an upstream socket

When a gateway bridges the client to another service's socket (a speech or
model API):

- Open the upstream with a timeout on the connect, and close the client with a
  code if it never opens.
- Queue or drop client messages that arrive before the upstream is ready —
  decide which, and say so in a comment.
- Close the other side when either side closes, and record why it closed.

## Tests

- Handshake: no token, bad token, someone else's resource → the right code and
  a closed socket.
- A malformed and an oversized message get an error code, not a crash.
- `finalize` twice has one effect; timers are cleared (use Jest fake timers).
