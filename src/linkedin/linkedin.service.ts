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
  // sendMessage - overload multi-sesión
  // -------------------------------
  // Legacy:
  //   sendMessage(profileUrl, message)
  sendMessage(profileUrl: string, message: string): Promise<any>;

  // Nuevo:
  //   sendMessage(sessionId, profileUrl, message)
  sendMessage(
    sessionId: string,
    profileUrl: string,
    message: string,
  ): Promise<any>;

  async sendMessage(a: string, b: string, c?: string): Promise<any> {
    // Nueva firma: (sessionId, profileUrl, message)
    if (typeof c === 'string') {
      const sessionId = a;
      const profileUrl = b;
      const message = c;
      return this.chat.sendMessage(sessionId, profileUrl, message);
    }

    // Legacy: (profileUrl, message) -> sesión "default"
    const sessionId = 'default';
    const profileUrl = a;
    const message = b;
    return this.chat.sendMessage(sessionId, profileUrl, message);
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
  checkConnection(profileUrl: string): Promise<boolean>;

  // Nuevo:
  //   checkConnection(sessionId, profileUrl)
  checkConnection(sessionId: string, profileUrl: string): Promise<boolean>;

  async checkConnection(a: string, b?: string): Promise<boolean> {
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
}
