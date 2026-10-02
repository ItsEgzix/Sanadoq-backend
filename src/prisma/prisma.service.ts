import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { errorMessage } from '../common/utils/error.util';
import { softDeleteExtension } from './soft-delete.extension';

// Pool settings for a database across the internet (Neon), where opening a
// connection — TCP, TLS, startup, SCRAM — costs several round trips, about
// 2 s from the dev machine against ~190 ms for one query.
//
// pg's defaults are tuned for a database next door. Its 10 s idle timeout
// made a treasurer who paused to read the grid pay a full reconnect on the
// next click (measured: 3 s instead of 0.7 s for a summary). Five minutes
// matches Neon's default auto-suspend; past it the compute is likely asleep
// and the connection dead anyway.
const POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// One summary fans out ~10 queries at once and a page load fires five
// endpoints together. At pg's default of 10 the rest queue a full round trip
// behind. Neon's pooled endpoint multiplexes client connections onto a few
// server ones, so 20 is cheap.
const POOL_MAX_CONNECTIONS = 20;
// pg waits forever by default; a compute that never wakes, or a network that
// is gone, fails the request instead of holding it open.
const POOL_CONNECT_TIMEOUT_MS = 15_000;

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
        {
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: POOL_MAX_CONNECTIONS,
          idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
          // Connections now sit idle for minutes; without keepalive a home
          // router or NAT can drop one silently, and the next query on it
          // hangs until the OS gives up instead of failing fast.
          keepAlive: true,
        },
        {
          schema: config.get<string>('DATABASE_SCHEMA'),
          // Neon closes idle connections when its compute suspends. The pool
          // discards them and opens fresh ones on demand; worth a line in the
          // log, not an error.
          onPoolError: (err) =>
            this.logger.warn(
              `Idle database connection closed: ${errorMessage(err)}`,
            ),
        },
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
