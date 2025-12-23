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
  // 5) Extracción robusta (timestamps + scoping) con múltiples fallbacks
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

    const extractClock = (raw) => {
      const s = norm(raw);
      if (!s) return { timeRaw: null, time: null };

      // 12h: 1:23 PM
      const m12 = s.match(/\\b(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\b/i);
      if (m12) {
        let hh = parseInt(m12[1], 10);
        const mm = m12[2];
        const ap = m12[3].toUpperCase();
        if (ap === 'PM' && hh < 12) hh += 12;
        if (ap === 'AM' && hh === 12) hh = 0;
        const hh2 = String(hh).padStart(2, '0');
        return { timeRaw: s, time: \`\${hh2}:\${mm}\` };
      }

      // 24h: 13:21
      const m24 = s.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
      if (m24) {
        const hh = String(parseInt(m24[1], 10)).padStart(2, '0');
        const mm = m24[2];
        return { timeRaw: s, time: \`\${hh}:\${mm}\` };
      }

      return { timeRaw: s, time: null };
    };

    const getSenderName = (group) =>
      norm(group.querySelector('.msg-s-message-group__name')?.textContent) ||
      norm(group.querySelector('[data-anonymize="person-name"]')?.textContent) ||
      norm(group.querySelector('[data-test-app-aware-link]')?.textContent) ||
      norm(group.querySelector('.msg-s-message-group__profile-link')?.textContent) ||
      null;

    const getSenderUrl = (group) => {
      const a =
        group.querySelector('a.msg-s-message-group__profile-link') ||
        group.querySelector('a[data-test-app-aware-link]') ||
        group.querySelector('a[href*="/in/"]');
      return a?.getAttribute?.('href') || null;
    };

    const getGroupTime = (group) => {
      const raw = pickFirst(group, [
        'time.msg-s-message-group__timestamp',
        'time[data-time]',
        'time[datetime]',
        'time',
        'span.msg-s-message-group__timestamp',
        '.msg-s-message-group__timestamp',
      ]);
      return extractClock(raw);
    };

    const getItemTime = (item, groupFallback) => {
      const raw = pickFirst(item, [
        'time.msg-s-event-listitem__timestamp',
        'time[datetime]',
        'time',
        '.timestamp',
        '[data-time]',
      ]);
      const parsed = extractClock(raw);
      return parsed.time ? parsed : groupFallback;
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

    // ✅ FALLBACK STRATEGY 1: Try primary selector
    const messages = [];
    const allGroups = [];
    
    // Strategy 1: Original .msg-s-message-group selector
    const groups1 = Array.from(rootEl.querySelectorAll('.msg-s-message-group'));
    if (groups1.length > 0) {
      allGroups.push(...groups1);
    }

    // ✅ FALLBACK STRATEGY 2: Alternative group selectors
    if (allGroups.length === 0) {
      const groups2 = Array.from(rootEl.querySelectorAll('.msg-s-event-listitem__group, [data-view-name*="message-group"]'));
      if (groups2.length > 0) {
        allGroups.push(...groups2);
      }
    }

    // ✅ FALLBACK STRATEGY 3: Even broader selectors
    if (allGroups.length === 0) {
      const groups3 = Array.from(rootEl.querySelectorAll('li[data-view-name*="message"], .message-item, .conversation-message'));
      if (groups3.length > 0) {
        allGroups.push(...groups3);
      }
    }

    // ✅ FALLBACK STRATEGY 4: Try without rootEl scoping if no groups found
    if (allGroups.length === 0) {
      const groups4 = Array.from(document.querySelectorAll('.msg-s-message-group'));
      if (groups4.length > 0) {
        allGroups.push(...groups4);
      }
    }

    // ✅ FALLBACK STRATEGY 5: Generic message containers
    if (allGroups.length === 0) {
      const groups5 = Array.from(document.querySelectorAll('[role="listitem"][data-view-name*="message"], .msg-conversation__body li'));
      if (groups5.length > 0) {
        allGroups.push(...groups5);
      }
    }

    const cappedGroups = allGroups.slice(-220); // preferimos lo más reciente

    for (const g of cappedGroups) {
      const senderName = getSenderName(g);
      const senderProfileUrl = getSenderUrl(g);
      const groupTime = getGroupTime(g);

      // ✅ FALLBACK STRATEGY: Multiple item selectors
      let items = Array.from(
        g.querySelectorAll(
          'li.msg-s-message-group__message, li.msg-s-event-listitem, .msg-s-event-listitem'
        )
      );

      // Fallback 1: Alternative item selectors
      if (items.length === 0) {
        items = Array.from(
          g.querySelectorAll(
            '.message-item, [data-test-id*="message"], .conversation-message-item'
          )
        );
      }

      // Fallback 2: Direct text containers
      if (items.length === 0) {
        items = Array.from(
          g.querySelectorAll(
            'p.msg-s-event-listitem__body, .msg-s-event-listitem__event-text, p[data-test-id="message-text"], .message-body'
          )
        )
          .map((p) => p.closest('li') || p.closest('div') || p)
          .filter(Boolean);
      }

      // Fallback 3: If still no items, treat the group itself as a message
      const effectiveItems = items.length > 0 ? items : [g];

      for (const it of effectiveItems) {
        const text = getItemText(it);
        if (!text) continue;

        const t = getItemTime(it, groupTime);

        const messageId =
          it.getAttribute?.('data-event-urn') || 
          it.getAttribute?.('data-message-id') ||
          it.id || 
          null;

        messages.push({
          id: messageId,
          senderName: senderName || null,
          senderProfileUrl: senderProfileUrl || null,
          time: t.time || null,       // ✅ HH:MM cuando se puede
          timeRaw: t.timeRaw || null, // ✅ lo que venía en DOM
          text,
        });
      }
    }

    // ✅ FALLBACK STRATEGY 6: If still no messages, try generic text extraction
    if (messages.length === 0) {
      const fallbackTexts = Array.from(rootEl.querySelectorAll('p, span'))
        .map(el => norm(el.textContent))
        .filter(text => text.length > 10 && text.length < 1000) // reasonable message length
        .slice(0, 50); // limit fallback messages
      
      for (let i = 0; i < fallbackTexts.length; i++) {
        messages.push({
          id: \`fallback-\${i}\`,
          senderName: null,
          senderProfileUrl: null,
          time: null,
          timeRaw: null,
          text: fallbackTexts[i],
        });
      }
    }

    // Dedupe
    const seen = new Set();
    const deduped = [];
    for (const m of messages) {
      const key = [m.senderName ?? '', m.time ?? '', m.text ?? ''].join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    const reversed =
      !!rootEl.querySelector('.msg-s-message-list-container--column-reversed') ||
      !!document.querySelector('.msg-s-message-list-container--column-reversed');

    const ordered = reversed ? deduped.reverse() : deduped;

    return {
      ok: true,
      totalFound: ordered.length,
      reversed,
      messages: ordered,
      fallbacksUsed: allGroups.length === 0 ? 'generic-text-extraction' : 
                     cappedGroups.length < groups1.length ? 'alternative-selectors' : 'primary-selectors',
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
            text: text,
            isFallback: true,
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
      text: '[No messages could be extracted from this conversation. This may indicate the chat is empty, requires login, or uses a different interface structure.]',
      isPlaceholder: true,
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
