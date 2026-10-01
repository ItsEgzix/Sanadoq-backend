import * as path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AcceptLanguageResolver, I18nModule, QueryResolver } from 'nestjs-i18n';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/guards/auth.guard';
import { validateEnv } from './common/config/env.schema';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { FALLBACK_LOCALE } from './common/utils/translate.util';
import { CycleModule } from './cycles/cycle.module';
import { EnrollmentModule } from './enrollments/enrollment.module';
import { EradatModule } from './eradat/eradat.module';
import { PaymentModule } from './payments/payment.module';
import { ContributorModule } from './contributors/contributor.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProgramModule } from './programs/program.module';
import { UserModule } from './users/user.module';

/**
 * Root module. Every route is behind the global AuthGuard and declares what
 * it needs; the fund's books are one shared ledger for everyone holding
 * MANAGE_FUND, so no query is scoped to the signed-in user — see AuthGuard.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    I18nModule.forRoot({
      fallbackLanguage: FALLBACK_LOCALE,
      loaderOptions: {
        // Copied next to the compiled module by nest-cli.json's assets entry.
        path: path.join(__dirname, 'i18n'),
        watch: process.env.NODE_ENV !== 'production',
      },
      // ?lang= first so the frontend can pin a locale; then the browser's.
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        AcceptLanguageResolver,
      ],
    }),
    PrismaModule,
    AuthModule,
    UserModule,
    ProgramModule,
    CycleModule,
    ContributorModule,
    EnrollmentModule,
    PaymentModule,
    EradatModule,
  ],
  providers: [
    // Every DTO is a nestjs-zod class; this pipe is what runs their schemas
    // on bodies, queries and params.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Runs before the pipe, so an unauthenticated request is refused before
    // its body is even parsed.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
  ],
})
export class AppModule {}
