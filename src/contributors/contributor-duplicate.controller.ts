import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from 'src/auth/auth.constant';
import { RequirePermission } from 'src/common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from 'src/common/decorators/current-user.decorator';
import { ListDuplicatesQueryDto } from './dto/list-duplicates-query.dto';
import { MergeDuplicateDto } from './dto/merge-duplicate.dto';
import { ContributorDuplicateService } from './contributor-duplicate.service';

/**
 * The duplicate review queue. Merge and dismiss are the only ways a flag is
 * resolved, and both are a reviewer's explicit decision.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('contributors/duplicates')
export class ContributorDuplicateController {
  constructor(private readonly duplicateService: ContributorDuplicateService) {}

  @Get()
  async list(@Query() query: ListDuplicatesQueryDto) {
    return this.duplicateService.listFlags(query);
  }

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async scan() {
    return this.duplicateService.scanAll();
  }

  @Post(':flagId/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(
    @CurrentUser() user: CurrentUserPayload,
    @Param('flagId') flagId: string,
  ) {
    return this.duplicateService.dismissFlag(user.userId, flagId);
  }

  @Post(':flagId/merge')
  @HttpCode(HttpStatus.OK)
  async merge(
    @CurrentUser() user: CurrentUserPayload,
    @Param('flagId') flagId: string,
    @Body() mergeDuplicateDto: MergeDuplicateDto,
  ) {
    return this.duplicateService.mergeFlag(
      user.userId,
      flagId,
      mergeDuplicateDto,
    );
  }
}
