import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // CORS compares origins as exact strings, so a trailing slash on
  // FRONTEND_URL silently blocks every browser request. Strip it here
  // rather than depend on the env var being typed perfectly.
  const frontend = (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(/[/]+$/, '');

  app.enableCors({
    origin: frontend,
    credentials: true,
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  console.log(`RentalCore API listening on port ${port}`);
  console.log(`CORS origin: ${frontend}`);
}

bootstrap();
