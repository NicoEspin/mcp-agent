// src/stream/stream.module.ts
import { Module } from '@nestjs/common';
import { BrowserModule } from '../browser/browser.module';
import { StreamGateway } from './stream.gateway';
import { StreamService } from './stream.service';

@Module({
  imports: [BrowserModule],
  providers: [StreamGateway, StreamService],
  exports: [StreamService], // <- IMPORTANTE
})
export class StreamModule {}
