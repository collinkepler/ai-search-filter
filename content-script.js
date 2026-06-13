// Main content script. Handles page-level classification (Layer 0) and
// initializes Layer 1 (image scanner) and Layer 3 (post scanner) modules.

(function () {
  let currentCheckId = 0;
  let lastCheckedUrl = null;
  let allowDomainsCache = null;
  let settingsCache = null;

  document.documentElement.classList.add('aisf-checking');

  init();

  // SPA navigation detection. The page changes its URL via history.pushState /
  // replaceState without a full reload (YouTube Music switching tracks, etc.).
  // A content script lives in the isolated world and can't hook the page's
  // history methods, so we re-check on every URL change via events + a polling
  // fallback. Each SPA re-check is "soft": it pauses audio but keeps the UI
  // visible (no full-page hide) so a music app doesn't blank on every track.
  let __aisfLastUrl = location.href;
  function onSpaNav() {
    if (location.href === __aisfLastUrl) return;
    __aisfLastUrl = location.href;
    init({ soft: true });
  }

  window.addEventListener('yt-navigate-start', () => startMediaGuard()); // silence ASAP
  window.addEventListener('yt-navigate-finish', onSpaNav);
  window.addEventListener('popstate', onSpaNav);
  window.addEventListener('hashchange', onSpaNav);
  setInterval(onSpaNav, 400); // catches pushState/replaceState the isolated world can't hook

  async function init({ soft = false } = {}) {
    if (location.protocol === 'chrome-extension:') {
      reveal();
      return;
    }

    const settings = await getSettings();
    const allowDomains = settings.allowDomains || [];

    if (isAllowedDomain(location.hostname, allowDomains)) {
      reveal();
      // Even on allow-domain, optionally run image/post scanners if user wants
      // (but default to skipping for performance)
      return;
    }

    const content = await extractContent();
    if (!content) {
      initSubLayers(settings, null);
      reveal();
      lastCheckedUrl = null;
      return;
    }

    if (location.href === lastCheckedUrl) return;
    lastCheckedUrl = location.href;

    const checkId = ++currentCheckId;
    const urlAtStart = location.href;

    startMediaGuard();
    if (!soft) document.documentElement.classList.add('aisf-checking');

    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (checkId !== currentCheckId) return;
      if (location.href !== urlAtStart) { reveal(); return; }

      console.log('[AISF] response:', response);

      if (chrome.runtime.lastError || !response) {
        console.warn('[AISF] message error:', chrome.runtime.lastError);
        initSubLayers(settings, content);
        reveal();
        return;
      }

      if (response.blocked) {
        const params = new URLSearchParams();
        params.set('q', describe(content));
        params.set('originalUrl', urlAtStart);
        if (response.matchedRule) params.set('rule', response.matchedRule);
        if (response.reason) params.set('reason', response.reason);
        if (response.error) params.set('error', response.error);
        if (response.fromCache) params.set('fromCache', '1');
        if (response.rawResponse) params.set('raw', response.rawResponse);
        if (response.cacheKey) params.set('cacheKey', response.cacheKey);

        const target = chrome.runtime.getURL('block.html') + '?' + params.toString();
        window.location.replace(target);
      } else {
        initSubLayers(settings, content);
        reveal();
      }
    };

    const timer = setTimeout(() => {
      console.warn('[AISF] sendMessage timeout — service worker did not respond');
      finish({
        blocked: settings.failMode === 'closed',
        reason: 'timeout',
        error: 'no response from service worker'
      });
    }, 10000);

    chrome.runtime.sendMessage({ type: 'check', content, navigationUrl: urlAtStart }, finish);
  }

  function initSubLayers(settings, content) {
    // Layer 1: image scanner
    const imageExcluded = isAllowedDomain(location.hostname, settings.imageScannerExcludeDomains);
    if (settings.enableImageScanner !== false && !imageExcluded && typeof window.AISFImageScanner !== 'undefined') {
      if (!window.__aisfImageScanner) {
        const scanner = new window.AISFImageScanner({
          minSize: settings.imageMinSize || 80,
          unverifiedAction: settings.imageUnverifiedAction || 'reveal'
        });
        window.__aisfImageScanner = scanner;

        // Search-result pages surface arbitrary web images (Google/Bing Images,
        // etc.) — always scan them, skipping the per-host "is this worth it?"
        // check that would otherwise let a search engine be classified as safe.
        const isSearch = !!(content && content.type === 'search');

        // Smart activation: ask the service worker once whether this host is
        // even a candidate for NSFW imagery. If not, tear down the scanner.
        // Default true; existing users who never set the key get smart skipping.
        if (!isSearch && settings.intelligentImageScanner !== false) {
          chrome.runtime.sendMessage(
            { type: 'classifyHostForImageScanner', hostname: location.hostname },
            (resp) => {
              if (chrome.runtime.lastError || !resp) return; // fail-open
              if (resp.skip) {
                console.log('[AISF] image scanner skipped for', location.hostname, '—', resp.reason || '(no reason)');
                scanner.disable();
                window.__aisfImageScanner = null;
              }
            }
          );
        }
      }
    }

    // Layer 3: post scanner
    if (settings.enablePostScanner && typeof window.AISFPostScanner !== 'undefined') {
      if (!window.__aisfPostScanner) {
        window.__aisfPostScanner = new window.AISFPostScanner({
          action: settings.postAction || 'hide'
        });
      }
    }

    // Usage limits: time-based heartbeat
    // Runs only when there are enabled time-limit rules matching this page.
    // Only counts time while the tab is visible (document.visibilityState).
    (async () => {
      const { usageLimits = [] } = await chrome.storage.local.get('usageLimits');
      const url = location.href;
      const matching = (usageLimits || []).filter(
        (r) => r.enabled && r.type === 'time' && matchesPatternClient(r.pattern, url)
      );
      if (!matching.length) return;

      const ruleIds = matching.map((r) => r.id);
      const INTERVAL_MS = 30000;

      const hb = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        chrome.runtime.sendMessage({ type: 'time-heartbeat', ruleIds, intervalMs: INTERVAL_MS }, (res) => {
          if (chrome.runtime.lastError || !res) return;
          if (!res.exceededRuleIds || !res.exceededRuleIds.length) return;
          clearInterval(hb);
          const rule = matching.find((r) => res.exceededRuleIds.includes(r.id));
          const params = new URLSearchParams();
          params.set('q', document.title || location.hostname);
          params.set('originalUrl', location.href);
          params.set('rule', `Usage limit: ${rule ? rule.label : 'Time limit'}`);
          const resets = rule && rule.period === 'week' ? 'next Monday' : 'at midnight';
          params.set('reason', `Time limit reached. Resets ${resets}.`);
          window.location.replace(chrome.runtime.getURL('block.html') + '?' + params.toString());
        });
      }, INTERVAL_MS);
    })();
  }

  async function getSettings() {
    if (settingsCache) return settingsCache;
    settingsCache = await chrome.storage.local.get([
      'allowDomains',
      'enableImageScanner',
      'enablePostScanner',
      'imageMinSize',
      'postAction',
      'failMode',
      'imageScannerExcludeDomains',
      'intelligentImageScanner',
      'imageUnverifiedAction'
    ]);
    return settingsCache;
  }

  function isAllowedDomain(hostname, allowDomains) {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    for (const raw of (allowDomains || [])) {
      if (!raw) continue;
      const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!d) continue;
      if (h === d || h.endsWith('.' + d)) return true;
      // Bare-word entry (e.g. "wikipedia"): match if any host label equals it.
      if (!d.includes('.') && h.split('.').includes(d)) return true;
    }
    return false;
  }

  function matchesPatternClient(pattern, url) {
    try {
      const u = new URL(url.includes('://') ? url : 'https://' + url);
      const stripped = pattern.replace(/^https?:\/\//, '');
      const slashIdx = stripped.indexOf('/');
      const hostPat = slashIdx === -1 ? stripped : stripped.slice(0, slashIdx);
      const pathPat = slashIdx === -1 ? '/*' : stripped.slice(slashIdx);
      const hostMatch = hostPat.startsWith('*.')
        ? (u.hostname === hostPat.slice(2) || u.hostname.endsWith('.' + hostPat.slice(2)))
        : (u.hostname === hostPat || u.hostname === 'www.' + hostPat || 'www.' + u.hostname === hostPat);
      if (!hostMatch) return false;
      if (pathPat === '/*' || pathPat === '*' || pathPat === '/') return true;
      if (pathPat.endsWith('*')) return u.pathname.startsWith(pathPat.slice(0, -1));
      return u.pathname === pathPat;
    } catch { return false; }
  }

  const SEARCH_PARAMS_STRONG = ['search_query', 'query', 'q', 'k', 'keyword', 'keywords', '_nkw', 'searchTerm'];
  const SEARCH_PARAMS_WEAK = ['search', 'term', 'wd', 'text', 's'];
  const SEARCH_PATH_RE = /\/(search|results|find|explore|browse|sch)(\/|$|\.)/i;

  function detectSearchQuery(host, path, params) {
    const pick = (names) => {
      for (const n of names) {
        const v = params.get(n);
        if (v && v.trim().length >= 2) return v.trim();
      }
      return null;
    };
    const q = pick(SEARCH_PARAMS_STRONG) || (SEARCH_PATH_RE.test(path) ? pick(SEARCH_PARAMS_WEAK) : null);
    if (!q) return null;
    let engine = host;
    if (host === 'duckduckgo.com') engine = 'duckduckgo';
    return { type: 'search', engine, query: q, hostname: host };
  }

  async function extractContent() {
    const host = location.hostname;
    const path = location.pathname;
    const params = new URLSearchParams(location.search);

    if (host === 'www.youtube.com' && path === '/watch') {
      const v = params.get('v');
      return v ? { type: 'youtube_video', videoId: v, url: location.href, hostname: host } : null;
    }

    const search = detectSearchQuery(host, path, params);
    if (search) return search;

    // YouTube container pages (homepage, channels, shorts feed, /feed/*) have no
    // specific content to classify at the URL level — Layer 3 filters individual
    // video cards as they scroll into view. Returning null here skips Layer 0 so
    // the site itself isn't blocked. Search results are caught above by
    // detectSearchQuery via the search_query param.
    if (host === 'www.youtube.com' || host === 'm.youtube.com') {
      return null;
    }

    await waitForTitle(1500);

    return {
      type: 'page',
      url: location.href,
      hostname: host,
      pathname: path,
      title: document.title || '',
      description: getMetaContent(['description', 'og:description', 'twitter:description']) || ''
    };
  }

  function waitForTitle(maxMs) {
    return new Promise((resolve) => {
      if (document.title && document.title.trim()) { resolve(); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        if (document.title && document.title.trim()) finish();
      });
      if (document.documentElement) {
        try {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
      }
      const timer = setTimeout(finish, maxMs);
    });
  }

  function getMetaContent(names) {
    for (const name of names) {
      const el = document.querySelector(`meta[name="${name}"]`) ||
                 document.querySelector(`meta[property="${name}"]`);
      if (el) {
        const v = el.getAttribute('content');
        if (v && v.trim()) return v.trim();
      }
    }
    return '';
  }

  function describe(content) {
    if (content.type === 'search') return content.query;
    if (content.type === 'youtube_video') return 'YouTube video (' + content.videoId + ')';
    if (content.type === 'page') {
      const title = (content.title || '').trim();
      if (title) return title + ' — ' + content.hostname;
      return content.url;
    }
    return '';
  }

  // Media guard: keeps audio/video paused for the duration of a pending check.
  // pauseMedia() alone only catches elements playing at call time; an SPA player
  // (YouTube Music) calls play() again on the same element mid-check, leaking
  // audio until the block navigation fires. The capture-phase 'play' listener on
  // document re-pauses anything that starts — including elements created later.
  let __aisfMediaGuard = null;
  let __aisfGuardSafety = null;
  function startMediaGuard() {
    pauseMedia();
    if (__aisfMediaGuard) return;
    const onPlay = (e) => {
      const m = e.target;
      if (m && (m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) {
        try { m.pause(); m.muted = true; m.dataset.aisfPaused = '1'; m.dataset.aisfMuted = '1'; } catch (e) {}
      }
    };
    document.addEventListener('play', onPlay, true);
    __aisfMediaGuard = () => document.removeEventListener('play', onPlay, true);
    // Never leave audio permanently muted if no verdict ever settles.
    __aisfGuardSafety = setTimeout(stopMediaGuard, 12000);
  }
  function stopMediaGuard() {
    if (__aisfGuardSafety) { clearTimeout(__aisfGuardSafety); __aisfGuardSafety = null; }
    if (__aisfMediaGuard) { __aisfMediaGuard(); __aisfMediaGuard = null; }
  }

  function pauseMedia() {
    try {
      document.querySelectorAll('video, audio').forEach((m) => {
        try {
          if (!m.paused) { m.pause(); m.dataset.aisfPaused = '1'; }
          if (!m.muted) { m.muted = true; m.dataset.aisfMuted = '1'; }
        } catch (e) {}
      });
    } catch (e) {}
  }

  function resumeMedia() {
    try {
      document.querySelectorAll('[data-aisf-muted]').forEach((m) => {
        try { m.muted = false; delete m.dataset.aisfMuted; } catch (e) {}
      });
      document.querySelectorAll('[data-aisf-paused]').forEach((m) => {
        try {
          delete m.dataset.aisfPaused;
          const p = m.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) {}
      });
    } catch (e) {}
  }

  function reveal() {
    stopMediaGuard(); // remove the play-capture listener before resuming...
    document.documentElement.classList.remove('aisf-checking');
    const overlay = document.getElementById('aisf-overlay');
    if (overlay) overlay.remove();
    resumeMedia();    // ...so resume's play() isn't immediately re-paused by the guard
  }
})();
