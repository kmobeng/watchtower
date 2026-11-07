// Must run before any module reads process.env (region config is read at
// import time). Keep this the first import in the file.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  Logger.log(
    `Check worker started for region ${process.env.CHECK_REGION ?? 'local'}`,
    'Bootstrap',
  );
}

void bootstrap();
