import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// Bootstrap-time defaults, documented in .env.example. 5000 is the frontend
// and 5001 is taken by `prisma dev`, hence 5050.
const DEFAULT_PORT = 5050;
const DEFAULT_CORS_ORIGIN = 'http://localhost:5000';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN,
    // The refresh token travels as a cookie on /auth requests, which the
    // browser only sends — and only lets the page read the answer to — when
    // the API allows credentials for exactly this origin.
    credentials: true,
  });
  // Exactly as many hops as the deployment has, so req.ip — the login
  // throttle's key — is the client, not the proxy. Never a blanket `true`:
  // anyone reaching the app directly could then forge X-Forwarded-For.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  // Lets PrismaService disconnect cleanly on SIGTERM instead of being cut off.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
