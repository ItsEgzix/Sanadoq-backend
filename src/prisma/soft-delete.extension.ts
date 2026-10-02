import { Prisma } from '../../generated/prisma/client';

/**
 * Models whose rows are soft-deleted. A model that gains `isDeleted` joins
 * this list in the same commit, or its "deleted" rows keep appearing in every
 * list and total.
 */
export const SOFT_DELETE_MODELS: ReadonlySet<Prisma.ModelName> =
  new Set<Prisma.ModelName>(['Contributor', 'Program']);

// findUnique is absent on purpose: its `where` only accepts unique fields, so
// `isDeleted` cannot be injected. Use findFirst for anything that must skip
// deleted rows.
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Injects `isDeleted: false` into reads on the soft-delete models. Passing
 * `isDeleted` explicitly in a `where` is the per-query opt-out. Relation
 * filters (`program: { isDeleted: false }` from ProgramEnrollment) are not
 * rewritten — Prisma gives an extension no hook into nested filters — so
 * queries that reach a soft-deleted model through a relation say it themselves.
 * Writes (update, updateMany) are never filtered: a conditional write that
 * must skip deleted rows names `isDeleted: false` itself.
 */
export const softDeleteExtension = Prisma.defineExtension({
  name: 'soft-delete',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (
          !SOFT_DELETE_MODELS.has(model) ||
          !FILTERED_OPERATIONS.has(operation)
        ) {
          return query(args);
        }
        // `args` is the union of every operation's argument type; every
        // operation in FILTERED_OPERATIONS takes an optional object `where`.
        const { where } = args as { where?: Record<string, unknown> };
        if (where && 'isDeleted' in where) return query(args);
        return query({ ...args, where: { ...where, isDeleted: false } });
      },
    },
  },
});
