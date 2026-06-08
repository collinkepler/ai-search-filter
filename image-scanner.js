// Layer 1: NSFW image scanner.
// Strict-mode flow:
//   1. Blur every observable image preemptively (before classification).
//   2. Send the URL to the service worker when it intersects the viewport.
//   3. On nsfw=true → hide entirely. On nsfw=false → clear the blur.
//   4. On unverified image URLs, apply the user's fallback (default reveal).
//      An 8s ceiling clears the blur if the classifier never responds, so a
//      broken pipeline doesn't permanently blur every image on the page.
//   5. Auto-detect un-scannable sites: if every observed image fails to fetch
//      (hotlink-protected CDNs — common on streaming/piracy sites), the scanner
//      reveals all of them and stands down. It cannot classify anything there,
//      so hiding/blurring every image is pure cost with zero protection.

(function () {
  const PENDING_TIMEOUT_MS = 8000;
  const BLUR_FILTER = 'blur(40px)';
  // How many images must fail-closed (with zero successful classifications)
  // before we conclude the whole site is un-fetchable and stop hiding images.
  const UNSCANNABLE_THRESHOLD = 5;

  class AISFImageScanner {
    constructor(options) {
      this.options = Object.assign({
        minSize: 80,
        rootMargin: '200px',
        unverifiedAction: 'reveal' // what to do when the classifier can't fetch an image
      }, options || {});

      this.scanned = new WeakSet();
      this.scannedUrls = new Set();
      this.disabled = false;

      // Auto-detect un-scannable sites. Once UNSCANNABLE_THRESHOLD images
      // fail-closed with zero successful classifications, the whole site is
      // treated as un-fetchable: everything is revealed and the scanner stops.
      this.failClosedCount = 0;
      this.verifiedCount = 0;
      this.unscannable = false;

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
        this.mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'srcset', 'poster']
        });
      }

      this.scheduleResweeps();
    }

    scheduleResweeps() {
      // observeAll() runs once at start and the MutationObserver catches everything
      // added afterward — but a page that renders its first batch of images around
      // the time the scanner is constructed (search-result pages: the scanner only
      // starts after the Layer 0 check resolves; and prerendered/preloaded pages)
      // can land that batch in a window neither path covers. Re-sweep the DOM a few
      // times so every image present gets observed. observe() is idempotent, so
      // re-sweeps just early-return for already-seen elements.
      let count = 0;
      this.resweepTimer = setInterval(() => {
        if (this.disabled || count++ >= 30) {
          clearInterval(this.resweepTimer);
          this.resweepTimer = null;
          return;
        }
        this.observeAll();
      }, 400);

      // A preloaded/prerendered page runs the scanner while hidden; re-sweep when it
      // becomes visible (also covers tab-restore and bfcache page-show).
      this.onVisible = () => {
        if (!this.disabled && document.visibilityState === 'visible') this.observeAll();
      };
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('pageshow', this.onVisible);
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
      if (this.unscannable) return;
      if (el.dataset.aisfPending || el.dataset.aisfFlagged || el.dataset.aisfCleared || el.dataset.aisfUnverified) return;
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
        if (m.type === 'attributes') {
          const el = m.target;
          if (!el || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) continue;
          // Skip elements we've never observed — observe() will pick them up via
          // the addedNodes branch if/when they enter the DOM.
          if (!this.scanned.has(el)) continue;
          const newUrl = el.tagName === 'IMG' ? (el.currentSrc || el.src) : el.poster;
          // blob: URLs can't be read by the service worker; data: URIs carry the bytes
          // inline (Google swaps real thumbnails in as data: URIs after page load).
          if (!newUrl || newUrl.startsWith('blob:')) continue;
          this.reCheck(el);
          continue;
        }
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

    reCheck(el) {
      // Reset every dataset flag the prior verdict left behind so applyPendingBlur
      // and checkElement treat this as a fresh classification round. This also
      // covers slot-reuse: an <img> that was hidden as NSFW can be repurposed by
      // Google's virtualized list for a different image, and we want to classify
      // the new content rather than leave it hidden or unhide it blindly.
      if (el.dataset.aisfFlagged) {
        delete el.dataset.aisfFlagged;
        delete el.dataset.aisfReason;
        el.style.visibility = '';
      }
      delete el.dataset.aisfPending;
      delete el.dataset.aisfCleared;
      delete el.dataset.aisfUnverified;
      delete el.dataset.aisfPrevFilter;
      el.style.filter = '';

      this.applyPendingBlur(el);
      this.checkElement(el);
    }

    checkElement(el) {
      if (this.disabled) return;
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

      // No usable URL — clear the blur rather than freezing it. blob: URLs are
      // scoped to the page context and can't be read by the service worker;
      // data: URIs carry the image bytes inline and CAN be classified.
      if (!url || url.startsWith('blob:')) {
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
          if (this.disabled) return;
          if (chrome.runtime.lastError || !response) {
            // Fail-closed: leave blurred. Timeout above will eventually clear it.
            return;
          }
          if (response.nsfw) {
            this.verifiedCount++;
            this.hideElement(el, response);
          } else if (response.failClosed) {
            this.failClosedCount++;
            if (!this.unscannable && this.verifiedCount === 0 &&
                this.failClosedCount >= UNSCANNABLE_THRESHOLD) {
              this.markUnscannable();
            }
            this.applyUnverified(el);
          } else {
            this.verifiedCount++;
            this.clearPendingBlur(el);
          }
        }
      );
    }

    applyUnverified(el) {
      // The classifier could not fetch/decode this image (hotlink-protected CDN,
      // dead URL). If the whole site has proven un-fetchable, hiding/blurring is
      // pure cost with zero protection — just reveal. Otherwise apply the user's
      // chosen fallback for un-verifiable images.
      if (this.unscannable) {
        this.clearPendingBlur(el);
        return;
      }
      const action = this.options.unverifiedAction;
      if (action === 'reveal') {
        this.clearPendingBlur(el);
      } else if (action === 'blur') {
        this.keepBlurred(el);
      } else {
        this.hideElement(el, { category: 'unverified' });
      }
    }

    markUnscannable() {
      // Every observed image on this host failed to fetch — the scanner cannot
      // protect against anything here. Reveal what we already hid/blurred as
      // "unverified", then stop observing so later images aren't blurred or sent
      // for classification (every call would just fail-closed again).
      this.unscannable = true;
      console.log('[AISF] image scanner: every image on ' + location.hostname +
        ' is un-fetchable (hotlink-protected) — revealing thumbnails and standing down');
      this.restoreUnverifiedElements();
      this.stop();
    }

    restoreUnverifiedElements() {
      document.querySelectorAll('img, video').forEach((el) => {
        if (el.dataset.aisfFlagged && el.dataset.aisfReason === 'unverified') {
          // Hidden by applyUnverified — un-hide. NSFW-flagged elements carry a
          // different aisfReason and are deliberately left untouched.
          delete el.dataset.aisfFlagged;
          delete el.dataset.aisfReason;
          el.style.visibility = '';
          el.style.filter = '';
          el.dataset.aisfCleared = '1';
        } else if (el.dataset.aisfUnverified) {
          // Permanently blurred by applyUnverified — clear the blur.
          delete el.dataset.aisfUnverified;
          el.style.filter = '';
          el.dataset.aisfCleared = '1';
        } else if (el.dataset.aisfPending) {
          this.clearPendingBlur(el);
        }
      });
    }

    keepBlurred(el) {
      // Convert the transient pending blur into a permanent one.
      if (el.dataset.aisfFlagged) return;
      delete el.dataset.aisfPending;
      delete el.dataset.aisfPrevFilter;
      el.dataset.aisfUnverified = '1';
      el.style.filter = BLUR_FILTER;
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
      if (this.resweepTimer) { clearInterval(this.resweepTimer); this.resweepTimer = null; }
      if (this.onVisible) {
        document.removeEventListener('visibilitychange', this.onVisible);
        window.removeEventListener('pageshow', this.onVisible);
        this.onVisible = null;
      }
    }

    disable() {
      // Tear-down for the "intelligent activation" path: a host-level verdict
      // says this site doesn't need image scanning. Stop observing, clear any
      // optimistic blurs we already applied, but DO NOT touch elements already
      // flagged as NSFW — those verdicts are authoritative.
      this.disabled = true;
      this.stop();
      document.querySelectorAll('img[data-aisf-pending], video[data-aisf-pending]')
        .forEach((el) => this.clearPendingBlur(el));
    }
  }

  window.AISFImageScanner = AISFImageScanner;
})();
