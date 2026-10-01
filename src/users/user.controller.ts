import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PERMISSIONS } from 'src/auth/auth.constant';
import { RequirePermission } from 'src/common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from 'src/common/decorators/current-user.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserService } from './user.service';

/** The account list. Managing accounts is part of managing the fund. */
@RequirePermission(PERMISSIONS.MANAGE_FUND)
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async list() {
    return this.userService.listUsers();
  }

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    return this.userService.createUser(createUserDto);
  }

  @Patch(':userId')
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.userService.updateUser(user.userId, userId, updateUserDto);
  }

  @Post(':userId/password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() resetPasswordDto: ResetPasswordDto,
  ) {
    return this.userService.resetPassword(
      user.userId,
      userId,
      resetPasswordDto,
    );
  }
}
