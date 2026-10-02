import { HttpStatus } from '@nestjs/common';
import { AppException } from '../exceptions/app.exception';

/** Something that still points at a record a caller asked to remove. */
export interface Blocker {
  kind: 'PROGRAM';
  id: string;
  name: string;
}

/**
 * The 409 for "still in use". `details.blockers` is the one piece of meta the
 * exception filter passes through in production — the UI needs it to link
 * straight to what must be detached first. `names` feeds the message.
 */
export function assertNoBlockers(code: string, blockers: Blocker[]): void {
  if (blockers.length === 0) return;
  throw new AppException(
    code,
    {
      details: { blockers },
      names: blockers.map((blocker) => blocker.name).join(', '),
    },
    HttpStatus.CONFLICT,
  );
}
