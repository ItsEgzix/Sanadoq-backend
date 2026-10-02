import type { Prisma } from '../../generated/prisma/client';

// A fund's handful of treasurers and collectors. The cap keeps the list a
// plain array rather than a cursor page.
export const USER_LIST_CAP = 100;

// passwordHash and tokenVersion never leave the server.
export const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { key: true, name: true } },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;
