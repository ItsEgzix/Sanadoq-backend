import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { ListEnrollmentsQueryDto } from './dto/list-enrollments-query.dto';
import { RateChangeDto } from './dto/rate-change.dto';
import { TermChangeDto } from './dto/term-change.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { EnrollmentTermService } from './enrollment-term.service';
import { EnrollmentService } from './enrollment.service';

/**
 * One program's enrollments, and each subscription's dated history: every
 * change after joining — dormant, reactivated, a new pledge — starts from a
 * month and is kept as a term. Collector assignment is deliberately not
 * routed — see the pending section of EnrollmentService.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId/enrollments')
export class EnrollmentController {
  constructor(
    private readonly enrollmentService: EnrollmentService,
    private readonly termService: EnrollmentTermService,
  ) {}

  @Get()
  async list(
    @Param('programId') programId: string,
    @Query() query: ListEnrollmentsQueryDto,
  ) {
    return this.enrollmentService.listEnrollments(programId, query);
  }

  @Post()
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Body() createEnrollmentDto: CreateEnrollmentDto,
  ) {
    return this.enrollmentService.createEnrollment(
      user.userId,
      programId,
      createEnrollmentDto,
    );
  }

  @Get(':enrollmentId/terms')
  async terms(
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.termService.listTerms(programId, enrollmentId);
  }

  @Patch(':enrollmentId')
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() updateEnrollmentDto: UpdateEnrollmentDto,
  ) {
    return this.enrollmentService.updateEnrollment(
      user.userId,
      programId,
      enrollmentId,
      updateEnrollmentDto,
    );
  }

  @Post(':enrollmentId/mark-dormant')
  async markDormant(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() termChangeDto: TermChangeDto,
  ) {
    return this.termService.markDormant(
      user.userId,
      programId,
      enrollmentId,
      termChangeDto,
    );
  }

  @Post(':enrollmentId/reactivate')
  async reactivate(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() termChangeDto: TermChangeDto,
  ) {
    return this.termService.reactivate(
      user.userId,
      programId,
      enrollmentId,
      termChangeDto,
    );
  }

  @Post(':enrollmentId/rate-changes')
  async changeRate(
    @CurrentUser() user: CurrentUserPayload,
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() rateChangeDto: RateChangeDto,
  ) {
    return this.termService.changeRate(
      user.userId,
      programId,
      enrollmentId,
      rateChangeDto,
    );
  }

  @Delete(':enrollmentId')
  async remove(
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollmentService.removeEnrollment(programId, enrollmentId);
  }
}
