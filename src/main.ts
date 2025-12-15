import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/zion');

  const allowList: (string | RegExp)[] = [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'http://andeshire.com',
    'https://andeshire.com',
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^https:\/\/andeshire\.com$/,
  ];

  app.enableCors({
    origin: (origin, cb) => {
      // origin puede venir undefined en llamadas server-to-server o algunas tools
      if (!origin) return cb(null, true);

      const ok = allowList.some((rule) =>
        typeof rule === 'string' ? rule === origin : rule.test(origin),
      );

      return ok
        ? cb(null, true)
        : cb(new Error(`CORS blocked: ${origin}`), false);
    },
    credentials: true, // ✅ CLAVE si usás fetch(..., { credentials: 'include' })
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    optionsSuccessStatus: 204,
  });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
