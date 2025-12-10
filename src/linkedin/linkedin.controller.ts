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

  @Post('read-chat')
  async readChat(@Body() dto: ReadChatDto) {
    return this.linkedin.readChat(
      dto.profileUrl,
      dto.limit ?? 30,
      dto.threadHint,
    );
  }

  @Post('send-message')
  async sendMessage(@Body() dto: SendMessageDto) {
    return this.linkedin.sendMessage(dto.profileUrl, dto.message);
  }

  @Post('send-connection')
  async sendConnection(@Body() dto: SendConnectionDto) {
    return this.linkedin.sendConnection(dto.profileUrl, dto.note);
  }

  @Post('check-connection')
  async checkConnection(@Body() dto: CheckConnectionDto): Promise<boolean> {
    return this.linkedin.checkConnection(dto.profileUrl);
  }

  @Post('open')
  async open() {
    // Esto forzará la apertura de Chromium si está en modo headed
    return this.mcp.callTool('browser_navigate', {
      url: 'https://www.linkedin.com/',
    });
  }
}
