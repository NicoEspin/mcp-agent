// src/linkedin/linkedin.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { LinkedinService } from './linkedin.service';
import { PlaywrightMcpService } from '../mcp/playwright-mcp.service';
import { SendMessageDto } from './dto/send-message.dto';
import { SendConnectionDto } from './dto/send-connection.dto';
import { CheckConnectionDto } from './dto/check-connection.dto';
import { ReadChatDto } from './dto/read-chat.dto';

@Controller('linkedin')
export class LinkedinController {
  constructor(
    private readonly linkedin: LinkedinService,
    private readonly mcp: PlaywrightMcpService,
  ) {}

  // -------------------
  // read-chat (POST)
  // -------------------
  @Post('read-chat')
  async readChat(@Body() dto: ReadChatDto) {
    const sessionId = dto.sessionId ?? 'default';

    return this.linkedin.readChat(
      sessionId,
      dto.profileUrl,
      dto.limit ?? 30,
      dto.threadHint,
    );
  }

  // -------------------
  // send-message (POST)
  // -------------------
  @Post('send-message')
  async sendMessage(@Body() dto: SendMessageDto) {
    const sessionId = dto.sessionId ?? 'default';

    return this.linkedin.sendMessage(sessionId, dto.profileUrl, dto.message);
  }

  // -------------------
  // send-connection (POST)
  // -------------------
  @Post('send-connection')
  async sendConnection(@Body() dto: SendConnectionDto) {
    const sessionId = dto.sessionId ?? 'default';

    return this.linkedin.sendConnection(sessionId, dto.profileUrl, dto.note);
  }

  // -------------------
  // check-connection (POST)
  // -------------------
  @Post('check-connection')
  async checkConnection(
    @Body() dto: CheckConnectionDto,
  ): Promise<boolean> {
    const sessionId = dto.sessionId ?? 'default';

    return this.linkedin.checkConnection(sessionId, dto.profileUrl);
  }

  // -------------------
  // open (POST)
  // -------------------
  @Post('open')
  async open(
    @Body()
    body?: {
      sessionId?: string;
    },
  ) {
    const sessionId = body?.sessionId ?? 'default';

    // Esto forzará la apertura de Chromium si está en modo headed
    return this.mcp.callTool(sessionId, 'browser_navigate', {
      url: 'https://www.linkedin.com/',
    });
  }
}
