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
   * Check if user is logged into LinkedIn based on li_at cookie presence (from saved files)
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
   * Check if user is logged into LinkedIn by directly checking browser context (real-time)
   */
  async isLinkedInLoggedInRealTime(sessionId: string, context: BrowserContext): Promise<boolean> {
    try {
      // Get cookies from multiple LinkedIn URLs
      const linkedinUrls = [
        'https://www.linkedin.com',
        'https://linkedin.com', 
        'https://www.linkedin.com/',
        'https://linkedin.com/',
      ];

      let allCookies: any[] = [];
      
      // Try each URL to get cookies
      for (const url of linkedinUrls) {
        try {
          const urlCookies = await context.cookies(url);
          allCookies = allCookies.concat(urlCookies);
        } catch (error) {
          this.logger.debug(`Failed to get cookies from ${url}: ${error}`);
        }
      }

      // Also get all cookies without URL filter as fallback
      try {
        const generalCookies = await context.cookies();
        allCookies = allCookies.concat(generalCookies);
      } catch (error) {
        this.logger.debug(`Failed to get general cookies: ${error}`);
      }

      // Remove duplicates and find li_at
      const uniqueCookies = allCookies.filter((cookie, index, self) => 
        index === self.findIndex(c => c.name === cookie.name && c.domain === cookie.domain)
      );

      const liAtCookie = uniqueCookies.find(cookie => cookie.name === 'li_at');
      
      if (!liAtCookie) {
        this.logger.debug(`🔍 Real-time check: No li_at cookie found for session ${sessionId} (checked ${uniqueCookies.length} cookies)`);
        return false;
      }

      // Check if cookie is expired
      if (liAtCookie.expires && liAtCookie.expires < Date.now()) {
        this.logger.debug(`🔍 Real-time check: li_at cookie expired for session ${sessionId}`);
        return false;
      }

      this.logger.log(`🔍 Real-time check: Valid li_at cookie found for session ${sessionId} (${liAtCookie.value.slice(0, 10)}... domain: ${liAtCookie.domain})`);
      return true;
    } catch (error) {
      this.logger.warn(`Error in real-time LinkedIn login check: ${error}`);
      return false;
    }
  }

  /**
   * Save cookies from browser context to file
   */
  async saveCookies(sessionId: string, context: BrowserContext, domain: string = 'linkedin.com'): Promise<void> {
    try {
      // Get cookies from multiple LinkedIn URLs to ensure we catch li_at
      const linkedinUrls = [
        'https://www.linkedin.com',
        'https://linkedin.com', 
        'https://www.linkedin.com/',
        'https://linkedin.com/',
      ];

      let allCookies: any[] = [];
      
      // Try each URL to get cookies
      for (const url of linkedinUrls) {
        try {
          const urlCookies = await context.cookies(url);
          allCookies = allCookies.concat(urlCookies);
          this.logger.debug(`Retrieved ${urlCookies.length} cookies from ${url} for session ${sessionId}`);
        } catch (error) {
          this.logger.debug(`Failed to get cookies from ${url}: ${error}`);
        }
      }

      // Also get all cookies without URL filter as fallback
      try {
        const generalCookies = await context.cookies();
        allCookies = allCookies.concat(generalCookies);
        this.logger.debug(`Retrieved ${generalCookies.length} general cookies for session ${sessionId}`);
      } catch (error) {
        this.logger.debug(`Failed to get general cookies: ${error}`);
      }

      // Remove duplicates based on name+domain
      const uniqueCookies = allCookies.filter((cookie, index, self) => 
        index === self.findIndex(c => c.name === cookie.name && c.domain === cookie.domain)
      );

      // Filter cookies for LinkedIn domains (much more flexible)
      const domainCookies = uniqueCookies.filter(cookie => {
        const cookieDomain = cookie.domain.toLowerCase();
        return cookieDomain.includes('linkedin.com') || 
               cookieDomain === domain || 
               cookieDomain === `.${domain}` ||
               cookieDomain === `www.${domain}` ||
               cookieDomain.endsWith('.linkedin.com');
      });

      // Debug: Log all cookie names and domains we found
      this.logger.debug(`Found ${domainCookies.length} LinkedIn cookies for session ${sessionId}:`);
      domainCookies.forEach(cookie => {
        this.logger.debug(`  Cookie: ${cookie.name} (domain: ${cookie.domain})`);
      });

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
        this.logger.log(`✅ LinkedIn cookies saved for session ${sessionId} (li_at: ${liAtCookie.value.slice(0, 10)}... domain: ${liAtCookie.domain})`);
      } else {
        this.logger.warn(`⚠️ Cookies saved for session ${sessionId} but NO li_at found! Found cookies: ${domainCookies.map(c => c.name).join(', ')}`);
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
      // Use real-time check to get li_at cookie
      const context = page.context();
      const isLoggedIn = await this.isLinkedInLoggedInRealTime(sessionId, context);
      
      if (!isLoggedIn) {
        this.logger.debug(`No li_at cookie found in real-time check for session ${sessionId}`);
        return null;
      }

      // Get the actual li_at cookie value using the same comprehensive approach
      const linkedinUrls = [
        'https://www.linkedin.com',
        'https://linkedin.com', 
        'https://www.linkedin.com/',
        'https://linkedin.com/',
      ];

      let allCookies: any[] = [];
      
      for (const url of linkedinUrls) {
        try {
          const urlCookies = await context.cookies(url);
          allCookies = allCookies.concat(urlCookies);
        } catch (error) {
          this.logger.debug(`Failed to get cookies from ${url}: ${error}`);
        }
      }

      // Also get all cookies as fallback
      try {
        const generalCookies = await context.cookies();
        allCookies = allCookies.concat(generalCookies);
      } catch (error) {
        this.logger.debug(`Failed to get general cookies: ${error}`);
      }

      const uniqueCookies = allCookies.filter((cookie, index, self) => 
        index === self.findIndex(c => c.name === cookie.name && c.domain === cookie.domain)
      );

      const liAtCookie = uniqueCookies.find(cookie => cookie.name === 'li_at');
      
      if (!liAtCookie) {
        this.logger.debug(`No li_at cookie found after comprehensive search for session ${sessionId}`);
        return null;
      }

      // Save all LinkedIn cookies
      await this.saveCookies(sessionId, context, 'linkedin.com');

      // Also save just the li_at value to a simple text file for easy access
      const authFilePath = path.join(this.cookiesDir, `${sessionId}_linkedin_auth.txt`);
      const authData = `sessionId: ${sessionId}\nli_at: ${liAtCookie.value}\ntimestamp: ${new Date().toISOString()}\ndomain: ${liAtCookie.domain}\n`;
      await fs.promises.writeFile(authFilePath, authData);

      this.logger.log(`✅ LinkedIn auth token extracted for session ${sessionId} (li_at: ${liAtCookie.value.slice(0, 10)}... domain: ${liAtCookie.domain})`);
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