// src/linkedin/linkedin.module.ts
import { Module } from '@nestjs/common';
import { LinkedinController } from './linkedin.controller';
import { LinkedinService } from './linkedin.service';

// import { LinkedinAgentController } from './linkedin-agent.controller';
import { BrowserModule } from '../browser/browser.module';
import { LinkedinSessionService } from './session/linkedin-session.service';
import { LinkedinSessionGuard } from './session/linkedin-session.guard';
import { StreamModule } from '../stream/stream.module';
import { LinkedinChatService } from './services/linkedin-chat.service';
import { LinkedinConnectionService } from './services/linkedin-connection.service';
import { LinkedinActionVerifierService } from './services/linkedin-action-verifier.service';
import { LinkedinSalesNavigatorService } from './services/linkedin-sales-navigator.service';
import { LinkedinSalesNavigatorChatService } from './services/linkedin-sales-navigator-chat.service';
import { LinkedinSalesNavigatorConnectionService } from './services/linkedin-sales-navigator-connection.service';

@Module({
  imports: [BrowserModule, StreamModule],
  controllers: [LinkedinController],
  providers: [
    LinkedinService, // fachada
    LinkedinChatService, // nuevo
    LinkedinConnectionService, // nuevo
    LinkedinSessionService,
    LinkedinSessionGuard,
    LinkedinActionVerifierService,
    LinkedinSalesNavigatorService,
    LinkedinSalesNavigatorChatService,
    LinkedinSalesNavigatorConnectionService,
  ],
})
export class LinkedinModule {}
