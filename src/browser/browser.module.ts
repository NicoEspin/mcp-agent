// src/browser/browser.module.ts
import { Module } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';
import { CookieManagerService } from './cookie-manager.service';

@Module({
  providers: [PlaywrightService, CookieManagerService],
  exports: [PlaywrightService, CookieManagerService],
})
export class BrowserModule {}