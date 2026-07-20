// src/main.ts
//
// `rawBody: true` + the NestExpressApplication type is the documented
// NestJS mechanism for preserving the unparsed request body, which
// PaymentWebhooksController depends on for every provider's signature
// verification (req.rawBody, populated automatically once this is set).
// Confirmed against NestJS's own raw-body documentation — this is not
// the older manual bodyParser-with-verify-callback workaround seen in
// some blog posts, which is unnecessary as of current NestJS versions.

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.enableCors();

  // Global validation for every DTO decorated with class-validator
  // (RegisterDto, LoginDto, etc.) — whitelist strips unknown fields
  // instead of erroring on them, forbidNonWhitelisted would reject the
  // request outright; whitelist-only is the friendlier default for a
  // frontend that's still evolving alongside this API.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  console.log(`Rental SaaS backend listening on port ${port}`);
}

bootstrap();
