import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../browser/playwright.service';
import type { InputEvent, SessionId } from './stream.types';

type ScreenshotResult = { data: string; mimeType: string };
type CachedScreenshot = ScreenshotResult & { ts: number };

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  private lastFrames = new Map<SessionId, CachedScreenshot>();
  private inFlight = new Map<SessionId, Promise<ScreenshotResult>>();

  // ✅ serialize inputs per session so events don't interleave weirdly
  private inputChain = new Map<SessionId, Promise<void>>();

  // ✅ Track when we last invalidated the cache (to force refresh after input)
  private invalidatedAt = new Map<SessionId, number>();

  constructor(private readonly playwright: PlaywrightService) {}

  private enqueueInput(sessionId: SessionId, task: () => Promise<void>) {
    const prev = this.inputChain.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.inputChain.set(sessionId, next);
    return next;
  }

  async dispatchInput(sessionId: SessionId, ev: InputEvent) {
    return this.enqueueInput(sessionId, async () => {
      switch (ev.type) {
        case 'move':
          await this.playwright.mouseMove(sessionId, ev.x, ev.y);
          break;
        case 'down':
          await this.playwright.mouseDown(sessionId, ev.x, ev.y, {
            button: ev.button,
            modifiers: ev.modifiers,
          });
          break;
        case 'up':
          await this.playwright.mouseUp(sessionId, ev.x, ev.y, {
            button: ev.button,
            modifiers: ev.modifiers,
          });
          break;
        case 'click':
          await this.playwright.mouseClick(sessionId, ev.x, ev.y, {
            button: ev.button,
            clickCount: ev.clickCount,
            modifiers: ev.modifiers,
          });
          break;
        case 'wheel':
          await this.playwright.mouseWheel(sessionId, ev.dx, ev.dy);
          break;
        case 'type':
          await this.playwright.keyboardType(sessionId, ev.text, ev.delayMs);
          break;
        case 'press':
          await this.playwright.keyboardPress(sessionId, ev.key, ev.modifiers);
          break;
        case 'keyDown':
          await this.playwright.keyboardDown(sessionId, ev.key);
          break;
        case 'keyUp':
          await this.playwright.keyboardUp(sessionId, ev.key);
          break;
      }

      // ✅ Just invalidate the cache - let the normal interval pick it up
      // This avoids racing with the WebSocket's screenshot interval
      this.invalidatedAt.set(sessionId, Date.now());
    });
  }

  async getScreenshotBase64(
    sessionId: SessionId = 'default',
  ): Promise<ScreenshotResult> {
    // ✅ If there's already a screenshot in progress, wait for it
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const screenshot = await this.playwright.takeScreenshot(
          { type: 'jpeg', fullPage: false },
          sessionId,
        );
        this.lastFrames.set(sessionId, { ...screenshot, ts: Date.now() });
        this.invalidatedAt.delete(sessionId); // Clear invalidation flag
        return screenshot;
      } catch (error: any) {
        const errorMessage = error.message || String(error);

        // Check if this is a browser closure error
        if (this.isBrowserClosureError(errorMessage)) {
          this.logger.warn(
            `Browser closure detected for ${sessionId}, attempting recovery: ${errorMessage}`,
          );

          // Try one more time after browser recovery
          try {
            // Force browser recovery by calling takeScreenshot again
            // The PlaywrightService will handle session recovery automatically
            const screenshot = await this.playwright.takeScreenshot(
              { type: 'jpeg', fullPage: false },
              sessionId,
            );
            this.lastFrames.set(sessionId, { ...screenshot, ts: Date.now() });
            this.invalidatedAt.delete(sessionId);
            this.logger.log(`Browser recovery successful for ${sessionId}`);
            return screenshot;
          } catch (retryError: any) {
            this.logger.error(
              `Browser recovery failed for ${sessionId}: ${retryError.message}`,
            );
            // Fall back to cached frame only after recovery attempt fails
            const last = this.lastFrames.get(sessionId);
            if (last) {
              this.logger.warn(
                `Using cached frame after recovery failure for ${sessionId}`,
              );
              return { data: last.data, mimeType: last.mimeType };
            }
            throw retryError;
          }
        }

        // For other errors, fall back to cached frame if available
        const last = this.lastFrames.get(sessionId);
        if (last) {
          this.logger.warn(
            `Screenshot failed for ${sessionId}, using cached frame: ${errorMessage}`,
          );
          return { data: last.data, mimeType: last.mimeType };
        }
        throw error;
      }
    })();

    this.inFlight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  async forceScreenshotBase64(
    sessionId: SessionId = 'default',
  ): Promise<ScreenshotResult> {
    const existing = this.inFlight.get(sessionId);
    if (existing) {
      try {
        await existing;
      } catch {
        // ignoramos: el próximo getScreenshotBase64 decidirá si usa cache o lanza
      }
    }
    return this.getScreenshotBase64(sessionId);
  }

  private isBrowserClosureError(errorMessage: string): boolean {
    const closurePatterns = [
      'target page, context or browser has been closed',
      'browser has been closed',
      'context has been closed',
      'page has been closed',
      'target closed',
      'session not found',
      'protocol error',
    ];

    const lowerMessage = errorMessage.toLowerCase();
    return closurePatterns.some((pattern) => lowerMessage.includes(pattern));
  }

  async getCachedScreenshotBase64(
    sessionId: SessionId = 'default',
    maxAgeMs = 800,
  ): Promise<ScreenshotResult> {
    const last = this.lastFrames.get(sessionId);
    const wasInvalidated = this.invalidatedAt.has(sessionId);

    // ✅ If cache was invalidated by user input, force refresh
    if (wasInvalidated) {
      return this.getScreenshotBase64(sessionId);
    }

    // ✅ Otherwise use cache if it's fresh enough
    if (last && Date.now() - last.ts <= maxAgeMs) {
      const { data, mimeType } = last;
      return { data, mimeType };
    }
    return this.getScreenshotBase64(sessionId);
  }
}
