import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so every feature module gets PrismaService without importing this
 * module; feature modules still list it in `imports` out of habit, which is
 * harmless.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
