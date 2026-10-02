import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PERMISSIONS } from '../auth/auth.constant';
import { RequirePermission } from '../common/decorators/access.decorator';
import { CreateProgramDto } from './dto/create-program.dto';
import { UpdateProgramDto } from './dto/update-program.dto';
import { ProgramService } from './program.service';

/**
 * HTTP surface for programs. Everything inside a program — cycles,
 * enrollments, payments, the summary — hangs off /programs/:programId in its
 * own module's controller.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('programs')
export class ProgramController {
  constructor(private readonly programService: ProgramService) {}

  @Get()
  async list() {
    return this.programService.listPrograms();
  }

  @Get(':programId')
  async get(@Param('programId') programId: string) {
    return this.programService.getProgram(programId);
  }

  @Post()
  async create(@Body() createProgramDto: CreateProgramDto) {
    return this.programService.createProgram(createProgramDto);
  }

  @Patch(':programId')
  async update(
    @Param('programId') programId: string,
    @Body() updateProgramDto: UpdateProgramDto,
  ) {
    return this.programService.updateProgram(programId, updateProgramDto);
  }

  @Delete(':programId')
  async remove(@Param('programId') programId: string) {
    return this.programService.deleteProgram(programId);
  }
}
