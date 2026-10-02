import { Controller, Get, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import { EradatYearQueryDto } from './dto/eradat-year-query.dto';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { LinesQueryDto } from './dto/lines-query.dto';
import { EradatLinesService } from './eradat-lines.service';
import { EradatSummaryService } from './eradat-summary.service';

/**
 * Read side of one program's books. Enrollment lines page with a cursor;
 * transfer lines (monthly grids only) come back whole, bounded by the number
 * of programs; ledger entries (dated programs only) page with a cursor.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId')
export class EradatController {
  constructor(
    private readonly summaryService: EradatSummaryService,
    private readonly linesService: EradatLinesService,
  ) {}

  @Get('summary')
  async summary(
    @Param('programId') programId: string,
    @Query() query: EradatYearQueryDto,
  ) {
    return this.summaryService.getSummary(programId, query);
  }

  @Get('lines')
  async lines(
    @Param('programId') programId: string,
    @Query() query: LinesQueryDto,
  ) {
    return this.linesService.getEnrollmentLines(programId, query);
  }

  @Get('transfer-lines')
  async transferLines(
    @Param('programId') programId: string,
    @Query() query: EradatYearQueryDto,
  ) {
    return this.linesService.getTransferLines(programId, query);
  }

  @Get('payments')
  async ledger(
    @Param('programId') programId: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.linesService.getLedger(programId, query);
  }
}
