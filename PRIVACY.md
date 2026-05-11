# Privacy Policy — AI Search Filter

_Last updated: 2026-05-11_

AI Search Filter ("the extension") is a Chrome extension that filters web content according to rules you write, by sending content from the pages you visit to Anthropic's Claude API for classification.

This policy explains exactly what data leaves your browser, where it goes, and what stays local.

## Single purpose

The extension exists for one purpose: **to filter web page content according to user-defined natural-language rules using Anthropic's Claude API**. It is not used for analytics, advertising, tracking, or any unrelated purpose.

## Data sent to Anthropic

When you enable a filtering layer in Options, the extension sends data to `https://api.anthropic.com/v1/messages` so that Claude can evaluate it against your rules. Depending on which layers are enabled:

- **Page layer** (off by default): the page's URL, `<title>`, and `<meta name="description">` content.
- **Image layer** (off by default): image URLs from the current page. Anthropic fetches the image bytes server-side; the extension does not proxy image bytes.
- **Post text layer** (off by default): the text of posts on supported feed sites (currently Reddit, Twitter/X, YouTube — see [post-scanner.js](post-scanner.js)). Post text is batched and sent in groups.
- **Site CSS layer** (on by default): **sends no data**. It is pure CSS injected locally to hide UI elements on specific sites.

Anthropic's handling of API data is governed by Anthropic's own privacy policy: <https://www.anthropic.com/legal/privacy>.

## Data NOT sent

- The extension does **not** send data from pages on your "Always-allow domains" list — those pages skip all layers entirely.
- The extension does **not** send analytics, telemetry, crash reports, or usage statistics anywhere.
- The extension does **not** transmit your API key to anyone except Anthropic, and only as the `x-api-key` request header.
- The extension does **not** share data with any third party other than Anthropic.

## What is stored locally

Stored only in your browser's `chrome.storage.local`, never transmitted:

- Your Anthropic API key (stored in plaintext — readable from disk by anyone with access to your Chrome profile).
- Your rules and settings.
- A page-verdict cache (default 7 days).
- An image-verdict cache (default 30 days).

You can clear all local data by removing the extension via `chrome://extensions`.

## Categories of data per Chrome Web Store taxonomy

- **Personally identifiable information**: No.
- **Health, financial, authentication, personal communications, or location**: No.
- **Web history**: Yes — page URLs are sent to Anthropic when the Page layer is enabled.
- **Website content**: Yes — page titles, meta descriptions, post text, and image URLs are sent to Anthropic when the corresponding layers are enabled.

Data is **not sold**, **not used for advertising**, and **not used for any purpose unrelated to the single purpose stated above**.

## Remote code

The extension does **not** load or execute remote code. All JavaScript ships in the extension package.

## Contact

Questions or requests: keplercollin0@gmail.com.
