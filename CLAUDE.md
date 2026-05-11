# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome MV3 extension that filters web content against user-defined rules using Claude Haiku. There is **no build step, no test suite, no package.json, no dependencies**. The repo is loaded directly via `chrome://extensions` → Developer mode → Load unpacked. Iteration loop is edit → reload the extension → reload the page.

## Architecture: four independent layers

The four layers each address content at a different granularity. They share only the service worker and `chrome.storage.local`; each can be toggled independently in options.

| Layer | Trigger | Where classified | Cache |
|---|---|---|---|
| **0 — Page** | content-script.js on every navigation | Service worker `checkContent` | `aisf-cache`, 7 days, keyed by normalized URL + rules hash |
| **1 — Image** | image-scanner.js, IntersectionObserver on `<img>`/`<video>`. **Preemptive blur**: every observable image is blurred immediately on `observe()`; classification runs on intersect; on `nsfw=true` the image is hidden (`visibility: hidden`), on `nsfw=false` the blur is cleared. Categories include `suggestive` alongside `porn` — both return `nsfw=true`. | Service worker `classifyImage` (Claude vision) | `aisf-img-cache`, 30 days, keyed by image URL hash. Invalidated by `IMG_CACHE_VERSION` bump (see Caching). |
| **2 — Site CSS** | Pure CSS, no JS — declared in manifest as separate content_scripts per host | n/a | n/a |
| **3 — Post text** | post-scanner.js, per-site selectors, batches as posts scroll into view | Service worker `classifyPosts` (batch) | In-memory only (per-page session) |

The orchestration entry point is [content-script.js:18](content-script.js#L18) `init()`: it runs Layer 0 first (blocking via `aisf-checking` class + injected overlay from [hide.css](hide.css)) and only spins up Layers 1 and 3 via `initSubLayers` ([content-script.js:82](content-script.js#L82)) **after** Layer 0 reveals the page. If Layer 0 blocks, the page is replaced with `block.html`.

**Feed-container exemption.** `extractContent` ([content-script.js:144](content-script.js#L144)) returns `null` for YouTube non-watch pages (homepage, search results, channels, etc.) so Layer 0 is skipped entirely — the page reveals immediately and Layer 3 filters individual video cards as they scroll into view. This is deliberate: an only-allow rule like "real-estate videos" would otherwise block the bare YouTube homepage (no specific video to classify against). Only `/watch?v=...` URLs flow through Layer 0 as `youtube_video`. Trade-off: a user who wants to block YouTube wholesale can't do it via a Layer 0 block rule on `youtube.com/`; they have to rely on Layer 3, an external blocker, or a block rule matching watch-page content.

### Why the overlay-first pattern matters

MV3 cannot synchronously block requests, so the page actually loads in the background while Layer 0 checks. The `hide.css` overlay + `pauseMedia()` is what creates the illusion of "checking before showing." Anything that breaks the overlay (e.g. removing the `aisf-checking` class too early, or failing to call `reveal()` on every code path) will leak content briefly. Every early-return in `init()` must either `reveal()` or navigate away.

### Service worker is the single API boundary

All three classification message types are dispatched from one `onMessage` listener in [service-worker.js:15](service-worker.js#L15). All Anthropic API calls go through `callAnthropic` ([service-worker.js:322](service-worker.js#L322)) which sets `anthropic-dangerous-direct-browser-access: true` — this header is **required** for browser-origin requests and must not be removed. The model constant is at [service-worker.js:12](service-worker.js#L12).

Content scripts never call the API directly. If you need a new classification type, add a message type to the service worker's listener, mirror its caching pattern (`getCached`/`setCached` with a distinct store key), and have the content-side module use `chrome.runtime.sendMessage`.

### Caching

Two stores in `chrome.storage.local`: `aisf-cache` (Layer 0) and `aisf-img-cache` (Layer 1). Both use the generic `getCached`/`setCached` helpers with LRU-style eviction by oldest timestamp. Layer 0 cache keys incorporate a `hashStr` of the rules JSON so that editing rules implicitly invalidates verdicts; the options page also explicitly removes `aisf-cache` on Save ([options.js](options.js)). When changing what data feeds a classification, update the cache key accordingly or stale verdicts will persist.

**Cache versioning for prompt changes.** Layer 1 uses an `IMG_CACHE_VERSION` constant at the top of [service-worker.js](service-worker.js); a startup IIFE compares it against the stored `aisf-img-cache-version` and wipes `aisf-img-cache` on mismatch. **Bump this constant any time the `callClaudeForImage` system prompt changes semantically** (e.g. adding a new category, broadening what counts as NSFW) — otherwise users keep getting stale "safe" verdicts from the old prompt. The same pattern should be added for `aisf-cache` if the Layer 0 prompt changes meaningfully.

### Layer 3: per-site config

[post-scanner.js:8](post-scanner.js#L8) `SITE_CONFIGS` is the extension point for feed-style sites. Each entry needs `match(hostname) → bool`, an array of `selectors` for post containers, and `extract(el) → string`. The scanner uses an IntersectionObserver + MutationObserver pair to handle infinite scroll, batches text in groups of 15 with a 600ms debounce ([post-scanner.js:62](post-scanner.js#L62)), and caches verdicts in-memory by exact post text within a page session. There is intentionally **no generic feed heuristic** — only the sites in `SITE_CONFIGS` get Layer 3.

### Layer 2: CSS-only

`site-filters/*.css` is injected per-host via separate `content_scripts` entries in [manifest.json:20-33](manifest.json#L20-L33). Adding a new site requires both creating the CSS file **and** adding a matching manifest entry (the manifest is not auto-generated).

## Settings model

All settings live in `chrome.storage.local`. Keys are accessed by string; there is no schema. The set the codebase expects:

- `apiKey` — Anthropic key
- `rules` — `[{id, text, mode: 'block'|'allow'|'only-allow', scope?: string[]}]`. `block` hides matching content; `allow` is an exception-override that force-allows even when a block rule fires; `only-allow` flips Layer 0 and Layer 3 to block-by-default — as soon as any `only-allow` rule applies to the current host, content not matching one is blocked (block rules still subtract from that set). Optional `scope` is a list of bare hostnames; a rule with a non-empty `scope` only fires when the current host equals or is a subdomain of one of them (same suffix-match semantics as `allowDomains`). Out-of-scope rules are filtered out before classification, so an only-allow rule scoped to `youtube.com` will not affect any other site. The host-derivation + filter helpers (`hostFromContent`, `ruleAppliesToHost`) and the mode-aware prompt branch live in [service-worker.js](service-worker.js); `classifyPosts` receives `hostname` via the message and `checkContent` derives host from the content payload. The older `blocklist` string format is migrated on read in both [service-worker.js:53](service-worker.js#L53) and [options.js:27](options.js#L27); when adding settings, follow this pattern (read-then-migrate) rather than a one-shot migration step.
- `failMode` — `'open'` or `'closed'` (what to do if the API errors out)
- `allowDomains` — array of bare hostnames; matched via exact or suffix match in [content-script.js:116](content-script.js#L116). Allow-domain pages skip all layers entirely.
- `enableSiteFilters` / `enableImageScanner` / `enablePostScanner` — Layer toggles (Layer 2 default ON, the others default OFF)
- `imageAction` (`blur`/`hide`), `imageMinSize`, `postAction` (`hide`/`dim`)

`content-script.js` caches the settings object in-memory per page-load ([content-script.js:103](content-script.js#L103)); if you add a setting that must take effect immediately on the current page, the user will still need to reload.

## Conventions to preserve

- **Strict JSON-only prompts.** All three Claude prompts demand `Respond with ONLY valid JSON` and the response is parsed after stripping a possible ```` ```json ```` fence. Keep this format if you edit prompts; the parsers will throw otherwise.
- **`describe()` and `block.html` query params.** When Layer 0 blocks, [content-script.js:65](content-script.js#L65) packs `q`, `rule`, `reason`, `error`, `fromCache`, `raw` into the block URL. `block.html` reads these — keep names in sync.
- **No frameworks, no transpilation.** Vanilla JS, IIFE-wrapped content scripts, `window.AISF*` exports between them. Don't introduce a bundler or npm dependencies for changes that don't need them — the zero-build property is a feature.
- **`console.log('[AISF] ...')`** is the established log prefix. `DEBUG` in service-worker.js is currently `true`.

## Known constraints baked into the design (don't "fix")

- Layer 1 only scans images that enter the viewport — by design, to avoid wasted API calls. Lazy-loaded NSFW images can flash briefly on fast scroll; the blur transition is what makes this acceptable.
- The API key sits in `chrome.storage.local` in plaintext. This is documented as personal-use only in [README.md](README.md).
- `image-scanner.js` sends image **URLs** to the service worker, and Claude fetches them server-side — we don't proxy bytes. Images behind auth won't classify.
