import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import { EradatYearQueryDto } from '../eradat/dto/eradat-year-query.dto';
import { CreateExpenseLineDto } from './dto/create-expense-line.dto';
import { ExpenseCellParamsDto } from './dto/expense-cell-params.dto';
import { SetExpenseCellDto } from './dto/set-expense-cell.dto';
import { UpdateExpenseLineDto } from './dto/update-expense-line.dto';
import { ExpenseSummaryService } from './expense-summary.service';
import { ExpenseService } from './expense.service';

/**
 * One program's expense sheet. Lines are its beneficiaries and purposes;
 * each cell is one month's payout, set with PUT and emptied with DELETE —
 * both idempotent, so the sheet can retry a save without double-booking.
 * What the program paid to other programs comes back with the sheet, read
 * from those payments; it is changed on the receiving program's books.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId')
export class ExpenseController {
  constructor(
    private readonly expenseService: ExpenseService,
    private readonly summaryService: ExpenseSummaryService,
  ) {}

  @Get('expense-summary')
  async summary(
    @Param('programId') programId: string,
    @Query() query: EradatYearQueryDto,
  ) {
    return this.summaryService.getSummary(programId, query);
  }

  @Get('expense-lines')
  async sheet(
    @Param('programId') programId: string,
    @Query() query: EradatYearQueryDto,
  ) {
    return this.expenseService.getSheet(programId, query);
  }

  @Post('expense-lines')
  async createLine(
    @Param('programId') programId: string,
    @Body() createExpenseLineDto: CreateExpenseLineDto,
  ) {
    return this.expenseService.createLine(programId, createExpenseLineDto);
  }

  @Patch('expense-lines/:lineId')
  async updateLine(
    @Param('programId') programId: string,
    @Param('lineId') lineId: string,
    @Body() updateExpenseLineDto: UpdateExpenseLineDto,
  ) {
    return this.expenseService.updateLine(
      programId,
      lineId,
      updateExpenseLineDto,
    );
  }

  @Delete('expense-lines/:lineId')
  async removeLine(
    @Param('programId') programId: string,
    @Param('lineId') lineId: string,
  ) {
    return this.expenseService.deleteLine(programId, lineId);
  }

  @Put('expense-lines/:lineId/cells/:year/:month')
  async setCell(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: ExpenseCellParamsDto,
    @Body() setExpenseCellDto: SetExpenseCellDto,
  ) {
    return this.expenseService.setCell(user.userId, params, setExpenseCellDto);
  }

  @Delete('expense-lines/:lineId/cells/:year/:month')
  async clearCell(@Param() params: ExpenseCellParamsDto) {
    return this.expenseService.clearCell(params);
  }
}
