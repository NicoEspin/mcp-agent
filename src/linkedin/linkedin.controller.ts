// src/linkedin/linkedin.controller.ts
import { Body, Controller, Post, Get, Query } from '@nestjs/common';
import { LinkedinService } from './linkedin.service';
import { PlaywrightService } from '../browser/playwright.service';
import { LinkedinSessionService } from './session/linkedin-session.service';
import { SendMessageDto } from './dto/send-message.dto';
import { SendConnectionDto } from './dto/send-connection.dto';
import { CheckConnectionDto } from './dto/check-connection.dto';
import { ReadChatDto } from './dto/read-chat.dto';

@Controller('linkedin')
export class LinkedinController {
  constructor(
    private readonly linkedin: LinkedinService,
    private readonly playwright: PlaywrightService,
    private readonly sessionService: LinkedinSessionService,
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
  async checkConnection(@Body() dto: CheckConnectionDto): Promise<boolean> {
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
    await this.playwright.navigate('https://www.linkedin.com/', sessionId);
    return { success: true, url: 'https://www.linkedin.com/', sessionId };
  }

  // -------------------
  // session-state (GET)
  // -------------------
  @Get('session-state')
  async getSessionState(@Query('sessionId') sessionId?: string) {
    const id = sessionId ?? 'default';
    return this.sessionService.checkLoggedIn(id);
  }

  // -------------------
  // stop-session (POST)
  // -------------------
  @Post('stop-session')
  async stopSession(
    @Body()
    body: {
      sessionId?: string;
    },
  ) {
    const sessionId = body?.sessionId ?? 'default';
    return this.playwright.stopSession(sessionId);
  }

  // -------------------
  // sessions (GET)
  // -------------------
  @Get('sessions')
  async listSessions() {
    return this.playwright.listSessions();
  }

  // -------------------
  // launch-session (POST)
  // -------------------
  @Post('launch-session')
  async launchSession(
    @Body()
    body: {
      sessionId: string;
      url?: string;
    },
  ) {
    const url = body.url ?? 'https://www.linkedin.com/';
    await this.playwright.navigate(url, body.sessionId);
    return {
      success: true,
      url,
      sessionId: body.sessionId,
    };
  }

  // -------------------
  // click (POST)
  // -------------------
  @Post('click')
  async click(
    @Body()
    body: {
      sessionId: string;
      x: number;
      y: number;
    },
  ) {
    const code = `
      const rect = document.querySelector('body').getBoundingClientRect();
      const x = ${body.x};
      const y = ${body.y};
      const element = document.elementFromPoint(x, y);
      if (element) {
        element.click();
        return { success: true, element: element.tagName, x, y };
      } else {
        return { success: false, message: 'No element found at coordinates', x, y };
      }
    `;

    const result = await this.playwright.runCode(code, body.sessionId);
    return result;
  }

  // -------------------
  // type (POST)
  // -------------------
  @Post('type')
  async type(
    @Body()
    body: {
      sessionId: string;
      x: number;
      y: number;
      text: string;
    },
  ) {
    const code = `
      const x = ${body.x};
      const y = ${body.y};
      const text = ${JSON.stringify(body.text)};
      const element = document.elementFromPoint(x, y);
      
      if (element) {
        // Focus the element first
        element.focus();
        
        // Clear existing content if it's an input
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          element.value = '';
        } else if (element.contentEditable === 'true') {
          element.textContent = '';
        }
        
        // Type the text
        element.dispatchEvent(new Event('input', { bubbles: true }));
        
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          element.value = text;
        } else if (element.contentEditable === 'true') {
          element.textContent = text;
        }
        
        // Trigger change events
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
        
        return { 
          success: true, 
          element: element.tagName, 
          x, 
          y, 
          text,
          elementType: element.type || 'unknown'
        };
      } else {
        return { success: false, message: 'No element found at coordinates', x, y };
      }
    `;

    const result = await this.playwright.runCode(code, body.sessionId);
    return result;
  }
}
