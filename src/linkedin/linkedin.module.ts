import { Module } from '@nestjs/common';
import { LinkedinController } from './linkedin.controller';
import { LinkedinService } from './linkedin.service';
import { PlaywrightMcpModule } from '../mcp/playwright-mcp.module';
import { LinkedinSessionService } from './session/linkedin-session.service';
import { LinkedinSessionGuard } from './session/linkedin-session.guard';
import { StreamModule } from 'src/stream/stream.module';

@Module({
  imports: [PlaywrightMcpModule, StreamModule],
  controllers: [LinkedinController],
  providers: [LinkedinService, LinkedinSessionService, LinkedinSessionGuard],
})
export class LinkedinModule {}
