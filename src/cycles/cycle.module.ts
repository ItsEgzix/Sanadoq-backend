import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProgramModule } from 'src/programs/program.module';
import { CycleController } from './cycle.controller';
import { CycleService } from './cycle.service';

/**
 * Exports CycleService to PaymentModule (a write must land inside the
 * program's current cycle) and EradatModule (reads open on that cycle).
 */
@Module({
  imports: [PrismaModule, ProgramModule],
  controllers: [CycleController],
  providers: [CycleService],
  exports: [CycleService],
})
export class CycleModule {}
