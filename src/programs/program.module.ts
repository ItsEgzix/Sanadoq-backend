import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramWindowService } from './program-window.service';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';

/**
 * Exports ProgramService to EnrollmentModule, PaymentModule, ExpenseModule
 * and EradatModule — each works inside a program that must exist — and
 * ProgramWindowService to the read sides, which all open on one year.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProgramController],
  providers: [ProgramService, ProgramWindowService],
  exports: [ProgramService, ProgramWindowService],
})
export class ProgramModule {}
