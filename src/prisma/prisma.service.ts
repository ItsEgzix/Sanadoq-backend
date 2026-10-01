import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'generated/prisma/client';
import { softDeleteExtension } from './soft-delete.extension';

function createFilteredClient(raw: PrismaClient) {
  return raw.$extends(softDeleteExtension);
}

type FilteredClient = ReturnType<typeof createFilteredClient>;

// Merges with the class below so TypeScript knows an injected PrismaService
// *is* the filtered client (see the constructor). Both lint rules guard
// against accidental merges; this one is the point.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface PrismaService extends FilteredClient {}

/**
 * The app's sole Prisma client, injected everywhere as the soft-delete-
 * filtered instance (see soft-delete.extension.ts) so ordinary reads never
 * need to remember `isDeleted: false`. `raw` is the unfiltered client for the
 * rare read or purge that must see deleted rows — never for a normal read.
 *
 * Connects through the `pg` driver adapter: Prisma 7's client has no built-in
 * engine connection, and the adapter is what reads DATABASE_URL — and
 * DATABASE_SCHEMA, which it uses to qualify every generated query.
 */
@Injectable()
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly raw: PrismaClient;

  constructor(config: ConfigService) {
    this.raw = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: config.getOrThrow<string>('DATABASE_URL') },
        { schema: config.get<string>('DATABASE_SCHEMA') },
      ),
    });

    // Returning an object from a constructor replaces `this`. Nest therefore
    // injects the extended client itself, so `this.prisma.contributor.findMany`
    // is filtered without a hand-written getter per model. `raw` and the
    // lifecycle hooks are copied on so Nest still finds them; the hooks are
    // arrows so they keep running against this original instance.
    return Object.assign(createFilteredClient(this.raw), {
      raw: this.raw,
      onModuleInit: () => this.onModuleInit(),
      onModuleDestroy: () => this.onModuleDestroy(),
    }) as unknown as PrismaService;
  }

  // Connect at boot so a wrong DATABASE_URL fails startup, not the first
  // request a treasurer makes.
  async onModuleInit(): Promise<void> {
    await this.raw.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.raw.$disconnect();
  }
}
