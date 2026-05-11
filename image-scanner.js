// Layer 1: NSFW image scanner.
// Strict-mode flow:
//   1. Blur every observable image preemptively (before classification).
//   2. Send the URL to the service worker when it intersects the viewport.
//   3. On nsfw=true → hide entirely. On nsfw=false → clear the blur.
//   4. On API error / timeout → leave the blur in place (fail-closed). An 8s
//      ceiling clears it if the classifier never responds, so a broken pipeline
//      doesn't permanently blur every image on the page.

(function () {
  const PENDING_TIMEOUT_MS = 8000;
  const BLUR_FILTER = 'blur(40px)';

  class AISFImageScanner {
    constructor(options) {
      this.options = Object.assign({
        minSize: 80,
        rootMargin: '200px'
      }, options || {});

      this.scanned = new WeakSet();
      this.scannedUrls = new Set();
      this.start();
    }

    start() {
      this.observer = new IntersectionObserver(
        this.onIntersect.bind(this),
        { rootMargin: this.options.rootMargin, threshold: 0.05 }
      );

      this.observeAll();

      this.mutationObserver = new MutationObserver(this.onMutation.bind(this));
      const root = document.body || document.documentElement;
      if (root) {
        this.mutationObserver.observe(root, { childList: true, subtree: true });
      }
    }

    observeAll() {
      document.querySelectorAll('img, video').forEach((el) => this.observe(el));
    }

    observe(el) {
      if (this.scanned.has(el)) return;
      this.scanned.add(el);

      // Skip elements that are already loaded and obviously too small to be content
      // (icons, avatars). We don't blur or observe these.
      if (el.complete && this.isTooSmall(el)) return;

      this.applyPendingBlur(el);
      this.observer.observe(el);
    }

    isTooSmall(el) {
      const w = el.naturalWidth || el.offsetWidth || el.clientWidth || 0;
      const h = el.naturalHeight || el.offsetHeight || el.clientHeight || 0;
      const min = this.options.minSize;
      return w > 0 && h > 0 && w < min && h < min;
    }

    applyPendingBlur(el) {
      if (el.dataset.aisfPending || el.dataset.aisfFlagged || el.dataset.aisfCleared) return;
      el.dataset.aisfPending = '1';
      el.dataset.aisfPrevFilter = el.style.filter || '';
      el.style.filter = BLUR_FILTER;
      el.style.transition = 'filter 0.15s';
    }

    clearPendingBlur(el) {
      if (!el.dataset.aisfPending) return;
      delete el.dataset.aisfPending;
      el.style.filter = el.dataset.aisfPrevFilter || '';
      delete el.dataset.aisfPrevFilter;
      el.dataset.aisfCleared = '1';
    }

    onIntersect(entries) {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          this.checkElement(entry.target);
          this.observer.unobserve(entry.target);
        }
      }
    }

    onMutation(mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
            this.observe(node);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('img, video').forEach((el) => this.observe(el));
          }
        }
      }
    }

    checkElement(el) {
      // Re-check size now that it may have loaded after observe() ran
      if (this.isTooSmall(el)) {
        this.clearPendingBlur(el);
        return;
      }

      let url;
      if (el.tagName === 'IMG') {
        url = el.currentSrc || el.src;
      } else if (el.tagName === 'VIDEO') {
        url = el.poster;
      }

      // No usable URL — nothing to classify; clear the blur rather than freezing it
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
        this.clearPendingBlur(el);
        return;
      }

      // Per-session dedupe on URL: if we already kicked off a request for this URL
      // on another element, we still want THIS element to resolve. Use the cache
      // hit on the service worker side instead of returning here.
      this.scannedUrls.add(url);

      // Timeout fallback: clear the blur if the classifier never responds. Without
      // this a broken pipeline leaves the page permanently blurred.
      const timeoutId = setTimeout(() => {
        if (el.dataset.aisfPending) {
          console.warn('[AISF] image classify timed out, clearing blur for', url);
          this.clearPendingBlur(el);
        }
      }, PENDING_TIMEOUT_MS);

      chrome.runtime.sendMessage(
        { type: 'classifyImage', imageUrl: url },
        (response) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError || !response) {
            // Fail-closed: leave blurred. Timeout above will eventually clear it.
            return;
          }
          if (response.nsfw) {
            this.hideElement(el, response);
          } else {
            this.clearPendingBlur(el);
          }
        }
      );
    }

    hideElement(el, verdict) {
      if (el.dataset.aisfFlagged) return;
      el.dataset.aisfFlagged = '1';
      el.dataset.aisfReason = verdict.category || 'NSFW';
      delete el.dataset.aisfPending;
      delete el.dataset.aisfPrevFilter;
      el.style.filter = '';
      el.style.visibility = 'hidden';
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      if (this.mutationObserver) this.mutationObserver.disconnect();
    }
  }

  window.AISFImageScanner = AISFImageScanner;
})();
