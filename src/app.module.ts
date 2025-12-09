import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PlaywrightMcpModule } from './mcp/playwright-mcp.module';
import { LinkedinModule } from './linkedin/linkedin.module';
import { StreamModule } from './stream/stream.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        path.resolve(process.cwd(), '.env'),     // cuando el repo root es /playwirght
        path.resolve(process.cwd(), '../.env'),  // tu estructura local rara
      ],
    }),
    PlaywrightMcpModule,
    LinkedinModule,
    StreamModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
