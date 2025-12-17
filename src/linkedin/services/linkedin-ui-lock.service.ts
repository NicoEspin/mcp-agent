// src/linkedin/services/linkedin-ui-lock.service.ts
import { Injectable } from '@nestjs/common';

type SessionId = string;

@Injectable()
export class LinkedinUiLockService {
  private chain = new Map<SessionId, Promise<any>>();

  async withLock<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(sessionId) ?? Promise.resolve();

    const next = prev.then(fn, fn);
    this.chain.set(sessionId, next);

    try {
      return await next;
    } finally {
      if (this.chain.get(sessionId) === next) this.chain.delete(sessionId);
    }
  }
}
