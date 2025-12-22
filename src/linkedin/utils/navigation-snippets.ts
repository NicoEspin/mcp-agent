// src/linkedin/utils/navigation-snippets.ts
export function buildEnsureOnUrlSnippet() {
  return `
  // -----------------------------
  // URL helpers (reusable)
  // -----------------------------
  const __normUrl = (u) => {
    try {
      if (!u) return '';
      // handle about:blank, chrome-error://, etc.
      if (/^about:|^chrome-error:|^data:/i.test(u)) return u;

      const url = new URL(u);
      const origin = (url.origin || '').toLowerCase();
      let path = (url.pathname || '/').replace(/\\/+$/, ''); // trim trailing slashes
      if (path === '') path = '/';
      return origin + path;
    } catch {
      return (u || '')
        .split('#')[0]
        .split('?')[0]
        .replace(/\\/+$/, '');
    }
  };

  const __sameUrl = (current, target, allowSubpaths = false) => {
    const cur = __normUrl(current);
    const tar = __normUrl(target);
    if (!cur || !tar) return false;
    if (cur === tar) return true;
    if (!allowSubpaths) return false;
    return cur.startsWith(tar + '/') || tar.startsWith(cur + '/');
  };

  const ensureOnUrl = async (targetUrl, opts) => {
    const options = opts || {};
    const waitUntil = options.waitUntil || 'domcontentloaded';
    const timeout = typeof options.timeout === 'number' ? options.timeout : 30000;
    const settleMs = typeof options.settleMs === 'number' ? options.settleMs : 800;
    const allowSubpaths = !!options.allowSubpaths;

    const beforeUrl = page.url();
    const beforeNorm = __normUrl(beforeUrl);
    const targetNorm = __normUrl(targetUrl);

    if (__sameUrl(beforeUrl, targetUrl, allowSubpaths)) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_on_target',
        beforeUrl,
        afterUrl: beforeUrl,
        beforeNorm,
        targetNorm,
      };
    }

    await page.goto(targetUrl, { waitUntil, timeout });
    if (settleMs) await page.waitForTimeout(settleMs);

    const afterUrl = page.url();
    const afterNorm = __normUrl(afterUrl);

    return {
      ok: true,
      skipped: false,
      reason: 'navigated',
      beforeUrl,
      afterUrl,
      beforeNorm,
      afterNorm,
      targetNorm,
    };
  };
  `;
}
