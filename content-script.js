// Main content script. Handles page-level classification (Layer 0) and
// initializes Layer 1 (image scanner) and Layer 3 (post scanner) modules.

(function () {
  let currentCheckId = 0;
  let lastCheckedUrl = null;
  let allowDomainsCache = null;
  let settingsCache = null;

  document.documentElement.classList.add('aisf-checking');

  init();

  window.addEventListener('yt-navigate-start', () => pauseMedia());
  window.addEventListener('yt-navigate-finish', init);
  window.addEventListener('popstate', init);

  async function init() {
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
      reveal();
      lastCheckedUrl = null;
      initSubLayers(settings);
      return;
    }

    if (location.href === lastCheckedUrl) return;
    lastCheckedUrl = location.href;

    const checkId = ++currentCheckId;
    const urlAtStart = location.href;

    pauseMedia();
    document.documentElement.classList.add('aisf-checking');
    injectOverlay(content);

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
        reveal();
        initSubLayers(settings);
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

        const target = chrome.runtime.getURL('block.html') + '?' + params.toString();
        window.location.replace(target);
      } else {
        reveal();
        initSubLayers(settings);
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

  function initSubLayers(settings) {
    // Layer 1: image scanner
    const imageExcluded = isAllowedDomain(location.hostname, settings.imageScannerExcludeDomains);
    if (settings.enableImageScanner && !imageExcluded && typeof window.AISFImageScanner !== 'undefined') {
      if (!window.__aisfImageScanner) {
        const scanner = new window.AISFImageScanner({
          minSize: settings.imageMinSize || 80
        });
        window.__aisfImageScanner = scanner;

        // Smart activation: ask the service worker once whether this host is
        // even a candidate for NSFW imagery. If not, tear down the scanner.
        // Default true; existing users who never set the key get smart skipping.
        if (settings.intelligentImageScanner !== false) {
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
      'intelligentImageScanner'
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

  function injectOverlay(content) {
    const tryInject = () => {
      const parent = document.body || document.documentElement;
      if (!parent) { requestAnimationFrame(tryInject); return; }
      if (document.getElementById('aisf-overlay')) return;

      let label;
      if (content.type === 'youtube_video') label = 'Checking this video…';
      else if (content.type === 'search') label = 'Checking your search…';
      else label = 'Checking ' + content.hostname + '…';

      const div = document.createElement('div');
      div.id = 'aisf-overlay';
      div.innerHTML =
        '<div class="aisf-card">' +
          '<div class="aisf-spinner"></div>' +
          '<div class="aisf-text">' + escapeHtml(label) + '</div>' +
        '</div>';
      parent.appendChild(div);
    };
    tryInject();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pauseMedia() {
    try {
      document.querySelectorAll('video, audio').forEach((m) => {
        try {
          if (!m.paused) m.pause();
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
    } catch (e) {}
  }

  function reveal() {
    document.documentElement.classList.remove('aisf-checking');
    const overlay = document.getElementById('aisf-overlay');
    if (overlay) overlay.remove();
    resumeMedia();
  }
})();
