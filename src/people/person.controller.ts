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
import { PERMISSIONS } from 'src/auth/auth.constant';
import { RequirePermission } from 'src/common/decorators/access.decorator';
import { CreatePersonDto } from './dto/create-person.dto';
import { ListPeopleQueryDto } from './dto/list-people-query.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import { PersonService } from './person.service';

/** The people directory, across every program. */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('people')
export class PersonController {
  constructor(private readonly personService: PersonService) {}

  @Get()
  async list(@Query() query: ListPeopleQueryDto) {
    return this.personService.listPeople(query);
  }

  @Get(':personId')
  async get(@Param('personId') personId: string) {
    return this.personService.getPerson(personId);
  }

  @Post()
  async create(@Body() createPersonDto: CreatePersonDto) {
    return this.personService.createPerson(createPersonDto);
  }

  @Patch(':personId')
  async update(
    @Param('personId') personId: string,
    @Body() updatePersonDto: UpdatePersonDto,
  ) {
    return this.personService.updatePerson(personId, updatePersonDto);
  }

  @Delete(':personId')
  async remove(@Param('personId') personId: string) {
    return this.personService.deletePerson(personId);
  }
}
