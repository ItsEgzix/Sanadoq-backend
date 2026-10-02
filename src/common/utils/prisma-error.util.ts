import { Prisma } from '../../../generated/prisma/client';

/**
 * True when a write lost to a unique constraint. Services dedupe by letting
 * the constraint fire and catching it here, rather than reading first — a
 * findFirst followed by create is a race two treasurers can both win.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * True when a write broke a foreign key — most often a delete that lost a
 * race to a write which started referencing the row after the service's
 * "nothing points here" check.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003'
  );
}
