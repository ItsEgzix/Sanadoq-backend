import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ContributorDuplicateController } from './contributor-duplicate.controller';
import { ContributorDuplicateService } from './contributor-duplicate.service';
import { ContributorController } from './contributor.controller';
import { ContributorService } from './contributor.service';

/**
 * Exports ContributorService to EnrollmentModule (enrolling an existing
 * contributor, or creating one in the same step).
 */
@Module({
  imports: [PrismaModule],
  // ContributorDuplicateController first: Nest registers routes in this order,
  // and GET /contributors/duplicates must be matched before
  // ContributorController's GET /contributors/:contributorId would take
  // "duplicates" as a contributor id.
  controllers: [ContributorDuplicateController, ContributorController],
  providers: [ContributorService, ContributorDuplicateService],
  exports: [ContributorService],
})
export class ContributorModule {}
