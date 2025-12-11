// src/linkedin/linkedin.module.ts
import { Module } from '@nestjs/common';
import { LinkedinController } from './linkedin.controller';
import { LinkedinService } from './linkedin.service';
import { LinkedinAgentService } from './linkedin-agent.service';
import { LinkedinAgentController } from './linkedin-agent.controller';
import { PlaywrightMcpModule } from '../mcp/playwright-mcp.module';
import { LinkedinSessionService } from './session/linkedin-session.service';
import { LinkedinSessionGuard } from './session/linkedin-session.guard';
import { StreamModule } from '../stream/stream.module';
import { LinkedinChatService } from './services/linkedin-chat.service';
import { LinkedinConnectionService } from './services/linkedin-connection.service';

@Module({
  imports: [PlaywrightMcpModule, StreamModule],
  controllers: [LinkedinController, LinkedinAgentController],
  providers: [
    LinkedinService, // fachada
    LinkedinChatService, // nuevo
    LinkedinConnectionService, // nuevo
    LinkedinAgentService,
    LinkedinSessionService,
    LinkedinSessionGuard,
  ],
})
export class LinkedinModule {}
