// src/stream/stream.module.ts
import { Module } from '@nestjs/common';
import { PlaywrightMcpModule } from '../mcp/playwright-mcp.module';
import { StreamGateway } from './stream.gateway';
import { StreamService } from './stream.service';

@Module({
  imports: [PlaywrightMcpModule],
  providers: [StreamGateway, StreamService],
  exports: [StreamService], // <- IMPORTANTE
})
export class StreamModule {}
