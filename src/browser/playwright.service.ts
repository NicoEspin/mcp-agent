// src/browser/playwright.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Browser,
  BrowserContext,
  Page,
  chromium,
  firefox,
  webkit,
} from 'playwright';
import type {
  Modifier as StreamModifier,
  MouseButton,
} from '../stream/stream.types';
import { CookieManagerService } from './cookie-manager.service';
import * as path from 'path';
import * as fs from 'fs';
import { StorageStateService } from './storage-state.service';
import { randomUUID } from 'crypto';

type SessionId = string;

type TabId = string;

type TabInfo = {
  tabId: TabId;
  url: string;
  title: string;
  active: boolean;
};

type ListTabsResponse = {
  activeTabId: TabId;
  tabs: TabInfo[];
};

interface BrowserSession {
  context: BrowserContext;

  // ✅ tab activa (compat con tu código actual)
  page: Page;
  activeTabId: TabId;

  // ✅ todas las tabs
  pages: Map<TabId, Page>;

  lastUsedAt: number;
}
type ScreenshotBytesResult = { bytes: Buffer; mimeType: string };
interface ScreenshotResult {
  data: string;
  mimeType: string;
}

@Injectable()
export class PlaywrightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightService.name);
  private browser: Browser | null = null;
  private sessions = new Map<SessionId, BrowserSession>();
  private readonly DEFAULT_SESSION_ID = 'default';
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cookieManager: CookieManagerService,
    private readonly storageState: StorageStateService,
  ) {}

  private normalizeButton(btn?: MouseButton): MouseButton {
    return btn ?? 'left';
  }

  private async createPage(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(this.getTimeoutAction());
    page.setDefaultNavigationTimeout(this.getTimeoutNavigation());
    return page;
  }

  private setActiveTab(
    sessionId: SessionId,
    session: BrowserSession,
    tabId: string,
  ) {
    const p = session.pages.get(tabId);
    if (!p) throw new Error(`Tab not found: ${tabId}`);
    session.activeTabId = tabId;
    session.page = p; // ✅ clave: stream + inputs siguen funcionando
    session.lastUsedAt = Date.now();
    this.sessions.set(sessionId, session);
  }

  private chord(modifiers: StreamModifier[] | undefined, key: string) {
    if (!modifiers?.length) return key;
    // Playwright accepts chords like "Control+L"
    return `${modifiers.join('+')}+${key}`;
  }

  /**
   * Playwright mouse API (page.mouse.*) does NOT support "modifiers".
   * To simulate Ctrl/Shift/Alt/Meta + click/drag we hold keys via keyboard.down()
   * around the mouse operation.
   */
  private normalizeModifier(mod: StreamModifier): string {
    const m = String(mod).toLowerCase();
    if (m === 'control' || m === 'ctrl') return 'Control';
    if (m === 'alt' || m === 'option') return 'Alt';
    if (m === 'shift') return 'Shift';
    if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win')
      return 'Meta';
    // fallback if you already send proper names
    return String(mod);
  }

  private async pressModifiers(page: Page, modifiers?: StreamModifier[]) {
    for (const mod of modifiers ?? []) {
      await page.keyboard.down(this.normalizeModifier(mod));
    }
  }

  private async releaseModifiers(page: Page, modifiers?: StreamModifier[]) {
    for (const mod of (modifiers ?? []).slice().reverse()) {
      await page.keyboard.up(this.normalizeModifier(mod));
    }
  }

  private async withModifiers<T>(
    page: Page,
    modifiers: StreamModifier[] | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!modifiers?.length) return fn();
    await this.pressModifiers(page, modifiers);
    try {
      return await fn();
    } finally {
      await this.releaseModifiers(page, modifiers);
    }
  }

  // ✅ invalida handlers viejos cuando se recrea una sesión
  private readonly sessionGen = new Map<SessionId, number>();

  private bumpSessionGen(sessionId: SessionId): number {
    const next = (this.sessionGen.get(sessionId) ?? 0) + 1;
    this.sessionGen.set(sessionId, next);
    return next;
  }

  private getSessionGen(sessionId: SessionId): number {
    return this.sessionGen.get(sessionId) ?? 0;
  }

  private findTabIdByPage(session: BrowserSession, page: Page): TabId | null {
    for (const [id, p] of session.pages.entries()) {
      if (p === page) return id;
    }
    return null;
  }

  private bindPageLifecycle(
    sessionId: SessionId,
    session: BrowserSession,
    gen: number,
    tabId: TabId,
    page: Page,
  ) {
    // timeouts consistentes
    try {
      page.setDefaultTimeout(this.getTimeoutAction());
      page.setDefaultNavigationTimeout(this.getTimeoutNavigation());
    } catch {}

    // popup => nueva tab
    page.on('popup', (popup) => {
      if (this.getSessionGen(sessionId) !== gen) return;
      this.registerPage(sessionId, session, gen, popup, true);
      void popup.bringToFront().catch(() => {});
    });

    // si se cierra una tab, limpiarla del map y recuperar activa si hace falta
    page.on('close', () => {
      if (this.getSessionGen(sessionId) !== gen) return;

      // puede ya no existir la sesión (stopSession)
      const live = this.sessions.get(sessionId);
      if (!live) return;

      live.pages.delete(tabId);

      if (live.pages.size === 0) {
        // no queda ninguna: creamos una nueva "blank" para que stream no muera
        void (async () => {
          try {
            const newPage = await this.createPage(live.context);
            const newId = randomUUID();
            live.pages.set(newId, newPage);
            this.bindPageLifecycle(sessionId, live, gen, newId, newPage);
            this.setActiveTab(sessionId, live, newId);
            await newPage.goto('about:blank').catch(() => {});
          } catch {}
        })();
        return;
      }

      if (tabId === live.activeTabId) {
        const next = live.pages.keys().next().value as TabId | undefined;
        if (next) this.setActiveTab(sessionId, live, next);
      } else {
        this.sessions.set(sessionId, live);
      }
    });
  }

  private registerPage(
    sessionId: SessionId,
    session: BrowserSession,
    gen: number,
    page: Page,
    makeActive: boolean,
  ): TabId {
    // evita duplicados (context.on('page') + popup pueden disparar ambos)
    const existing = this.findTabIdByPage(session, page);
    if (existing) {
      if (makeActive) this.setActiveTab(sessionId, session, existing);
      return existing;
    }

    const tabId = randomUUID();
    session.pages.set(tabId, page);
    this.bindPageLifecycle(sessionId, session, gen, tabId, page);

    if (makeActive) this.setActiveTab(sessionId, session, tabId);
    else this.sessions.set(sessionId, session);

    return tabId;
  }

  private async pruneDeadPages(session: BrowserSession) {
    const entries = Array.from(session.pages.entries());
    for (const [tabId, p] of entries) {
      const alive = await this.isPageAlive(p).catch(() => false);
      if (!alive) session.pages.delete(tabId);
    }
  }

  private async ensureActiveTab(sessionId: SessionId, session: BrowserSession) {
    if (session.pages.size === 0) return;

    if (!session.pages.has(session.activeTabId)) {
      const next = session.pages.keys().next().value as TabId;
      this.setActiveTab(sessionId, session, next);
    }
  }

  async mouseMove(sessionId: SessionId, x: number, y: number) {
    const session = await this.getSession(sessionId);
    await session.page.mouse.move(x, y);
  }

  async mouseDown(
    sessionId: SessionId,
    x: number,
    y: number,
    opts?: { button?: MouseButton; modifiers?: StreamModifier[] },
  ) {
    const session = await this.getSession(sessionId);

    await this.withModifiers(session.page, opts?.modifiers, async () => {
      await session.page.mouse.move(x, y);
      await session.page.mouse.down({
        button: this.normalizeButton(opts?.button),
      });
    });
  }

  async mouseUp(
    sessionId: SessionId,
    x: number,
    y: number,
    opts?: { button?: MouseButton; modifiers?: StreamModifier[] },
  ) {
    const session = await this.getSession(sessionId);

    await this.withModifiers(session.page, opts?.modifiers, async () => {
      await session.page.mouse.move(x, y);
      await session.page.mouse.up({
        button: this.normalizeButton(opts?.button),
      });
    });
  }

  async mouseClick(
    sessionId: SessionId,
    x: number,
    y: number,
    opts?: {
      button?: MouseButton;
      clickCount?: number;
      modifiers?: StreamModifier[];
    },
  ) {
    const session = await this.getSession(sessionId);

    await this.withModifiers(session.page, opts?.modifiers, async () => {
      await session.page.mouse.click(x, y, {
        button: this.normalizeButton(opts?.button),
        clickCount: opts?.clickCount ?? 1,
      });
    });
  }

  async mouseWheel(sessionId: SessionId, dx: number, dy: number) {
    const session = await this.getSession(sessionId);
    await session.page.mouse.wheel(dx, dy);
  }

  async keyboardType(sessionId: SessionId, text: string, delayMs?: number) {
    const session = await this.getSession(sessionId);
    await session.page.keyboard.type(text, { delay: delayMs ?? 0 });
  }

  async keyboardPress(
    sessionId: SessionId,
    key: string,
    modifiers?: StreamModifier[],
  ) {
    const session = await this.getSession(sessionId);
    await session.page.keyboard.press(this.chord(modifiers, key));
  }

  async keyboardDown(sessionId: SessionId, key: string) {
    const session = await this.getSession(sessionId);
    await session.page.keyboard.down(key);
  }

  async keyboardUp(sessionId: SessionId, key: string) {
    const session = await this.getSession(sessionId);
    await session.page.keyboard.up(key);
  }

  private async getLiAtFromContext(
    context: BrowserContext,
  ): Promise<string | null> {
    try {
      const all = await context.cookies();
      const liAt = all.find(
        (c) =>
          c?.name === 'li_at' &&
          String(c?.domain ?? '')
            .toLowerCase()
            .includes('linkedin.com'),
      );
      return liAt?.value ?? null;
    } catch {
      return null;
    }
  }

  private async getLiAtFromStateFile(
    sessionId: SessionId,
  ): Promise<string | null> {
    try {
      const p = this.storageState.getStatePath(sessionId);
      if (!fs.existsSync(p)) return null;

      const txt = await fs.promises.readFile(p, 'utf-8');
      const state = JSON.parse(txt);
      const cookies: any[] = Array.isArray(state?.cookies) ? state.cookies : [];

      const liAt = cookies.find(
        (c) =>
          c?.name === 'li_at' &&
          String(c?.domain ?? '')
            .toLowerCase()
            .includes('linkedin.com'),
      );

      return liAt?.value ?? null;
    } catch {
      return null;
    }
  }

  private getStorageStateDir(): string {
    // Truco: derive el dir desde un path “probe”
    return path.dirname(this.storageState.getStatePath('__probe__'));
  }

  async onModuleInit() {
    try {
      await this.initBrowser();

      const autoWarmup =
        this.config.get<string>('PLAYWRIGHT_AUTO_WARMUP') !== 'false';
      if (autoWarmup) {
        await this.warmupBrowser();
      }

      // Start keepalive mechanism
      this.startKeepalive();
    } catch (error: any) {
      this.logger.error(
        'Failed to initialize Playwright browser:',
        error?.message ?? error,
      );
      if ((error?.message ?? '').includes("Executable doesn't exist")) {
        this.logger.error(
          'Browser binaries not found. Please run: npx playwright install',
        );
      }
      // Don't throw - allow service to start without browser for now
      this.logger.warn(
        'Service starting without browser initialization. Browser will be initialized on first use.',
      );
    }
  }

  async onModuleDestroy() {
    // Stop keepalive
    this.stopKeepalive();

    // Invalida handlers (popups/close) para todas las sesiones
    for (const [sessionId] of this.sessions.entries()) {
      this.bumpSessionGen(sessionId);
      this.stopLinkedInCookieMonitor(sessionId);
    }

    // Best-effort: persist state for all alive sessions before closing
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        const contextAlive = await this.isContextAlive(session.context);
        if (contextAlive) {
          await this.storageState.saveState(sessionId, session.context, {
            requireLiAt: true,
            minIntervalMs: 0, // forzar write al cerrar
          });
        }
      } catch (e: any) {
        this.logger.warn(`Error saving storageState for ${sessionId}: ${e}`);
      }
    }

    // Close all sessions (✅ cerrar TODAS las tabs)
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        for (const [, p] of session.pages.entries()) {
          await p.close().catch(() => {});
        }
        await session.context.close().catch(() => {});
      } catch (e: any) {
        this.logger.warn(`Error closing session ${sessionId}: ${e}`);
      }
    }

    this.sessions.clear();

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private async initBrowser() {
    const browserType =
      this.config.get<string>('PLAYWRIGHT_BROWSER') ?? 'chrome';
    // Prefer headed for visibility, but fall back to headless if no display to avoid crashes
    const hasDisplay = !!process.env.DISPLAY;
    const headless = hasDisplay ? false : true;
    if (!hasDisplay) {
      this.logger.warn(
        'DISPLAY is not set; falling back to headless to avoid X11 launch failure. Run with a DISPLAY/Xvfb to view the browser.',
      );
    }

    const launchOptions = {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
    };

    switch (browserType.toLowerCase()) {
      case 'firefox':
        this.browser = await firefox.launch(launchOptions);
        break;
      case 'webkit':
      case 'safari':
        this.browser = await webkit.launch(launchOptions);
        break;
      case 'chrome':
      case 'chromium':
      default:
        this.browser = await chromium.launch(launchOptions);
        break;
    }

    this.logger.log(
      `Browser initialized: ${browserType} (headless: ${headless})`,
    );
  }

  private async warmupBrowser() {
    try {
      const warmupUrl =
        this.config.get<string>('PLAYWRIGHT_WARMUP_URL') ??
        'https://www.linkedin.com/';
      await this.navigate(warmupUrl);
      this.logger.log(`Browser warmed up: ${warmupUrl}`);
    } catch (e: any) {
      this.logger.warn(`Browser warmup failed: ${e}`);
    }
  }

  private async isBrowserAlive(): Promise<boolean> {
    if (!this.browser) return false;
    try {
      await this.browser.version();
      return true;
    } catch {
      return false;
    }
  }
  private readonly cookieMonitorGen = new Map<SessionId, number>();
  private readonly cookieMonitorTimers = new Map<SessionId, NodeJS.Timeout[]>();

  private stopLinkedInCookieMonitor(sessionId: SessionId) {
    const timers = this.cookieMonitorTimers.get(sessionId);
    if (timers?.length) {
      for (const t of timers) clearTimeout(t);
    }
    this.cookieMonitorTimers.delete(sessionId);
  }

  private startLinkedInCookieMonitor(
    sessionId: SessionId,
    context: BrowserContext,
  ) {
    // Cancela el monitor previo (si existía)
    this.stopLinkedInCookieMonitor(sessionId);

    // Generación para invalidar callbacks viejos
    const gen = (this.cookieMonitorGen.get(sessionId) ?? 0) + 1;
    this.cookieMonitorGen.set(sessionId, gen);

    const checkpoints = [2000, 5000, 10000, 15000, 30000];
    const timers: NodeJS.Timeout[] = [];

    for (const delay of checkpoints) {
      const t = setTimeout(async () => {
        if (this.cookieMonitorGen.get(sessionId) !== gen) return;

        try {
          // 1) chequeo real-time (barato)
          const loggedIn = await this.cookieManager.isLinkedInLoggedInRealTime(
            sessionId,
            context,
          );

          if (loggedIn) {
            // 2) persistir storageState (no cookies.json)
            await this.storageState.saveState(sessionId, context, {
              requireLiAt: true,
              minIntervalMs: 0, // acá conviene forzar para que quede escrito
            });

            this.logger.log(
              `🔐 LinkedIn login detected for session ${sessionId} (monitor @${delay}ms)`,
            );

            this.stopLinkedInCookieMonitor(sessionId);
            return;
          }

          this.logger.debug(
            `LinkedIn monitor (${delay}ms): still not logged (session: ${sessionId})`,
          );

          if (delay === checkpoints[checkpoints.length - 1]) {
            this.stopLinkedInCookieMonitor(sessionId);
          }
        } catch (error) {
          this.logger.warn(
            `LinkedIn monitor failed at ${delay}ms for session ${sessionId}: ${error}`,
          );
          if (delay === checkpoints[checkpoints.length - 1]) {
            this.stopLinkedInCookieMonitor(sessionId);
          }
        }
      }, delay);

      timers.push(t);
    }

    this.cookieMonitorTimers.set(sessionId, timers);
  }

  private async isContextAlive(context: BrowserContext): Promise<boolean> {
    try {
      await context.pages();
      return true;
    } catch {
      return false;
    }
  }

  private async isPageAlive(page: Page): Promise<boolean> {
    try {
      await page.url();
      return true;
    } catch {
      return false;
    }
  }

  private startKeepalive() {
    this.stopKeepalive(); // Clear any existing timer

    const keepaliveInterval = Number(
      this.config.get('PLAYWRIGHT_KEEPALIVE_INTERVAL') ?? 30000, // 30 seconds default
    );

    this.keepaliveTimer = setInterval(async () => {
      try {
        await this.performKeepalive();
      } catch (error) {
        this.logger.warn(`Keepalive failed: ${error}`);
      }
    }, keepaliveInterval);

    this.logger.log(
      `Browser keepalive started (interval: ${keepaliveInterval}ms)`,
    );
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.logger.log('Browser keepalive stopped');
    }
  }

  private async performKeepalive() {
    await this.ensureBrowser();

    const brokenSessions: SessionId[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const contextAlive = await this.isContextAlive(session.context).catch(
        () => false,
      );
      if (!contextAlive) {
        brokenSessions.push(sessionId);
        continue;
      }

      // ✅ limpiar tabs cerradas
      await this.pruneDeadPages(session);

      // ✅ si no quedan tabs, sesión rota
      if (session.pages.size === 0) {
        brokenSessions.push(sessionId);
        continue;
      }

      // ✅ asegurar que activeTabId exista
      await this.ensureActiveTab(sessionId, session);

      // ✅ persistencia periódica si está en LinkedIn y ya hay li_at
      try {
        const url = session.page.url();
        if (url.includes('linkedin.com')) {
          const logged = await this.cookieManager.isLinkedInLoggedInRealTime(
            sessionId,
            session.context,
          );

          if (logged) {
            await this.storageState.saveState(sessionId, session.context, {
              requireLiAt: true,
            });
          }
        }
      } catch (e) {
        this.logger.debug(`Keepalive persist skipped for ${sessionId}: ${e}`);
      }

      // update last used
      session.lastUsedAt = Date.now();
      this.sessions.set(sessionId, session);
    }

    // Remove broken sessions
    for (const sessionId of brokenSessions) {
      this.logger.debug(
        `Removing broken session during keepalive: ${sessionId}`,
      );
      this.bumpSessionGen(sessionId);
      this.stopLinkedInCookieMonitor(sessionId);
      this.sessions.delete(sessionId);
    }

    if (brokenSessions.length > 0) {
      this.logger.warn(
        `Cleaned up ${brokenSessions.length} broken sessions during keepalive`,
      );
    }
  }

  private async ensureBrowser() {
    const isAlive = await this.isBrowserAlive();
    if (!this.browser || !isAlive) {
      if (this.browser && !isAlive) {
        this.logger.warn('Browser detected as closed, reinitializing...');
        try {
          await this.browser.close();
        } catch (e) {
          // Browser might already be closed
        }
        this.browser = null;

        // Clear all sessions since browser context will be invalid
        this.sessions.clear();
      }

      try {
        await this.initBrowser();
        this.logger.log('Browser reinitialized successfully');
      } catch (error: any) {
        if ((error?.message ?? '').includes("Executable doesn't exist")) {
          throw new Error(
            'Browser binaries not found. Please run: npx playwright install',
          );
        }
        throw error;
      }
    }
  }

  private async getSession(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<BrowserSession> {
    await this.ensureBrowser();

    let session = this.sessions.get(sessionId);

    // ✅ si existe, validar y recuperar active tab si hace falta
    if (session) {
      const contextAlive = await this.isContextAlive(session.context).catch(
        () => false,
      );

      if (!contextAlive) {
        this.logger.warn(
          `Session ${sessionId} context is closed, recreating...`,
        );
        this.bumpSessionGen(sessionId);
        this.stopLinkedInCookieMonitor(sessionId);

        try {
          for (const [, p] of session.pages.entries()) {
            await p.close().catch(() => {});
          }
          await session.context.close().catch(() => {});
        } catch {}

        this.sessions.delete(sessionId);
        session = undefined;
      } else {
        // limpiar tabs cerradas
        await this.pruneDeadPages(session);

        // si no queda ninguna tab, crear una nueva
        if (session.pages.size === 0) {
          const gen = this.getSessionGen(sessionId); // misma gen, no recreamos sesión
          const newPage = await this.createPage(session.context);
          this.registerPage(sessionId, session, gen, newPage, true);
          await newPage.goto('about:blank').catch(() => {});
        } else {
          // asegurar active válida
          await this.ensureActiveTab(sessionId, session);
        }

        session.lastUsedAt = Date.now();
        this.sessions.set(sessionId, session);
        return session;
      }
    }

    // ✅ crear sesión nueva
    let context: BrowserContext;

    const gen = this.bumpSessionGen(sessionId);

    // storageState restore
    const hasValidState = this.storageState.ensureValidStateFile(sessionId);
    const statePath = this.storageState.getStatePath(sessionId);

    const ctxOptions: any = {
      viewport: this.getViewportSize(),
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      ...this.getContextFingerprint(),
    };

    if (hasValidState) {
      ctxOptions.storageState = statePath;
      this.logger.log(`♻️ Restoring storageState for session ${sessionId}`);
    }

    try {
      context = await this.browser!.newContext(ctxOptions);
    } catch (error: any) {
      const msg = error?.message?.toLowerCase?.() ?? '';
      if (
        msg.includes('browser has been closed') ||
        msg.includes('target page') ||
        msg.includes('context or browser has been closed')
      ) {
        this.logger.warn(
          `Browser appeared closed when creating context for ${sessionId}, reinitializing...`,
        );
        await this.initBrowser();
        context = await this.browser!.newContext(ctxOptions);
      } else {
        throw error;
      }
    }

    // Block service workers if configured
    if (this.config.get<string>('PLAYWRIGHT_BLOCK_SW') === 'true') {
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.includes('sw.js') || u.includes('service-worker')) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    const page = await this.createPage(context);

    session = {
      context,
      page,
      activeTabId: 'tmp' as TabId, // se setea abajo
      pages: new Map(),
      lastUsedAt: Date.now(),
    };

    // ✅ si el context crea páginas por scripts/popup, también las registramos
    context.on('page', (p) => {
      if (this.getSessionGen(sessionId) !== gen) return;
      this.registerPage(sessionId, session!, gen, p, false);
    });

    // ✅ registrar la primera tab y dejarla activa
    const firstTabId = this.registerPage(sessionId, session, gen, page, true);
    session.activeTabId = firstTabId;
    session.page = page;

    this.sessions.set(sessionId, session);
    this.logger.log(`Created new session: ${sessionId}`);

    return session;
  }

  private getViewportSize() {
    const viewportString =
      this.config.get<string>('PLAYWRIGHT_VIEWPORT_SIZE') ?? '1280x720';
    const [width, height] = viewportString.split('x').map(Number);
    return { width: width || 1280, height: height || 720 };
  }

  private getTimeoutAction() {
    return Number(this.config.get('PLAYWRIGHT_TIMEOUT_ACTION') ?? 45000);
  }

  private getTimeoutNavigation() {
    return Number(this.config.get('PLAYWRIGHT_TIMEOUT_NAVIGATION') ?? 90000);
  }

  private getContextFingerprint() {
    // Hardcoded realistic desktop Chrome fingerprint (Buenos Aires)
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    const locale = 'es-AR';
    const timezoneId = 'America/Argentina/Buenos_Aires';
    const geolocation = { latitude: -34.6037, longitude: -58.3816 };

    return {
      userAgent,
      locale,
      timezoneId,
      geolocation,
      permissions: ['geolocation'],
    };
  }

  // Public API methods - direct replacements for MCP calls

  async navigate(
    url: string,
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<void> {
    const session = await this.getSession(sessionId);

    // Check login status before navigation
    const wasLoggedInBefore = await this.isLinkedInLoggedIn(sessionId);
    this.logger.debug(
      `LinkedIn login status before navigation: ${wasLoggedInBefore} (session: ${sessionId})`,
    );

    await session.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.getTimeoutNavigation(),
    });

    // If navigating to LinkedIn, continuously monitor and save cookies
    if (url.includes('linkedin.com')) {
      this.startLinkedInCookieMonitor(sessionId, session.context);
    }

    this.logger.debug(`Navigated to ${url} (session: ${sessionId})`);
  }

  /**
   * Continuously monitor LinkedIn cookies after navigation
   */
  async runCode(
    code: string,
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<any> {
    const session = await this.getSession(sessionId);

    // Check login status before code execution
    const wasLoggedInBefore = await this.isLinkedInLoggedIn(sessionId);

    let result;
    if (code.trim().startsWith('async (page)')) {
      const func = eval(`(${code})`);
      result = await func(session.page);
    } else {
      result = await session.page.evaluate(code);
    }

    // Monitor cookies after code execution (especially for LinkedIn operations)
    const currentUrl = await session.page.url();
    if (currentUrl.includes('linkedin.com')) {
      this.startLinkedInCookieMonitor(sessionId, session.context);
    }

    return result;
  }

  async takeScreenshotBytes(
    options: {
      type?: 'png' | 'jpeg';
      fullPage?: boolean;
      quality?: number;
    } = {},
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<ScreenshotBytesResult> {
    const session = await this.getSession(sessionId);

    const type = options.type ?? 'jpeg';
    const fullPage = options.fullPage ?? false;

    // quality solo aplica a jpeg
    const screenshotOptions: any = {
      type,
      fullPage,
      animations: 'disabled', // reduce “ruido” y a veces acelera
    };
    if (type === 'jpeg') screenshotOptions.quality = options.quality ?? 70;

    const buffer = await session.page.screenshot(screenshotOptions);

    return { bytes: buffer, mimeType: `image/${type}` };
  }
  // ✅ compat: lo que ya usa tu código (base64)
  async takeScreenshot(
    options: {
      type?: 'png' | 'jpeg';
      fullPage?: boolean;
      quality?: number;
    } = {},
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<ScreenshotResult> {
    const { bytes, mimeType } = await this.takeScreenshotBytes(
      options,
      sessionId,
    );
    return { data: bytes.toString('base64'), mimeType };
  }

  async getSnapshot(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<string> {
    const session = await this.getSession(sessionId);
    return await session.page.content();
  }

  async getPageTitle(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<string> {
    const session = await this.getSession(sessionId);
    return await session.page.title();
  }

  async getCurrentUrl(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<string> {
    const session = await this.getSession(sessionId);
    return session.page.url();
  }

  // Session management

  async stopSession(
    sessionId: SessionId,
  ): Promise<{ success: boolean; message: string }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { success: false, message: `Session "${sessionId}" not found` };
    }

    try {
      // ✅ invalida handlers + frena cookie monitor
      this.bumpSessionGen(sessionId);
      this.stopLinkedInCookieMonitor(sessionId);

      // ✅ persist before closing
      await this.storageState.saveState(sessionId, session.context, {
        requireLiAt: true,
        minIntervalMs: 0,
      });

      // ✅ cerrar TODAS las tabs
      for (const [, p] of session.pages.entries()) {
        await p.close().catch(() => {});
      }

      await session.context.close().catch(() => {});
      this.sessions.delete(sessionId);

      this.logger.log(`Session "${sessionId}" stopped successfully`);
      return {
        success: true,
        message: `Session "${sessionId}" stopped successfully`,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to stop session "${sessionId}": ${error?.message ?? error}`,
      );
      return {
        success: false,
        message: `Failed to stop session "${sessionId}": ${error?.message ?? 'Unknown error'}`,
      };
    }
  }

  async listSessions(): Promise<
    { sessionId: string; lastUsedAt: number; url: string }[]
  > {
    const sessions: { sessionId: string; lastUsedAt: number; url: string }[] =
      [];

    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        sessions.push({
          sessionId,
          lastUsedAt: session.lastUsedAt,
          url: session.page.url(),
        });
      } catch (e) {
        // Page might be closed
        sessions.push({
          sessionId,
          lastUsedAt: session.lastUsedAt,
          url: 'unknown',
        });
      }
    }

    return sessions;
  }

  // Compatibility methods for gradual migration

  async callTool(name: string, args?: any): Promise<any>;
  async callTool(sessionId: SessionId, name: string, args?: any): Promise<any>;
  async callTool(a: string, b?: any, c?: any): Promise<any> {
    let sessionId: SessionId = this.DEFAULT_SESSION_ID;
    let name: string;
    let args: any;

    if (c !== undefined) {
      sessionId = a;
      name = b;
      args = c;
    } else if (typeof b === 'string') {
      sessionId = a;
      name = b;
      args = {};
    } else {
      name = a;
      args = b || {};
    }

    switch (name) {
      case 'browser_navigate':
        await this.navigate(args.url, sessionId);
        return { success: true };

      case 'browser_run_code': {
        const result = await this.runCode(args.code, sessionId);
        return { result };
      }

      case 'browser_take_screenshot':
        return await this.takeScreenshot(args, sessionId);

      case 'browser_snapshot': {
        const content = await this.getSnapshot(sessionId);
        return { content };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async hasTool(name: string): Promise<boolean>;
  async hasTool(sessionId: SessionId, name: string): Promise<boolean>;
  async hasTool(a: string, b?: string): Promise<boolean> {
    const supportedTools = [
      'browser_navigate',
      'browser_run_code',
      'browser_take_screenshot',
      'browser_snapshot',
    ];

    const toolName = b !== undefined ? b : a;
    return supportedTools.includes(toolName);
  }

  async listTools(): Promise<any> {
    return {
      tools: [
        { name: 'browser_navigate', description: 'Navigate to a URL' },
        { name: 'browser_run_code', description: 'Execute JavaScript code' },
        { name: 'browser_take_screenshot', description: 'Take a screenshot' },
        { name: 'browser_snapshot', description: 'Get page content' },
      ],
    };
  }

  // Cookie management methods

  /**
   * Check if user is logged into LinkedIn (combines real-time and saved cookie checks)
   */
  async isLinkedInLoggedIn(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId);

      // 1) real-time (source of truth)
      const realTimeResult =
        await this.cookieManager.isLinkedInLoggedInRealTime(
          sessionId,
          session.context,
        );

      if (realTimeResult) {
        // ✅ persist storageState (no cookies.json)
        await this.storageState.saveState(sessionId, session.context, {
          requireLiAt: true,
        });
        return true;
      }

      // 2) fallback: leer storageState en disco
      const savedResult = await this.storageState.hasLiAtInStateFile(sessionId);

      this.logger.debug(
        `LinkedIn login check for session ${sessionId}: real-time=${realTimeResult}, savedState=${savedResult}`,
      );
      return savedResult;
    } catch (error) {
      this.logger.warn(
        `Error checking LinkedIn login status for session ${sessionId}: ${error}`,
      );
      return this.storageState.hasLiAtInStateFile(sessionId);
    }
  }

  /**
   * Extract and save LinkedIn authentication token
   */
  async extractLinkedInAuth(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<string | null> {
    const session = await this.getSession(sessionId);

    const liAt = await this.getLiAtFromContext(session.context);
    if (!liAt) return null;

    await this.storageState.saveState(sessionId, session.context, {
      requireLiAt: true,
      minIntervalMs: 0,
    });

    return liAt;
  }

  /**
   * Get stored LinkedIn authentication token
   */
  async getLinkedInAuthToken(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<string | null> {
    try {
      // Si hay sesión viva, lo sacamos del context (más confiable)
      if (this.sessions.has(sessionId)) {
        const s = await this.getSession(sessionId);
        const liAt = await this.getLiAtFromContext(s.context);
        if (liAt) return liAt;
      }

      // Fallback al storageState en disco
      return await this.getLiAtFromStateFile(sessionId);
    } catch {
      return await this.getLiAtFromStateFile(sessionId);
    }
  }

  /**
   * Save current session cookies
   */
  async saveCookies(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
    domain: string = 'linkedin.com',
  ): Promise<void> {
    const session = await this.getSession(sessionId);

    const requireLiAt = domain.includes('linkedin.com');
    await this.storageState.saveState(sessionId, session.context, {
      requireLiAt,
      minIntervalMs: 0,
    });
  }
  /**
   * Clear saved cookies for a session
   */
  async clearCookies(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
    domain: string = 'linkedin.com',
  ): Promise<void> {
    // ✅ nuevo: storageState
    await this.storageState.clearState(sessionId);

    // (opcional) limpiar legacy cookie files si todavía existen en tu proyecto
    try {
      await this.cookieManager.clearCookies(sessionId, domain);
    } catch {}
  }

  /**
   * List all sessions with saved cookies
   */
  async listSavedSessions(): Promise<
    { sessionId: string; domain: string; timestamp: number; hasLiAt: boolean }[]
  > {
    try {
      const dir = this.getStorageStateDir();
      const files = await fs.promises.readdir(dir);

      const stateFiles = files.filter((f) => f.endsWith('.storage.json'));

      const out: {
        sessionId: string;
        domain: string;
        timestamp: number;
        hasLiAt: boolean;
      }[] = [];

      for (const f of stateFiles) {
        const full = path.join(dir, f);
        const stat = await fs.promises.stat(full);
        const sessionId = f.replace(/\.storage\.json$/, '');

        const hasLiAt = await this.storageState.hasLiAtInStateFile(sessionId);

        out.push({
          sessionId,
          domain: 'linkedin.com',
          timestamp: stat.mtimeMs,
          hasLiAt,
        });
      }

      return out.sort((a, b) => b.timestamp - a.timestamp);
    } catch (e) {
      this.logger.warn(`Error listing storageStates: ${e}`);
      return [];
    }
  }

  /**
   * Force immediate cookie check and save (useful for manual authentication detection)
   */

  async newTab(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
    url?: string,
    makeActive: boolean = true,
  ) {
    const session = await this.getSession(sessionId);
    const page = await this.createPage(session.context);

    const gen = this.getSessionGen(sessionId);
    const tabId = this.registerPage(sessionId, session, gen, page, makeActive);

    if (url) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.getTimeoutNavigation(),
      });

      if (url.includes('linkedin.com')) {
        this.startLinkedInCookieMonitor(sessionId, session.context);
      }
    }

    return { tabId, activeTabId: session.activeTabId };
  }

  async reloadPage(sessionId: SessionId = this.DEFAULT_SESSION_ID) {
    const session = await this.getSession(sessionId);
    await session.page.reload({
      waitUntil: 'domcontentloaded',
      timeout: this.getTimeoutNavigation(),
    });

    const url = session.page.url();
    if (url.includes('linkedin.com'))
      this.startLinkedInCookieMonitor(sessionId, session.context);

    return { ok: true, url };
  }

  async switchTab(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
    tabId: string,
  ) {
    const session = await this.getSession(sessionId);
    this.setActiveTab(sessionId, session, tabId);
    await session.page.bringToFront().catch(() => {});
    return { ok: true, activeTabId: session.activeTabId };
  }

  async listTabs(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<ListTabsResponse> {
    const session = await this.getSession(sessionId);

    const tabs: TabInfo[] = [];

    for (const [id, p] of session.pages.entries()) {
      let url = 'unknown';
      let title = '';
      try {
        url = p.url();
        title = await p.title();
      } catch {}

      tabs.push({
        tabId: id,
        url,
        title,
        active: id === session.activeTabId,
      });
    }

    return { activeTabId: session.activeTabId, tabs };
  }

  async closeTab(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
    tabId?: string,
  ) {
    const session = await this.getSession(sessionId);
    const id = tabId ?? session.activeTabId;

    const page = session.pages.get(id);
    if (!page) {
      return {
        ok: false,
        message: 'Tab not found',
        activeTabId: session.activeTabId,
      };
    }

    await page.close().catch(() => {}); // el handler hace el resto

    // refrescar sesión (por si el handler creó blank / cambió active)
    const s2 = await this.getSession(sessionId);

    return { ok: true, activeTabId: s2.activeTabId, tabsCount: s2.pages.size };
  }

  async forceCookieCheck(
    sessionId: SessionId = this.DEFAULT_SESSION_ID,
  ): Promise<{ isLoggedIn: boolean; authToken: string | null }> {
    try {
      const session = await this.getSession(sessionId);

      const isLoggedIn = await this.cookieManager.isLinkedInLoggedInRealTime(
        sessionId,
        session.context,
      );

      if (isLoggedIn) {
        await this.storageState.saveState(sessionId, session.context, {
          requireLiAt: true,
          minIntervalMs: 0,
        });

        const authToken = await this.getLiAtFromContext(session.context);

        this.logger.log(
          `🔄 Force check - LinkedIn authenticated for session ${sessionId} (li_at: ${authToken?.slice(0, 10)}...)`,
        );
        return { isLoggedIn: true, authToken };
      }

      this.logger.log(
        `🔄 Force check - LinkedIn NOT authenticated for session ${sessionId}`,
      );
      return { isLoggedIn: false, authToken: null };
    } catch (error) {
      this.logger.error(
        `Force cookie check failed for session ${sessionId}: ${error}`,
      );
      return { isLoggedIn: false, authToken: null };
    }
  }
}
