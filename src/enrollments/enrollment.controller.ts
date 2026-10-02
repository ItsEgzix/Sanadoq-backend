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
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { ListEnrollmentsQueryDto } from './dto/list-enrollments-query.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { EnrollmentService } from './enrollment.service';

/**
 * One program's enrollments. Reactivation, rate changes and collector
 * assignment are deliberately not routed — see the pending section of
 * EnrollmentService.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs/:programId/enrollments')
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  @Get()
  async list(
    @Param('programId') programId: string,
    @Query() query: ListEnrollmentsQueryDto,
  ) {
    return this.enrollmentService.listEnrollments(programId, query);
  }

  @Post()
  async create(
    @Param('programId') programId: string,
    @Body() createEnrollmentDto: CreateEnrollmentDto,
  ) {
    return this.enrollmentService.createEnrollment(
      programId,
      createEnrollmentDto,
    );
  }

  @Patch(':enrollmentId')
  async update(
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() updateEnrollmentDto: UpdateEnrollmentDto,
  ) {
    return this.enrollmentService.updateEnrollment(
      programId,
      enrollmentId,
      updateEnrollmentDto,
    );
  }

  @Post(':enrollmentId/mark-dormant')
  async markDormant(
    @Param('programId') programId: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollmentService.markEnrollmentDormant(
      programId,
      enrollmentId,
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
