// Layer 3: Post scanner.
// On feed-style sites (Reddit, Twitter, YouTube, etc.), finds individual posts
// and classifies their text via Claude in small batches. Flagged posts get hidden.

(function () {
  // Per-site selectors. Each entry maps site host pattern → array of selectors
  // identifying post containers, and an extractor function for getting the text.
  const SITE_CONFIGS = [
    {
      match: (h) => h.includes('reddit.com'),
      selectors: [
        'shreddit-post',
        'article[data-testid="post-container"]',
        'div[data-testid="post-container"]',
        '.thing.link'
      ],
      extract: (el) => {
        const title =
          el.querySelector('a[slot="title"]') ||
          el.querySelector('[data-testid="post-title"]') ||
          el.querySelector('h3') ||
          el.querySelector('a.title');
        const sub =
          el.querySelector('a[slot="subreddit-name"]') ||
          el.querySelector('[data-testid="subreddit-name"]') ||
          el.querySelector('.subreddit');
        const titleText = title ? title.textContent.trim() : '';
        const subText = sub ? sub.textContent.trim() : '';
        return subText ? `[${subText}] ${titleText}` : titleText;
      }
    },
    {
      match: (h) => h.includes('twitter.com') || h.includes('x.com'),
      selectors: ['article[data-testid="tweet"]'],
      extract: (el) => {
        const text = el.querySelector('[data-testid="tweetText"]');
        const user = el.querySelector('[data-testid="User-Name"]');
        const t = text ? text.textContent.trim() : '';
        const u = user ? user.textContent.trim().split('\n')[0] : '';
        return u ? `[@${u}] ${t}` : t;
      }
    },
    {
      match: (h) => h.includes('youtube.com'),
      selectors: [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-compact-video-renderer'
      ],
      extract: (el) => {
        const title = el.querySelector('#video-title, [id="video-title"]');
        const channel = el.querySelector('ytd-channel-name, .ytd-channel-name');
        const t = title ? title.textContent.trim() : '';
        const c = channel ? channel.textContent.trim() : '';
        return c ? `[${c}] ${t}` : t;
      }
    }
  ];

  class AISFPostScanner {
    constructor(options) {
      this.options = Object.assign({
        action: 'hide',
        batchSize: 15,
        batchDelay: 600,
        minTextLength: 8
      }, options || {});

      this.config = this.findConfig();
      if (!this.config) return; // not a supported feed site

      this.scanned = new WeakSet();
      this.scannedTexts = new Map(); // text → verdict
      this.queue = [];
      this.batchTimer = null;
      this.findTimer = null;

      this.start();
    }

    findConfig() {
      const h = location.hostname.toLowerCase();
      return SITE_CONFIGS.find((c) => c.match(h));
    }

    start() {
      this.observer = new IntersectionObserver(
        this.onIntersect.bind(this),
        { rootMargin: '200px', threshold: 0.05 }
      );

      // Initial pass
      setTimeout(() => this.findPosts(), 500);

      // Re-scan on DOM mutations (feed-load-more, etc.)
      const root = document.body || document.documentElement;
      if (root) {
        this.mutationObserver = new MutationObserver(() => {
          clearTimeout(this.findTimer);
          this.findTimer = setTimeout(() => this.findPosts(), 400);
        });
        this.mutationObserver.observe(root, { childList: true, subtree: true });
      }
    }

    findPosts() {
      for (const sel of this.config.selectors) {
        let els;
        try { els = document.querySelectorAll(sel); } catch (e) { continue; }
        els.forEach((el) => {
          if (this.scanned.has(el)) return;
          this.scanned.add(el);
          this.observer.observe(el);
        });
      }
    }

    onIntersect(entries) {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          this.queuePost(entry.target);
          this.observer.unobserve(entry.target);
        }
      }
    }

    queuePost(el) {
      let text;
      try { text = this.config.extract(el); } catch (e) { return; }
      if (!text || text.length < this.options.minTextLength) return;

      // Cache hit on identical text — apply verdict immediately
      const cached = this.scannedTexts.get(text);
      if (cached) {
        if (cached.blocked) this.flagPost(el, cached);
        return;
      }

      this.queue.push({ el, text });

      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushQueue(), this.options.batchDelay);
      }
    }

    flushQueue() {
      this.batchTimer = null;
      if (this.queue.length === 0) return;

      const batch = this.queue.splice(0, this.options.batchSize);
      const posts = batch.map((b, i) => ({ id: i, text: b.text }));

      chrome.runtime.sendMessage(
        { type: 'classifyPosts', posts, hostname: location.hostname },
        (response) => {
          if (chrome.runtime.lastError || !response || !Array.isArray(response.verdicts)) {
            console.warn('[AISF] classifyPosts failed:', chrome.runtime.lastError, response);
            return;
          }

          response.verdicts.forEach((v) => {
            const item = batch[v.id];
            if (!item) return;
            // Cache by text
            this.scannedTexts.set(item.text, v);
            if (v.blocked) {
              this.flagPost(item.el, v);
            }
          });

          if (this.queue.length > 0) {
            this.batchTimer = setTimeout(() => this.flushQueue(), 200);
          }
        }
      );
    }

    flagPost(el, verdict) {
      if (el.dataset.aisfFlagged) return;
      el.dataset.aisfFlagged = '1';

      if (this.options.action === 'hide') {
        el.style.display = 'none';
        return;
      }

      // 'dim' mode: collapse to a small "hidden" placeholder
      const placeholder = document.createElement('div');
      placeholder.style.cssText = [
        'padding: 12px 16px',
        'background: #f3f4f6',
        'color: #6b7280',
        'font-family: system-ui, sans-serif',
        'font-size: 13px',
        'border-radius: 6px',
        'margin: 6px 0',
        'border: 1px dashed #d1d5db',
        'cursor: pointer'
      ].join(';');
      const rule = verdict.matchedRule || 'matched rule';
      placeholder.textContent = `Hidden by filter: ${rule}. Click to show.`;
      placeholder.addEventListener('click', () => {
        placeholder.style.display = 'none';
        el.style.display = '';
      });

      el.style.display = 'none';
      el.parentElement && el.parentElement.insertBefore(placeholder, el);
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      if (this.mutationObserver) this.mutationObserver.disconnect();
    }
  }

  window.AISFPostScanner = AISFPostScanner;
})();
