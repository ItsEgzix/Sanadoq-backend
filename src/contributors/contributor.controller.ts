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
import { CreateContributorDto } from './dto/create-contributor.dto';
import { ListContributorsQueryDto } from './dto/list-contributors-query.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';
import { ContributorService } from './contributor.service';

/** The contributors directory, across every program. */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('contributors')
export class ContributorController {
  constructor(private readonly contributorService: ContributorService) {}

  @Get()
  async list(@Query() query: ListContributorsQueryDto) {
    return this.contributorService.listContributors(query);
  }

  // Ahead of ':contributorId' on purpose: Nest matches in declaration order,
  // and "stats" would otherwise be read as a contributor id.
  @Get('stats')
  async stats() {
    return this.contributorService.getDirectoryStats();
  }

  @Get(':contributorId')
  async get(@Param('contributorId') contributorId: string) {
    return this.contributorService.getContributor(contributorId);
  }

  @Post()
  async create(@Body() createContributorDto: CreateContributorDto) {
    return this.contributorService.createContributor(createContributorDto);
  }

  @Patch(':contributorId')
  async update(
    @Param('contributorId') contributorId: string,
    @Body() updateContributorDto: UpdateContributorDto,
  ) {
    return this.contributorService.updateContributor(
      contributorId,
      updateContributorDto,
    );
  }

  @Delete(':contributorId')
  async remove(@Param('contributorId') contributorId: string) {
    return this.contributorService.deleteContributor(contributorId);
  }
}
