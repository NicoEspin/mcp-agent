// src/linkedin/linkedin.controller.ts
import { Body, Controller, Post, Get, Query } from '@nestjs/common';
import { LinkedinService } from './linkedin.service';
import { PlaywrightService } from '../browser/playwright.service';
import { LinkedinSessionService } from './session/linkedin-session.service';
import { SendMessageDto } from './dto/send-message.dto';
import { SendConnectionDto } from './dto/send-connection.dto';
import { CheckConnectionDto } from './dto/check-connection.dto';
import { ReadChatDto } from './dto/read-chat.dto';
import { LinkedinActionVerifierService } from './services/linkedin-action-verifier.service';

@Controller('linkedin')
export class LinkedinController {
  constructor(
    private readonly linkedin: LinkedinService,
    private readonly playwright: PlaywrightService,
    private readonly sessionService: LinkedinSessionService,
    private readonly verifier: LinkedinActionVerifierService,
  ) {}

  // -------------------
  // read-chat (POST)
  // -------------------
  @Post('read-chat')
  async readChat(@Body() dto: ReadChatDto) {
    const sessionId = dto.sessionId ?? 'default';

    const actionResult = await this.linkedin.readChat(
      sessionId,
      dto.profileUrl,
      dto.limit ?? 30,
      dto.threadHint,
    );

    const verification = await this.verifier.verifyAfterAction({
      sessionId,
      action: 'read_chat',
      profileUrl: dto.profileUrl,
      actionResult,
    });

    return { ...actionResult, verification };
  }

  // -------------------
  // send-message (POST)
  // -------------------
  @Post('send-message')
  async sendMessage(@Body() dto: SendMessageDto) {
    const sessionId = dto.sessionId ?? 'default';

    const actionResult = await this.linkedin.sendMessage(
      sessionId,
      dto.profileUrl,
      dto.message,
    );

    const verification = await this.verifier.verifyAfterAction({
      sessionId,
      action: 'send_message',
      profileUrl: dto.profileUrl,
      message: dto.message,
      actionResult,
    });

    return { ...actionResult, verification };
  }

  // -------------------
  // send-connection (POST)
  // -------------------
  @Post('send-connection')
  async sendConnection(@Body() dto: SendConnectionDto) {
    const sessionId = dto.sessionId ?? 'default';

    const actionResult = await this.linkedin.sendConnection(
      sessionId,
      dto.profileUrl,
      dto.note,
    );

    const verification = await this.verifier.verifyAfterAction({
      sessionId,
      action: 'send_connection',
      profileUrl: dto.profileUrl,
      note: dto.note,
      actionResult,
    });

    return { ...actionResult, verification };
  }

  // -------------------
  // check-connection (POST)  <-- NO verification (según regla)
  // -------------------
  @Post('check-connection')
  async checkConnection(@Body() dto: CheckConnectionDto): Promise<any> {
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
        errors: [] as any[],
      },
    };

    try {
      verboseResult.executionDetails.steps.push(
        `Starting LinkedIn open for session: ${sessionId}`,
      );
      verboseResult.executionDetails.steps.push(`Target URL: ${targetUrl}`);
      verboseResult.executionDetails.steps.push(
        'Initiating Playwright navigation (will force Chromium open if in headed mode)',
      );

      await this.playwright.navigate(targetUrl, sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.steps.push(
        `Navigation completed successfully in ${verboseResult.executionDetails.executionTimeMs}ms`,
      );

      const verification = await this.verifier.verifyAfterAction({
        sessionId,
        action: 'open',
        actionResult: verboseResult,
      });

      return { ...verboseResult, verification };
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.success = false;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Navigation failed: ${e?.message ?? 'Unknown error'}`,
      );

      const verification = await this.verifier.verifyAfterAction({
        sessionId,
        action: 'open',
        actionResult: verboseResult,
      });

      return { ...verboseResult, verification };
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
        errors: [] as any[],
      },
    };

    try {
      verboseResult.executionDetails.steps.push(
        `Starting session cleanup for: ${sessionId}`,
      );

      const result = await this.playwright.stopSession(sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.success = result.success;
      verboseResult.message = result.message;

      if (result.success) {
        verboseResult.executionDetails.steps.push(
          `Session stopped successfully: ${result.message}`,
        );
      } else {
        verboseResult.executionDetails.steps.push(
          `Session stop failed: ${result.message}`,
        );
        verboseResult.executionDetails.errors.push({
          message: result.message,
          timestamp: endTime,
        });
      }

      // ✅ también verificamos stop-session (no dijiste excluirlo)
      const verification = await this.verifier.verifyAfterAction({
        sessionId,
        action: 'open', // 👈 opcional: o no verificar stop-session
        actionResult: verboseResult,
      });

      return { ...verboseResult, verification };
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Error occurred: ${e?.message ?? 'Unknown error'}`,
      );
      verboseResult.message = e?.message ?? 'Unknown error';

      // incluso en error, podemos verificar para ver si quedó en login/captcha etc.
      const verification = await this.verifier.verifyAfterAction({
        sessionId,
        action: 'open',
        actionResult: verboseResult,
      });

      return { ...verboseResult, verification };
    }
  }
}
