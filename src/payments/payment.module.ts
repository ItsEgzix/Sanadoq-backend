import { Module } from '@nestjs/common';
import { EnrollmentModule } from '../enrollments/enrollment.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramModule } from '../programs/program.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [PrismaModule, ProgramModule, EnrollmentModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
