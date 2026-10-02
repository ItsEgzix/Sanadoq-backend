import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';

/**
 * Exports ProgramService to CycleModule, EnrollmentModule, PaymentModule and
 * EradatModule — each works inside a program that must exist.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProgramController],
  providers: [ProgramService],
  exports: [ProgramService],
})
export class ProgramModule {}
