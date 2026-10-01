import { Body, Controller, Delete, Param, Post, Put } from '@nestjs/common';
import { PERMISSIONS } from 'src/auth/auth.constant';
import { RequirePermission } from 'src/common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from 'src/common/decorators/current-user.decorator';
import {
  PersonCellParamsDto,
  ProgramCellParamsDto,
} from './dto/cell-params.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { SetCellDto } from './dto/set-cell.dto';
import { PaymentService } from './payment.service';

/**
 * Writes into one program's books.
 *
 * Monthly grid — one cell per URL, PUT sets it (amount or ★), DELETE empties
 * it; both idempotent, so the grid can retry a save without double-booking:
 *   …/cells/people/:personId/:year/:month          an enrolled person's row
 *   …/cells/programs/:payerProgramId/:year/:month  another program's row
 *
 * Dated ledger — POST …/payments records an entry (idempotent through the
 * form's idempotencyKey), DELETE …/payments/:paymentId removes one.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Put('cells/people/:personId/:year/:month')
  async setPersonCell(
    @CurrentUser() user: CurrentUserPayload,
    @Param() { programId, personId, year, month }: PersonCellParamsDto,
    @Body() setCellDto: SetCellDto,
  ) {
    return this.paymentService.setCell(
      user.userId,
      programId,
      { kind: 'PERSON', personId },
      { year, month },
      setCellDto,
    );
  }

  @Delete('cells/people/:personId/:year/:month')
  async clearPersonCell(
    @Param() { programId, personId, year, month }: PersonCellParamsDto,
  ) {
    return this.paymentService.clearCell(
      programId,
      { kind: 'PERSON', personId },
      { year, month },
    );
  }

  @Put('cells/programs/:payerProgramId/:year/:month')
  async setProgramCell(
    @CurrentUser() user: CurrentUserPayload,
    @Param() { programId, payerProgramId, year, month }: ProgramCellParamsDto,
    @Body() setCellDto: SetCellDto,
  ) {
    return this.paymentService.setCell(
      user.userId,
      programId,
      { kind: 'PROGRAM', programId: payerProgramId },
      { year, month },
      setCellDto,
    );
  }

  @Delete('cells/programs/:payerProgramId/:year/:month')
  async clearProgramCell(
    @Param() { programId, payerProgramId, year, month }: ProgramCellParamsDto,
  ) {
    return this.paymentService.clearCell(
      programId,
      { kind: 'PROGRAM', programId: payerProgramId },
      { year, month },
    );
  }

  @Post('payments')
  async record(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Body() recordPaymentDto: RecordPaymentDto,
  ) {
    return this.paymentService.recordPayment(
      user.userId,
      programId,
      recordPaymentDto,
    );
  }

  @Delete('payments/:paymentId')
  async remove(
    @Param('programId') programId: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.paymentService.deletePayment(programId, paymentId);
  }
}
