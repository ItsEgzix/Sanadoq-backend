import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AnyAuthenticated,
  Public,
} from '../common/decorators/access.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import {
  LOGIN_THROTTLE,
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
} from './auth.constant';
import { AuthService, type IssuedSession } from './auth.service';
import { readCookie } from './cookie.util';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

/**
 * Sign-in and session upkeep. The only controller that touches cookies: the
 * refresh token goes into an httpOnly cookie scoped to /auth and never
 * appears in a response body; the short-lived access token goes back in the
 * body for the frontend to hold in memory and send as a Bearer header.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Slows password guessing; see LOGIN_THROTTLE.
  @UseGuards(ThrottlerGuard)
  @Throttle(LOGIN_THROTTLE)
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withRefreshCookie(res, await this.authService.login(loginDto));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.refresh(
      readCookie(req.headers.cookie, REFRESH_COOKIE_NAME),
    );
    return this.withRefreshCookie(res, session);
  }

  // Public: signing out must work after the access token has expired, which
  // is exactly when people tend to do it. It authenticates by the cookie.
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.logout(
      readCookie(req.headers.cookie, REFRESH_COOKIE_NAME),
    );
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    return result;
  }

  @AnyAuthenticated()
  @Get('me')
  async me(@CurrentUser() user: CurrentUserPayload) {
    return this.authService.me(user.userId);
  }

  @AnyAuthenticated()
  @Post('password')
  @HttpCode(HttpStatus.OK)
  // Requires the current password, so it is a guessing oracle like login.
  @UseGuards(ThrottlerGuard)
  @Throttle(LOGIN_THROTTLE)
  async changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body() changePasswordDto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withRefreshCookie(
      res,
      await this.authService.changePassword(user.userId, changePasswordDto),
    );
  }

  private withRefreshCookie<T extends IssuedSession>(
    res: Response,
    session: T,
  ) {
    const { refreshToken, ...body } = session;
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    return body;
  }
}
