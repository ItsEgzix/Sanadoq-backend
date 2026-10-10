import { Controller, Get, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import { EradatYearQueryDto } from '../eradat/dto/eradat-year-query.dto';
import { DashboardService } from './dashboard.service';

/** A program's dashboard: revenue, expenses and balance for one year. */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard')
  async dashboard(
    @Param('programId') programId: string,
    @Query() query: EradatYearQueryDto,
  ) {
    return this.dashboardService.getDashboard(programId, query);
  }
}
