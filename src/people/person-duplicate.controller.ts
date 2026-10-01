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
import { PersonDuplicateService } from './person-duplicate.service';

/**
 * The duplicate review queue. Merge and dismiss are the only ways a flag is
 * resolved, and both are a person's explicit decision.
 */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('people/duplicates')
export class PersonDuplicateController {
  constructor(private readonly duplicateService: PersonDuplicateService) {}

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
