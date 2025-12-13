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
  async checkConnection(
    @Body() dto: CheckConnectionDto,
  ): Promise<any> {
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
    const startTime = Date.now();
    const targetUrl = 'https://www.linkedin.com/';

    const verboseResult = {
      success: true,
      url: targetUrl,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_navigate',
        browserType: 'chromium',
        steps: [] as string[],
        errors: [] as any[]
      }
    };

    try {
      verboseResult.executionDetails.steps.push(`Starting LinkedIn open for session: ${sessionId}`);
      verboseResult.executionDetails.steps.push(`Target URL: ${targetUrl}`);
      verboseResult.executionDetails.steps.push('Initiating Playwright navigation (will force Chromium open if in headed mode)');

      // Esto forzará la apertura de Chromium si está en modo headed
      await this.playwright.navigate(targetUrl, sessionId);
      
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.steps.push(`Navigation completed successfully in ${verboseResult.executionDetails.executionTimeMs}ms`);

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.success = false;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime
      });
      verboseResult.executionDetails.steps.push(`Navigation failed: ${e?.message ?? 'Unknown error'}`);

      return verboseResult;
    }
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
    const startTime = Date.now();

    const verboseResult = {
      success: false,
      message: '',
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_session_cleanup',
        steps: [] as string[],
        errors: [] as any[]
      }
    };

    try {
      verboseResult.executionDetails.steps.push(`Starting session cleanup for: ${sessionId}`);
      
      const result = await this.playwright.stopSession(sessionId);
      
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.success = result.success;
      verboseResult.message = result.message;
      
      if (result.success) {
        verboseResult.executionDetails.steps.push(`Session stopped successfully: ${result.message}`);
      } else {
        verboseResult.executionDetails.steps.push(`Session stop failed: ${result.message}`);
        verboseResult.executionDetails.errors.push({
          message: result.message,
          timestamp: endTime
        });
      }

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime
      });
      verboseResult.executionDetails.steps.push(`Error occurred: ${e?.message ?? 'Unknown error'}`);
      verboseResult.message = e?.message ?? 'Unknown error';

      return verboseResult;
    }
  }
}
