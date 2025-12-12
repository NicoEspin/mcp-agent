import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/zion');

  app.enableCors({
    origin: [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
      'http://andeshire.com',
      'https://andeshire.com',
      /^http:\/\/localhost:\d+$/,
      /^https:\/\/andeshire\.com$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
