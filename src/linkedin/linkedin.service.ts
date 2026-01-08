// src/linkedin/linkedin.service.ts
import { Injectable } from '@nestjs/common';
import { LinkedinChatService } from './services/linkedin-chat.service';
import { LinkedinConnectionService } from './services/linkedin-connection.service';
import { LinkedinSalesNavigatorService } from './services/linkedin-sales-navigator.service';
import { LinkedinSalesNavigatorChatService } from './services/linkedin-sales-navigator-chat.service';
import { LinkedinSalesNavigatorConnectionService } from './services/linkedin-sales-navigator-connection.service';
import { LinkedinWarmUpService } from './services/linkedin-warmup.service';

@Injectable()
export class LinkedinService {
  constructor(
    private readonly chat: LinkedinChatService,
    private readonly connection: LinkedinConnectionService,
    private readonly salesNav: LinkedinSalesNavigatorService,
    private readonly salesNavChat: LinkedinSalesNavigatorChatService,
    private readonly salesNavConn: LinkedinSalesNavigatorConnectionService,
    private readonly warmup: LinkedinWarmUpService,
  ) {}

  // -------------------------------
  // readChat - overload multi-sesión
  // -------------------------------
  // Uso legacy (default session):
  //   readChat(profileUrl, limit?, threadHint?)
  readChat(
    profileUrl: string,
    limit?: number,
    threadHint?: string,
  ): Promise<any>;

  // Uso nuevo multi-sesión:
  //   readChat(sessionId, profileUrl, limit?, threadHint?)
  readChat(
    sessionId: string,
    profileUrl: string,
    limit?: number,
    threadHint?: string,
  ): Promise<any>;

  // Implementación
  async readChat(
    a: string,
    b?: string | number,
    c?: number | string,
    d?: string,
  ): Promise<any> {
    // Firma nueva: (sessionId, profileUrl, limit?, threadHint?)
    if (typeof b === 'string') {
      const sessionId = a;
      const profileUrl = b;
      const limit = typeof c === 'number' ? c : undefined;
      const threadHint = typeof c === 'string' ? c : d;
      return this.chat.readChat(sessionId, profileUrl, limit, threadHint);
    }

    // Firma legacy: (profileUrl, limit?, threadHint?) -> usa sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    const limit = typeof b === 'number' ? b : undefined;
    const threadHint = typeof c === 'string' ? c : undefined;

    return this.chat.readChat(sessionId, profileUrl, limit, threadHint);
  }

  // -------------------------------
  // sendMessage - overload multi-sesión + multi-messages
  // -------------------------------

  // Legacy:
  //   sendMessage(profileUrl, message | messages)
  sendMessage(profileUrl: string, message: string | string[]): Promise<any>;

  // Nuevo:
  //   sendMessage(sessionId, profileUrl, message | messages)
  sendMessage(
    sessionId: string,
    profileUrl: string,
    message: string | string[],
  ): Promise<any>;

  async sendMessage(
    a: string,
    b: string | string[],
    c?: string | string[],
  ): Promise<any> {
    // Nueva firma: (sessionId, profileUrl, messageOrMessages)
    if (typeof c !== 'undefined') {
      const sessionId = a;
      const profileUrl = b as string;
      const messageOrMessages = c;

      const messages = Array.isArray(messageOrMessages)
        ? messageOrMessages
        : [messageOrMessages];

      return this.chat.sendMessages(sessionId, profileUrl, messages);
    }

    // Legacy: (profileUrl, messageOrMessages) -> sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    const messageOrMessages = b;

    const messages = Array.isArray(messageOrMessages)
      ? messageOrMessages
      : [messageOrMessages];

    return this.chat.sendMessages(sessionId, profileUrl, messages);
  }
  // -------------------------------
  // sendConnection - overload multi-sesión
  // -------------------------------
  // Legacy:
  //   sendConnection(profileUrl, note?)
  sendConnection(profileUrl: string, note?: string): Promise<any>;

  // Nuevo:
  //   sendConnection(sessionId, profileUrl, note?)
  sendConnection(
    sessionId: string,
    profileUrl: string,
    note?: string,
  ): Promise<any>;

  async sendConnection(a: string, b?: string, c?: string): Promise<any> {
    // Nueva firma: (sessionId, profileUrl, note?)
    if (typeof b === 'string') {
      const sessionId = a;
      const profileUrl = b;
      const note = c;
      return this.connection.sendConnection(sessionId, profileUrl, note);
    }

    // Legacy: (profileUrl, note?) -> sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    const note = b;
    return this.connection.sendConnection(sessionId, profileUrl, note);
  }

  // -------------------------------
  // checkConnection - overload multi-sesión
  // -------------------------------
  // Legacy:
  //   checkConnection(profileUrl)
  checkConnection(profileUrl: string): Promise<any>;

  // Nuevo:
  //   checkConnection(sessionId, profileUrl)
  checkConnection(sessionId: string, profileUrl: string): Promise<any>;

  async checkConnection(a: string, b?: string): Promise<any> {
    // Nueva firma: (sessionId, profileUrl)
    if (typeof b === 'string') {
      const sessionId = a;
      const profileUrl = b;
      return this.connection.checkConnection(sessionId, profileUrl);
    }

    // Legacy: (profileUrl) -> sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    return this.connection.checkConnection(sessionId, profileUrl);
  }

  // -------------------------------
  // sendSalesNavMessage - overload multi-sesión
  // -------------------------------

  sendSalesNavMessage(
    profileUrl: string,
    message: string,
    subject?: string,
  ): Promise<any>;
  sendSalesNavMessage(
    sessionId: string,
    profileUrl: string,
    message: string,
    subject?: string,
  ): Promise<any>;

  async sendSalesNavMessage(
    a: string,
    b: string,
    c?: string,
    d?: string,
  ): Promise<any> {
    const looksLikeUrl = (s: string) =>
      /^https?:\/\//i.test(s) || /linkedin\.com/i.test(s);

    // Legacy: (profileUrl, message, subject?)
    if (looksLikeUrl(a)) {
      const sessionId = 'default';
      const profileUrl = a;
      const message = b;
      const subject = c;
      return this.salesNav.sendSalesNavigatorMessage(
        sessionId,
        profileUrl,
        message,
        subject,
      );
    }

    // Nuevo: (sessionId, profileUrl, message, subject?)
    const sessionId = a;
    const profileUrl = b;
    const message = c ?? '';
    const subject = d;

    return this.salesNav.sendSalesNavigatorMessage(
      sessionId,
      profileUrl,
      message,
      subject,
    );
  }

  readSalesNavChat(
    profileUrl: string,
    limit?: number,
    threadHint?: string,
  ): Promise<any>;
  readSalesNavChat(
    sessionId: string,
    profileUrl: string,
    limit?: number,
    threadHint?: string,
  ): Promise<any>;

  async readSalesNavChat(
    a: string,
    b?: string | number,
    c?: number | string,
    d?: string,
  ): Promise<any> {
    const looksLikeUrl = (s: string) =>
      /^https?:\/\//i.test(s) || /linkedin\.com/i.test(s);

    // Legacy: (profileUrl, limit?, threadHint?)
    if (looksLikeUrl(a)) {
      const sessionId = 'default';
      const profileUrl = a;
      const limit = typeof b === 'number' ? b : undefined;
      const threadHint = typeof c === 'string' ? c : undefined;
      return this.salesNavChat.readSalesNavChat(
        sessionId,
        profileUrl,
        limit ?? 30,
        threadHint,
      );
    }

    // Nuevo: (sessionId, profileUrl, limit?, threadHint?)
    const sessionId = a;
    const profileUrl = String(b ?? '');
    const limit = typeof c === 'number' ? c : undefined;
    const threadHint = typeof c === 'string' ? c : d;

    return this.salesNavChat.readSalesNavChat(
      sessionId,
      profileUrl,
      limit ?? 30,
      threadHint,
    );
  }

  // -------------------------------
  // checkSalesNavConnection - overload multi-sesión
  // -------------------------------
  checkSalesNavConnection(profileUrl: string): Promise<any>;
  checkSalesNavConnection(sessionId: string, profileUrl: string): Promise<any>;

  async checkSalesNavConnection(a: string, b?: string): Promise<any> {
    // Nueva firma: (sessionId, profileUrl)
    if (typeof b === 'string') {
      const sessionId = a;
      const profileUrl = b;
      return this.salesNavConn.checkConnectionSalesNavigator(
        sessionId,
        profileUrl,
      );
    }

    // Legacy: (profileUrl) -> sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    return this.salesNavConn.checkConnectionSalesNavigator(
      sessionId,
      profileUrl,
    );
  }

  async startWarmUp(
    sessionId: string,
    linkedinUrl: string,
    lastMessageStr: string,
    intervalSeconds?: number,
    maxMinutes?: number,
    closeOnFinish?: boolean,
  ) {
    return this.warmup.startWarmUp(
      sessionId,
      linkedinUrl,
      lastMessageStr,
      intervalSeconds ?? 60,
      maxMinutes ?? 30,
      closeOnFinish ?? true,
    );
  }

  // -------------------------------
  // warmup watcher controls
  // -------------------------------
  startWarmUpWatcher(
    sessionId: string,
    profileUrl: string,
    lastMessageStr: string,
    opts: any = {},
  ) {
    return this.warmup.startWarmUpWatcher(
      sessionId,
      profileUrl,
      lastMessageStr,
      opts,
    );
  }

  stopWarmUpWatcher(watcherId: string) {
    return this.warmup.stopWarmUpWatcher(watcherId);
  }

  stopWarmUpBySession(sessionId: string, profileUrl?: string) {
    return this.warmup.stopWarmUpBySession(sessionId, profileUrl);
  }

  listWarmUpWatchers() {
    return this.warmup.listWarmUpWatchers();
  }
}
