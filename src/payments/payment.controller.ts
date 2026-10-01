import { Body, Controller, Delete, Param, Post, Put } from '@nestjs/common';
import { PERMISSIONS } from 'src/auth/auth.constant';
import { RequirePermission } from 'src/common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from 'src/common/decorators/current-user.decorator';
import {
  ContributorCellParamsDto,
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
 *   …/cells/contributors/:contributorId/:year/:month  an enrolled contributor
 *   …/cells/programs/:payerProgramId/:year/:month     another program's row
 *
 * Dated ledger — POST …/payments records an entry (idempotent through the
 * form's idempotencyKey), DELETE …/payments/:paymentId removes one.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Put('cells/contributors/:contributorId/:year/:month')
  async setContributorCell(
    @CurrentUser() user: CurrentUserPayload,
    @Param()
    { programId, contributorId, year, month }: ContributorCellParamsDto,
    @Body() setCellDto: SetCellDto,
  ) {
    return this.paymentService.setCell(
      user.userId,
      programId,
      { kind: 'CONTRIBUTOR', contributorId },
      { year, month },
      setCellDto,
    );
  }

  @Delete('cells/contributors/:contributorId/:year/:month')
  async clearContributorCell(
    @Param()
    { programId, contributorId, year, month }: ContributorCellParamsDto,
  ) {
    return this.paymentService.clearCell(
      programId,
      { kind: 'CONTRIBUTOR', contributorId },
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
