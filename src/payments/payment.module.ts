import { Module } from '@nestjs/common';
import { CycleModule } from '../cycles/cycle.module';
import { EnrollmentModule } from '../enrollments/enrollment.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [PrismaModule, CycleModule, EnrollmentModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
