// src/stream/stream.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../browser/playwright.service';

type SessionId = string;

type ScreenshotResult = { data: string; mimeType: string };
type CachedScreenshot = ScreenshotResult & { ts: number };

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  // Cache por sesión
  private lastFrames = new Map<SessionId, CachedScreenshot>();
  private inFlight = new Map<SessionId, Promise<ScreenshotResult>>();

  constructor(private readonly playwright: PlaywrightService) {}


  async getScreenshotBase64(
    sessionId: SessionId = 'default',
  ): Promise<ScreenshotResult> {
    // Evita tormenta de screenshots si hay varios consumidores a la vez
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    const promise = (async () => {
      const screenshot = await this.playwright.takeScreenshot(
        { type: 'jpeg', fullPage: false },
        sessionId
      );

      this.lastFrames.set(sessionId, { ...screenshot, ts: Date.now() });
      return screenshot;
    })();

    this.inFlight.set(sessionId, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  async getCachedScreenshotBase64(
    sessionId: SessionId = 'default',
    maxAgeMs = 800,
  ): Promise<ScreenshotResult> {
    const last = this.lastFrames.get(sessionId);

    if (last && Date.now() - last.ts <= maxAgeMs) {
      const { data, mimeType } = last;
      return { data, mimeType };
    }

    return this.getScreenshotBase64(sessionId);
  }
}
