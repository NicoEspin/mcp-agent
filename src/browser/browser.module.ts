// src/browser/browser.module.ts
import { Module } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';
import { CookieManagerService } from './cookie-manager.service';
import { StorageStateService } from './storage-state.service';

@Module({
    providers: [PlaywrightService, CookieManagerService, StorageStateService],
  exports: [PlaywrightService, CookieManagerService, StorageStateService],
})
export class BrowserModule {}