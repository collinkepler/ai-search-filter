# AI Search Filter v1.0.0

Multi-layer Chrome content filter powered by Claude Haiku.

## Install

Chrome Web Store listing (private — Trusted Tester accounts only): _link will be added after the listing is approved_.

To install from source, see [Developing](#developing) below.

## The four layers

| Layer | What it does | API cost | Default |
|---|---|---|---|
| **0 — Page-level** | Classify every page URL + title + meta description | Cheap (1 call per unique page, cached 7 days) | Always on |
| **2 — Site CSS** | Hide content Reddit/Twitter/YouTube already tag as NSFW or sensitive | Free | On |
| **1 — Image scanner** | Send visible images to Claude vision for NSFW classification | ~$0.0005/image, cached 30 days | Off |
| **3 — Post text** | Extract feed post titles, batch-classify against your rules | ~$0.0001 per post, batched | Off |

Each layer is independent. Toggle whichever combination you want in Options.

## Quick start

1. Install from the Chrome Web Store (see [Install](#install)) — or load unpacked for development.
2. Open Options. Paste API key. Add rules. Decide which layers to enable.
3. Enable **Site CSS** immediately — it's free and catches the obvious stuff (NSFW-tagged Reddit posts, sensitive Twitter content).
4. Enable **Image scanner** when you want broader coverage (catches unticked porn previews). Set blur vs hide.
5. Enable **Post text** for feed content beyond images (gambling discussions, political drama, etc.) on Reddit/Twitter/YouTube.

## How each layer handles your specific case

**Reddit feed with porn previews** (the case you flagged):
- Layer 2 catches anything Reddit tagged `[nsfw]` — most of it
- Layer 1 catches the rest by image analysis (unticked previews)
- Layer 3 catches text-based stuff in unticked NSFW subs

Three nets at increasing cost. Most of what slips through one is caught by the next.

## Privacy

Everything outside your **Always-allow domains** is sent to Anthropic's API:
- Layer 0: URL + title + meta description
- Layer 1: image URLs (Claude fetches them)
- Layer 3: post text

Put banking, work tools, personal email in the allow list. They skip all layers entirely.

## Cost realism

Heavy usage (Reddit + Twitter daily, all layers on):
- Layer 0: ~$0.10/month
- Layer 1: ~$1–3/month depending on scroll volume (cached after first sight)
- Layer 3: ~$0.50–1.50/month
- Total: ~$2–5/month

Light usage (just Layer 0 + 2): basically free.

## Architecture

```
content-script.js   →  orchestrator: page classification + spins up sub-scanners
image-scanner.js    →  Layer 1: IntersectionObserver on images, blurs/hides flagged
post-scanner.js     →  Layer 3: site-specific selectors, batched classification
site-filters/*.css  →  Layer 2: pure CSS injected per-site
service-worker.js   →  handles all 3 classification message types, separate caches
options.html/js     →  per-layer toggles, rules editor, allow-domain list
block.html          →  block screen with matched rule + reason
hide.css            →  overlay during Layer 0 check
```

## Adding a new site for Layer 2 / Layer 3

**Layer 2** (CSS-only): create `site-filters/yoursite.css`, add a content_script entry in `manifest.json` matching that host.

**Layer 3** (post selectors): add an entry to `SITE_CONFIGS` in `post-scanner.js` with the host matcher, post selectors, and an `extract(el)` function returning the post text.

## Known limits

- **Layer 1 can't see lazy-loaded images** until they enter viewport. By design — would be wasteful otherwise. Brief flash of NSFW possible if you scroll fast. Blur action transitions fast enough that this is rarely noticeable.
- **Layer 2 only knows the selectors I included.** Sites redesign. If a selector breaks, edit `site-filters/*.css`.
- **Layer 3 has known-site bias.** Generic feed detection (heuristic across all sites) was decided against — too unreliable, would break random sites. Reddit/Twitter/YouTube covered out of the box.
- **MV3 can't synchronously block requests.** The page loads in background; we just hide it. Audio gets paused.
- **API key in `chrome.storage.local`** is stored in plaintext on your device. The extension never transmits it anywhere except directly to Anthropic's API.

## Developing

Vanilla JS, no build step. Clone the repo, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select this folder. Edit a file → reload the extension → reload the page.

## Files

```
manifest.json
content-script.js
image-scanner.js
post-scanner.js
service-worker.js
options.html
options.js
block.html
hide.css
site-filters/reddit.css
site-filters/twitter.css
site-filters/youtube.css
README.md
```
