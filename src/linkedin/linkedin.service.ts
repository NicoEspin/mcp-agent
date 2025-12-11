// src/linkedin/linkedin.service.ts
import { Injectable } from '@nestjs/common';
import { LinkedinChatService } from './services/linkedin-chat.service';
import { LinkedinConnectionService } from './services/linkedin-connection.service';

@Injectable()
export class LinkedinService {
  constructor(
    private readonly chat: LinkedinChatService,
    private readonly connection: LinkedinConnectionService,
  ) {}

  readChat(profileUrl: string, limit?: number, threadHint?: string) {
    return this.chat.readChat(profileUrl, limit, threadHint);
  }

  sendMessage(profileUrl: string, message: string) {
    return this.chat.sendMessage(profileUrl, message);
  }

  sendConnection(profileUrl: string, note?: string) {
    return this.connection.sendConnection(profileUrl, note);
  }

  checkConnection(profileUrl: string) {
    return this.connection.checkConnection(profileUrl);
  }
}
