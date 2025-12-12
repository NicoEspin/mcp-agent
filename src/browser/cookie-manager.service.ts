// src/browser/cookie-manager.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

interface SessionCookies {
  sessionId: string;
  cookies: StoredCookie[];
  timestamp: number;
  domain: string;
}

@Injectable()
export class CookieManagerService {
  private readonly logger = new Logger(CookieManagerService.name);
  private readonly cookiesDir: string;

  constructor(private readonly config: ConfigService) {
    // Create cookies directory if it doesn't exist
    this.cookiesDir = this.config.get<string>('COOKIES_DIR') || './cookies';
    if (!fs.existsSync(this.cookiesDir)) {
      fs.mkdirSync(this.cookiesDir, { recursive: true });
    }
  }

  /**
   * Check if user is logged into LinkedIn based on li_at cookie presence
   */
  async isLinkedInLoggedIn(sessionId: string): Promise<boolean> {
    try {
      const cookies = await this.loadCookies(sessionId, 'linkedin.com');
      const liAtCookie = cookies.find(cookie => cookie.name === 'li_at');
      
      if (!liAtCookie) {
        this.logger.debug(`No li_at cookie found for session ${sessionId}`);
        return false;
      }

      // Check if cookie is expired
      if (liAtCookie.expires && liAtCookie.expires < Date.now()) {
        this.logger.debug(`li_at cookie expired for session ${sessionId}`);
        return false;
      }

      this.logger.debug(`Valid li_at cookie found for session ${sessionId}`);
      return true;
    } catch (error) {
      this.logger.warn(`Error checking LinkedIn login status: ${error}`);
      return false;
    }
  }

  /**
   * Save cookies from browser context to file
   */
  async saveCookies(sessionId: string, context: BrowserContext, domain: string = 'linkedin.com'): Promise<void> {
    try {
      const cookies = await context.cookies();
      
      // Filter cookies for the specific domain
      const domainCookies = cookies.filter(cookie => 
        cookie.domain === domain || cookie.domain === `.${domain}`
      );

      const sessionCookies: SessionCookies = {
        sessionId,
        cookies: domainCookies,
        timestamp: Date.now(),
        domain
      };

      const filePath = this.getCookieFilePath(sessionId, domain);
      await fs.promises.writeFile(filePath, JSON.stringify(sessionCookies, null, 2));
      
      const liAtCookie = domainCookies.find(c => c.name === 'li_at');
      if (liAtCookie) {
        this.logger.log(`LinkedIn cookies saved for session ${sessionId} (li_at: ${liAtCookie.value.slice(0, 10)}...)`);
      } else {
        this.logger.log(`Cookies saved for session ${sessionId} (no li_at found)`);
      }
    } catch (error) {
      this.logger.error(`Error saving cookies for session ${sessionId}: ${error}`);
    }
  }

  /**
   * Load cookies from file
   */
  async loadCookies(sessionId: string, domain: string = 'linkedin.com'): Promise<StoredCookie[]> {
    try {
      const filePath = this.getCookieFilePath(sessionId, domain);
      
      if (!fs.existsSync(filePath)) {
        this.logger.debug(`No cookie file found for session ${sessionId}`);
        return [];
      }

      const fileContent = await fs.promises.readFile(filePath, 'utf-8');
      const sessionCookies: SessionCookies = JSON.parse(fileContent);

      // Check if cookies are not too old (configurable, default 30 days)
      const maxAge = this.config.get<number>('COOKIES_MAX_AGE') || (30 * 24 * 60 * 60 * 1000);
      if (Date.now() - sessionCookies.timestamp > maxAge) {
        this.logger.debug(`Cookie file too old for session ${sessionId}, ignoring`);
        return [];
      }

      return sessionCookies.cookies;
    } catch (error) {
      this.logger.warn(`Error loading cookies for session ${sessionId}: ${error}`);
      return [];
    }
  }

  /**
   * Restore cookies to browser context
   */
  async restoreCookies(sessionId: string, context: BrowserContext, domain: string = 'linkedin.com'): Promise<boolean> {
    try {
      const cookies = await this.loadCookies(sessionId, domain);
      
      if (cookies.length === 0) {
        this.logger.debug(`No cookies to restore for session ${sessionId}`);
        return false;
      }

      // Convert stored cookies to playwright format
      const playwrightCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }));

      await context.addCookies(playwrightCookies);
      
      const liAtCookie = cookies.find(c => c.name === 'li_at');
      if (liAtCookie) {
        this.logger.log(`LinkedIn cookies restored for session ${sessionId} (li_at: ${liAtCookie.value.slice(0, 10)}...)`);
      } else {
        this.logger.log(`Cookies restored for session ${sessionId} (no li_at found)`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Error restoring cookies for session ${sessionId}: ${error}`);
      return false;
    }
  }

  /**
   * Extract and save LinkedIn authentication cookie
   */
  async extractLinkedInAuth(sessionId: string, page: Page): Promise<string | null> {
    try {
      // Get all cookies for LinkedIn domain
      const cookies = await page.context().cookies('https://www.linkedin.com');
      const liAtCookie = cookies.find(cookie => cookie.name === 'li_at');
      
      if (!liAtCookie) {
        this.logger.debug(`No li_at cookie found in page for session ${sessionId}`);
        return null;
      }

      // Save all LinkedIn cookies
      await this.saveCookies(sessionId, page.context(), 'linkedin.com');

      // Also save just the li_at value to a simple text file for easy access
      const authFilePath = path.join(this.cookiesDir, `${sessionId}_linkedin_auth.txt`);
      const authData = `sessionId: ${sessionId}\nli_at: ${liAtCookie.value}\ntimestamp: ${new Date().toISOString()}\n`;
      await fs.promises.writeFile(authFilePath, authData);

      this.logger.log(`LinkedIn auth token extracted for session ${sessionId}`);
      return liAtCookie.value;
    } catch (error) {
      this.logger.error(`Error extracting LinkedIn auth for session ${sessionId}: ${error}`);
      return null;
    }
  }

  /**
   * Get the stored li_at value
   */
  async getLinkedInAuthToken(sessionId: string): Promise<string | null> {
    try {
      const cookies = await this.loadCookies(sessionId, 'linkedin.com');
      const liAtCookie = cookies.find(cookie => cookie.name === 'li_at');
      return liAtCookie?.value || null;
    } catch (error) {
      this.logger.warn(`Error getting LinkedIn auth token for session ${sessionId}: ${error}`);
      return null;
    }
  }

  /**
   * Clear saved cookies for a session
   */
  async clearCookies(sessionId: string, domain: string = 'linkedin.com'): Promise<void> {
    try {
      const filePath = this.getCookieFilePath(sessionId, domain);
      const authFilePath = path.join(this.cookiesDir, `${sessionId}_linkedin_auth.txt`);
      
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      
      if (fs.existsSync(authFilePath)) {
        await fs.promises.unlink(authFilePath);
      }

      this.logger.log(`Cookies cleared for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error clearing cookies for session ${sessionId}: ${error}`);
    }
  }

  /**
   * List all sessions with saved cookies
   */
  async listSavedSessions(): Promise<{ sessionId: string; domain: string; timestamp: number; hasLiAt: boolean }[]> {
    try {
      const files = await fs.promises.readdir(this.cookiesDir);
      const cookieFiles = files.filter(file => file.endsWith('_cookies.json'));
      
      const sessions: { sessionId: string; domain: string; timestamp: number; hasLiAt: boolean }[] = [];
      for (const file of cookieFiles) {
        try {
          const filePath = path.join(this.cookiesDir, file);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const sessionCookies: SessionCookies = JSON.parse(content);
          
          const hasLiAt = sessionCookies.cookies.some(c => c.name === 'li_at');
          
          sessions.push({
            sessionId: sessionCookies.sessionId,
            domain: sessionCookies.domain,
            timestamp: sessionCookies.timestamp,
            hasLiAt
          });
        } catch (error) {
          this.logger.warn(`Error reading cookie file ${file}: ${error}`);
        }
      }
      
      return sessions.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      this.logger.error(`Error listing saved sessions: ${error}`);
      return [];
    }
  }

  private getCookieFilePath(sessionId: string, domain: string): string {
    const sanitizedDomain = domain.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(this.cookiesDir, `${sessionId}_${sanitizedDomain}_cookies.json`);
  }
}