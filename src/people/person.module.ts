import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PersonDuplicateController } from './person-duplicate.controller';
import { PersonDuplicateService } from './person-duplicate.service';
import { PersonController } from './person.controller';
import { PersonService } from './person.service';

/**
 * Exports PersonService to EnrollmentModule (enrolling an existing person,
 * or creating one in the same step).
 */
@Module({
  imports: [PrismaModule],
  // PersonDuplicateController first: Nest registers routes in this order, and
  // GET /people/duplicates must be matched before PersonController's
  // GET /people/:personId would take "duplicates" as a person id.
  controllers: [PersonDuplicateController, PersonController],
  providers: [PersonService, PersonDuplicateService],
  exports: [PersonService],
})
export class PersonModule {}
