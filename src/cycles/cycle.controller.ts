import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import { CycleService } from './cycle.service';
import { CreateCycleDto } from './dto/create-cycle.dto';
import { UpdateCycleDto } from './dto/update-cycle.dto';

/**
 * One program's cycles: list them, read the current one, create, reshape
 * (start year / length) and switch which one is current. Programs without
 * cycles answer PROGRAM_HAS_NO_CYCLES.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId/cycles')
export class CycleController {
  constructor(private readonly cycleService: CycleService) {}

  @Get()
  async list(@Param('programId') programId: string) {
    return this.cycleService.listCycles(programId);
  }

  // Declared before ':cycleId' routes — Nest matches in declaration order, and
  // although no GET ':cycleId' exists today, adding one must not swallow this.
  @Get('current')
  async current(@Param('programId') programId: string) {
    return this.cycleService.getCurrentCycle(programId);
  }

  @Post()
  async create(
    @Param('programId') programId: string,
    @Body() createCycleDto: CreateCycleDto,
  ) {
    return this.cycleService.createCycle(programId, createCycleDto);
  }

  @Patch(':cycleId')
  async update(
    @Param('programId') programId: string,
    @Param('cycleId') cycleId: string,
    @Body() updateCycleDto: UpdateCycleDto,
  ) {
    return this.cycleService.updateCycle(programId, cycleId, updateCycleDto);
  }

  @Post(':cycleId/activate')
  async activate(
    @Param('programId') programId: string,
    @Param('cycleId') cycleId: string,
  ) {
    return this.cycleService.activateCycle(programId, cycleId);
  }
}
