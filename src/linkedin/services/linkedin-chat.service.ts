// src/linkedin/services/linkedin-chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { extractFirstText } from '../utils/mcp-utils';
import { buildEnsureOnUrlSnippet } from '../utils/navigation-snippets';

type SessionId = string;

@Injectable()
export class LinkedinChatService {
  private readonly logger = new Logger(LinkedinChatService.name);

  constructor(private readonly playwright: PlaywrightService) {}
  private buildCloseChatCode() {
    return `
async (page) => {
  const debug = (msg) => console.log('[close-chat]', msg, 'url=', page.url());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const firstVisible = async (loc) => {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {}
    }
    return null;
  };

  const iconSel = 'svg[data-test-icon="close-small"], use[href="#close-small"]';

  // Prefer overlay root to avoid clicking random close icons elsewhere
  const overlayRoot = page.locator(
    '.msg-overlay-container, .msg-overlay-list-bubble, .msg-overlay-conversation-bubble'
  ).first();

  // Prefer: last visible bubble (most likely the one we opened)
  const bubble = page.locator('.msg-overlay-conversation-bubble:visible').last();

  // Capture a "before" snapshot of visible bubbles (best-effort)
  const beforeVisibleBubbles = await page.locator('.msg-overlay-conversation-bubble:visible').count().catch(() => 0);

  const candidates = [];

  // 1) Bubble scoped close control with icon
  candidates.push(
    bubble
      .locator('button.msg-overlay-bubble-header__control')
      .filter({ has: bubble.locator(iconSel) })
  );

  // 2) Bubble scoped aria-label (dynamic name)
  candidates.push(
    bubble.locator(
      [
        'button[aria-label^="Cierra tu conversación"]',
        'button[aria-label^="Close your conversation"]',
        'button[aria-label^="Cerrar conversación"]',
        'button[aria-label^="Close conversation"]',
      ].join(', ')
    )
  );

  // 3) Global (but still messaging-related): header control w/ icon
  candidates.push(
    page
      .locator('button.msg-overlay-bubble-header__control')
      .filter({ has: page.locator(iconSel) })
  );

  // 4) Role/name fallback (still specific text)
  candidates.push(
    page.getByRole('button', {
      name: /cierra tu conversación|close your conversation|cerrar conversación|close conversation/i,
    })
  );

  // 5) Icon-only fallback BUT scoped to overlay area only
  candidates.push(
    overlayRoot
      .locator('button')
      .filter({ has: overlayRoot.locator('svg[data-test-icon="close-small"]') })
  );
  candidates.push(
    overlayRoot
      .locator('button')
      .filter({ has: overlayRoot.locator('use[href="#close-small"]') })
  );

  let clicked = false;

  for (const loc of candidates) {
    const btn = await firstVisible(loc);
    if (!btn) continue;

    try {
      await debug('Found close candidate -> clicking');
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 8000, force: true });
      clicked = true;
      break;
    } catch {
      await debug('Click failed, trying next candidate');
    }
  }

  if (!clicked) {
    await debug('No close button found -> ESC fallback');
    try {
      await page.keyboard.press('Escape');
      await sleep(120);
      await page.keyboard.press('Escape');
    } catch {}
  }

  await sleep(250);

  // After-state checks:
  const afterVisibleBubbles = await page.locator('.msg-overlay-conversation-bubble:visible').count().catch(() => beforeVisibleBubbles);

  // Also check if the bubble we targeted is still visible (best-effort)
  const bubbleStillVisible = await bubble.isVisible().catch(() => false);

  // Consider it "closed" if bubble count decreased OR targeted bubble disappeared
  const closed = (!bubbleStillVisible) || (afterVisibleBubbles < beforeVisibleBubbles);

  return { ok: true, clicked, closed, beforeVisibleBubbles, afterVisibleBubbles };
}
`;
  }

  async closeChatOverlay(sessionId: string) {
    const code = this.buildCloseChatCode();
    return this.playwright.runCode(code, sessionId);
  }

  // ✅ UPDATED: buildReadChatCode con ensureOnUrl (skip si ya está en la URL)
  private buildReadChatCode(
    profileUrl: string,
    limit: number,
    threadHint?: string,
  ) {
    return `
async (page) => {
  ${buildEnsureOnUrlSnippet()}
  const profileUrl = ${JSON.stringify(profileUrl)};
  const limit = ${JSON.stringify(limit)};
  const threadHint = ${JSON.stringify(threadHint ?? '')};

  const debug = (msg) => console.log('[read-chat]', msg, 'url=', page.url());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -----------------------------
  // 1) Ir al perfil (solo si hace falta)
  // -----------------------------
  const nav = await ensureOnUrl(profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 25000,
    settleMs: 800,
    allowSubpaths: false,
  });
  await debug('ensureOnUrl -> ' + JSON.stringify(nav));
  await debug('Perfil listo');

  const main = page.locator('main').first();
  const topCard = main
    .locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2')
    .first();
  const scope = (await topCard.count()) ? topCard : main;

  // -----------------------------
  // 2) Encontrar CTA mensaje (con fallbacks)
  // -----------------------------
  const findMessageButton = async () => {
    let loc = scope
      .locator('button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]')
      .first();
    if (await loc.count()) return loc;

    loc = main
      .locator('button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]')
      .first();
    if (await loc.count()) return loc;

    loc = scope.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
    if (await loc.count()) return loc;

    loc = main.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
    if (await loc.count()) return loc;

    // Icon fallback (si el texto no está)
    const icon = scope
      .locator(
        'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
        'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
      )
      .first();

    if (await icon.count()) {
      const btn = icon.locator('xpath=ancestor::button[1]').first();
      if (await btn.count()) return btn;
    }

    const icon2 = main
      .locator(
        'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
        'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
      )
      .first();

    if (await icon2.count()) {
      const btn = icon2.locator('xpath=ancestor::button[1]').first();
      if (await btn.count()) return btn;
    }

    return null;
  };

  let messageBtn = await findMessageButton();

  // -----------------------------
  // 3) Overflow "Más" si no hay CTA
  // -----------------------------
  if (!messageBtn) {
    await debug('CTA mensaje no encontrado. Probando overflow del perfil');

    const moreBtn = scope
      .locator(
        'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
        'button[data-view-name="profile-overflow-button"][aria-label="More"]'
      )
      .first();

    if (await moreBtn.count()) {
      await moreBtn.scrollIntoViewIfNeeded().catch(() => {});
      await moreBtn.click({ timeout: 8000, force: true });
      await page.waitForTimeout(200);

      const msgItem = page
        .getByRole('menuitem', { name: /enviar mensaje|mensaje|message/i })
        .first();

      if (await msgItem.count()) {
        await msgItem.click({ timeout: 8000 });
      } else {
        throw new Error('No se encontró opción de mensaje en el menú Más del perfil.');
      }
    } else {
      throw new Error('No se encontró CTA de mensaje ni overflow del perfil.');
    }
  } else {
    const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
    if (/para negocios|for business/i.test(aria)) {
      throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
    }

    await debug('Click CTA Enviar mensaje');
    await messageBtn.scrollIntoViewIfNeeded().catch(() => {});
    await messageBtn.click({ timeout: 8000, force: true });
  }

  // -----------------------------
  // 4) Esperar wrapper del overlay (overlay vs inline) con múltiples fallbacks
  // -----------------------------
  await page.waitForTimeout(500);

  const containerCandidates = [
    page.locator('.msg-overlay-conversation-bubble__content-wrapper').last(),
    page.locator('.msg-s-message-list').last(),
    page.locator('.msg-overlay-conversation-bubble').last(),
    page.locator('[role="main"] .msg-conversation-listitem').last(),
    page.locator('.msg-conversation__body').last(),
    page.locator('.msg-thread').last(),
    page.locator('[data-view-name*="conversation"]').last(),
    page.locator('.conversation-wrapper').last(),
    page.locator('main').last(),
  ];

  let root = null;

  // Try each container candidate
  for (const candidate of containerCandidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 2000 });
      root = candidate;
      const containerType = await candidate.evaluate(el => el.className || el.tagName);
      await debug(\`Container detected: \${containerType}\`);
      break;
    } catch {
      // Continue to next candidate
    }
  }

  // ✅ FALLBACK: If no specific container found, use the page body but with more targeted selectors
  if (!root) {
    await debug('No specific conversation container found, using fallback to body');
    root = page.locator('body');
  }

  // -----------------------------
  // 5) Enhanced scroll to load ALL chat history
  // -----------------------------
  await debug('Starting comprehensive message scrolling to load entire chat history...');
  
  const scrollToLoadAllMessages = async () => {
    const scrollContainers = [
      '.msg-s-message-list',
      '.msg-overlay-conversation-bubble__content-wrapper',
      '.msg-conversation__body',
      '.msg-thread',
      '[data-view-name*="conversation"]',
      '.msg-overlay-conversation-bubble',
    ];
    
    let scrollContainer = null;
    
    // Find the scrollable container with enhanced detection
    for (const selector of scrollContainers) {
      const container = root.locator(selector).first();
      if (await container.count() && await container.isVisible().catch(() => false)) {
        // Check if container is actually scrollable
        const isScrollable = await container.evaluate((el) => {
          return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
        }).catch(() => false);
        
        if (isScrollable) {
          scrollContainer = container;
          await debug(\`Found scrollable container: \${selector}\`);
          break;
        }
      }
    }
    
    if (!scrollContainer) {
      await debug('No specific scrollable container found, using page for scrolling');
      scrollContainer = page.locator('body');
    }
    
    // Enhanced message counting with multiple selectors
    const countMessages = async () => {
      return await root.evaluate((rootEl) => {
        const selectors = [
          '.msg-s-event-listitem',
          '.msg-s-message-group',
          '.msg-s-message-list__event',
          '.conversation-message-item',
          'li[data-event-urn]',
          '[data-view-name*="message-list-item"]'
        ];
        
        const allMessages = new Set();
        for (const selector of selectors) {
          const elements = rootEl.querySelectorAll(selector);
          elements.forEach(el => {
            // Use unique identifier to avoid duplicates
            const id = el.getAttribute('data-event-urn') || 
                      el.getAttribute('data-message-id') || 
                      el.id || 
                      el.textContent?.slice(0, 50);
            if (id) allMessages.add(id);
          });
        }
        
        return allMessages.size;
      });
    };
    
    // Enhanced date header counting to track loading progress
    const countDateHeaders = async () => {
      return await root.evaluate((rootEl) => {
        const headers = rootEl.querySelectorAll('.msg-s-message-list__time-heading, time.msg-s-message-list__time-heading');
        return headers.length;
      });
    };

    // Check for loading indicators and wait if present
    const waitForLoading = async () => {
      const hasLoading = await page.evaluate(() => {
        const indicators = [
          '.loading', '.spinner', '[data-loading="true"]',
          '.msg-s-message-list-loading', '.conversation-loading',
          '.artdeco-spinner', '.loader'
        ];
        return indicators.some(sel => document.querySelector(sel));
      }).catch(() => false);
      
      if (hasLoading) {
        await debug('Loading indicator detected, waiting...');
        await sleep(2000);
        return true;
      }
      return false;
    };
    
    let totalScrollAttempts = 0;
    const maxTotalAttempts = 40;
    const scrollDelay = 800;
    let initialMessageCount = 0;
    let initialDateHeaders = 0;
    
    // Get initial counts
    initialMessageCount = await countMessages();
    initialDateHeaders = await countDateHeaders();
    
    await debug(\`Initial state: \${initialMessageCount} messages, \${initialDateHeaders} date headers\`);
    
    // 🔄 PHASE 1: Scroll UP to load ALL older messages
    await debug('=== PHASE 1: Loading older messages by scrolling UP ===');
    
    let previousMessageCount = initialMessageCount;
    let currentMessageCount = initialMessageCount;
    let upScrollAttempts = 0;
    const maxUpScrolls = 20;
    let noUpProgressCount = 0;
    
    do {
      previousMessageCount = currentMessageCount;
      
      // Multiple UP scrolling strategies
      try {
        // Strategy 1: Scroll to absolute top
        await scrollContainer.evaluate((el) => {
          el.scrollTo({ top: 0, behavior: 'instant' });
        });
        await sleep(200);
        
        // Strategy 2: Keyboard navigation UP
        await scrollContainer.focus().catch(() => {});
        await scrollContainer.press('Home').catch(() => {});
        await sleep(200);
        
        // Strategy 3: Multiple Page Up presses
        for (let i = 0; i < 5; i++) {
          await scrollContainer.press('PageUp').catch(() => {});
          await sleep(100);
        }
        
        // Strategy 4: Ctrl+Home for document top
        await page.keyboard.down('Control').catch(() => {});
        await page.keyboard.press('Home').catch(() => {});
        await page.keyboard.up('Control').catch(() => {});
        await sleep(200);
        
        // Strategy 5: Mouse wheel UP scrolling
        if (upScrollAttempts % 3 === 0) {
          await scrollContainer.hover().catch(() => {});
          for (let i = 0; i < 10; i++) {
            await page.mouse.wheel(0, -800).catch(() => {});
            await sleep(50);
          }
        }
        
      } catch (e) {
        await debug(\`UP scroll strategy error: \${e.message}\`);
      }
      
      await sleep(scrollDelay);
      await waitForLoading();
      
      // Update counts
      currentMessageCount = await countMessages();
      const messageProgress = currentMessageCount - previousMessageCount;
      
      await debug(\`UP Scroll \${upScrollAttempts + 1}: \${currentMessageCount} messages (+\${messageProgress})\`);
      
      if (messageProgress <= 0) {
        noUpProgressCount++;
      } else {
        noUpProgressCount = 0;
      }
      
      upScrollAttempts++;
      totalScrollAttempts++;
      
      const shouldContinueUp = (messageProgress > 0 && upScrollAttempts < maxUpScrolls) || 
                              (upScrollAttempts < 3) || 
                              (noUpProgressCount < 2);
      
      if (!shouldContinueUp) break;
      
    } while (upScrollAttempts < maxUpScrolls && totalScrollAttempts < maxTotalAttempts);
    
    const messagesAfterUpScroll = currentMessageCount;
    await debug(\`=== UP SCROLL COMPLETE: \${messagesAfterUpScroll} total messages (+\${messagesAfterUpScroll - initialMessageCount} from scrolling up) ===\`);
    
    // 🔄 PHASE 2: Scroll DOWN to load ALL newer messages  
    await debug('=== PHASE 2: Loading newer messages by scrolling DOWN ===');
    
    previousMessageCount = messagesAfterUpScroll;
    currentMessageCount = messagesAfterUpScroll;
    let downScrollAttempts = 0;
    const maxDownScrolls = 20;
    let noDownProgressCount = 0;
    
    do {
      previousMessageCount = currentMessageCount;
      
      // Multiple DOWN scrolling strategies
      try {
        // Strategy 1: Scroll to absolute bottom
        await scrollContainer.evaluate((el) => {
          el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
        });
        await sleep(200);
        
        // Strategy 2: Keyboard navigation DOWN
        await scrollContainer.focus().catch(() => {});
        await scrollContainer.press('End').catch(() => {});
        await sleep(200);
        
        // Strategy 3: Multiple Page Down presses
        for (let i = 0; i < 5; i++) {
          await scrollContainer.press('PageDown').catch(() => {});
          await sleep(100);
        }
        
        // Strategy 4: Ctrl+End for document bottom
        await page.keyboard.down('Control').catch(() => {});
        await page.keyboard.press('End').catch(() => {});
        await page.keyboard.up('Control').catch(() => {});
        await sleep(200);
        
        // Strategy 5: Mouse wheel DOWN scrolling
        if (downScrollAttempts % 3 === 0) {
          await scrollContainer.hover().catch(() => {});
          for (let i = 0; i < 10; i++) {
            await page.mouse.wheel(0, 800).catch(() => {});
            await sleep(50);
          }
        }
        
      } catch (e) {
        await debug(\`DOWN scroll strategy error: \${e.message}\`);
      }
      
      await sleep(scrollDelay);
      await waitForLoading();
      
      // Update counts
      currentMessageCount = await countMessages();
      const messageProgress = currentMessageCount - previousMessageCount;
      
      await debug(\`DOWN Scroll \${downScrollAttempts + 1}: \${currentMessageCount} messages (+\${messageProgress})\`);
      
      if (messageProgress <= 0) {
        noDownProgressCount++;
      } else {
        noDownProgressCount = 0;
      }
      
      downScrollAttempts++;
      totalScrollAttempts++;
      
      const shouldContinueDown = (messageProgress > 0 && downScrollAttempts < maxDownScrolls) || 
                                (downScrollAttempts < 3) || 
                                (noDownProgressCount < 2);
      
      if (!shouldContinueDown) break;
      
    } while (downScrollAttempts < maxDownScrolls && totalScrollAttempts < maxTotalAttempts);
    
    const finalMessageCount = currentMessageCount;
    const finalDateHeaders = await countDateHeaders();
    
    await debug(\`=== DOWN SCROLL COMPLETE: \${finalMessageCount} total messages (+\${finalMessageCount - messagesAfterUpScroll} from scrolling down) ===\`);
    
    // Final scroll to top for consistent extraction starting point
    try {
      await scrollContainer.evaluate((el) => {
        el.scrollTo({ top: 0, behavior: 'instant' });
      });
      await sleep(500);
    } catch (e) {
      await debug(\`Final positioning scroll error: \${e.message}\`);
    }
    
    await debug(\`BI-DIRECTIONAL SCROLL COMPLETE: \${finalMessageCount} total messages (\${finalMessageCount - initialMessageCount} new), \${finalDateHeaders} date headers, \${totalScrollAttempts} total attempts\`);
    
    return {
      finalMessageCount: finalMessageCount,
      finalDateHeaders: finalDateHeaders,
      scrollAttempts: totalScrollAttempts,
      upScrollAttempts: upScrollAttempts,
      downScrollAttempts: downScrollAttempts,
      messagesFromUpScroll: messagesAfterUpScroll - initialMessageCount,
      messagesFromDownScroll: finalMessageCount - messagesAfterUpScroll
    };
  };
  
  const scrollResult = await scrollToLoadAllMessages();
  await debug(\`Scroll result: \${JSON.stringify(scrollResult)}\`);

  // -----------------------------
  // 6) Multiple extraction strategies - run ALL and return the best one
  // -----------------------------
  const payload = await root.evaluate((rootEl) => {
    const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();

    const pickFirst = (node, selectors) => {
      if (!node) return null;
      for (const sel of selectors) {
        const el = node.querySelector(sel);
        if (!el) continue;
        const raw =
          norm(el.getAttribute?.('aria-label')) ||
          norm(el.getAttribute?.('datetime')) ||
          norm(el.textContent);
        if (raw) return raw;
      }
      return null;
    };

    // ✅ ENHANCED: Comprehensive datetime extraction with LinkedIn date grouping support
    const extractDateTime = (timeRaw, dateContext = null) => {
      const s = norm(timeRaw);
      if (!s) return { timeRaw: null, time: null, datetime: null, dateContext: dateContext };

      // Parse time component with multiple fallbacks
      let parsedTime = null;
      let hour24 = null;
      let minute = null;

      // Strategy 1: 12-hour format (1:23 PM, 11:45 AM)
      const m12 = s.match(/\\b(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\b/i);
      if (m12) {
        let hh = parseInt(m12[1], 10);
        const mm = parseInt(m12[2], 10);
        const ap = m12[3].toUpperCase();
        if (ap === 'PM' && hh < 12) hh += 12;
        if (ap === 'AM' && hh === 12) hh = 0;
        hour24 = hh;
        minute = mm;
        parsedTime = \`\${String(hh).padStart(2, '0')}:\${String(mm).padStart(2, '0')}\`;
      }

      // Strategy 2: 24-hour format (13:21, 09:30)
      if (!parsedTime) {
        const m24 = s.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
        if (m24) {
          const hh = parseInt(m24[1], 10);
          const mm = parseInt(m24[2], 10);
          if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            hour24 = hh;
            minute = mm;
            parsedTime = \`\${String(hh).padStart(2, '0')}:\${String(mm).padStart(2, '0')}\`;
          }
        }
      }

      // Strategy 3: Time with seconds (13:21:45)
      if (!parsedTime) {
        const mSec = s.match(/\\b(\\d{1,2}):(\\d{2}):(\\d{2})\\b/);
        if (mSec) {
          const hh = parseInt(mSec[1], 10);
          const mm = parseInt(mSec[2], 10);
          if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            hour24 = hh;
            minute = mm;
            parsedTime = \`\${String(hh).padStart(2, '0')}:\${String(mm).padStart(2, '0')}\`;
          }
        }
      }

      let fullDateTime = null;
      
      // Create full datetime if we have both time and date context
      if (parsedTime && dateContext && hour24 !== null && minute !== null) {
        try {
          // Handle different date context formats
          let targetDate = new Date();
          const today = new Date();
          let parsedSuccessfully = false;
          
          if (typeof dateContext === 'string') {
            const dateText = dateContext.toLowerCase().trim();
            
            // Strategy 1: Handle relative dates (Today, Yesterday, etc.)
            if (['today', 'hoy', 'hoje'].includes(dateText)) {
              targetDate = new Date(today);
              parsedSuccessfully = true;
            } else if (['yesterday', 'ayer', 'ontem'].includes(dateText)) {
              targetDate = new Date(today);
              targetDate.setDate(today.getDate() - 1);
              parsedSuccessfully = true;
            }
            
            // Strategy 2: Parse specific dates (16 dic, 16 December, etc.)
            if (!parsedSuccessfully) {
              // Spanish months
              const spanishMonths = {
                'ene': 0, 'enero': 0,
                'feb': 1, 'febrero': 1, 'febr': 1,
                'mar': 2, 'marzo': 2,
                'abr': 3, 'abril': 3,
                'may': 4, 'mayo': 4,
                'jun': 5, 'junio': 5,
                'jul': 6, 'julio': 6,
                'ago': 7, 'agosto': 7,
                'sep': 8, 'septiembre': 8, 'sept': 8,
                'oct': 9, 'octubre': 9,
                'nov': 10, 'noviembre': 10,
                'dic': 11, 'diciembre': 11
              };
              
              // English months
              const englishMonths = {
                'jan': 0, 'january': 0,
                'feb': 1, 'february': 1,
                'mar': 2, 'march': 2,
                'apr': 3, 'april': 3,
                'may': 4,
                'jun': 5, 'june': 5,
                'jul': 6, 'july': 6,
                'aug': 7, 'august': 7,
                'sep': 8, 'september': 8, 'sept': 8,
                'oct': 9, 'october': 9,
                'nov': 10, 'november': 11,
                'dec': 11, 'december': 11
              };
              
              // Combined months mapping
              const allMonths = { ...spanishMonths, ...englishMonths };
              
              // Pattern 1: "16 dic", "16 December", "16 de diciembre"
              const datePattern1 = dateText.match(/^(\\d{1,2})\\s+(?:de\\s+)?(\\w+)$/);
              if (datePattern1) {
                const day = parseInt(datePattern1[1], 10);
                const monthStr = datePattern1[2];
                const monthIndex = allMonths[monthStr];
                
                if (monthIndex !== undefined && day >= 1 && day <= 31) {
                  // Determine the year (current year or previous year)
                  const currentYear = today.getFullYear();
                  const currentMonth = today.getMonth();
                  const currentDay = today.getDate();
                  
                  // Try current year first
                  targetDate = new Date(currentYear, monthIndex, day);
                  
                  // If the date is in the future, it might be from last year
                  if (targetDate > today) {
                    targetDate = new Date(currentYear - 1, monthIndex, day);
                  }
                  
                  parsedSuccessfully = true;
                  console.log(\`[datetime-extract] Parsed date "\${dateText}" as \${targetDate.toDateString()}\`);
                }
              }
              
              // Pattern 2: "December 16", "diciembre 16"
              if (!parsedSuccessfully) {
                const datePattern2 = dateText.match(/^(\\w+)\\s+(\\d{1,2})$/);
                if (datePattern2) {
                  const monthStr = datePattern2[1];
                  const day = parseInt(datePattern2[2], 10);
                  const monthIndex = allMonths[monthStr];
                  
                  if (monthIndex !== undefined && day >= 1 && day <= 31) {
                    const currentYear = today.getFullYear();
                    targetDate = new Date(currentYear, monthIndex, day);
                    
                    if (targetDate > today) {
                      targetDate = new Date(currentYear - 1, monthIndex, day);
                    }
                    
                    parsedSuccessfully = true;
                    console.log(\`[datetime-extract] Parsed date "\${dateText}" as \${targetDate.toDateString()}\`);
                  }
                }
              }
            }
            
            // Strategy 3: Parse day names (Monday, Tuesday, jueves, lunes, etc.)
            if (!parsedSuccessfully) {
              const dayNames = {
                // English days
                'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6,
                'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6,
                // Spanish days
                'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3, 'jueves': 4, 'viernes': 5, 'sábado': 6,
                'dom': 0, 'lun': 1, 'mar': 2, 'mié': 3, 'jue': 4, 'vie': 5, 'sáb': 6
              };
              
              const dayIndex = dayNames[dateText];
              if (dayIndex !== undefined) {
                // Calculate the most recent occurrence of this weekday
                const todayDay = today.getDay();
                let daysBack = (todayDay - dayIndex + 7) % 7;
                if (daysBack === 0) {
                  // If it's the same day, check if the time has passed
                  const nowHour = today.getHours();
                  const nowMinute = today.getMinutes();
                  if (hour24 > nowHour || (hour24 === nowHour && minute > nowMinute)) {
                    // Time hasn't passed today, so it's last week
                    daysBack = 7;
                  }
                }
                
                targetDate = new Date(today);
                targetDate.setDate(today.getDate() - daysBack);
                parsedSuccessfully = true;
                console.log(\`[datetime-extract] Parsed weekday "\${dateText}" as \${targetDate.toDateString()}\`);
              }
            }
          } else if (dateContext instanceof Date) {
            // Direct date object
            targetDate = new Date(dateContext);
            parsedSuccessfully = true;
          }
          
          // Apply the time to the target date
          if (parsedSuccessfully) {
            targetDate.setHours(hour24, minute, 0, 0);
            fullDateTime = targetDate.toISOString();
          } else {
            // Fallback: use today's date with the time
            console.log(\`[datetime-extract] Could not parse date context "\${dateContext}", using today\`);
            targetDate = new Date();
            targetDate.setHours(hour24, minute, 0, 0);
            fullDateTime = targetDate.toISOString();
          }
          
        } catch (e) {
          // Fallback on datetime creation error
          console.log(\`[datetime-extract] Error creating datetime: \${e.message}\`);
          fullDateTime = null;
        }
      }

      return { 
        timeRaw: s, 
        time: parsedTime, 
        datetime: fullDateTime,
        dateContext: dateContext,
        hour24: hour24,
        minute: minute 
      };
    };

    // ✅ ENHANCED: Extract date headers and build accurate date context mapping
    const extractDateHeaders = () => {
      const dateHeaders = Array.from(rootEl.querySelectorAll('.msg-s-message-list__time-heading, time.msg-s-message-list__time-heading'));
      const dateMap = new Map();
      
      console.log(\`[date-extract] Found \${dateHeaders.length} date headers\`);
      
      // Strategy 1: Use TreeWalker to traverse DOM in document order
      const walker = document.createTreeWalker(
        rootEl,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: function(node) {
            // Accept date headers and message elements
            if (node.classList.contains('msg-s-message-list__time-heading') ||
                node.tagName === 'TIME' && node.classList.contains('msg-s-message-list__time-heading') ||
                node.classList.contains('msg-s-event-listitem') ||
                node.classList.contains('msg-s-message-group') ||
                node.classList.contains('msg-s-message-list__event')) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        },
        false
      );
      
      let currentDateContext = null;
      let node;
      
      while (node = walker.nextNode()) {
        // Check if this is a date header
        if ((node.classList.contains('msg-s-message-list__time-heading') || 
            (node.tagName === 'TIME' && node.classList.contains('msg-s-message-list__time-heading')))) {
          const dateText = norm(node.textContent);
          if (dateText) {
            currentDateContext = dateText;
            console.log(\`[date-extract] Found date header: "\${dateText}"\`);
          }
        }
        // Check if this is a message element
        else if (currentDateContext && (
          node.classList.contains('msg-s-event-listitem') ||
          node.classList.contains('msg-s-message-group') ||
          node.classList.contains('msg-s-message-list__event'))) {
          dateMap.set(node, currentDateContext);
        }
      }
      
      // Strategy 2: Fallback using DOM position for elements not caught by TreeWalker
      const allMessages = Array.from(rootEl.querySelectorAll('.msg-s-event-listitem, .msg-s-message-group, .msg-s-message-list__event'));
      
      for (const message of allMessages) {
        if (!dateMap.has(message)) {
          // Find the closest preceding date header using DOM traversal
          let current = message;
          let foundDateHeader = null;
          
          // Walk backwards through the DOM
          while (current && current !== rootEl) {
            // Check previous siblings
            let prevSibling = current.previousElementSibling;
            while (prevSibling) {
              const dateHeader = prevSibling.querySelector('.msg-s-message-list__time-heading, time.msg-s-message-list__time-heading');
              if (dateHeader) {
                foundDateHeader = norm(dateHeader.textContent);
                break;
              }
              if (prevSibling.classList.contains('msg-s-message-list__time-heading') ||
                  (prevSibling.tagName === 'TIME' && prevSibling.classList.contains('msg-s-message-list__time-heading'))) {
                foundDateHeader = norm(prevSibling.textContent);
                break;
              }
              prevSibling = prevSibling.previousElementSibling;
            }
            
            if (foundDateHeader) break;
            
            // Move up to parent and continue search
            current = current.parentElement;
          }
          
          if (foundDateHeader) {
            dateMap.set(message, foundDateHeader);
          }
        }
      }
      
      // Strategy 3: Final fallback using document.compareDocumentPosition
      for (const message of allMessages) {
        if (!dateMap.has(message)) {
          let closestHeader = null;
          let closestDistance = Infinity;
          
          for (const header of dateHeaders) {
            // Check if header comes before this message in document order
            const position = header.compareDocumentPosition(message);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
              // Calculate approximate distance (simple heuristic)
              const headerRect = header.getBoundingClientRect();
              const messageRect = message.getBoundingClientRect();
              const distance = Math.abs(messageRect.top - headerRect.bottom);
              
              if (distance < closestDistance) {
                closestDistance = distance;
                closestHeader = header;
              }
            }
          }
          
          if (closestHeader) {
            const dateText = norm(closestHeader.textContent);
            if (dateText) {
              dateMap.set(message, dateText);
            }
          }
        }
      }
      
      console.log(\`[date-extract] Successfully mapped \${dateMap.size} message elements to date contexts\`);
      
      // Debug: Print some mappings
      let debugCount = 0;
      for (const [element, dateContext] of dateMap.entries()) {
        if (debugCount < 5) {
          const messageText = element.querySelector('.msg-s-event-listitem__body')?.textContent?.slice(0, 30) || 'no text';
          console.log(\`[date-extract] Message "\${messageText}..." -> Date context "\${dateContext}"\`);
          debugCount++;
        }
      }
      
      return dateMap;
    };

    const dateContextMap = extractDateHeaders();

    // ✅ ENHANCED: Improved sender name extraction with more fallbacks
    const getSenderName = (group) => {
      // Strategy 1: Standard LinkedIn selectors
      let name = norm(group.querySelector('.msg-s-message-group__name')?.textContent) ||
                 norm(group.querySelector('.msg-s-message-group__profile-link')?.textContent) ||
                 norm(group.querySelector('[data-anonymize="person-name"]')?.textContent) ||
                 norm(group.querySelector('a[data-test-app-aware-link] .msg-s-message-group__name')?.textContent) ||
                 norm(group.querySelector('a[data-test-app-aware-link]')?.textContent);
      
      if (name) return name;
      
      // Strategy 2: Enhanced meta container extraction
      const metaContainer = group.querySelector('.msg-s-message-group__meta');
      if (metaContainer) {
        name = norm(metaContainer.querySelector('.msg-s-message-group__name')?.textContent) ||
               norm(metaContainer.querySelector('a[href*="/in/"]')?.textContent) ||
               norm(metaContainer.querySelector('[data-test-app-aware-link]')?.textContent);
        if (name) return name;
      }
      
      // Strategy 3: Image attributes (enhanced)
      const imgs = group.querySelectorAll('img.msg-s-event-listitem__profile-picture, img[alt], img[title], img[data-ghost-person]');
      for (const img of imgs) {
        name = norm(img.getAttribute('title')) || norm(img.getAttribute('alt')) || norm(img.getAttribute('aria-label'));
        if (name && !name.match(/^(profile|foto|picture|image)$/i)) return name;
      }
      
      // Strategy 4: Enhanced accessibility text parsing
      const a11yTexts = group.querySelectorAll('.a11y-text, .visually-hidden, [aria-label]');
      for (const a11y of a11yTexts) {
        const text = a11y.textContent || a11y.getAttribute('aria-label');
        if (text) {
          // Parse patterns like "View Santiago's profile", "Santiago sent a message"
          const patterns = [
            /View\\s+(.+?)'?s?\\s+profile/i,
            /(.+?)\\s+sent\\s+a\\s+message/i,
            /Message\\s+from\\s+(.+)/i,
            /(.+?)\\s+dice:/i,
            /(.+?)\\s+says:/i
          ];
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
              name = norm(match[1]);
              if (name) return name;
            }
          }
        }
      }
      
      // Strategy 5: Profile link structure (enhanced)
      const profileLinks = group.querySelectorAll('a[href*="/in/"], a[href*="linkedin.com"]');
      for (const link of profileLinks) {
        // Try text content of the link
        name = norm(link.textContent);
        if (name && name.length > 1 && !name.match(/^(profile|perfil|view|ver)$/i)) return name;
        
        // Try nested elements
        const nested = link.querySelector('.msg-s-message-group__name, [data-anonymize="person-name"], strong, span');
        if (nested) {
          name = norm(nested.textContent);
          if (name) return name;
        }
        
        // Try associated images
        const linkImg = link.querySelector('img[alt], img[title]');
        if (linkImg) {
          name = norm(linkImg.getAttribute('title')) || norm(linkImg.getAttribute('alt'));
          if (name && !name.match(/^(profile|foto|picture|image)$/i)) return name;
        }
      }
      
      // Strategy 6: Header and title elements
      const headers = group.querySelectorAll('h1, h2, h3, h4, h5, h6, .heading, [role="heading"]');
      for (const header of headers) {
        name = norm(header.textContent);
        if (name && name.length > 1 && name.length < 50) return name;
      }
      
      return null;
    };

    // ✅ ENHANCED: Improved sender URL extraction
    const getSenderUrl = (group) => {
      // Strategy 1: Enhanced LinkedIn profile link selectors
      const candidates = [
        'a.msg-s-event-listitem__link[href*="/in/"]',
        'a.msg-s-message-group__profile-link[href*="/in/"]', 
        '.msg-s-message-group__meta a[href*="/in/"]',
        'a[data-test-app-aware-link][href*="/in/"]',
        'a[href*="/in/ACoAA"]', // Specific LinkedIn ID pattern
        'a[href*="linkedin.com/in/"]',
      ];
      
      for (const selector of candidates) {
        const link = group.querySelector(selector);
        if (link) {
          const href = link.getAttribute('href');
          if (href && href.includes('/in/')) {
            // Clean up relative URLs
            if (href.startsWith('/')) {
              return 'https://www.linkedin.com' + href;
            }
            return href;
          }
        }
      }
      
      // Strategy 2: Any profile link patterns (enhanced)
      const allLinks = Array.from(group.querySelectorAll('a[href]'));
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        if (href) {
          // Match various LinkedIn profile URL patterns
          const patterns = [
            /linkedin\\.com\\/in\\//i,
            /\\/in\\/ACoAA/,
            /\\/in\\/[a-zA-Z0-9\\-]+/,
            /miniprofile\\/.*urn.*person/i
          ];
          
          for (const pattern of patterns) {
            if (pattern.test(href)) {
              if (href.startsWith('/')) {
                return 'https://www.linkedin.com' + href;
              }
              return href;
            }
          }
        }
      }
      
      // Strategy 3: Data attributes that might contain profile info
      const dataAttrs = ['data-member-id', 'data-profile-id', 'data-person-urn'];
      for (const attr of dataAttrs) {
        const value = group.getAttribute(attr) || group.querySelector(\`[\${attr}]\`)?.getAttribute(attr);
        if (value) {
          // Convert to LinkedIn URL if it looks like an ID
          if (value.match(/^\\d+$/) || value.includes('ACoAA')) {
            return \`https://www.linkedin.com/in/\${value}\`;
          }
        }
      }
      
      return null;
    };

    // ✅ ENHANCED: Get group time with date context support
    const getGroupTime = (group) => {
      const raw = pickFirst(group, [
        'time.msg-s-message-group__timestamp',
        'time[data-time]',
        'time[datetime]',
        'time',
        'span.msg-s-message-group__timestamp',
        '.msg-s-message-group__timestamp',
      ]);
      
      // Get date context for this group
      let dateContext = null;
      
      // Strategy 1: Check direct mapping
      if (dateContextMap.has(group)) {
        dateContext = dateContextMap.get(group);
      }
      
      // Strategy 2: Check parent elements
      if (!dateContext) {
        let current = group.parentElement;
        while (current && current !== rootEl) {
          if (dateContextMap.has(current)) {
            dateContext = dateContextMap.get(current);
            break;
          }
          current = current.parentElement;
        }
      }
      
      // Strategy 3: Look for closest preceding date header
      if (!dateContext) {
        const allDateHeaders = Array.from(rootEl.querySelectorAll('.msg-s-message-list__time-heading, time.msg-s-message-list__time-heading'));
        let closestHeader = null;
        let minDistance = Infinity;
        
        for (const header of allDateHeaders) {
          const headerRect = header.getBoundingClientRect();
          const groupRect = group.getBoundingClientRect();
          
          // Check if header comes before this group in document order
          const position = header.compareDocumentPosition(group);
          if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
            const distance = Math.abs(headerRect.bottom - groupRect.top);
            if (distance < minDistance) {
              minDistance = distance;
              closestHeader = header;
            }
          }
        }
        
        if (closestHeader) {
          dateContext = norm(closestHeader.textContent);
        }
      }
      
      return extractDateTime(raw, dateContext);
    };

    // ✅ ENHANCED: Get item time with enhanced fallback logic
    const getItemTime = (item, groupFallback) => {
      const raw = pickFirst(item, [
        'time.msg-s-event-listitem__timestamp',
        'time[datetime]',
        'time',
        '.timestamp',
        '[data-time]',
      ]);
      
      // Try to extract with item's own date context first
      let dateContext = null;
      
      // Check if item has its own date context
      if (dateContextMap.has(item)) {
        dateContext = dateContextMap.get(item);
      }
      
      // If not, inherit from the group fallback
      if (!dateContext && groupFallback && groupFallback.dateContext) {
        dateContext = groupFallback.dateContext;
      }
      
      const parsed = extractDateTime(raw, dateContext);
      
      // Fallback to group time if item time extraction failed
      if (!parsed.time && groupFallback) {
        return {
          ...groupFallback,
          timeRaw: parsed.timeRaw || groupFallback.timeRaw,
          extractionSource: 'group-fallback'
        };
      }
      
      return {
        ...parsed,
        extractionSource: parsed.time ? 'item-direct' : 'failed'
      };
    };

    const getItemText = (item) => {
      const body =
        item.querySelector('p.msg-s-event-listitem__body') ||
        item.querySelector('span.msg-s-event-listitem__body') ||
        item.querySelector('div.msg-s-event-listitem__body') ||
        item.querySelector('.msg-s-event-listitem__event-text') ||
        item.querySelector('p[data-test-id="message-text"]') ||
        item.querySelector('.message-body') ||
        item.querySelector('p.t-14') ||
        item.querySelector('span.break-words');

      const text = norm(body?.textContent);
      return text || null;
    };

    // ✅ ENHANCED: Helper to find parent meta container for message items
    const findParentMeta = (messageElement) => {
      // Walk up the DOM to find the closest meta container
      let current = messageElement;
      let attempts = 0;
      const maxAttempts = 10; // Prevent infinite loops
      
      while (current && current !== rootEl && attempts < maxAttempts) {
        attempts++;
        
        // Check if current element or its siblings have meta info
        const parent = current.parentElement;
        if (!parent) break;
        
        // Look for meta container in the parent's children (siblings)
        const metaInSiblings = parent.querySelector('.msg-s-message-group__meta');
        if (metaInSiblings) {
          return metaInSiblings;
        }
        
        // Look for meta container in the parent itself
        const metaInParent = parent.querySelector('.msg-s-message-group__meta');
        if (metaInParent) {
          return metaInParent;
        }
        
        // Check previous siblings for meta containers
        let sibling = current.previousElementSibling;
        while (sibling) {
          const metaInSibling = sibling.querySelector('.msg-s-message-group__meta');
          if (metaInSibling) return metaInSibling;
          
          if (sibling.classList.contains('msg-s-message-group__meta')) {
            return sibling;
          }
          
          sibling = sibling.previousElementSibling;
        }
        
        current = parent;
      }
      
      return null;
    };

    // ✅ STRATEGY EXTRACTION FUNCTION: Extract messages using a specific group selection strategy
    const extractWithStrategy = (strategyName, groupSelector, scopeEl = rootEl) => {
      const groups = Array.from(scopeEl.querySelectorAll(groupSelector));
      const messages = [];
      
      for (const g of groups) {
        let senderName = getSenderName(g);
        let senderProfileUrl = getSenderUrl(g);
        let groupTime = getGroupTime(g);

        // ✅ ENHANCED: If this is a message item without sender info, find the parent meta
        if (g.classList.contains('msg-s-event-listitem') && !senderName && !senderProfileUrl) {
          const parentMeta = findParentMeta(g);
          if (parentMeta) {
            senderName = getSenderName(parentMeta);
            senderProfileUrl = getSenderUrl(parentMeta);
            if (!groupTime.time) {
              groupTime = getGroupTime(parentMeta);
            }
          }
        }

        let items = [];
        
        // Handle different LinkedIn message structures
        if (g.classList.contains('msg-s-event-listitem')) {
          items = [g];
        } else {
          items = Array.from(g.querySelectorAll('li.msg-s-message-group__message, li.msg-s-event-listitem, .msg-s-event-listitem'));
          
          // ✅ ENHANCED: For meta containers, look for related message items in siblings/descendants
          if (g.classList.contains('msg-s-message-group__meta')) {
            const parent = g.parentElement;
            if (parent) {
              // Look for message items that come after this meta container
              let nextSibling = g.nextElementSibling;
              const relatedItems = [];
              
              while (nextSibling) {
                if (nextSibling.classList.contains('msg-s-event-listitem') || 
                    nextSibling.classList.contains('msg-s-message-list__event')) {
                  relatedItems.push(nextSibling);
                }
                
                // Also check within the sibling for nested items
                const nestedItems = nextSibling.querySelectorAll('.msg-s-event-listitem');
                relatedItems.push(...Array.from(nestedItems));
                
                nextSibling = nextSibling.nextElementSibling;
                
                // Stop if we hit another meta container (different sender)
                if (nextSibling && nextSibling.querySelector('.msg-s-message-group__meta')) {
                  break;
                }
              }
              
              if (relatedItems.length > 0) {
                items.push(...relatedItems);
              }
            }
          }
        }

        // Fallback item extraction
        if (items.length === 0) {
          items = Array.from(g.querySelectorAll('.message-item, [data-test-id*="message"], .conversation-message-item'));
        }

        if (items.length === 0) {
          items = Array.from(g.querySelectorAll('p.msg-s-event-listitem__body, .msg-s-event-listitem__event-text, p[data-test-id="message-text"], .message-body'))
            .map((p) => p.closest('li') || p.closest('div') || p)
            .filter(Boolean);
        }

        const effectiveItems = items.length > 0 ? items : [g];

        for (const it of effectiveItems) {
          const text = getItemText(it);
          if (!text) continue;

          const t = getItemTime(it, groupTime);
          const messageId = it.getAttribute?.('data-event-urn') || it.getAttribute?.('data-message-id') || it.id || \`\${strategyName}-msg-\${messages.length}\`;

          // ✅ ENHANCED: For individual message items, try to get sender info from parent meta if not available
          let finalSenderName = senderName;
          let finalSenderUrl = senderProfileUrl;
          
          if (!finalSenderName || !finalSenderUrl) {
            const itemMeta = findParentMeta(it);
            if (itemMeta) {
              finalSenderName = finalSenderName || getSenderName(itemMeta);
              finalSenderUrl = finalSenderUrl || getSenderUrl(itemMeta);
            }
          }

          messages.push({
            id: messageId,
            senderName: finalSenderName || null,
            senderProfileUrl: finalSenderUrl || null,
            time: t.time || null,
            timeRaw: t.timeRaw || null,
            datetime: t.datetime || null,
            dateContext: t.dateContext || null,
            timeDetails: {
              hour24: t.hour24 ?? null,
              minute: t.minute ?? null,
              extractionSource: t.extractionSource || 'standard'
            },
            text,
            extractionStrategy: strategyName,
          });
        }
      }
      
      return {
        strategyName,
        groupsFound: groups.length,
        messages: messages,
        messagesFound: messages.length,
      };
    };

    // ✅ RUN ALL EXTRACTION STRATEGIES INDEPENDENTLY
    const strategies = [
      { name: 'primary-selectors', selector: '.msg-s-event-listitem, .msg-s-message-group', scope: rootEl },
      { name: 'alternative-groups', selector: '.msg-s-event-listitem__group, [data-view-name*="message-group"]', scope: rootEl },
      { name: 'broader-selectors', selector: 'li[data-view-name*="message"], .message-item, .conversation-message', scope: rootEl },
      { name: 'global-groups', selector: '.msg-s-message-group', scope: document },
      { name: 'generic-containers', selector: '[role="listitem"][data-view-name*="message"], .msg-conversation__body li', scope: document },
      { name: 'meta-containers', selector: '.msg-s-message-group__meta', scope: rootEl },
      { name: 'conversation-items', selector: '.conversation-message-item, .msg-conversation-listitem', scope: rootEl },
    ];

    const extractionResults = [];
    
    for (const strategy of strategies) {
      try {
        const result = extractWithStrategy(strategy.name, strategy.selector, strategy.scope);
        extractionResults.push(result);
        console.log(\`[extract-debug] \${strategy.name}: \${result.groupsFound} groups, \${result.messagesFound} messages\`);
      } catch (e) {
        console.log(\`[extract-debug] \${strategy.name}: extraction failed - \${e.message}\`);
        extractionResults.push({
          strategyName: strategy.name,
          groupsFound: 0,
          messages: [],
          messagesFound: 0,
          error: e.message,
        });
      }
    }

    // ✅ GENERIC TEXT FALLBACK STRATEGY
    if (extractionResults.every(r => r.messagesFound === 0)) {
      console.log('[extract-debug] All structured strategies failed, trying generic text extraction');
      const fallbackTexts = Array.from(rootEl.querySelectorAll('p, span, div'))
        .map(el => norm(el.textContent))
        .filter(text => text.length > 10 && text.length < 1000 && 
                       !el.querySelector('input, button, a') &&
                       !/^(send|enviar|type|escribir|profile|perfil)/i.test(text))
        .slice(0, 50);
      
      const fallbackMessages = [];
      for (let i = 0; i < fallbackTexts.length; i++) {
        fallbackMessages.push({
          id: \`generic-fallback-\${i}\`,
          senderName: null,
          senderProfileUrl: null,
          time: null,
          timeRaw: null,
          datetime: null,
          dateContext: null,
          timeDetails: {
            hour24: null,
            minute: null,
            extractionSource: 'fallback'
          },
          text: fallbackTexts[i],
          extractionStrategy: 'generic-text-fallback',
        });
      }
      
      extractionResults.push({
        strategyName: 'generic-text-fallback',
        groupsFound: 0,
        messages: fallbackMessages,
        messagesFound: fallbackMessages.length,
      });
    }

    // ✅ FIND THE BEST STRATEGY (most messages with sender info, or just most messages)
    let bestStrategy = extractionResults[0];
    
    for (const result of extractionResults) {
      if (result.messagesFound === 0) continue;
      
      // Calculate quality score: messages count + sender info bonus
      const currentScore = result.messagesFound;
      const currentSenderScore = result.messages.filter(m => m.senderName || m.senderProfileUrl).length;
      const currentQuality = currentScore + (currentSenderScore * 0.5);
      
      const bestScore = bestStrategy.messagesFound;
      const bestSenderScore = bestStrategy.messages?.filter(m => m.senderName || m.senderProfileUrl).length || 0;
      const bestQuality = bestScore + (bestSenderScore * 0.5);
      
      if (currentQuality > bestQuality) {
        bestStrategy = result;
      }
    }

    // Dedupe best strategy messages
    const seen = new Set();
    const deduped = [];
    for (const m of bestStrategy.messages || []) {
      const key = [m.senderName ?? '', m.time ?? '', m.text ?? ''].join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    const reversed = !!rootEl.querySelector('.msg-s-message-list-container--column-reversed') ||
                    !!document.querySelector('.msg-s-message-list-container--column-reversed');

    const ordered = reversed ? deduped.reverse() : deduped;

    console.log(\`[extract-debug] Best strategy: \${bestStrategy.strategyName} with \${ordered.length} messages\`);

    return {
      ok: true,
      totalFound: ordered.length,
      reversed,
      messages: ordered,
      bestStrategy: bestStrategy.strategyName,
      allStrategies: extractionResults,
      debugInfo: {
        strategiesAttempted: extractionResults.length,
        bestStrategyName: bestStrategy.strategyName,
        bestStrategyGroups: bestStrategy.groupsFound,
        allResults: extractionResults.map(r => ({
          name: r.strategyName,
          groups: r.groupsFound,
          messages: r.messagesFound,
          withSender: r.messages?.filter(m => m.senderName || m.senderProfileUrl).length || 0,
        })),
      },
    };
  });

  let msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  if (msgs.length > limit) msgs = msgs.slice(-limit);

  // ✅ FINAL FALLBACK: If we still have 0 messages, try additional strategies
  if (msgs.length === 0) {
    await debug('Zero messages extracted, applying final fallbacks');
    
    // Strategy 1: Try finding any visible text in the conversation area
    const finalFallback = await root.evaluate((rootEl) => {
      const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();
      const fallbackMessages = [];
      
      // Look for any paragraphs or divs with substantial text content
      const textElements = Array.from(rootEl.querySelectorAll('p, div, span'))
        .filter(el => {
          const text = norm(el.textContent);
          return text.length > 10 && text.length < 2000 && 
                 !el.querySelector('input, button, a') && // avoid UI elements
                 !/^(send|enviar|type|escribir)/i.test(text); // avoid UI text
        })
        .slice(0, 20); // limit to avoid noise
      
      for (let i = 0; i < textElements.length; i++) {
        const text = norm(textElements[i].textContent);
        if (text) {
          fallbackMessages.push({
            id: \`emergency-fallback-\${i}\`,
            senderName: null,
            senderProfileUrl: null,
            time: null,
            timeRaw: null,
            datetime: null,
            dateContext: null,
            timeDetails: {
              hour24: null,
              minute: null,
              extractionSource: 'emergency-fallback'
            },
            text: text,
            isFallback: true,
            extractionStrategy: 'emergency-fallback',
          });
        }
      }
      
      return fallbackMessages;
    }).catch(() => []);
    
    if (finalFallback.length > 0) {
      msgs = finalFallback.slice(0, Math.min(limit, 10)); // limit fallback messages
      await debug(\`Emergency fallback applied: found \${msgs.length} text elements\`);
    }
  }

  // ✅ ULTIMATE FALLBACK: If we absolutely have no messages, create a placeholder
  if (msgs.length === 0) {
    await debug('All fallback strategies failed, creating placeholder message');
    msgs = [{
      id: 'no-messages-placeholder',
      senderName: null,
      senderProfileUrl: null,
      time: null,
      timeRaw: null,
      datetime: null,
      dateContext: null,
      timeDetails: {
        hour24: null,
        minute: null,
        extractionSource: 'placeholder'
      },
      text: '[No messages could be extracted from this conversation. This may indicate the chat is empty, requires login, or uses a different interface structure.]',
      isPlaceholder: true,
      extractionStrategy: 'placeholder',
    }];
  }

  const result = {
    ok: true,
    limit,
    totalFound: payload?.totalFound ?? msgs.length,
    reversed: payload?.reversed ?? false,
    extractedAt: new Date().toISOString(),
    threadHint: threadHint || undefined,
    messages: msgs,
    fallbacksUsed: payload?.fallbacksUsed || 'unknown',
    extractionStrategy: msgs[0]?.isPlaceholder ? 'placeholder' : 
                       msgs[0]?.isFallback ? 'emergency-fallback' : 'standard',
  };

  // ✅ Wait for chat content to fully load before extraction
  await debug('Waiting for message content to load...');
  
  // Wait for specific message indicators
  try {
    await page.waitForSelector('.msg-s-event-listitem, .msg-s-message-group', { 
      timeout: 3000,
      state: 'visible' 
    });
    await debug('Message containers detected, proceeding with extraction');
  } catch {
    await debug('No structured message containers found after 3s, proceeding with fallback');
  }

  // Additional wait for dynamic content
  await sleep(800);

  // ✅ TEST: LinkedIn GraphQL API fetch for testing
  await debug('Testing LinkedIn GraphQL API fetch...');
  
  let graphqlTestResult = null;
  try {
    const url = "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql" +
      "?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314" +
      "&variables=(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AACoAAEGI9uQBNvuMbXy4c6ldqNLaiN8JclJJWdI%2C2-ZDZjMDVjZjgtNmNlMy00YjQwLTk2ZDUtOTcyODhjYmIxZjlhXzEwMA%3D%3D%29)";

    graphqlTestResult = await page.evaluate(async (testUrl) => {
      try {
        // Enhanced CSRF token extraction with comprehensive LinkedIn-specific strategies
        let csrf = null;
        let debugInfo = {
          strategiesAttempted: 0,
          strategiesSuccessful: 0,
          details: []
        };
        
        // Strategy 1: Check window object properties (LinkedIn globals)
        debugInfo.strategiesAttempted++;
        const windowProps = ['csrfToken', '_csrf', 'CSRF_TOKEN', 'voyagerCsrfToken'];
        for (const prop of windowProps) {
          if (window[prop]) {
            csrf = window[prop];
            debugInfo.strategiesSuccessful++;
            debugInfo.details.push(\`Found in window.\${prop}\`);
            break;
          }
        }
        
        // Strategy 2: Enhanced meta tag detection
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          const metaSelectors = [
            'meta[name="csrf-token"]',
            'meta[name="_csrf"]', 
            'meta[name="csrf_token"]',
            'meta[name="x-csrf-token"]',
            'meta[property="csrf-token"]',
            'meta[http-equiv="csrf-token"]',
            'meta[name="voyager-csrf"]',
            'meta[name="li-csrf"]'
          ];
          
          for (const selector of metaSelectors) {
            const meta = document.querySelector(selector);
            if (meta) {
              const token = meta.getAttribute('content') || meta.getAttribute('value') || meta.getAttribute('csrf');
              if (token && token.length > 10) {
                csrf = token;
                debugInfo.strategiesSuccessful++;
                debugInfo.details.push(\`Found in meta tag: \${selector}\`);
                break;
              }
            }
          }
        }
        
        // Strategy 3: LinkedIn app state and configuration objects
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          
          // Check LinkedIn's global state objects
          const stateObjects = [
            () => window.lix?.clientState?.csrfToken,
            () => window.lix?.clientState?.csrf,
            () => window.appConfig?.csrfToken,
            () => window.appConfig?.csrf,
            () => window.voyagerCsrf,
            () => window.linkedInConfig?.csrf,
            () => window.pageConfig?.csrf,
            () => window.__INITIAL_STATE__?.csrf,
            () => window.__CONFIG__?.csrfToken
          ];
          
          for (const getter of stateObjects) {
            try {
              const token = getter();
              if (token && typeof token === 'string' && token.length > 10) {
                csrf = token;
                debugInfo.strategiesSuccessful++;
                debugInfo.details.push('Found in LinkedIn state object');
                break;
              }
            } catch (e) {
              // Continue to next getter
            }
          }
        }
        
        // Strategy 4: Enhanced script tag parsing with better patterns
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          const scripts = document.querySelectorAll('script');
          
          // Enhanced regex patterns for different CSRF token formats
          const patterns = [
            /"csrf[Tt]oken"[\\s]*:[\\s]*"([^"]{20,})"/,
            /'csrf[Tt]oken'[\\s]*:[\\s]*'([^']{20,})'/,
            /csrf[Tt]oken[\\s]*=[\\s]*['"]([^'"]{20,})['"]/,
            /"_csrf"[\\s]*:[\\s]*"([^"]{20,})"/,
            /'_csrf'[\\s]*:[\\s]*'([^']{20,})'/,
            /voyager[Cc]srf[\\s]*:[\\s]*['"]([^'"]{20,})['"]/,
            /"X-CSRF-TOKEN"[\\s]*:[\\s]*"([^"]{20,})"/,
            /csrf[\\s]*:[\\s]*['"]([^'"]{20,})['"]/,
            /"csrfParam"[\\s]*:[\\s]*"([^"]{20,})"/
          ];
          
          for (const script of scripts) {
            const text = script.textContent || script.innerHTML;
            if (text && (text.includes('csrf') || text.includes('CSRF'))) {
              for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match && match[1] && match[1].length > 10) {
                  csrf = match[1];
                  debugInfo.strategiesSuccessful++;
                  debugInfo.details.push('Found in script tag with regex');
                  break;
                }
              }
              if (csrf) break;
            }
          }
        }
        
        // Strategy 5: Check form inputs and hidden fields
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
          
          for (const input of hiddenInputs) {
            const name = input.getAttribute('name');
            const value = input.getAttribute('value');
            
            if (name && value && value.length > 10 && 
                (name.toLowerCase().includes('csrf') || 
                 name.toLowerCase().includes('token') ||
                 name === '_token' || 
                 name === 'authenticity_token')) {
              csrf = value;
              debugInfo.strategiesSuccessful++;
              debugInfo.details.push(\`Found in hidden input: \${name}\`);
              break;
            }
          }
        }
        
        // Strategy 6: Check cookies for CSRF tokens, JSESSIONID, AND li_at
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          try {
            const cookies = document.cookie.split(';');
            const cookieMap = {};
            
            // Parse all cookies into a map
            for (const cookie of cookies) {
              const [name, value] = cookie.trim().split('=');
              if (name && value) {
                cookieMap[name] = decodeURIComponent(value);
              }
            }
            
            // LinkedIn authentication priority:
            // 1. JSESSIONID (contains CSRF token)
            // 2. Traditional CSRF tokens  
            // 3. li_at (authentication token - may also serve as CSRF)
            const tokenPriority = [
              'JSESSIONID', 'jsessionid',
              'csrf_token', 'csrftoken', 'CSRF-TOKEN', 'X-CSRF-TOKEN', 'li_csrf',
              'li_at'  // LinkedIn authentication token
            ];
            
            for (const cookieName of tokenPriority) {
              if (cookieMap[cookieName] && cookieMap[cookieName].length > 5) {
                csrf = cookieMap[cookieName];
                debugInfo.strategiesSuccessful++;
                debugInfo.details.push(\`Found in cookie: \${cookieName}\`);
                break;
              }
            }
            
            // Enhanced debug info
            debugInfo.details.push(\`Total cookies found: \${cookies.length}\`);
            debugInfo.details.push(\`Cookie names: \${Object.keys(cookieMap).join(', ')}\`);
            debugInfo.details.push(\`li_at present: \${!!cookieMap.li_at}\`);
            debugInfo.details.push(\`JSESSIONID present: \${!!cookieMap.JSESSIONID}\`);
            
          } catch (e) {
            debugInfo.details.push(\`Cookie parsing error: \${e.message}\`);
          }
        }
        
        // Strategy 7: Check local/session storage (including JSESSIONID variants)
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          try {
            const storageKeys = ['csrf_token', 'csrfToken', 'voyager_csrf', 'li_csrf', 'JSESSIONID', 'jsessionid', 'li_session'];
            
            for (const key of storageKeys) {
              let token = localStorage.getItem(key) || sessionStorage.getItem(key);
              if (token && token.length > 5) { // Lower threshold for session IDs
                csrf = token;
                debugInfo.strategiesSuccessful++;
                debugInfo.details.push(\`Found in storage: \${key}\`);
                break;
              }
            }
          } catch (e) {
            debugInfo.details.push(\`Storage access error: \${e.message}\`);
          }
        }
        
        // Strategy 8: Try to extract from any data attributes on key LinkedIn elements
        if (!csrf) {
          debugInfo.strategiesAttempted++;
          const keyElements = [
            document.documentElement,
            document.body,
            document.querySelector('#app'),
            document.querySelector('[data-app-name]'),
            document.querySelector('.authentication-outlet'),
            document.querySelector('.voyager-feed')
          ];
          
          const dataAttrs = ['data-csrf-token', 'data-csrf', 'data-x-csrf-token', 'data-voyager-csrf'];
          
          for (const element of keyElements) {
            if (!element) continue;
            for (const attr of dataAttrs) {
              const token = element.getAttribute(attr);
              if (token && token.length > 10) {
                csrf = token;
                debugInfo.strategiesSuccessful++;
                debugInfo.details.push(\`Found in element data attribute: \${attr}\`);
                break;
              }
            }
            if (csrf) break;
          }
        }
        
        // ✅ POST-PROCESSING: Parse CSRF token from JSESSIONID or other sources
        let finalCsrf = csrf;
        if (csrf && csrf !== 'no-csrf-found') {
          // LinkedIn often stores CSRF token in JSESSIONID with format: "ajax:ACTUAL_TOKEN"
          if (csrf.includes('ajax:')) {
            const match = csrf.match(/ajax[:"]*([^"']+)/);
            if (match && match[1]) {
              finalCsrf = match[1];
              debugInfo.details.push(\`Parsed CSRF from JSESSIONID ajax format: \${finalCsrf}\`);
            }
          }
          // Remove surrounding quotes if present
          finalCsrf = finalCsrf.replace(/^["']|["']$/g, '');
        }
        
        // Final fallback
        if (!finalCsrf || finalCsrf === 'no-csrf-found') {
          finalCsrf = 'no-csrf-found';
        }

        const res = await fetch(testUrl, {
          method: "GET",
          credentials: "include",
          headers: {
            // LinkedIn Voyager API specific headers
            "csrf-token": finalCsrf,
            "x-csrf-token": finalCsrf,
            "X-CSRF-TOKEN": finalCsrf,
            "accept": "application/json",
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
        });

        const responseText = await res.text();
        
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          responseText: responseText.slice(0, 2000), // Limit response size
          csrf: finalCsrf, // Show the processed CSRF token
          rawCsrf: csrf, // Show the original raw token
          csrfDebug: {
            // Enhanced debug information
            strategiesAttempted: debugInfo.strategiesAttempted,
            strategiesSuccessful: debugInfo.strategiesSuccessful,
            details: debugInfo.details,
            foundCsrf: csrf !== 'no-csrf-found',
            csrfLength: csrf !== 'no-csrf-found' ? csrf.length : 0,
            // Legacy debug info for compatibility
            windowCsrfToken: !!window.csrfToken,
            windowCsrf: !!window._csrf,
            windowCSRFTOKEN: !!window.CSRF_TOKEN,
            metaTagsChecked: document.querySelectorAll('meta[name*="csrf"], meta[property*="csrf"]').length,
            scriptsWithCsrf: Array.from(document.querySelectorAll('script')).filter(s => (s.textContent || '').includes('csrf')).length,
            hasLixClientState: !!(window.lix && window.lix.clientState),
            hasAppConfig: !!window.appConfig,
            cookiesAvailable: !!document.cookie,
            storageAvailable: !!(typeof Storage !== 'undefined'),
            totalScriptsChecked: document.querySelectorAll('script').length,
            totalMetaTagsChecked: document.querySelectorAll('meta').length
          },
          url: testUrl
        };
      } catch (e) {
        return {
          ok: false,
          error: e.message,
          csrf: 'error-getting-csrf',
          csrfDebug: { error: 'Failed to detect CSRF token due to error' },
          url: testUrl
        };
      }
    }, url);

    await debug(\`GraphQL API test result: \${JSON.stringify(graphqlTestResult, null, 2).slice(0, 500)}\`);
  } catch (e) {
    graphqlTestResult = {
      ok: false,
      error: \`GraphQL test failed: \${e.message}\`,
      url: url
    };
    await debug(\`GraphQL API test error: \${e.message}\`);
  }

  // Add GraphQL test result to the final result
  result.graphqlTest = graphqlTestResult;

  // ✅ return object (not JSON.stringify)
  return result;
}
`;
  }

  // -----------------------------
  // ✅ UPDATED: readChat multi-sesión (safe parse + correct logs)
  // -----------------------------
  async readChat(
    sessionId: SessionId,
    profileUrl: string,
    limit = 30,
    threadHint?: string,
  ) {
    const startTime = Date.now();
    const code = this.buildReadChatCode(profileUrl, limit, threadHint);

    const verboseResult = {
      ok: true,
      profileUrl,
      limit,
      threadHint,
      sessionId,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_direct_execution',
        codeLength: code.length,
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],
      },
      data: null as any,
      toolResult: null as any,
    };

    const safeParse = (v: any) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };

    try {
      verboseResult.executionDetails.steps.push(
        'Generated JavaScript code for Playwright execution',
      );
      verboseResult.executionDetails.steps.push(
        `Code length: ${code.length} characters`,
      );
      verboseResult.executionDetails.steps.push(
        'Starting Playwright runCode execution',
      );

      const result = await this.playwright.runCode(code, sessionId);
      const parsed = safeParse(result);

      verboseResult.executionDetails.steps.push(
        'Playwright execution completed successfully',
      );
      verboseResult.executionDetails.steps.push(
        `Messages extracted: ${parsed?.messages?.length ?? 0}`,
      );

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      verboseResult.data = parsed;
      verboseResult.toolResult = parsed;

      this.logger.debug(
        `readChat completed successfully in ${verboseResult.executionDetails.executionTimeMs}ms`,
      );

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        `Error occurred: ${e?.message ?? 'Unknown error'}`,
      );

      this.logger.warn(`readChat failed: ${e?.message ?? e}`);

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        limit,
        sessionId,
      };
    }
  }
  // -----------------------------
  // sendMessage multi-sesión
  // -----------------------------
  // -----------------------------
  // sendMessages (multi) + sendMessage wrapper
  // -----------------------------
  async sendMessage(sessionId: SessionId, profileUrl: string, message: string) {
    return this.sendMessages(sessionId, profileUrl, [message]);
  }

  // ✅ UPDATED: sendMessages con ensureOnUrl (skip si ya está en la URL)
  async sendMessages(
    sessionId: SessionId,
    profileUrl: string,
    messages: string[],
  ) {
    const startTime = Date.now();

    const cleaned = (messages ?? [])
      .map((m) => (m ?? '').toString().trim())
      .filter(Boolean);

    const verboseResult = {
      ok: true,
      profileUrl,
      sessionId,
      messageCount: cleaned.length,
      messagePreviews: cleaned.map((m) => m.slice(0, 60)),
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_direct_execution',
        fallbackAttempts: 0,
        steps: [] as string[],
        errors: [] as any[],
        playwrightLogs: [] as string[],
      },
      note: null as string | null,
      result: null as any,
    };

    if (!cleaned.length) {
      return {
        ok: false,
        error: 'No messages provided (message/messages vacío).',
        profileUrl,
        sessionId,
      };
    }

    verboseResult.executionDetails.steps.push(
      'Starting sendMessages execution',
    );
    verboseResult.executionDetails.steps.push(
      `Messages: ${cleaned.length} item(s)`,
    );

    const code = `
async (page) => {
  ${buildEnsureOnUrlSnippet()}

  const profileUrl = ${JSON.stringify(profileUrl)};
  const messages = ${JSON.stringify(cleaned)};

  const debug = async (msg) => {
    console.log('[send-messages]', msg, 'url=', page.url());
    return msg;
  };

  const sleep = (ms) => page.waitForTimeout(ms);

  // ✅ usa el helper compartido
  const isOnTargetProfile = () => __sameUrl(page.url(), profileUrl, true);

  const findVisibleBoxNow = async () => {
    const a = page.locator(
      'div.msg-form__contenteditable[role="textbox"][contenteditable="true"]'
    ).first();

    if ((await a.count().catch(() => 0)) && (await a.isVisible().catch(() => false))) return a;

    const b = page.getByRole('textbox', { name: /escribe un mensaje|write a message/i }).first();
    if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) return b;

    return null;
  };

  const waitForMessageBox = async (timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const box = await findVisibleBoxNow();
      if (box) return box;
      await sleep(200);
    }
    return null;
  };

  // ✅ FAST PATH:
  // Si ya está visible el textarea Y estamos en el perfil objetivo, no navegamos ni clickeamos CTA.
  let box = await findVisibleBoxNow();
  if (box && isOnTargetProfile()) {
    await debug('Textarea visible en perfil objetivo -> skip navegación y CTA');
  } else {
    // 1) Ir al perfil (solo si hace falta)
    const nav = await ensureOnUrl(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
      settleMs: 1200,
      allowSubpaths: false,
    });
    await debug('ensureOnUrl -> ' + JSON.stringify(nav));
    await debug('Perfil listo');

    const main = page.locator('main').first();
    const topCard = main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
    const scope = (await topCard.count()) ? topCard : main;

    const findMessageButton = async () => {
      let loc = scope.locator(
        'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
      ).first();
      if (await loc.count()) return loc;

      loc = main.locator(
        'button[aria-label^="Enviar mensaje"], button[aria-label^="Message"]'
      ).first();
      if (await loc.count()) return loc;

      loc = scope.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
      if (await loc.count()) return loc;

      loc = main.locator('button, a').filter({ hasText: /enviar mensaje|message/i }).first();
      if (await loc.count()) return loc;

      const icon = scope.locator(
        'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
        'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
      ).first();

      if (await icon.count()) {
        const btn = icon.locator('xpath=ancestor::button[1]').first();
        if (await btn.count()) return btn;
      }

      const icon2 = main.locator(
        'use[href="#send-privately-small"], use[href="#send-privately-medium"], ' +
        'svg[data-test-icon="send-privately-small"], svg[data-test-icon="send-privately-medium"]'
      ).first();

      if (await icon2.count()) {
        const btn = icon2.locator('xpath=ancestor::button[1]').first();
        if (await btn.count()) return btn;
      }

      return null;
    };

    let messageBtn = await findMessageButton();

    if (!messageBtn) {
      await debug('CTA no encontrado. Probando overflow del perfil');

      const moreBtn = scope.locator(
        'button[data-view-name="profile-overflow-button"][aria-label="Más"], ' +
        'button[data-view-name="profile-overflow-button"][aria-label="More"]'
      ).first();

      if (await moreBtn.count()) {
        await moreBtn.scrollIntoViewIfNeeded().catch(() => {});
        await moreBtn.click({ timeout: 15000, force: true });
        await sleep(250);

        const msgItem = page.getByRole('menuitem', {
          name: /enviar mensaje|mensaje|message/i,
        }).first();

        if (await msgItem.count()) {
          await msgItem.click({ timeout: 15000 });
        } else {
          throw new Error('No se encontró opción de mensaje en el menú Más del perfil.');
        }
      } else {
        throw new Error('No se encontró CTA de mensaje ni overflow del perfil.');
      }
    } else {
      const aria = (await messageBtn.getAttribute('aria-label')) ?? '';
      if (/para negocios|for business/i.test(aria)) {
        throw new Error('Selector de mensaje resolvió a un botón del header. Ajustar scope.');
      }

      await debug('Click CTA Enviar mensaje');
      await messageBtn.scrollIntoViewIfNeeded().catch(() => {});
      await messageBtn.click({ timeout: 15000, force: true });
    }

    await sleep(900);
    box = await waitForMessageBox(14000);
    if (!box) throw new Error('No se encontró el textarea de mensajes.');
  }

  // Helpers send loop
  const clearBox = async () => {
    try { await box.click({ timeout: 8000 }); } catch {}

    // 1) Ctrl+A + Backspace
    try {
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await sleep(50);
    } catch {}

    // 2) Hard clear via DOM
    try {
      await box.evaluate((el) => {
        try { el.innerHTML = ''; } catch {}
        try { el.textContent = ''; } catch {}

        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('keyup', { bubbles: true }));
      });
    } catch {}
  };

  const waitEnabled = async (loc, timeout = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if ((await loc.count()) && (await loc.isVisible()) && (await loc.isEnabled())) return true;
      } catch {}
      await sleep(120);
    }
    return false;
  };

  const resolveSendButton = async () => {
    let form = box.locator('xpath=ancestor::form[1]');
    if (!(await form.count().catch(() => 0))) {
      form = page.locator('form.msg-form, form[data-view-name*="message"]').last();
    }

    let sendBtn = form.locator('button.msg-form__send-button[type="submit"]').first();

    if (!(await sendBtn.count().catch(() => 0))) {
      sendBtn = form.locator('button[type="submit"]').filter({ hasText: /enviar|send/i }).first();
    }

    return { form, sendBtn };
  };

  const perMessage = [];

  for (let i = 0; i < messages.length; i++) {
    const text = (messages[i] ?? '').toString().trim();
    if (!text) {
      perMessage.push({ i, ok: false, skipped: true, reason: 'empty' });
      continue;
    }

    await debug('Enviando mensaje #' + (i + 1));
    await clearBox();
    await sleep(80);

    try {
      await box.click({ timeout: 15000 });
    } catch {}

    // type/fill
    let typed = true;
    try {
      await box.type(text, { delay: 5 });
    } catch {
      typed = false;
      try { await box.fill(text); } catch {}
    }

    await sleep(200);

    const { sendBtn } = await resolveSendButton();

    let method = 'enter';
    if ((await sendBtn.count().catch(() => 0))) {
      const enabled = await waitEnabled(sendBtn, 3000);

      if (!enabled) {
        await debug('Send button deshabilitado, forzando input events');
        try {
          await box.evaluate((el) => {
            try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
            catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('keyup', { bubbles: true }));
          });
        } catch {}
        await sleep(200);
      }

      const okEnabled = await waitEnabled(sendBtn, 5000);
      if (okEnabled) {
        method = 'button';
        await sendBtn.scrollIntoViewIfNeeded().catch(() => {});
        await sendBtn.click({ timeout: 15000, force: true });
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    await sleep(450);

    perMessage.push({
      i,
      ok: true,
      method,
      typed,
      length: text.length,
      preview: text.slice(0, 60),
    });

    await sleep(250);
  }

  const sentCount = perMessage.filter((x) => x.ok && !x.skipped).length;

  return { ok: true, sentCount, total: messages.length, perMessage };
}
`;

    try {
      verboseResult.executionDetails.steps.push(`Code length: ${code.length}`);
      verboseResult.executionDetails.steps.push('Executing Playwright code');

      const result = await this.playwright.runCode(code, sessionId);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;

      verboseResult.note = `Mensajes enviados vía Playwright directo (${cleaned.length}).`;
      verboseResult.result = result;

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });

      return {
        ok: false,
        error: e?.message ?? 'Unknown error',
        executionDetails: verboseResult.executionDetails,
        profileUrl,
        sessionId,
      };
    }
  }
}
