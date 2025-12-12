// src/browser/playwright.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Browser, BrowserContext, Page, chromium, firefox, webkit } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

type SessionId = string;

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

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

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.initBrowser();
    
    const autoWarmup = this.config.get<string>('PLAYWRIGHT_AUTO_WARMUP') !== 'false';
    if (autoWarmup) {
      await this.warmupBrowser();
    }
  }

  async onModuleDestroy() {
    // Close all sessions
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        await session.page.close();
        await session.context.close();
      } catch (e) {
        this.logger.warn(`Error closing session ${sessionId}: ${e}`);
      }
    }
    
    this.sessions.clear();
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async initBrowser() {
    const browserType = this.config.get<string>('PLAYWRIGHT_BROWSER') ?? 'chrome';
    const headless = this.config.get<string>('PLAYWRIGHT_HEADLESS') !== 'false';

    const launchOptions = {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
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

    this.logger.log(`Browser initialized: ${browserType} (headless: ${headless})`);
  }

  private async warmupBrowser() {
    try {
      const warmupUrl = this.config.get<string>('PLAYWRIGHT_WARMUP_URL') ?? 'https://www.linkedin.com/';
      await this.navigate(warmupUrl);
      this.logger.log(`Browser warmed up: ${warmupUrl}`);
    } catch (e) {
      this.logger.warn(`Browser warmup failed: ${e}`);
    }
  }

  private async ensureBrowser() {
    if (!this.browser) {
      await this.initBrowser();
    }
  }

  private async getSession(sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<BrowserSession> {
    await this.ensureBrowser();
    
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Create new browser context for this session
      const context = await this.browser!.newContext({
        viewport: this.getViewportSize(),
        ignoreHTTPSErrors: true,
        bypassCSP: true,
      });

      // Block service workers if configured
      if (this.config.get<string>('PLAYWRIGHT_BLOCK_SW') === 'true') {
        await context.route('**/*', (route) => {
          if (route.request().url().includes('sw.js') || 
              route.request().url().includes('service-worker')) {
            route.abort();
          } else {
            route.continue();
          }
        });
      }

      const page = await context.newPage();
      
      // Set up page timeouts
      page.setDefaultTimeout(this.getTimeoutAction());
      page.setDefaultNavigationTimeout(this.getTimeoutNavigation());
      
      session = {
        context,
        page,
        lastUsedAt: Date.now(),
      };
      
      this.sessions.set(sessionId, session);
      this.logger.log(`Created new session: ${sessionId}`);
    } else {
      session.lastUsedAt = Date.now();
      this.sessions.set(sessionId, session);
    }
    
    return session;
  }

  private getViewportSize() {
    const viewportString = this.config.get<string>('PLAYWRIGHT_VIEWPORT_SIZE') ?? '1280x720';
    const [width, height] = viewportString.split('x').map(Number);
    return { width: width || 1280, height: height || 720 };
  }

  private getTimeoutAction() {
    return Number(this.config.get('PLAYWRIGHT_TIMEOUT_ACTION') ?? 45000);
  }

  private getTimeoutNavigation() {
    return Number(this.config.get('PLAYWRIGHT_TIMEOUT_NAVIGATION') ?? 90000);
  }

  // Public API methods - direct replacements for MCP calls
  
  async navigate(url: string, sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<void> {
    const session = await this.getSession(sessionId);
    await session.page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: this.getTimeoutNavigation()
    });
    this.logger.debug(`Navigated to ${url} (session: ${sessionId})`);
  }

  async runCode(code: string, sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<any> {
    const session = await this.getSession(sessionId);
    
    // If code starts with "async (page) =>" it's a function, evaluate it directly
    if (code.trim().startsWith('async (page)')) {
      const func = eval(`(${code})`);
      return await func(session.page);
    }
    
    // Otherwise evaluate as JavaScript
    return await session.page.evaluate(code);
  }

  async takeScreenshot(
    options: { type?: 'png' | 'jpeg'; fullPage?: boolean } = {},
    sessionId: SessionId = this.DEFAULT_SESSION_ID
  ): Promise<ScreenshotResult> {
    const session = await this.getSession(sessionId);
    
    const screenshotOptions = {
      type: options.type || 'jpeg',
      fullPage: options.fullPage || false,
    };
    
    const buffer = await session.page.screenshot(screenshotOptions);
    const base64 = buffer.toString('base64');
    
    return {
      data: base64,
      mimeType: `image/${screenshotOptions.type}`,
    };
  }

  async getSnapshot(sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<string> {
    const session = await this.getSession(sessionId);
    return await session.page.content();
  }

  async getPageTitle(sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<string> {
    const session = await this.getSession(sessionId);
    return await session.page.title();
  }

  async getCurrentUrl(sessionId: SessionId = this.DEFAULT_SESSION_ID): Promise<string> {
    const session = await this.getSession(sessionId);
    return session.page.url();
  }

  // Session management
  
  async stopSession(sessionId: SessionId): Promise<{ success: boolean; message: string }> {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return {
        success: false,
        message: `Session "${sessionId}" not found`,
      };
    }

    try {
      await session.page.close();
      await session.context.close();
      this.sessions.delete(sessionId);
      
      this.logger.log(`Session "${sessionId}" stopped successfully`);
      return {
        success: true,
        message: `Session "${sessionId}" stopped successfully`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to stop session "${sessionId}": ${error?.message ?? error}`);
      return {
        success: false,
        message: `Failed to stop session "${sessionId}": ${error?.message ?? 'Unknown error'}`,
      };
    }
  }

  async listSessions(): Promise<{ sessionId: string; lastUsedAt: number; url: string }[]> {
    const sessions: { sessionId: string; lastUsedAt: number; url: string }[] = [];
    
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
        
      case 'browser_run_code':
        const result = await this.runCode(args.code, sessionId);
        return { result };
        
      case 'browser_take_screenshot':
        return await this.takeScreenshot(args, sessionId);
        
      case 'browser_snapshot':
        const content = await this.getSnapshot(sessionId);
        return { content };
        
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
      'browser_snapshot'
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
      ]
    };
  }
}