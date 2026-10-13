# File uploads, downloads, and object storage

## Upload route

```ts
@Post(':folderId/files')
// The limit is enforced while streaming, so an oversized upload is cut off
// before it is buffered into memory.
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE_BYTES } }))
upload(
  @Param('folderId') folderId: string,
  @UploadedFile() file: UploadedFileType,
  @CurrentUser() user: CurrentUserPayload,
) {
  return this.files.upload(user.userId, folderId, file);
}
```

- The size cap is set on the interceptor **and** re-checked in the service with
  a translated code (`X_FILE_TOO_LARGE`). The interceptor stops memory abuse;
  the service check gives the user a real message.
- The service checks, in order: file present → size → type → ownership of the
  parent → store.
- **Type allowlist** by extension, confirmed against the MIME type and, for
  formats that matter, the file's magic bytes. Never a denylist.
- Size limit and allowed types are constants in the feature's
  `.constant.ts`, shared with the frontend's copy only through the API (an
  endpoint or error message), never duplicated by hand.

## Filenames

- Multipart filenames arrive decoded as latin1; non-ASCII names (Arabic,
  Chinese, accents) come through garbled. Repair them with the shared filename
  util before they reach the DB, the storage path, or a third party.
- The client's filename is **display data only**. It never becomes part of a
  filesystem or storage path unsanitised.

## Storage

- Raw uploaded bytes live in object storage and are the durable source of
  truth — anything derived (parsed text, chunks, embeddings, thumbnails) can be
  rebuilt from them.
- One function builds every storage path, and every path starts with the owner:
  `<userId>/<parentId>/<fileId>-<safeName>`. No other code concatenates paths.
- The storage client uses the service-role credential, so the backend is the
  only gatekeeper — every read and write is preceded by an ownership check.
- Create the DB row first with status `PENDING`, upload, then set the path and
  status; a failure in between leaves a row that can be retried or cleaned up,
  never an orphaned object nobody can find.
- Heavy processing runs as background work with a status state machine the UI
  polls (SKILL.md §13).

## Downloads

- Serve through an ownership-checked route that either streams the object or
  returns a **short-lived signed URL** (minutes, not days).
- Never return a permanent public URL for a user's file.
- Set `Content-Disposition` with the repaired filename, encoded per RFC 5987,
  so non-ASCII names download correctly.

## Deletion

- Soft-deleting the row keeps the object; the hard delete (a "forget me"
  purge, a retention job) removes the object **and** every derived copy —
  list them in the method's comment.
- Deleting the object and the row is ordered so a failure leaves something
  retryable: delete derived data, then the object, then the row.

## Tests

- Empty file, oversized file, wrong type, and someone else's parent id each give
  their code and store nothing.
- A non-ASCII filename survives the round trip.
- The storage path always starts with the owner's id.
