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

  // ✅ utilidades locales (re-usan helpers del snippet)
  const normalizeProfileUrl = (u) => __normalizeUrl(u);
  const sameProfile = (a, b) => __sameUrl(a, b, false);

  // ✅ detectar si ya hay una conversación abierta (overlay/inline)
  const getOpenThreadProfileHref = async () => {
    const candidates = [
      '.msg-overlay-bubble-header__title a[href*="/in/"]',
      '.msg-overlay-conversation-bubble__header a[href*="/in/"]',
      '.msg-overlay-bubble-header a[href*="/in/"]',
      '.msg-thread__link-to-profile a[href*="/in/"]',
      'a.msg-thread__link-to-profile[href*="/in/"]',
      '.msg-conversation-card__header a[href*="/in/"]',
      '.msg-thread__header a[href*="/in/"]',
      '.msg-overlay-container a[href*="/in/"]',
      '.msg-overlay-conversation-bubble a[href*="/in/"]',
    ];

    for (const sel of candidates) {
      const a = page.locator(sel).first();
      if (!(await a.count().catch(() => 0))) continue;
      const href = (await a.getAttribute('href').catch(() => '')) || '';
      if (!href || !href.includes('/in/')) continue;
      if (href.startsWith('/')) return 'https://www.linkedin.com' + href;
      return href;
    }
    return '';
  };

  const threadHintMatchesNow = async () => {
    const hint = (threadHint || '').toString().trim().toLowerCase();
    if (!hint) return true;

    const titleLocs = [
      page.locator('.msg-overlay-bubble-header__title').last(),
      page.locator('.msg-overlay-conversation-bubble__header').last(),
      page.locator('.msg-thread__header').first(),
      page.locator('[data-view-name*="conversation"] header').first(),
    ];

    for (const loc of titleLocs) {
      try {
        if (!(await loc.count().catch(() => 0))) continue;
        const txt = ((await loc.innerText().catch(() => '')) || '').toLowerCase();
        if (txt && txt.includes(hint)) return true;
      } catch {}
    }
    return false;
  };

  const detectConversationRootNow = async () => {
    const candidates = [
      page.locator('.msg-overlay-conversation-bubble__content-wrapper').last(),
      page.locator('.msg-s-message-list').last(),
      page.locator('.msg-overlay-conversation-bubble').last(),
      page.locator('[role="main"] .msg-conversation-listitem').last(),
      page.locator('.msg-conversation__body').last(),
      page.locator('.msg-thread').last(),
      page.locator('[data-view-name*="conversation"]').last(),
      page.locator('.conversation-wrapper').last(),
    ];

    for (const loc of candidates) {
      try {
        if (!(await loc.count().catch(() => 0))) continue;
        if (await loc.isVisible().catch(() => false)) return loc;
      } catch {}
    }
    return null;
  };

  let root = await detectConversationRootNow();
  let usedFastPath = false;

  // ✅ FAST PATH: si ya hay conversación abierta y coincide con perfil o threadHint
  if (root) {
    const openHref = await getOpenThreadProfileHref();
    const same = openHref ? sameProfile(openHref, profileUrl) : false;
    const hintOk = await threadHintMatchesNow();

    if (same || hintOk) {
      usedFastPath = true;
      await debug(
        'Conversación ya abierta -> skip navegación/CTA (sameProfile=' +
          same +
          ', hintOk=' +
          hintOk +
          ', openHref=' +
          (openHref || 'n/a') +
          ')'
      );
    } else {
      root = null;
    }
  }

  // -----------------------------
  // 1) Ir al perfil (solo si hace falta)
  // -----------------------------
  if (!usedFastPath) {
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

        const msgItem = page.getByRole('menuitem', { name: /enviar mensaje|mensaje|message/i }).first();

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

    for (const candidate of containerCandidates) {
      try {
        await candidate.waitFor({ state: 'visible', timeout: 2000 });
        root = candidate;
        const containerType = await candidate.evaluate((el) => el.className || el.tagName);
        await debug(\`Container detected: \${containerType}\`);
        break;
      } catch {}
    }

    if (!root) {
      await debug('No specific conversation container found, using fallback to body');
      root = page.locator('body');
    }
  }

  // ✅ Wait for chat content to fully load before extraction
  await debug('Waiting for message content to load...');

  try {
    await root.locator('.msg-s-event-listitem, .msg-s-message-group').first().waitFor({ timeout: 3000, state: 'visible' });
    await debug('Message containers detected, proceeding with extraction');
  } catch {
    await debug('No structured message containers found after 3s, proceeding with fallback');
  }

  await sleep(800);

  // -----------------------------
  // 5) Scroll to load all messages before extraction
  // -----------------------------
  await debug('Starting message scrolling to load all content...');

  const scrollToLoadMessages = async () => {
    const scrollContainers = [
      '.msg-s-message-list',
      '.msg-overlay-conversation-bubble__content-wrapper',
      '.msg-conversation__body',
      '.msg-thread',
      '[data-view-name*="conversation"]',
    ];

    let scrollContainer = null;

    for (const selector of scrollContainers) {
      const container = root.locator(selector).first();
      if ((await container.count()) && (await container.isVisible().catch(() => false))) {
        scrollContainer = container;
        await debug(\`Found scrollable container: \${selector}\`);
        break;
      }
    }

    if (!scrollContainer) {
      await debug('No scrollable container found, using root for scrolling');
      scrollContainer = root;
    }

    let previousMessageCount = 0;
    let currentMessageCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 15;
    const scrollDelay = 800;

    do {
      previousMessageCount = currentMessageCount;
      currentMessageCount = await root.evaluate((rootEl) => {
        const groups = rootEl.querySelectorAll('.msg-s-event-listitem, .msg-s-message-group');
        return groups.length;
      });

      await debug(\`Scroll attempt \${scrollAttempts + 1}: \${currentMessageCount} messages found\`);

      try {
        await scrollContainer.evaluate((el) => {
          el.scrollTo({ top: 0, behavior: 'smooth' });
        });
        await sleep(scrollDelay);

        await scrollContainer.press('Home').catch(() => {});
        await sleep(200);

        for (let i = 0; i < 3; i++) {
          await scrollContainer.press('PageUp').catch(() => {});
          await sleep(100);
        }
      } catch (e) {
        await debug(\`Scrolling error: \${e && e.message ? e.message : String(e)}\`);
      }

      scrollAttempts++;
      await sleep(scrollDelay);
    } while (
      scrollAttempts < maxScrollAttempts &&
      (currentMessageCount > previousMessageCount || scrollAttempts < 3)
    );

    await debug(
      \`Scrolling completed. Final message count: \${currentMessageCount}, scroll attempts: \${scrollAttempts}\`
    );

    await sleep(1000);
  };

  await scrollToLoadMessages();

  // -----------------------------
  // 6) Extraction (con fix de datetime usando time-heading)
  // -----------------------------
  const payload = await root.evaluate(
    (rootEl, ctx) => {
      const targetProfileUrl = (ctx?.profileUrl ?? '').toString();
      const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();

      const stripAccents = (s) => {
        try {
          return (s || '').toString().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
        } catch {
          return (s || '').toString();
        }
      };

      const normalizeUrl = (u) => {
        const s = norm(u);
        if (!s) return '';
        try {
          const url = new URL(s, document.baseURI);
          let out = (url.origin + url.pathname).toLowerCase();
          while (out.endsWith('/')) out = out.slice(0, -1);
          return out;
        } catch {
          let out = s.toLowerCase();
          out = out.split('#')[0].split('?')[0];
          while (out.endsWith('/')) out = out.slice(0, -1);
          return out;
        }
      };

      const inferThreadProfileUrl = () => {
        const selectors = [
          '.msg-overlay-bubble-header__title a[href*="/in/"]',
          '.msg-overlay-conversation-bubble__header a[href*="/in/"]',
          '.msg-overlay-bubble-header a[href*="/in/"]',
          '.msg-thread__link-to-profile a[href*="/in/"]',
          'a.msg-thread__link-to-profile[href*="/in/"]',
          '.msg-conversation-card__header a[href*="/in/"]',
          '.msg-thread__header a[href*="/in/"]',
        ];

        for (const sel of selectors) {
          const a = document.querySelector(sel);
          const href = a && (a.getAttribute('href') || a.href);
          if (href && href.includes('/in/')) {
            try {
              const abs = new URL(href, document.baseURI).toString();
              return abs;
            } catch {
              return href;
            }
          }
        }

        const broad = document.querySelector(
          '.msg-overlay-container a[href*="/in/"], .msg-overlay-conversation-bubble a[href*="/in/"]'
        );
        const href = broad && (broad.getAttribute('href') || broad.href);
        if (href && href.includes('/in/')) {
          try {
            const abs = new URL(href, document.baseURI).toString();
            return abs;
          } catch {
            return href;
          }
        }

        return '';
      };

      const targetProfileUrlNorm = normalizeUrl(targetProfileUrl || inferThreadProfileUrl() || '');

      const pickFirst = (node, selectors) => {
        if (!node) return null;
        for (const sel of selectors) {
          const el = node.querySelector(sel);
          if (!el) continue;
          const raw =
            norm(el.getAttribute?.('aria-label')) ||
            norm(el.getAttribute?.('datetime')) ||
            norm(el.getAttribute?.('title')) ||
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

      // ✅ FIX DATETIME: usar el "time heading" más cercano (ej: "9 dic", "jueves")
      const getDayHeadingTextForNode = (node) => {
        try {
          const el = node && node.nodeType === 1 ? node : node?.parentElement;
          if (!el) return '';

          const container =
            el.closest?.('.msg-s-message-list') ||
            rootEl.querySelector?.('.msg-s-message-list') ||
            document.querySelector?.('.msg-s-message-list') ||
            rootEl;

          if (!container) return '';

          const headings = Array.from(
            container.querySelectorAll('time.msg-s-message-list__time-heading, time.msg-s-message-list__time-heading *')
          )
            .map((x) => (x.tagName === 'TIME' ? x : x.closest('time')))
            .filter(Boolean);

          let best = null;

          for (const h of headings) {
            if (!h || !h.compareDocumentPosition) continue;
            const pos = h.compareDocumentPosition(el);
            // si el message está DESPUÉS del heading => DOCUMENT_POSITION_FOLLOWING
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
          }

          const txt = best ? norm(best.textContent) : '';
          return txt;
        } catch {
          return '';
        }
      };

      const parseDayHeadingToYMD = (raw, now = new Date()) => {
        const s0 = norm(raw);
        if (!s0) return { ymd: null, dateObj: null, raw: null };

        const s = stripAccents(s0).toLowerCase().replace(/[\\.,]/g, ' ');
        const clean = s.replace(/\\s+/g, ' ').trim();

        const months = {
          // ES
          ene: 0, enero: 0,
          feb: 1, febrero: 1,
          mar: 2, marzo: 2,
          abr: 3, abril: 3,
          may: 4, mayo: 4,
          jun: 5, junio: 5,
          jul: 6, julio: 6,
          ago: 7, agosto: 7,
          sep: 8, sept: 8, septiembre: 8,
          oct: 9, octubre: 9,
          nov: 10, noviembre: 10,
          dic: 11, diciembre: 11,
          // EN
          jan: 0, january: 0,
          february: 1,
          march: 2,
          apr: 3, april: 3,
          jun: 5, june: 5,
          jul: 6, july: 6,
          aug: 7, august: 7,
          sept: 8, september: 8,
          oct: 9, october: 9,
          nov: 10, november: 10,
          dec: 11, december: 11,
        };

        const weekdays = {
          domingo: 0, sunday: 0,
          lunes: 1, monday: 1,
          martes: 2, tuesday: 2,
          miercoles: 3, wednesday: 3,
          jueves: 4, thursday: 4,
          viernes: 5, friday: 5,
          sabado: 6, saturday: 6,
        };

        // Relativos
        if (clean === 'hoy' || clean === 'today') {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const ymd = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
          return { ymd, dateObj: d, raw: s0 };
        }
        if (clean === 'ayer' || clean === 'yesterday') {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          d.setDate(d.getDate() - 1);
          const ymd = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
          return { ymd, dateObj: d, raw: s0 };
        }

        // Weekday (ej: "jueves")
        if (weekdays.hasOwnProperty(clean)) {
          const target = weekdays[clean];
          const cur = now.getDay();
          const diff = (cur - target + 7) % 7;
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          d.setDate(d.getDate() - diff);
          const ymd = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
          return { ymd, dateObj: d, raw: s0 };
        }

        // Día + mes (ej: "9 dic", "9 de dic", "Dec 9")
        let m =
          clean.match(/\\b(\\d{1,2})\\s*(?:de\\s*)?([a-z]{3,9})(?:\\s*(\\d{4}))?\\b/i) ||
          clean.match(/\\b([a-z]{3,9})\\s*(\\d{1,2})(?:\\s*(\\d{4}))?\\b/i);

        if (m) {
          let day = null;
          let monStr = null;
          let year = null;

          if (/^\\d/.test(m[1])) {
            // (day)(month)(year?)
            day = parseInt(m[1], 10);
            monStr = (m[2] || '').toLowerCase();
            year = m[3] ? parseInt(m[3], 10) : null;
          } else {
            // (month)(day)(year?)
            monStr = (m[1] || '').toLowerCase();
            day = parseInt(m[2], 10);
            year = m[3] ? parseInt(m[3], 10) : null;
          }

          // Normalizar month key (corta a 3 si hace falta)
          let monKey = monStr;
          if (!months.hasOwnProperty(monKey) && monKey.length > 3) monKey = monKey.slice(0, 3);

          if (months.hasOwnProperty(monKey) && day && day >= 1 && day <= 31) {
            let yy = year || now.getFullYear();
            let d = new Date(yy, months[monKey], day);

            // Heurística de año: si queda en el futuro "demasiado", probablemente fue año anterior (ej: hoy es enero y dice "dic")
            const futureGuard = new Date(now.getTime());
            futureGuard.setDate(futureGuard.getDate() + 2);

            if (!year && d.getTime() > futureGuard.getTime()) {
              yy = yy - 1;
              d = new Date(yy, months[monKey], day);
            }

            const ymd = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
            return { ymd, dateObj: d, raw: s0 };
          }
        }

        return { ymd: null, dateObj: null, raw: s0 };
      };

      const combineYmdAndTimeToIso = (ymd, hhmm) => {
        if (!ymd) return null;
        const parts = (ymd || '').split('-').map((x) => parseInt(x, 10));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
        const [Y, M, D] = parts;

        let hh = 0;
        let mm = 0;

        if (hhmm && /^\\d{2}:\\d{2}$/.test(hhmm)) {
          hh = parseInt(hhmm.slice(0, 2), 10);
          mm = parseInt(hhmm.slice(3, 5), 10);
        }

        const dt = new Date(Y, M - 1, D, hh, mm, 0, 0);
        if (isNaN(dt.getTime())) return null;
        return dt.toISOString();
      };

      // ✅ (mantener) role detection helpers
      const inferRoleByLayout = (itemEl) => {
        try {
          if (!itemEl) return null;

          const bubble =
            itemEl.querySelector(
              '.msg-s-event-listitem__message-bubble,' +
                ' .msg-s-event-listitem__body,' +
                ' p.msg-s-event-listitem__body,' +
                ' .msg-s-event-listitem__event'
            ) || itemEl;

          const r = bubble.getBoundingClientRect?.();
          if (!r || !r.width) return null;

          const container =
            bubble.closest(
              '.msg-s-message-list-container,' +
                ' .msg-s-message-list,' +
                ' .msg-thread,' +
                ' .msg-overlay-conversation-bubble__content-wrapper,' +
                ' [data-view-name*="conversation"]'
            ) || rootEl;

          const cr = container.getBoundingClientRect?.();
          if (!cr || !cr.width) return null;

          const pad = Math.min(80, Math.max(24, cr.width * 0.12));
          const distLeft = r.left - cr.left;
          const distRight = cr.right - r.right;

          if (distRight < pad && distLeft > pad) return 'recruiter';
          if (distLeft < pad && distRight > pad) return 'candidate';

          const bubbleCenter = r.left + r.width / 2;
          const containerCenter = cr.left + cr.width / 2;
          const deadZone = cr.width * 0.05;

          if (bubbleCenter > containerCenter + deadZone) return 'recruiter';
          if (bubbleCenter < containerCenter - deadZone) return 'candidate';

          return null;
        } catch {
          return null;
        }
      };

      const hasSelfHints = (node) => {
        let cur = node;
        let hops = 0;
        while (cur && hops < 10) {
          const cls = (cur.className || '').toString().toLowerCase();

          if (
            cls.includes('from-me') ||
            cls.includes('is-from-me') ||
            cls.includes('--me') ||
            cls.includes('--self') ||
            cls.includes('--mine') ||
            cls.includes('own-message') ||
            cls.includes('message--own')
          ) {
            return true;
          }

          try {
            const attrBag = [
              cur.getAttribute?.('data-message-author'),
              cur.getAttribute?.('data-sender'),
              cur.getAttribute?.('data-event-direction'),
              cur.getAttribute?.('data-direction'),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();

            if (
              attrBag.includes('self') ||
              attrBag.includes('me') ||
              attrBag.includes('outbound') ||
              attrBag.includes('sent')
            ) {
              return true;
            }
          } catch {}

          cur = cur.parentElement;
          hops++;
        }
        return false;
      };

      const inferRoleByLinkedInClasses = (node) => {
        try {
          if (!node) return null;

          const item =
            node.closest?.('.msg-s-event-listitem') || node.querySelector?.('.msg-s-event-listitem') || null;

          if (!item) return null;

          const cls = (item.className || '').toString().toLowerCase();

          if (cls.includes('msg-s-event-listitem--system')) return null;
          if (cls.includes('msg-s-event-listitem--other')) return 'candidate';

          const meta = item.parentElement?.querySelector?.('.msg-s-message-group__meta');
          const metaCls = (meta?.className || '').toString().toLowerCase();
          if (metaCls.includes('msg-s-message-group__meta--other')) return 'candidate';

          if (cls.includes('msg-s-event-listitem')) return 'recruiter';

          return null;
        } catch {
          return null;
        }
      };

      const detectRole = (itemEl, groupEl, senderName, senderUrl) => {
        const byClass = inferRoleByLinkedInClasses(itemEl) || inferRoleByLinkedInClasses(groupEl);
        if (byClass) return byClass;

        if (hasSelfHints(itemEl) || hasSelfHints(groupEl)) return 'recruiter';

        const byLayout = inferRoleByLayout(itemEl);
        if (byLayout) return byLayout;

        const name = norm(senderName).toLowerCase();
        if (name === 'you' || name === 'tú' || name === 'tu' || name === 'vos' || name === 'yo') {
          return 'recruiter';
        }

        const sUrl = normalizeUrl(senderUrl || '');
        if (sUrl && targetProfileUrlNorm && sUrl === targetProfileUrlNorm) return 'candidate';

        if (senderName) return 'candidate';
        return null;
      };

      // URN discovery (igual que antes)
      const extractConversationUrn = (raw) => {
        const s = norm(raw);
        if (!s) return '';
        const m1 = s.match(/urn:li:msg_conversation:\\([^\\)]+\\)/i);
        if (m1 && m1[0]) return m1[0];
        const m2 = s.match(/urn:li:msg_conversation:[^\\s\\)\\,"]+/i);
        if (m2 && m2[0]) return m2[0];
        const m3 = s.match(/urn:li:msg_message:\\((urn:li:msg_conversation:[^\\)]+)\\,/i);
        if (m3 && m3[1]) return m3[1];
        const m4 = s.match(/urn:li:msg_message:\\((urn:li:msg_conversation:\\([^\\)]+\\))\\,/i);
        if (m4 && m4[1]) return m4[1];
        return '';
      };

      const findConversationUrnInDom = () => {
        const fromUrl = extractConversationUrn(location.href);
        if (fromUrl) return fromUrl;

        const urnEls = Array.from(
          rootEl.querySelectorAll(
            '[data-event-urn],[data-entity-urn],[data-urn],[data-conversation-urn],[data-conversation-id]'
          )
        );

        for (const el of urnEls) {
          const attrs = [
            'data-conversation-urn',
            'data-entity-urn',
            'data-event-urn',
            'data-urn',
            'data-conversation-id',
          ];
          for (const a of attrs) {
            const v = el.getAttribute && el.getAttribute(a);
            const urn = extractConversationUrn(v);
            if (urn) return urn;
          }
        }

        const sample = Array.from(rootEl.querySelectorAll('*')).slice(0, 600);
        for (const el of sample) {
          const v =
            (el.getAttribute &&
              (el.getAttribute('data-event-urn') || el.getAttribute('data-entity-urn') || el.getAttribute('data-urn'))) ||
            '';
          const urn = extractConversationUrn(v);
          if (urn) return urn;
        }

        return '';
      };

      const conversationUrn = findConversationUrnInDom();
      const threadProfileUrlDetected = inferThreadProfileUrl();

      const getSenderName = (group) => {
        let name =
          norm(group.querySelector('.msg-s-message-group__name')?.textContent) ||
          norm(group.querySelector('.msg-s-message-group__profile-link')?.textContent) ||
          norm(group.querySelector('[data-anonymize="person-name"]')?.textContent) ||
          norm(group.querySelector('a[data-test-app-aware-link] .msg-s-message-group__name')?.textContent) ||
          norm(group.querySelector('a[data-test-app-aware-link]')?.textContent);

        if (name) return name;

        const metaContainer = group.querySelector('.msg-s-message-group__meta');
        if (metaContainer) {
          name =
            norm(metaContainer.querySelector('.msg-s-message-group__name')?.textContent) ||
            norm(metaContainer.querySelector('a[href*="/in/"]')?.textContent) ||
            norm(metaContainer.querySelector('[data-test-app-aware-link]')?.textContent);
          if (name) return name;
        }

        const imgs = group.querySelectorAll(
          'img.msg-s-event-listitem__profile-picture, img[alt], img[title], img[data-ghost-person]'
        );
        for (const img of imgs) {
          name = norm(img.getAttribute('title')) || norm(img.getAttribute('alt')) || norm(img.getAttribute('aria-label'));
          if (name && !name.match(/^(profile|foto|picture|image)$/i)) return name;
        }

        const a11yTexts = group.querySelectorAll('.a11y-text, .visually-hidden, [aria-label]');
        for (const a11y of a11yTexts) {
          const text = a11y.textContent || a11y.getAttribute('aria-label');
          if (text) {
            const patterns = [
              /View\\s+(.+?)'?s?\\s+profile/i,
              /(.+?)\\s+sent\\s+a\\s+message/i,
              /Message\\s+from\\s+(.+)/i,
              /(.+?)\\s+dice:/i,
              /(.+?)\\s+says:/i,
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

        const profileLinks = group.querySelectorAll('a[href*="/in/"], a[href*="linkedin.com"]');
        for (const link of profileLinks) {
          name = norm(link.textContent);
          if (name && name.length > 1 && !name.match(/^(profile|perfil|view|ver)$/i)) return name;

          const nested = link.querySelector('.msg-s-message-group__name, [data-anonymize="person-name"], strong, span');
          if (nested) {
            name = norm(nested.textContent);
            if (name) return name;
          }

          const linkImg = link.querySelector('img[alt], img[title]');
          if (linkImg) {
            name = norm(linkImg.getAttribute('title')) || norm(linkImg.getAttribute('alt'));
            if (name && !name.match(/^(profile|foto|picture|image)$/i)) return name;
          }
        }

        const headers = group.querySelectorAll('h1, h2, h3, h4, h5, h6, .heading, [role="heading"]');
        for (const header of headers) {
          name = norm(header.textContent);
          if (name && name.length > 1 && name.length < 50) return name;
        }

        return null;
      };

      const getSenderUrl = (group) => {
        const candidates = [
          'a.msg-s-event-listitem__link[href*="/in/"]',
          'a.msg-s-message-group__profile-link[href*="/in/"]',
          '.msg-s-message-group__meta a[href*="/in/"]',
          'a[data-test-app-aware-link][href*="/in/"]',
          'a[href*="/in/ACoAA"]',
          'a[href*="linkedin.com/in/"]',
        ];

        for (const selector of candidates) {
          const link = group.querySelector(selector);
          if (link) {
            const href = link.getAttribute('href');
            if (href && href.includes('/in/')) {
              if (href.startsWith('/')) return 'https://www.linkedin.com' + href;
              return href;
            }
          }
        }

        const allLinks = Array.from(group.querySelectorAll('a[href]'));
        for (const link of allLinks) {
          const href = link.getAttribute('href');
          if (href) {
            const patterns = [
              /linkedin\\.com\\/in\\//i,
              /\\/in\\/ACoAA/,
              /\\/in\\/[a-zA-Z0-9\\-]+/,
              /miniprofile\\/.*urn.*person/i,
            ];

            for (const pattern of patterns) {
              if (pattern.test(href)) {
                if (href.startsWith('/')) return 'https://www.linkedin.com' + href;
                return href;
              }
            }
          }
        }

        const dataAttrs = ['data-member-id', 'data-profile-id', 'data-person-urn'];
        for (const attr of dataAttrs) {
          const value = group.getAttribute(attr) || group.querySelector(\`[\${attr}]\`)?.getAttribute(attr);
          if (value) {
            if (value.match(/^\\d+$/) || value.includes('ACoAA')) {
              return \`https://www.linkedin.com/in/\${value}\`;
            }
          }
        }

        return null;
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

      const findParentMeta = (messageElement) => {
        let current = messageElement;
        let attempts = 0;
        const maxAttempts = 10;

        while (current && current !== rootEl && attempts < maxAttempts) {
          attempts++;

          const parent = current.parentElement;
          if (!parent) break;

          const metaInSiblings = parent.querySelector('.msg-s-message-group__meta');
          if (metaInSiblings) return metaInSiblings;

          const metaInParent = parent.querySelector('.msg-s-message-group__meta');
          if (metaInParent) return metaInParent;

          let sibling = current.previousElementSibling;
          while (sibling) {
            const metaInSibling = sibling.querySelector('.msg-s-message-group__meta');
            if (metaInSibling) return metaInSibling;

            if (sibling.classList.contains('msg-s-message-group__meta')) return sibling;

            sibling = sibling.previousElementSibling;
          }

          current = parent;
        }

        return null;
      };

      const extractWithStrategy = (strategyName, groupSelector, scopeEl = rootEl) => {
        const groups = Array.from(scopeEl.querySelectorAll(groupSelector));
        const messages = [];

        for (const g of groups) {
          let senderName = getSenderName(g);
          let senderProfileUrl = getSenderUrl(g);
          let groupTime = getGroupTime(g);

          if (g.classList.contains('msg-s-event-listitem') && !senderName && !senderProfileUrl) {
            const parentMeta = findParentMeta(g);
            if (parentMeta) {
              senderName = getSenderName(parentMeta);
              senderProfileUrl = getSenderUrl(parentMeta);
              if (!groupTime.time) groupTime = getGroupTime(parentMeta);
            }
          }

          let items = [];

          if (g.classList.contains('msg-s-event-listitem')) {
            items = [g];
          } else {
            items = Array.from(
              g.querySelectorAll('li.msg-s-message-group__message, li.msg-s-event-listitem, .msg-s-event-listitem')
            );

            if (g.classList.contains('msg-s-message-group__meta')) {
              const parent = g.parentElement;
              if (parent) {
                let nextSibling = g.nextElementSibling;
                const relatedItems = [];

                while (nextSibling) {
                  if (
                    nextSibling.classList.contains('msg-s-event-listitem') ||
                    nextSibling.classList.contains('msg-s-message-list__event')
                  ) {
                    relatedItems.push(nextSibling);
                  }

                  const nestedItems = nextSibling.querySelectorAll('.msg-s-event-listitem');
                  relatedItems.push(...Array.from(nestedItems));

                  nextSibling = nextSibling.nextElementSibling;

                  if (nextSibling && nextSibling.querySelector('.msg-s-message-group__meta')) break;
                }

                if (relatedItems.length > 0) items.push(...relatedItems);
              }
            }
          }

          if (items.length === 0) {
            items = Array.from(
              g.querySelectorAll('.message-item, [data-test-id*="message"], .conversation-message-item')
            );
          }

          if (items.length === 0) {
            items = Array.from(
              g.querySelectorAll(
                'p.msg-s-event-listitem__body, .msg-s-event-listitem__event-text, p[data-test-id="message-text"], .message-body'
              )
            )
              .map((p) => p.closest('li') || p.closest('div') || p)
              .filter(Boolean);
          }

          const effectiveItems = items.length > 0 ? items : [g];

          for (const it of effectiveItems) {
            const text = getItemText(it);
            if (!text) continue;

            const t = getItemTime(it, groupTime);

            const messageId =
              it.getAttribute?.('data-event-urn') ||
              it.getAttribute?.('data-message-id') ||
              it.id ||
              \`\${strategyName}-msg-\${messages.length}\`;

            let finalSenderName = senderName;
            let finalSenderUrl = senderProfileUrl;

            if (!finalSenderName || !finalSenderUrl) {
              const itemMeta = findParentMeta(it);
              if (itemMeta) {
                finalSenderName = finalSenderName || getSenderName(itemMeta);
                finalSenderUrl = finalSenderUrl || getSenderUrl(itemMeta);
              }
            }

            // ✅ NEW: datetime desde time-heading más cercano (ej: "9 dic", "jueves")
            const dayHeadingRaw =
              getDayHeadingTextForNode(it) ||
              getDayHeadingTextForNode(g) ||
              getDayHeadingTextForNode(findParentMeta(it)) ||
              '';

            const day = parseDayHeadingToYMD(dayHeadingRaw, new Date());
            const datetimeFromHeading = day?.ymd ? combineYmdAndTimeToIso(day.ymd, t.time) : null;

            // fallback: si no hay heading o no se pudo parsear, dejamos null (antes te quedaba null siempre)
            const datetime = datetimeFromHeading;

            const role = detectRole(it, g, finalSenderName, finalSenderUrl);

            messages.push({
              id: messageId,
              senderName: finalSenderName || null,
              senderProfileUrl: finalSenderUrl || null,
              time: t.time || null,
              timeRaw: t.timeRaw || null,
              text,
              extractionStrategy: strategyName,
              datetime,
              role,
            });
          }
        }

        return {
          strategyName,
          groupsFound: groups.length,
          messages,
          messagesFound: messages.length,
        };
      };

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

      // Generic fallback (igual que antes)
      if (extractionResults.every((r) => r.messagesFound === 0)) {
        console.log('[extract-debug] All structured strategies failed, trying generic text extraction');
        const fallbackEls = Array.from(rootEl.querySelectorAll('p, span, div'))
          .filter((el) => {
            const text = norm(el.textContent);
            return (
              text.length > 10 &&
              text.length < 1000 &&
              !el.querySelector('input, button, a') &&
              !/^(send|enviar|type|escribir|profile|perfil)/i.test(text)
            );
          })
          .slice(0, 50);

        const fallbackTexts = fallbackEls.map((el) => norm(el.textContent));

        const fallbackMessages = [];
        for (let i = 0; i < fallbackTexts.length; i++) {
          fallbackMessages.push({
            id: \`generic-fallback-\${i}\`,
            senderName: null,
            senderProfileUrl: null,
            time: null,
            timeRaw: null,
            text: fallbackTexts[i],
            extractionStrategy: 'generic-text-fallback',
            datetime: null,
            role: null,
          });
        }

        extractionResults.push({
          strategyName: 'generic-text-fallback',
          groupsFound: 0,
          messages: fallbackMessages,
          messagesFound: fallbackMessages.length,
        });
      }

      // Pick best strategy
      let bestStrategy = extractionResults[0];

      for (const result of extractionResults) {
        if (result.messagesFound === 0) continue;

        const currentScore = result.messagesFound;
        const currentSenderScore = result.messages.filter((m) => m.senderName || m.senderProfileUrl).length;
        const currentQuality = currentScore + currentSenderScore * 0.5;

        const bestScore = bestStrategy.messagesFound;
        const bestSenderScore =
          bestStrategy.messages?.filter((m) => m.senderName || m.senderProfileUrl).length || 0;
        const bestQuality = bestScore + bestSenderScore * 0.5;

        if (currentQuality > bestQuality) bestStrategy = result;
      }

      // Dedupe
      const seen = new Set();
      const deduped = [];
      for (const m of bestStrategy.messages || []) {
        const key = [m.senderName ?? '', m.time ?? '', m.text ?? ''].join('||');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(m);
      }

      const reversed =
        !!rootEl.querySelector('.msg-s-message-list-container--column-reversed') ||
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
        conversationUrn: conversationUrn || null,
        threadProfileUrlDetected: threadProfileUrlDetected || null,
        debugInfo: {
          strategiesAttempted: extractionResults.length,
          bestStrategyName: bestStrategy.strategyName,
          bestStrategyGroups: bestStrategy.groupsFound,
          allResults: extractionResults.map((r) => ({
            name: r.strategyName,
            groups: r.groupsFound,
            messages: r.messagesFound,
            withSender: r.messages?.filter((m) => m.senderName || m.senderProfileUrl).length || 0,
            withDatetime: r.messages?.filter((m) => !!m.datetime).length || 0,
          })),
        },
      };
    },
    { profileUrl }
  );

  // ✅ DEBUG: resumen de extracción
  try {
    await debug(
      'Extraction summary -> ' +
        JSON.stringify(
          {
            totalFound: payload?.totalFound,
            bestStrategy: payload?.bestStrategy,
            reversed: payload?.reversed,
            conversationUrn: payload?.conversationUrn,
            threadProfileUrlDetected: payload?.threadProfileUrlDetected,
            strategies: payload?.debugInfo?.allResults?.slice(0, 10),
          },
          null,
          2
        ).slice(0, 1800)
    );
  } catch {}

  // ✅ DEBUG: sample de mensajes (los últimos 8)
  try {
    const all = Array.isArray(payload?.messages) ? payload.messages : [];
    const sample = all.slice(Math.max(0, all.length - 8)).map((m) => ({
      id: m?.id ?? null,
      role: m?.role ?? null,
      datetime: m?.datetime ?? null,
      time: m?.time ?? null,
      senderName: m?.senderName ?? null,
      senderProfileUrl: m?.senderProfileUrl ?? null,
      textPreview: (m?.text ?? '').toString().slice(0, 140),
      extractionStrategy: m?.extractionStrategy ?? null,
    }));

    await debug('Messages sample(last 8) -> ' + JSON.stringify({ count: all.length, sample }, null, 2).slice(0, 2200));
  } catch {}

  let msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  if (msgs.length > limit) msgs = msgs.slice(-limit);

  // ✅ FINAL FALLBACK: si 0 mensajes, fallback de texto
  if (msgs.length === 0) {
    await debug('Zero messages extracted, applying final fallbacks');

    const finalFallback = await root
      .evaluate((rootEl) => {
        const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();
        const fallbackMessages = [];

        const textElements = Array.from(rootEl.querySelectorAll('p, div, span'))
          .filter((el) => {
            const text = norm(el.textContent);
            return (
              text.length > 10 &&
              text.length < 2000 &&
              !el.querySelector('input, button, a') &&
              !/^(send|enviar|type|escribir)/i.test(text)
            );
          })
          .slice(0, 20);

        for (let i = 0; i < textElements.length; i++) {
          const text = norm(textElements[i].textContent);
          if (text) {
            fallbackMessages.push({
              id: \`emergency-fallback-\${i}\`,
              senderName: null,
              senderProfileUrl: null,
              time: null,
              timeRaw: null,
              text,
              isFallback: true,
              datetime: null,
              role: null,
            });
          }
        }

        return fallbackMessages;
      })
      .catch(() => []);

    if (finalFallback.length > 0) {
      msgs = finalFallback.slice(0, Math.min(limit, 10));
      await debug(\`Emergency fallback applied: found \${msgs.length} text elements\`);
    }
  }

  if (msgs.length === 0) {
    await debug('All fallback strategies failed, creating placeholder message');
    msgs = [
      {
        id: 'no-messages-placeholder',
        senderName: null,
        senderProfileUrl: null,
        time: null,
        timeRaw: null,
        text: '[No messages could be extracted from this conversation. This may indicate the chat is empty, requires login, or uses a different interface structure.]',
        isPlaceholder: true,
        datetime: null,
        role: null,
      },
    ];
  }

  // ✅ TEST: LinkedIn GraphQL API fetch for testing
  await debug('Testing LinkedIn GraphQL API fetch...');

  const conversationUrn = payload && payload.conversationUrn ? String(payload.conversationUrn) : '';
  const threadProfileUrlDetected = payload && payload.threadProfileUrlDetected ? String(payload.threadProfileUrlDetected) : '';

  const baseGraphql = "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";
  const queryId = "messengerMessages.5846eeb71c981f11e0134cb6626cc314";

  const variablesRaw = conversationUrn ? \`(conversationUrn:\${conversationUrn})\` : '';
  const testUrl = conversationUrn
    ? \`\${baseGraphql}?queryId=\${encodeURIComponent(queryId)}&variables=\${encodeURIComponent(variablesRaw)}\`
    : null;

  let graphqlTestResult = null;
  let graphqlMessages = null;

  try {
    if (!testUrl) {
      graphqlTestResult = {
        ok: false,
        skipped: true,
        reason: "No conversationUrn detected in DOM",
        conversationUrn: conversationUrn || null,
        threadProfileUrlDetected: threadProfileUrlDetected || null,
      };
      await debug('GraphQL test skipped (no conversationUrn detected)');
    } else {
      graphqlTestResult = await page.evaluate(
        async ({ testUrl, targetProfileUrl }) => {
          try {
            let csrf = null;

            csrf = window.csrfToken || window._csrf || window.CSRF_TOKEN;

            if (!csrf) {
              const metaSelectors = [
                'meta[name="csrf-token"]',
                'meta[name="_csrf"]',
                'meta[name="csrf_token"]',
                'meta[name="x-csrf-token"]',
                'meta[property="csrf-token"]',
                'meta[http-equiv="csrf-token"]',
              ];

              for (const selector of metaSelectors) {
                const meta = document.querySelector(selector);
                if (meta) {
                  csrf = meta.getAttribute('content') || meta.getAttribute('value');
                  if (csrf) break;
                }
              }
            }

            if (!csrf) {
              const scripts = document.querySelectorAll('script');
              for (const script of scripts) {
                const text = script.textContent || script.innerHTML;
                if (text && text.includes('csrf')) {
                  const patterns = [
                    /"csrf[Tt]oken"\\s*:\\s*"([^"]+)"/,
                    /'csrf[Tt]oken'\\s*:\\s*'([^']+)'/,
                    /csrf[Tt]oken['"]*\\s*[=:]\\s*['"]([^'"]+)['"]/,
                    /"_csrf"\\s*:\\s*"([^"]+)"/,
                    /'_csrf'\\s*:\\s*'([^']+)'/,
                  ];

                  for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match && match[1]) {
                      csrf = match[1];
                      break;
                    }
                  }
                  if (csrf) break;
                }
              }
            }

            if (!csrf) {
              const dataAttrs = ['data-csrf-token', 'data-csrf', 'data-x-csrf-token'];
              for (const attr of dataAttrs) {
                csrf = document.documentElement.getAttribute(attr) || document.body.getAttribute(attr);
                if (csrf) break;
              }
            }

            if (!csrf && window.lix && window.lix.clientState) {
              csrf = window.lix.clientState.csrfToken || window.lix.clientState.csrf;
            }

            if (!csrf && window.appConfig) {
              csrf = window.appConfig.csrfToken || window.appConfig.csrf;
            }

            if (!csrf) csrf = 'no-csrf-found';

            const res = await fetch(testUrl, {
              method: "GET",
              credentials: "include",
              headers: {
                "csrf-token": csrf,
                "accept": "application/json",
                "x-restli-protocol-version": "2.0.0",
              },
            });

            let json = null;
            let responseText = null;

            try {
              json = await res.json();
            } catch {
              responseText = await res.text();
            }

            const csrfDebugInfo = {
              windowCsrfToken: !!window.csrfToken,
              windowCsrf: !!window._csrf,
              windowCSRFTOKEN: !!window.CSRF_TOKEN,
              metaTagsChecked: document.querySelectorAll('meta[name*="csrf"], meta[property*="csrf"]').length,
              scriptsWithCsrf: Array.from(document.querySelectorAll('script')).filter((s) => (s.textContent || '').includes('csrf')).length,
              hasLixClientState: !!(window.lix && window.lix.clientState),
              hasAppConfig: !!window.appConfig,
              foundCsrf: csrf !== 'no-csrf-found',
            };

            const extracted = [];
            const seen = new Set();
            const norm = (s) => (s ?? '').toString().replace(/\\s+/g, ' ').trim();

            const buildProfileUrlFromMini = (mini) => {
              const pid = mini && (mini.publicIdentifier || mini.publicIdentifierString || mini.publicIdentifierV2);
              if (pid) return 'https://www.linkedin.com/in/' + pid;
              return null;
            };

            const toIso = (ts) => {
              if (typeof ts === 'number' && ts > 0) {
                const ms = ts < 2e12 ? ts * 1000 : ts;
                const d = new Date(ms);
                if (!isNaN(d.getTime())) return d.toISOString();
              }
              return null;
            };

            const pushMsg = (m) => {
              const text = norm(m.text);
              if (!text) return;
              const key = (m.senderName || '') + '||' + (m.datetime || '') + '||' + text;
              if (seen.has(key)) return;
              seen.add(key);
              extracted.push(m);
            };

            const walk = (node) => {
              if (!node) return;
              if (Array.isArray(node)) return node.forEach(walk);
              if (typeof node !== 'object') return;

              const ec = node.eventContent || null;
              if (ec) {
                const msgEvent =
                  ec['com.linkedin.voyager.messaging.event.MessageEvent'] ||
                  ec['com.linkedin.voyager.messaging.event.MessageEventV2'] ||
                  ec.MessageEvent ||
                  ec.messageEvent ||
                  null;

                if (msgEvent) {
                  const t =
                    (msgEvent.attributedBody && (msgEvent.attributedBody.text || msgEvent.attributedBody.textV2)) ||
                    (msgEvent.body && (msgEvent.body.text || msgEvent.body.messageText)) ||
                    msgEvent.text;

                  const from = msgEvent.from || msgEvent.sender || node.from || node.sender || null;
                  const mini =
                    (from && (from.miniProfile || from.miniProfileV2 || from.miniProfileUrn)) || node.miniProfile || null;
                  const senderName =
                    (mini && (mini.firstName || mini.firstNameV2 || '')) +
                    (mini && (mini.lastName || mini.lastNameV2) ? ' ' + (mini.lastName || mini.lastNameV2) : '');
                  const senderProfileUrl = buildProfileUrlFromMini(mini);

                  const createdAt =
                    msgEvent.createdAt || msgEvent.time || msgEvent.timestamp || node.createdAt || node.time || node.timestamp;
                  const datetime = toIso(createdAt);

                  if (typeof t === 'string') {
                    pushMsg({
                      id: node.entityUrn || node.urn || node.eventUrn || node.messageUrn || null,
                      senderName: norm(senderName) || null,
                      senderProfileUrl: senderProfileUrl || null,
                      time: null,
                      timeRaw: null,
                      text: norm(t),
                      extractionStrategy: 'graphql-fallback',
                      datetime,
                      role: null,
                    });
                  }
                }
              }

              for (const k of Object.keys(node)) walk(node[k]);
            };

            if (json) walk(json);

            return {
              ok: res.ok,
              status: res.status,
              statusText: res.statusText,
              headers: Object.fromEntries(res.headers.entries()),
              responseText: responseText ? responseText.slice(0, 2000) : null,
              csrf,
              csrfDebug: csrfDebugInfo,
              url: testUrl,
              extractedMessages: extracted.slice(0, 200),
              targetProfileUrl: targetProfileUrl || null,
            };
          } catch (e) {
            return {
              ok: false,
              error: e.message,
              csrf: 'error-getting-csrf',
              csrfDebug: { error: 'Failed to detect CSRF token due to error' },
              url: testUrl,
            };
          }
        },
        { testUrl, targetProfileUrl: profileUrl }
      );

      graphqlMessages = Array.isArray(graphqlTestResult?.extractedMessages) ? graphqlTestResult.extractedMessages : null;

      await debug(\`GraphQL API test result: \${JSON.stringify(graphqlTestResult, null, 2).slice(0, 500)}\`);
    }
  } catch (e) {
    graphqlTestResult = {
      ok: false,
      error: \`GraphQL test failed: \${e && e.message ? e.message : String(e)}\`,
      url: testUrl,
      conversationUrn: conversationUrn || null,
    };
    await debug(\`GraphQL API test error: \${e && e.message ? e.message : String(e)}\`);
  }

  // ✅ DOM->GraphQL fallback
  if ((msgs.length === 0 || !!msgs[0]?.isPlaceholder) && Array.isArray(graphqlMessages) && graphqlMessages.length > 0) {
    await debug(\`Using GraphQL fallback messages: \${graphqlMessages.length}\`);
    msgs = graphqlMessages;
    if (msgs.length > limit) msgs = msgs.slice(-limit);
  }

  try {
    await debug(
      'Final msgs(after limit) -> ' +
        JSON.stringify(
          {
            limit,
            finalCount: msgs.length,
            first: msgs[0]
              ? {
                  role: msgs[0].role ?? null,
                  datetime: msgs[0].datetime ?? null,
                  senderName: msgs[0].senderName ?? null,
                  textPreview: (msgs[0].text ?? '').slice(0, 80),
                }
              : null,
            last: msgs[msgs.length - 1]
              ? {
                  role: msgs[msgs.length - 1].role ?? null,
                  datetime: msgs[msgs.length - 1].datetime ?? null,
                  senderName: msgs[msgs.length - 1].senderName ?? null,
                  textPreview: (msgs[msgs.length - 1].text ?? '').slice(0, 80),
                }
              : null,
          },
          null,
          2
        ).slice(0, 1400)
    );
  } catch {}

  const result = {
    ok: true,
    limit,
    totalFound: payload?.totalFound ?? msgs.length,
    reversed: payload?.reversed ?? false,
    extractedAt: new Date().toISOString(),
    threadHint: threadHint || undefined,
    messages: msgs,
    fallbacksUsed: payload?.fallbacksUsed || 'unknown',
    extractionStrategy: msgs[0]?.isPlaceholder
      ? 'placeholder'
      : msgs[0]?.isFallback
        ? 'emergency-fallback'
        : msgs[0]?.extractionStrategy === 'graphql-fallback'
          ? 'graphql-fallback'
          : 'standard',
    usedFastPath,
    conversationUrn: conversationUrn || null,
    threadProfileUrlDetected: threadProfileUrlDetected || null,
  };

  result.graphqlTest = graphqlTestResult;

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
