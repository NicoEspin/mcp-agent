// src/linkedin/services/linkedin-sales-navigator-chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlaywrightService } from '../../browser/playwright.service';
import { buildEnsureOnUrlSnippet } from '../utils/navigation-snippets';

type SessionId = string;

@Injectable()
export class LinkedinSalesNavigatorChatService {
  private readonly logger = new Logger(LinkedinSalesNavigatorChatService.name);

  constructor(private readonly playwright: PlaywrightService) {}

  // -----------------------------
  // Close SalesNav compose/chat
  // (para ejecutarlo DESPUÉS del verifier en controller)
  // -----------------------------
  private buildCloseSalesNavChatCode() {
    return `
async (page) => {
  const debug = (msg) => console.log('[salesnav-close-chat]', msg, 'url=', page.url());
  const sleep = (ms) => page.waitForTimeout(ms);

  const stepWait = async (baseMs) => {
    const jitter = Math.floor(Math.random() * 220);
    await sleep(baseMs + jitter);
  };

  const firstVisible = async (loc) => {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {}
    }
    return null;
  };

  const clickFirstWorking = async (label, locators, opts = {}) => {
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      const el = await firstVisible(loc);
      if (!el) continue;

      try {
        await debug(label + ': candidate ' + i + ' -> click');
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await stepWait(350);
        await el.click({ timeout: 12000, force: true, ...opts });
        await stepWait(650);
        return { ok: true, usedIndex: i };
      } catch {
        await debug(label + ': click failed candidate ' + i);
      }
    }
    return { ok: false, usedIndex: -1 };
  };

  // Intentar scopear a dialogs/forms de compose
  const composeRoots = [
    page.locator('form[id*="compose-form"]').last(),
    page.locator('div[role="dialog"]').last(),
    page.locator('section[role="dialog"]').last(),
    page.locator('div').filter({ has: page.locator('input[id*="compose-form-subject"], textarea[name="message"], p[data-anonymize="general-blurb"]') }).last(),
  ];

  let composeRoot = null;
  for (const r of composeRoots) {
    try {
      if ((await r.count().catch(() => 0)) && (await r.first().isVisible().catch(() => false))) {
        composeRoot = r.first();
        break;
      }
    } catch {}
  }

  if (!composeRoot) composeRoot = page.locator('body');

  await debug('closing compose/chat (SalesNav)');

  const closeCandidates = [
    // aria-label / title
    composeRoot.locator('button[aria-label*="Close" i]').first(),
    composeRoot.locator('button[aria-label*="Cerrar" i]').first(),
    composeRoot.locator('button[aria-label*="Dismiss" i]').first(),
    composeRoot.locator('button[title*="Close" i]').first(),
    composeRoot.locator('button[title*="Cerrar" i]').first(),

    // icons
    composeRoot.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('use[href*="close" i]').locator('xpath=ancestor::button[1]'),
    composeRoot.locator('svg[aria-label*="close" i]').locator('xpath=ancestor::button[1]'),

    // tu span class/icon
    composeRoot.locator('span._icon_ps32ck').first(),
    composeRoot.locator('span[class*="_icon"]').first(),
    composeRoot.locator('path[d^="M14 3.41L9.41 8"]').locator('xpath=ancestor::*[self::button or self::span or self::div][1]'),

    // global fallbacks
    page.locator('button[aria-label*="Close" i]').last(),
    page.locator('button[aria-label*="Cerrar" i]').last(),
    page.locator('svg[data-test-icon*="close" i]').locator('xpath=ancestor::button[1]'),
    page.locator('span._icon_ps32ck').last(),
  ];

  let closed = false;

  for (let attempt = 0; attempt < 3 && !closed; attempt++) {
    if (attempt > 0) await stepWait(700 + attempt * 350);
    const res = await clickFirstWorking('close-compose', closeCandidates, { force: true });
    if (res.ok) {
      closed = true;
      break;
    }
  }

  if (!closed) {
    await debug('close click failed -> ESC fallback');
    await page.keyboard.press('Escape').catch(() => {});
    await stepWait(300);
    await page.keyboard.press('Escape').catch(() => {});
    await stepWait(300);
  }

  return { ok: true, closed, via: closed ? 'click' : 'escape' };
}
`;
  }

  async closeSalesNavChatOverlay(sessionId: SessionId) {
    const code = this.buildCloseSalesNavChatCode();
    return this.playwright.runCode(code, sessionId);
  }

  // -----------------------------
  // Read SalesNav chat
  // -----------------------------
  // ✅ UPDATED: ahora sigue el “estilo” de readChat normal, pero con contenedor Sales Nav
  private buildReadSalesNavChatCode(
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

  const debug = (msg) => console.log('[salesnav-read-chat]', msg, 'url=', page.url());
  const sleep = (ms) => page.waitForTimeout(ms);

  const stepWait = async (baseMs) => {
    const jitter = Math.floor(Math.random() * 220);
    await sleep(baseMs + jitter);
  };

  page.setDefaultTimeout(14000);
  page.setDefaultNavigationTimeout(35000);

  const looksLikeSalesNav = (url) => /linkedin\\.com\\/sales\\b|sales-navigator/i.test(url);

  const firstVisible = async (loc) => {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (await el.isVisible()) return el;
      } catch {}
    }
    return null;
  };

  const clickFirstWorking = async (label, locators, opts = {}) => {
    for (let i = 0; i < locators.length; i++) {
      const loc = locators[i];
      const el = await firstVisible(loc);
      if (!el) continue;

      try {
        await debug(label + ': candidato ' + i + ' visible -> click');
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await stepWait(450);
        await el.click({ timeout: 12000, force: true, ...opts });
        await stepWait(850);
        return { ok: true, usedIndex: i };
      } catch (e) {
        await debug(label + ': click falló candidato ' + i);
      }
    }
    return { ok: false, usedIndex: -1 };
  };

  const waitAnyVisible = async (candidates, timeoutMs = 12000, pollMs = 180) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const c of candidates) {
        try {
          if ((await c.count().catch(() => 0)) && (await c.first().isVisible().catch(() => false))) {
            return c.first();
          }
        } catch {}
      }
      await sleep(pollMs);
    }
    return null;
  };

  // -----------------------------
  // FAST PATH (simple):
  // si ya hay mensajes visibles en el DOM actual, no navegamos/overflow
  // -----------------------------
  let usedFastPath = false;

  try {
    const alreadyHasMessages =
      (await page.locator('div.message-content[data-x-message-content="message"]').first().isVisible().catch(() => false)) ||
      (await page.locator('article:has(div.message-content[data-x-message-content="message"])').first().isVisible().catch(() => false));

    if (alreadyHasMessages) {
      // si hay threadHint y no coincide, no usamos fast path
      const hint = (threadHint || '').toString().trim().toLowerCase();
      if (!hint) {
        usedFastPath = true;
        await debug('FAST PATH: mensajes ya visibles y sin threadHint -> skip navegación');
      } else {
        const headerText = await page
          .locator('a[title*="View" i], a[title*="Ver" i], span[data-anonymize="person"], span[data-anonymize="person-name"]')
          .first()
          .innerText()
          .catch(() => '');
        if ((headerText || '').toLowerCase().includes(hint)) {
          usedFastPath = true;
          await debug('FAST PATH: mensajes ya visibles y threadHint coincide -> skip navegación');
        }
      }
    }
  } catch {}

  // -----------------------------
  // 1) ensureOnUrl al perfil si hace falta
  // -----------------------------
  const alreadySalesNavAtStart =
    looksLikeSalesNav(page.url()) ||
    (await page.locator('button[data-anchor-send-inmail], textarea[name="message"]').first().isVisible().catch(() => false));

  if (!usedFastPath && !alreadySalesNavAtStart) {
    await debug('ensureOnUrl profile');
    const nav = await ensureOnUrl(profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
      settleMs: 1800,
      allowSubpaths: false,
    });
    await debug('ensureOnUrl -> ' + JSON.stringify(nav));
    await stepWait(900);
  }

  // -----------------------------
  // 2) Si no estamos en Sales Nav, abrir desde overflow "More" -> "View in Sales Navigator"
  // -----------------------------
  let salesPage = page;

  const alreadySalesNav =
    looksLikeSalesNav(page.url()) ||
    (await page.locator('button[data-anchor-send-inmail], textarea[name="message"]').first().isVisible().catch(() => false));

  if (!usedFastPath && !alreadySalesNav) {
    const main = page.locator('main').first();
    const topCard = main.locator('.pv-top-card, .pv-top-card-v2-ctas, .pv-top-card-v2').first();
    const scope = (await topCard.count().catch(() => 0)) ? topCard : main;

    await debug('finding overflow "More actions"');

    const overflowCandidates = [
      scope.locator('button[aria-label="More actions"]').first(),
      scope.locator('button[aria-label="Más acciones"]').first(),
      scope.locator('button[aria-label*="More actions" i]').first(),
      scope.locator('button[aria-label*="Más acciones" i]').first(),

      scope.locator('button[id*="profile-overflow-action"]').first(),
      scope.locator('button[id$="-profile-overflow-action"]').first(),
      scope.locator('button.artdeco-dropdown__trigger[id*="profile-overflow-action"]').first(),

      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="More"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"][aria-label="Más"]').first(),
      scope.locator('button[data-view-name="profile-overflow-button"]').first(),

      scope.locator('button').filter({ hasText: /^More$/ }).first(),
      scope.locator('button').filter({ hasText: /^Más$/ }).first(),
      main.locator('button').filter({ hasText: /^More$/ }).first(),
      main.locator('button').filter({ hasText: /^Más$/ }).first(),

      page.locator('button[aria-label="More actions"]').first(),
      page.locator('button[aria-label="Más acciones"]').first(),
      page.locator('button[id*="profile-overflow-action"]').first(),
    ];

    let overflowClicked = false;
    for (let attempt = 0; attempt < 3 && !overflowClicked; attempt++) {
      if (attempt > 0) await stepWait(1600 + attempt * 900);
      const res = await clickFirstWorking('overflow-more', overflowCandidates);
      overflowClicked = res.ok;
    }

    if (!overflowClicked) {
      throw new Error('No se encontró / no se pudo clickear el botón "More / Más acciones" (overflow).');
    }

    await debug('waiting dropdown');
    await stepWait(1100);

    const dropdownRoots = [
      page.locator('div.artdeco-dropdown__content-inner').last(),
      page.locator('.artdeco-dropdown__content').last(),
      page.locator('[role="menu"]').last(),
      page.locator('div[role="menu"]').last(),
    ];

    const dropdownRoot = await waitAnyVisible(dropdownRoots, 14000, 200);
    if (!dropdownRoot) throw new Error('No se detectó el dropdown del overflow (artdeco-dropdown / role=menu).');

    await debug('dropdown visible');

    const viewSalesNavRegex = /view in sales navigator|ver en sales navigator|sales navigator/i;

    const itemCandidates = [
      dropdownRoot.locator('div.artdeco-dropdown__item[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('[role="menuitem"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('div[role="button"]').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('button').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('a').filter({ hasText: viewSalesNavRegex }),
      dropdownRoot.locator('[aria-label*="Sales Navigator" i]'),
      dropdownRoot.locator('div[aria-label*="Sales Navigator" i]'),
      dropdownRoot
        .locator('svg[data-test-icon="sales-navigator-small"], use[href="#sales-navigator-small"]')
        .locator('xpath=ancestor::*[self::div or self::button or self::a][1]'),
    ];

    const ctx = page.context();
    const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);

    const clickedSalesNav = await clickFirstWorking('view-in-sales-nav', itemCandidates);
    if (!clickedSalesNav.ok) throw new Error('No se encontró / no se pudo clickear "View in Sales Navigator" en el dropdown.');

    const popup = await popupPromise;
    await navPromise;

    if (popup) {
      salesPage = popup;
      await debug('sales nav opened in new page');
      await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(800);
    } else {
      salesPage = page;
      await debug('sales nav opened in same page (or navigation completed)');
      await stepWait(1500);
    }
  } else {
    await debug('already on Sales Navigator / fast path -> skip overflow');
    salesPage = page;
  }

  // -----------------------------
  // 3) En Sales Navigator: click "Message"
  // -----------------------------
  if (!usedFastPath) {
    await debug('sales page url=' + salesPage.url());
    await stepWait(1200);

    await salesPage.waitForLoadState('domcontentloaded').catch(() => {});
    await stepWait(900);

    const messageBtnCandidates = [
      salesPage.locator('button[data-anchor-send-inmail]').first(),
      salesPage.locator('button[data-anchor-send-inmail=""]').first(),
      salesPage.getByRole('button', { name: /message|mensaje/i }).first(),
      salesPage.locator('button').filter({ hasText: /^Message$/i }).first(),
      salesPage.locator('button').filter({ hasText: /^Mensaje$/i }).first(),
      salesPage.locator('button._message-cta_1xow7n, button._cta_1xow7n').first(),
      salesPage.locator('button[class*="_message-cta"]').first(),
      salesPage.locator('button[class*="message"][class*="cta"]').first(),
      salesPage.locator('button[aria-label*="Message" i], button[aria-label*="Mensaje" i]').first(),
    ];

    let messageClicked = false;
    for (let attempt = 0; attempt < 3 && !messageClicked; attempt++) {
      if (attempt > 0) await stepWait(1200 + attempt * 700);
      const res = await clickFirstWorking('salesnav-message-cta', messageBtnCandidates);
      messageClicked = res.ok;
    }
    if (!messageClicked) throw new Error('No se encontró / no se pudo clickear el botón "Message" en Sales Navigator.');
  }

  // -----------------------------
  // 4) Detectar root del thread (SalesNav container real)
  // -----------------------------
  await debug('waiting SalesNav thread root...');
  await stepWait(700);

  const composeRoots = [
    salesPage.locator('div[role="dialog"]').last(),
    salesPage.locator('section[role="dialog"]').last(),
    salesPage.locator('form[id*="compose-form"]').last(),
    salesPage.locator('form').filter({ has: salesPage.locator('textarea[name="message"], [role="textbox"][contenteditable="true"], div.message-content[data-x-message-content="message"]') }).last(),
    salesPage.locator('div').filter({ has: salesPage.locator('div.message-content[data-x-message-content="message"]') }).last(),
  ];

  const composeRoot = (await waitAnyVisible(composeRoots, 14000, 220)) || salesPage.locator('body');
  await debug('compose root ready');

  // Root candidates: el scroll container y/o el UL que contiene los articles
  const rootCandidates = [
    composeRoot.locator('div.flex.flex-column.overflow-y-auto').filter({ has: composeRoot.locator('div.message-content[data-x-message-content="message"]') }).last(),
    composeRoot.locator('div.overflow-y-auto').filter({ has: composeRoot.locator('div.message-content[data-x-message-content="message"]') }).last(),
    composeRoot.locator('div').filter({ has: composeRoot.locator('ul.list-style-none article:has(div.message-content[data-x-message-content="message"])') }).last(),
    composeRoot.locator('ul.list-style-none').filter({ has: composeRoot.locator('article:has(div.message-content[data-x-message-content="message"])') }).last(),
    composeRoot.locator('article:has(div.message-content[data-x-message-content="message"])').first().locator('xpath=ancestor::div[contains(@class,"overflow")][1]').first(),
  ];

  let root = (await waitAnyVisible(rootCandidates, 12000, 220)) || composeRoot;
  await debug('thread root detected');

  // Esperar al menos 1 message-content
  await waitAnyVisible(
    [
      root.locator('div.message-content[data-x-message-content="message"]').first(),
      root.locator('article:has(div.message-content[data-x-message-content="message"])').first(),
      composeRoot.locator('div.message-content[data-x-message-content="message"]').first(),
    ],
    9000,
    220
  ).catch(() => null);

  await sleep(450);

  // -----------------------------
  // 5) Scroll UP para cargar todo el historial (Sales Nav)
  // -----------------------------
  await debug('Starting SalesNav scrolling to load all messages...');

  const scrollToLoadMessages = async () => {
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const scrollSelectors = [
      // contenedor real que nos pasaste
      'div.flex.flex-column.overflow-y-auto',
      'div.overflow-y-auto',
      // fallbacks
      'div.flex.flex-column.overflow-auto',
      'div.overflow-auto',
      'ul.list-style-none',
    ];

    const pickBestScrollable = async () => {
      let bestLoc = null;
      let bestSel = null;
      let bestInfo = null;
      let bestScore = -1;

      const candidatesFor = (sel) => [root.locator(sel).last(), composeRoot.locator(sel).last(), salesPage.locator(sel).last()];

      for (const sel of scrollSelectors) {
        for (const loc of candidatesFor(sel)) {
          try {
            if (!(await loc.count().catch(() => 0))) continue;
            const visible = await loc.isVisible().catch(() => false);
            if (!visible) continue;

            const info = await loc.evaluate((el) => {
              const st = window.getComputedStyle(el);
              const oy = (st.overflowY || '').toLowerCase();
              const sh = el.scrollHeight || 0;
              const ch = el.clientHeight || 0;
              const cls = (el.className || '').toString();
              const tag = (el.tagName || '').toString();
              const scrollable = sh > ch + 8 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay');
              return { oy, sh, ch, cls, tag, scrollable };
            }).catch(() => null);

            if (!info) continue;
            // score: prioriza scrollable real y con más contenido
            const score = (info.scrollable ? 1_000_000 : 0) + Math.max(0, info.sh - info.ch);

            if (score > bestScore) {
              bestScore = score;
              bestLoc = loc;
              bestSel = sel;
              bestInfo = info;
            }
          } catch {}
        }
      }

      // fallback final: root
      return { loc: bestLoc || root, sel: bestSel || 'root', info: bestInfo };
    };

    const getMessageCount = async () => {
      try {
        return await root.evaluate((rootEl) => {
          const arts = Array.from(rootEl.querySelectorAll('article'))
            .filter((a) => a.querySelector('div.message-content[data-x-message-content="message"]'));
          return arts.length;
        });
      } catch {
        return 0;
      }
    };

    const picked = await pickBestScrollable();
    const sc = picked.loc;

    try {
      await debug(
        'Using scroll container -> ' +
          picked.sel +
          (picked.info
            ? ' (scrollHeight=' + picked.info.sh + ', clientHeight=' + picked.info.ch + ', overflowY=' + picked.info.oy + ')'
            : '')
      );
    } catch {}

    // focus/click para asegurar scroll correcto
    try {
      await sc.scrollIntoViewIfNeeded().catch(() => {});
      await sc.click({ timeout: 2000 }).catch(() => {});
      await sc.evaluate((el) => el.focus && el.focus()).catch(() => {});
    } catch {}

    // Detectar reverse
    const meta = await sc.evaluate((el) => {
      const cs = getComputedStyle(el);
      const flexDir = (cs.flexDirection || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const isReverse = flexDir.includes('column-reverse') || cls.includes('column-reversed');

      const scrollH = el.scrollHeight || 0;
      const clientH = el.clientHeight || 0;
      const span = Math.max(0, scrollH - clientH);
      const min = isReverse ? -span : 0;
      const max = isReverse ? 0 : span;

      return {
        isReverse,
        flexDir,
        overflowY: (cs.overflowY || '').toLowerCase(),
        scrollTop: el.scrollTop || 0,
        scrollH,
        clientH,
        min,
        max,
      };
    }).catch(() => ({
      isReverse: false,
      flexDir: '',
      overflowY: '',
      scrollTop: 0,
      scrollH: 0,
      clientH: 0,
      min: 0,
      max: 0,
    }));

    await debug('Scroll direction -> UP' + (meta.isReverse ? ' (column-reverse)' : ''));

    const step = 520;
    const maxAttempts = 90;
    const settleMs = 220;
    const stableStop = 10;

    // Arrancar en el extremo “más nuevo”
    try {
      await sc.evaluate((el, startTop) => { el.scrollTop = startTop; }, meta.max);
    } catch {}
    await sleep(settleMs);

    let noChange = 0;
    let lastTarget = meta.max;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const beforeCount = await getMessageCount();

      const before = await sc.evaluate((el) => ({
        top: el.scrollTop || 0,
        scrollH: el.scrollHeight || 0,
        clientH: el.clientHeight || 0,
      })).catch(() => ({ top: 0, scrollH: 0, clientH: 0 }));

      const bounds = await sc.evaluate((el, isReverse) => {
        const scrollH = el.scrollHeight || 0;
        const clientH = el.clientHeight || 0;
        const span = Math.max(0, scrollH - clientH);
        const min = isReverse ? -span : 0;
        const max = isReverse ? 0 : span;
        return { min, max };
      }, meta.isReverse).catch(() => ({ min: meta.min, max: meta.max }));

      const target = clamp(before.top - step, bounds.min, bounds.max);
      lastTarget = target;

      await sc.evaluate((el, t) => { el.scrollTop = t; }, target).catch(() => {});
      await sleep(settleMs);

      // anti-snapback
      await sc.evaluate((el, t) => {
        const drift = (el.scrollTop || 0) - t;
        if (Math.abs(drift) > 40) el.scrollTop = t;
      }, lastTarget).catch(() => {});
      await sleep(90);

      const afterCount = await getMessageCount();

      const after = await sc.evaluate((el) => ({
        top: el.scrollTop || 0,
        scrollH: el.scrollHeight || 0,
      })).catch(() => ({ top: 0, scrollH: 0 }));

      const changed = afterCount !== beforeCount || after.scrollH !== before.scrollH;
      const atEdge = Math.abs(after.top - bounds.min) <= 2;

      await debug(
        'Scroll attempt ' +
          attempt +
          ': before=' +
          beforeCount +
          ', after=' +
          afterCount +
          ', changed=' +
          changed +
          ', atEdge=' +
          atEdge +
          ', scrollTop=' +
          after.top +
          ', scrollH=' +
          after.scrollH
      );

      if (changed) noChange = 0;
      else noChange++;

      if (atEdge && noChange >= stableStop) {
        await debug('Reached edge and content stabilized -> stop scrolling');
        break;
      }

      if (noChange > 0 && noChange % 8 === 0) {
        await debug('No DOM change -> extra jitter');
        await sc.evaluate((el, isReverse) => {
          const scrollH = el.scrollHeight || 0;
          const clientH = el.clientHeight || 0;
          const span = Math.max(0, scrollH - clientH);
          const min = isReverse ? -span : 0;
          const max = isReverse ? 0 : span;

          const tiny = 180;
          const t = Math.max(min, Math.min(max, (el.scrollTop || 0) - tiny));
          el.scrollTop = t;
        }, meta.isReverse).catch(() => {});
        await sleep(240);

        await sc.evaluate((el, t) => {
          const drift = (el.scrollTop || 0) - t;
          if (Math.abs(drift) > 40) el.scrollTop = t;
        }, lastTarget).catch(() => {});
        await sleep(80);
      }
    }

    await debug('Scrolling completed.');
    await sleep(550);
  };

  await scrollToLoadMessages();

  // -----------------------------
  // 6) Extraction (Sales Nav DOM)
  // - mensajes con hora + datetime + role (You vs other)
  // -----------------------------
  const payload = await root.evaluate((rootEl, ctx) => {
    const lim = ctx?.limit ?? 30;
    const hint = (ctx?.threadHint ?? '').toString();

    const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();

    const extractClock = (raw) => {
      const s = norm(raw);
      if (!s) return { timeRaw: null, time: null };

      const m12 = s.match(/\\b(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\b/i);
      if (m12) {
        let hh = parseInt(m12[1], 10);
        const mm = m12[2];
        const ap = m12[3].toUpperCase();
        if (ap === 'PM' && hh < 12) hh += 12;
        if (ap === 'AM' && hh === 12) hh = 0;
        const hh2 = String(hh).padStart(2, '0');
        return { timeRaw: s, time: hh2 + ':' + mm };
      }

      const m24 = s.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
      if (m24) {
        const hh = String(parseInt(m24[1], 10)).padStart(2, '0');
        const mm = m24[2];
        return { timeRaw: s, time: hh + ':' + mm };
      }

      return { timeRaw: s, time: null };
    };

    const parseFromAria = (aria) => {
      const a = norm(aria);
      if (!a) return null;
      const m1 = a.match(/^message from\\s+/i);
      const m2 = a.match(/^mensaje de\\s+/i);
      if (m1) return norm(a.replace(/^message from\\s+/i, ''));
      if (m2) return norm(a.replace(/^mensaje de\\s+/i, ''));
      return null;
    };

    const getNearestDateBoundaryYMD = (node) => {
      try {
        const li = node?.closest?.('li') || node?.parentElement;
        if (!li) return null;

        // buscamos hacia atrás una boundary con time[datetime]
        let cur = li;
        for (let i = 0; i < 40 && cur; i++) {
          const boundary = cur.querySelector?.('div.message-item__date-boundary time[datetime]');
          const dt = boundary?.getAttribute?.('datetime');
          if (dt) {
            const d = new Date(dt);
            if (!isNaN(d.getTime())) {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const da = String(d.getDate()).padStart(2, '0');
              return y + '-' + m + '-' + da;
            }
          }
          cur = cur.previousElementSibling;
        }
      } catch {}
      return null;
    };

    const combineYmdAndTimeToIso = (ymd, hhmm) => {
      if (!ymd) return null;
      const parts = (ymd || '').split('-').map((x) => parseInt(x, 10));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
      const Y = parts[0], M = parts[1], D = parts[2];

      let hh = 0, mm = 0;
      if (hhmm && /^\\d{2}:\\d{2}$/.test(hhmm)) {
        hh = parseInt(hhmm.slice(0, 2), 10);
        mm = parseInt(hhmm.slice(3, 5), 10);
      }

      const dt = new Date(Y, M - 1, D, hh, mm, 0, 0);
      if (isNaN(dt.getTime())) return null;
      return dt.toISOString();
    };

    const extractTextFromArticle = (article) => {
      const content = article.querySelector('div.message-content[data-x-message-content="message"]');
      if (!content) return null;

      const ps = Array.from(content.querySelectorAll('p'));
      const parts = ps.map((p) => norm(p.textContent)).filter(Boolean);
      const text = parts.length ? parts.join('\\n') : norm(content.textContent);
      return text || null;
    };

    const extractSender = (article) => {
      // 1) casos “You” por aria-label
      const youSpan =
        article.querySelector('address span[aria-label*="Message from you" i]') ||
        article.querySelector('address span[aria-label*="Mensaje de ti" i]') ||
        article.querySelector('address span[aria-label*="Mensaje de usted" i]');

      if (youSpan) return { senderName: 'You', isYou: true };

      // 2) person-name
      const pn = article.querySelector('address span[data-anonymize="person-name"]');
      const pnText = norm(pn?.textContent);
      if (pnText) return { senderName: pnText, isYou: false };

      // 3) parse por aria label "Message from X"
      const anyAriaEl = article.querySelector('address span[aria-label*="Message from" i], address span[aria-label*="Mensaje de" i]');
      const from = parseFromAria(anyAriaEl?.getAttribute?.('aria-label'));
      if (from) return { senderName: from, isYou: false };

      // 4) fallback: address text
      const addr = article.querySelector('address');
      const addrText = norm(addr?.textContent);
      if (addrText) {
        if (/\\byou\\b/i.test(addrText)) return { senderName: 'You', isYou: true };
        return { senderName: addrText, isYou: false };
      }

      return { senderName: null, isYou: false };
    };

    const extractTime = (article) => {
      const t = article.querySelector('div._message-padding--medium_zovuu6 time[datetime]') ||
                article.querySelector('time[datetime]') ||
                article.querySelector('time');

      const datetime = t?.getAttribute?.('datetime') || null;
      const label = norm(t?.textContent) || null;

      const clk = extractClock(label);
      return { datetime, timeRaw: clk.timeRaw, time: clk.time };
    };

    // detectar reversed (si existiera)
    let reversed = false;
    try {
      const sc = rootEl.closest('div') || rootEl;
      const cs = window.getComputedStyle(sc);
      const flexDir = (cs.flexDirection || '').toLowerCase();
      const cls = (sc.className || '').toString().toLowerCase();
      reversed = flexDir.includes('column-reverse') || cls.includes('column-reversed');
    } catch {}

    // Extraer articles reales
    const articles = Array.from(rootEl.querySelectorAll('article'))
      .filter((a) => a.querySelector('div.message-content[data-x-message-content="message"]'));

    const items = [];
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];

      const text = extractTextFromArticle(a);
      if (!text) continue;

      const sender = extractSender(a);
      const t = extractTime(a);

      let datetime = null;

      // preferir datetime directo
      if (t.datetime) {
        const d = new Date(t.datetime);
        if (!isNaN(d.getTime())) datetime = d.toISOString();
      }

      // fallback: boundary + hora
      if (!datetime) {
        const ymd = getNearestDateBoundaryYMD(a);
        datetime = combineYmdAndTimeToIso(ymd, t.time);
      }

      const role = sender.isYou ? 'recruiter' : 'candidate';

      items.push({
        id: a.getAttribute?.('data-message-id') || a.id || ('salesnav-msg-' + i),
        senderName: sender.senderName,
        senderProfileUrl: null,
        time: t.time,
        timeRaw: t.timeRaw,
        datetime,
        text,
        extractionStrategy: 'salesnav-article',
        role,
      });
    }

    // Dedup (sender + datetime + text)
    const seen = new Set();
    const deduped = [];
    for (const m of items) {
      const key = [m.senderName ?? '', m.datetime ?? '', m.text ?? ''].join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    // Orden por datetime asc (si existe)
    const withIdx = deduped.map((m, idx) => ({ ...m, _idx: idx }));
    withIdx.sort((a, b) => {
      const ta = Date.parse(a.datetime || '');
      const tb = Date.parse(b.datetime || '');
      const va = Number.isFinite(ta);
      const vb = Number.isFinite(tb);
      if (va && vb) return ta - tb;
      return a._idx - b._idx;
    });

    let messages = withIdx.map(({ _idx, ...m }) => m);

    // Si reversed, invertimos para dejar “cronológico” consistente (old->new)
    // (en general SalesNav no viene reversed, pero lo soportamos)
    if (reversed) messages = messages.reverse();

    // aplicar limit: devolver ÚLTIMOS N
    if (typeof lim === 'number' && lim > 0 && messages.length > lim) {
      messages = messages.slice(-lim);
    }

    // participants (best effort)
    const other =
      messages.find((m) => m.role === 'candidate' && m.senderName)?.senderName ||
      norm(rootEl.querySelector('span[data-anonymize="person"], span[data-anonymize="person-name"]')?.textContent) ||
      null;

    return {
      ok: true,
      threadHint: hint || undefined,
      participants: { me: 'You', other },
      totalFound: withIdx.length,
      returned: messages.length,
      reversed,
      extractedAt: new Date().toISOString(),
      messages,
    };
  }, { limit, threadHint });

  // Debug summary
  try {
    await debug('Extraction summary -> ' + JSON.stringify({
      totalFound: payload?.totalFound,
      returned: payload?.returned,
      reversed: payload?.reversed,
      participants: payload?.participants,
      first: payload?.messages?.[0] ? {
        role: payload.messages[0].role,
        datetime: payload.messages[0].datetime,
        senderName: payload.messages[0].senderName,
        textPreview: String(payload.messages[0].text || '').slice(0, 80),
      } : null,
      last: payload?.messages?.[payload?.messages?.length - 1] ? {
        role: payload.messages[payload.messages.length - 1].role,
        datetime: payload.messages[payload.messages.length - 1].datetime,
        senderName: payload.messages[payload.messages.length - 1].senderName,
        textPreview: String(payload.messages[payload.messages.length - 1].text || '').slice(0, 80),
      } : null,
    }, null, 2).slice(0, 1600));
  } catch {}

  return {
    ok: true,
    limit,
    extractedAt: new Date().toISOString(),
    threadHint: threadHint || undefined,
    usedFastPath,
    url: salesPage.url(),
    data: payload,
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    totalFound: payload?.totalFound ?? (Array.isArray(payload?.messages) ? payload.messages.length : 0),
  };
}
`;
  }

  async readSalesNavChat(
    sessionId: SessionId,
    profileUrl: string,
    limit = 30,
    threadHint?: string,
  ) {
    const startTime = Date.now();
    const code = this.buildReadSalesNavChatCode(profileUrl, limit, threadHint);

    const verboseResult = {
      ok: true,
      sessionId,
      profileUrl,
      limit,
      threadHint,
      executionDetails: {
        startTime,
        endTime: null as number | null,
        executionTimeMs: null as number | null,
        method: 'playwright_runCode_salesnav_read_chat',
        steps: [] as string[],
        errors: [] as any[],
        codeLength: code.length,
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
        'Building SalesNav read-chat runCode',
      );
      verboseResult.executionDetails.steps.push('Executing runCode');

      const result = await this.playwright.runCode(code, sessionId);
      const parsed = safeParse(result);

      const endTime = Date.now();
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.steps.push('Completed');

      verboseResult.data = parsed;
      verboseResult.toolResult = parsed;

      return verboseResult;
    } catch (e: any) {
      const endTime = Date.now();
      verboseResult.ok = false;
      verboseResult.executionDetails.endTime = endTime;
      verboseResult.executionDetails.executionTimeMs = endTime - startTime;
      verboseResult.executionDetails.errors.push({
        message: e?.message ?? 'Unknown error',
        stack: e?.stack,
        timestamp: endTime,
      });
      verboseResult.executionDetails.steps.push(
        'Error: ' + (e?.message ?? 'Unknown error'),
      );
      return verboseResult;
    }
  }
}
