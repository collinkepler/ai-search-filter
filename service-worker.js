// Background service worker. Handles three classification request types:
//  - check       → page/search/youtube classification (Layer 0)
//  - classifyImage → NSFW image check via Claude vision (Layer 1)
//  - classifyPosts → batch text classification of feed posts (Layer 3)

const CACHE_KEY = 'aisf-cache';
const CACHE_VERSION_KEY = 'aisf-cache-version';
const CACHE_VERSION = 6; // bump when callClaudeForContext / callClaudeForPosts prompt changes meaningfully
const IMG_CACHE_KEY = 'aisf-img-cache';
const IMG_CACHE_VERSION_KEY = 'aisf-img-cache-version';
const IMG_CACHE_VERSION = 2; // bump when callClaudeForImage prompt changes meaningfully
const HOST_SKIP_CACHE_KEY = 'aisf-host-skip-cache';
const HOST_SKIP_CACHE_VERSION_KEY = 'aisf-host-skip-cache-version';
const HOST_SKIP_CACHE_VERSION = 1; // bump when classifyHostNeedsImageScan prompt changes meaningfully
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const IMG_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days for images
const HOST_SKIP_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days for host-skip verdicts
const MAX_CACHE_ENTRIES = 2000;
const MAX_IMG_CACHE = 5000;
const MAX_HOST_SKIP_CACHE = 1000;
const MODEL = 'claude-haiku-4-5-20251001';
const APPEAL_MODEL = 'claude-sonnet-4-6';
const APPEAL_GRANT_KEY = 'aisf-appeal-grants';
const APPEAL_GRANT_TTL_MS = 1000 * 60 * 60; // 1 hour bypass window after a granted appeal
const PERSONAL_CONTEXT_MAX_CHARS = 2000;
const DEBUG = true;

(async () => {
  try {
    const { [IMG_CACHE_VERSION_KEY]: v } = await chrome.storage.local.get(IMG_CACHE_VERSION_KEY);
    if (v !== IMG_CACHE_VERSION) {
      await chrome.storage.local.remove(IMG_CACHE_KEY);
      await chrome.storage.local.set({ [IMG_CACHE_VERSION_KEY]: IMG_CACHE_VERSION });
      if (DEBUG) console.log('[AISF] img cache invalidated to version', IMG_CACHE_VERSION);
    }
  } catch (e) { console.warn('[AISF] cache version check failed:', e); }
})();

(async () => {
  try {
    const { [CACHE_VERSION_KEY]: v } = await chrome.storage.local.get(CACHE_VERSION_KEY);
    if (v !== CACHE_VERSION) {
      await chrome.storage.local.remove(CACHE_KEY);
      await chrome.storage.local.set({ [CACHE_VERSION_KEY]: CACHE_VERSION });
      if (DEBUG) console.log('[AISF] page cache invalidated to version', CACHE_VERSION);
    }
  } catch (e) { console.warn('[AISF] page cache version check failed:', e); }
})();

(async () => {
  try {
    const { [HOST_SKIP_CACHE_VERSION_KEY]: v } = await chrome.storage.local.get(HOST_SKIP_CACHE_VERSION_KEY);
    if (v !== HOST_SKIP_CACHE_VERSION) {
      await chrome.storage.local.remove(HOST_SKIP_CACHE_KEY);
      await chrome.storage.local.set({ [HOST_SKIP_CACHE_VERSION_KEY]: HOST_SKIP_CACHE_VERSION });
      if (DEBUG) console.log('[AISF] host-skip cache invalidated to version', HOST_SKIP_CACHE_VERSION);
    }
  } catch (e) { console.warn('[AISF] host-skip cache version check failed:', e); }
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'check') {
    checkContent(msg.content, msg.navigationUrl).then(sendResponse).catch((err) => {
      console.error('[AISF] check threw:', err);
      sendResponse({ blocked: false, reason: 'internal-error', error: String(err) });
    });
    return true;
  }

  if (msg.type === 'appealBlock') {
    handleAppeal(msg).then(sendResponse).catch((err) => {
      console.error('[AISF] appeal threw:', err);
      sendResponse({ overturned: false, reason: 'Appeal failed: ' + String(err && err.message || err), error: String(err) });
    });
    return true;
  }

  if (msg.type === 'appealRuleChange') {
    handleRuleChangeAppeal(msg).then(sendResponse).catch((err) => {
      console.error('[AISF] rule-change appeal threw:', err);
      sendResponse({ approved: false, reason: 'Appeal failed: ' + String(err && err.message || err), error: String(err) });
    });
    return true;
  }

  if (msg.type === 'classifyImage') {
    classifyImage(msg.imageUrl).then(sendResponse).catch((err) => {
      console.error('[AISF] classifyImage threw:', err);
      sendResponse({ nsfw: false, error: String(err) });
    });
    return true;
  }

  if (msg.type === 'classifyHostForImageScanner') {
    classifyHostForImageScanner(msg.hostname).then(sendResponse).catch((err) => {
      console.error('[AISF] classifyHostForImageScanner threw:', err);
      sendResponse({ skip: false, error: String(err) }); // fail-open: keep scanner running
    });
    return true;
  }

  if (msg.type === 'classifyPosts') {
    classifyPosts(msg.posts, msg.hostname).then(sendResponse).catch((err) => {
      console.error('[AISF] classifyPosts threw:', err);
      sendResponse({ verdicts: [], error: String(err) });
    });
    return true;
  }
});

// ============================================================
// Layer 0: page/search/youtube classification
// ============================================================

async function checkContent(content, navigationUrl) {
  if (DEBUG) console.log('[AISF] checkContent', content);

  const granted = navigationUrl ? await hasAppealGrant(navigationUrl) : false;
  if (granted) {
    const cid = cacheIdFromContent(content);
    if (cid) await invalidateCacheByPrefix(CACHE_KEY, cid + '::');
    if (DEBUG) console.log('[AISF] checkContent: appeal grant honored for', navigationUrl);
    return { blocked: false, reason: 'appeal-granted' };
  }

  const stored = await chrome.storage.local.get(['apiKey', 'rules', 'blocklist', 'failMode', 'personalContext', 'personalContextOnHotPaths', 'contentStrictness']);
  const apiKey = stored.apiKey || '';
  const failMode = stored.failMode || 'open';
  const useOnHotPaths = stored.personalContextOnHotPaths !== false; // default ON
  const personalContext = useOnHotPaths ? (stored.personalContext || '').trim() : '';
  const contentStrictness = stored.contentStrictness || 'balanced';

  let rules = Array.isArray(stored.rules) ? stored.rules : null;
  if (!rules && typeof stored.blocklist === 'string' && stored.blocklist.trim()) {
    rules = stored.blocklist.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((text) => ({ id: rand(), text, mode: 'block' }));
    await chrome.storage.local.set({ rules });
    await chrome.storage.local.remove('blocklist');
  }
  if (!rules) rules = [];

  const host = hostFromContent(content);
  const scopedRules = rules.filter((r) => ruleAppliesToHost(r, host));
  const { blockRules, allowRules, onlyAllowRules } = splitRulesByMode(scopedRules);

  if (!apiKey || (blockRules.length === 0 && onlyAllowRules.length === 0)) {
    return { blocked: false, reason: 'not-configured' };
  }

  let context, cacheId;
  try {
    const built = await buildContext(content);
    if (!built) return { blocked: false, reason: 'no-context' };
    context = built.context;
    cacheId = built.cacheId;
  } catch (e) {
    return { blocked: failMode === 'closed', reason: 'context-error', error: String(e && e.message || e) };
  }

  const ruleForHash = (r) => ({ t: r.text, s: r.scope || [] });
  const hashSource = {
    b: blockRules.map(ruleForHash),
    a: allowRules.map(ruleForHash)
  };
  if (onlyAllowRules.length) hashSource.oa = onlyAllowRules.map(ruleForHash);
  if (personalContext) hashSource.pc = hashStr(personalContext);
  if (contentStrictness && contentStrictness !== 'balanced') hashSource.cs = contentStrictness;
  const rulesHash = hashStr(JSON.stringify(hashSource));
  const cacheKey = `${cacheId}::${rulesHash}`;

  const cached = await getCached(CACHE_KEY, cacheKey, CACHE_TTL_MS);
  if (cached) return { ...cached, fromCache: true };

  try {
    const decision = await callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey, personalContext, contentStrictness);
    await setCached(CACHE_KEY, cacheKey, decision, MAX_CACHE_ENTRIES);
    return decision;
  } catch (e) {
    return { blocked: failMode === 'closed', reason: 'api-error', error: String(e && e.message || e) };
  }
}

async function buildContext(content) {
  if (content.type === 'search') {
    return {
      context: `Content type: web search query\nEngine: ${content.engine}\nQuery: "${content.query}"`,
      cacheId: `search:${content.query.toLowerCase().trim()}`
    };
  }
  if (content.type === 'youtube_video') {
    const meta = await fetchYouTubeMeta(content.videoId);
    return {
      context: meta
        ? `Content type: YouTube video the user is about to watch\nTitle: "${meta.title}"\nChannel: ${meta.channel}`
        : `Content type: YouTube video\nVideo ID: ${content.videoId}\n(metadata fetch failed)`,
      cacheId: `yt:${content.videoId}`
    };
  }
  if (content.type === 'page') {
    const parts = [
      'Content type: web page the user is about to view',
      `URL: ${content.url}`,
      `Domain: ${content.hostname}`
    ];
    if (content.title) parts.push(`Page title: "${content.title}"`);
    if (content.description) parts.push(`Page description: "${content.description}"`);
    return { context: parts.join('\n'), cacheId: 'page:' + normalizeUrl(content.url) };
  }
  return null;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname + u.search).toLowerCase().replace(/\/+$/, '');
  } catch (e) { return String(url).toLowerCase(); }
}

async function fetchYouTubeMeta(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
  try {
    const res = await fetchWithTimeout(url, {}, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || '', channel: data.author_name || '' };
  } catch (e) { return null; }
}

async function callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey, personalContext, contentStrictness) {
  const blockListText = blockRules.length
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';

  const contextBlock = buildPersonalContextBlock(personalContext);
  const strictnessDirective = buildStrictnessDirective(contentStrictness, 'content');

  const systemPrompt = onlyAllowRules.length > 0 ? [
    contextBlock,
    strictnessDirective,
    'You classify web content against the user\'s rules.',
    '',
    'The user is in ALLOWLIST mode: by default, content is BLOCKED unless it clearly matches at least one ONLY-ALLOW rule.',
    '',
    'ONLY-ALLOW rules (content must match one of these to be allowed):',
    onlyAllowListText,
    '',
    'ALLOW rules (exception-overrides; force-allow even when a block rule fires):',
    allowListText,
    '',
    'BLOCK rules (block even if matched by an only-allow rule):',
    blockListText,
    '',
    'Decision process, in order:',
    '1. If content clearly matches an ALLOW rule -> blocked=false, matchedRule = that allow rule.',
    '2. Else if content clearly matches a BLOCK rule -> blocked=true, matchedRule = that block rule.',
    '3. Else if content clearly matches an ONLY-ALLOW rule -> blocked=false, matchedRule = that only-allow rule.',
    '4. Otherwise -> blocked=true, matchedRule=null.',
    '',
    'The `reason` field is REQUIRED and must be substantive in every case:',
    '- If a rule matched: name what the page is and which rule it triggered (e.g. "page is a tutorial about async/await JavaScript, matches your only-allow rule for programming content").',
    '- If no rule matched: describe what the page appears to be in one short sentence, then say which of the user\'s only-allow rules it failed to fit (e.g. "page is a celebrity gossip article; doesn\'t fit your only-allow rules for programming or cooking content").',
    'Never return a boilerplate or generic reason. The user reads this verbatim to decide whether their rules are right.',
    '',
    'Be reasonable: educational/news content ABOUT a topic in an only-allow rule counts as a match. Do not invent matches — if it is truly unrelated, block it.',
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "1-2 sentence substantive explanation, required"}'
  ].join('\n') : [
    contextBlock,
    strictnessDirective,
    'You classify web content against the user\'s rules.',
    '',
    'BLOCK rules:',
    blockListText,
    '',
    'ALLOW rules (override block rules):',
    allowListText,
    '',
    'Process: allow > block > default-allow. Be reasonable; educational/recovery/news content ABOUT a blocked topic is usually allowed.',
    '',
    'When a rule is phrased around the user\'s intent or impulse (e.g. "block things I\'d look up if I was X" or "block when I\'m tempted by Y"), treat search queries and pages that plausibly fulfill that intent as a match, even if the query itself is mild or euphemistic. The rule expresses a precommitment by the user against themselves — err toward honoring it on ambiguous cases. This overrides the educational/news carve-out only for intent-phrased rules.',
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "one-sentence explanation, required"}'
  ].join('\n');

  const data = await callAnthropic({
    apiKey,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: context }],
    max_tokens: 300
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in API response');
  const rawText = textBlock.text.trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  const matchedRule = (typeof parsed.matchedRule === 'string' && parsed.matchedRule.trim()) ? parsed.matchedRule.trim() : null;
  const reason = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : null;
  return { blocked: Boolean(parsed.blocked), matchedRule, category: matchedRule, reason, rawResponse: rawText };
}

// ============================================================
// Layer 1: image NSFW classification via vision
// ============================================================

async function classifyImage(imageUrl) {
  if (!imageUrl) return { nsfw: false, reason: 'no-url' };

  const { apiKey = '', enableImageScanner = false } = await chrome.storage.local.get(['apiKey', 'enableImageScanner']);
  if (!apiKey || !enableImageScanner) return { nsfw: false, reason: 'disabled' };

  const cacheKey = 'img:' + hashStr(imageUrl);
  const cached = await getCached(IMG_CACHE_KEY, cacheKey, IMG_CACHE_TTL_MS);
  if (cached) return { ...cached, fromCache: true };

  try {
    const result = await callClaudeForImage(imageUrl, apiKey);
    await setCached(IMG_CACHE_KEY, cacheKey, result, MAX_IMG_CACHE);
    return result;
  } catch (e) {
    console.warn('[AISF] image classify failed:', e);
    // Cache negative result briefly so we don't hammer
    const fallback = { nsfw: false, error: String(e && e.message || e) };
    return fallback;
  }
}

async function callClaudeForImage(imageUrl, apiKey) {
  const systemPrompt =
    'You are a strict image classifier. The user does not want to see sexual content of ANY kind, including suggestive imagery — not just explicit pornography.\n\n' +
    'Categories (pick the most specific that applies):\n' +
    '- "porn": pornography, nudity, sex acts, exposed genitals, exposed breasts, masturbation, explicit sexual imagery\n' +
    '- "suggestive": sexually suggestive but not explicit. Includes: lingerie/underwear photos, swimwear posed sexually (bikini shots framed for sex appeal, beach pin-ups), sheer or tight clothing emphasizing body, cleavage as the focal point, lower-body / butt close-ups, "thirst trap" framing, sexualized fitness/gym content, implied-nude posing, partial nudity, sexually suggestive cartoon/anime art, OnlyFans-style promotional images\n' +
    '- "violence": graphic violence, gore, injury\n' +
    '- "none": safe for general viewing — ordinary photos of people fully clothed without sexual framing, landscapes, objects, screenshots, diagrams, memes without sexual content, etc.\n\n' +
    'Rules:\n' +
    '- Both "porn" AND "suggestive" return nsfw=true. Only "none" and "violence" return nsfw=false (violence is tracked separately but does not trigger NSFW for this user).\n' +
    '- Be conservative on sexual content: if you are uncertain whether the framing is sexual, choose "suggestive" rather than "none".\n' +
    '- Context matters: a person in a swimsuit at a clearly-non-sexualized family beach photo is "none"; the same swimsuit shot for sex appeal (posed, body emphasized, professional/glamour lighting) is "suggestive".\n' +
    '- Athletes mid-competition in standard sport attire = "none". Posed bikini fitness modeling = "suggestive".\n\n' +
    'Respond ONLY with JSON, no prose:\n' +
    '{"nsfw": true|false, "category": "porn"|"suggestive"|"violence"|"none", "confidence": 0.0-1.0}';

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: 'Classify this image.' }
      ]
    }],
    max_tokens: 100
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text in response');
  const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    nsfw: Boolean(parsed.nsfw),
    category: parsed.category || null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null
  };
}

// ============================================================
// Layer 1 helper: per-host "is image scanning even worth it?" classification
// ============================================================

async function classifyHostForImageScanner(hostname) {
  const host = (hostname || '').toLowerCase().trim();
  if (!host) return { skip: false, reason: 'no-host' };

  const { apiKey = '', enableImageScanner = false } = await chrome.storage.local.get(['apiKey', 'enableImageScanner']);
  if (!apiKey || !enableImageScanner) return { skip: false, reason: 'disabled' };

  const cached = await getCached(HOST_SKIP_CACHE_KEY, host, HOST_SKIP_CACHE_TTL_MS);
  if (cached) return { ...cached, fromCache: true };

  try {
    const result = await callClaudeForHostSkip(host, apiKey);
    await setCached(HOST_SKIP_CACHE_KEY, host, result, MAX_HOST_SKIP_CACHE);
    return result;
  } catch (e) {
    console.warn('[AISF] host-skip classify failed:', e);
    return { skip: false, error: String(e && e.message || e) };
  }
}

async function callClaudeForHostSkip(hostname, apiKey) {
  const systemPrompt =
    'You decide whether a Chrome extension\'s NSFW image scanner should bother running on a given website.\n\n' +
    'The scanner exists to blur/hide pornographic and sexually suggestive imagery. It is expensive (one Claude vision call per visible image), so we want to skip it on sites where such imagery is essentially impossible.\n\n' +
    'Return skip=true ONLY if the hostname is a well-known site whose ordinary content clearly cannot include sexual or suggestive imagery. Examples:\n' +
    '- Real estate (zillow.com, redfin.com, realtor.com)\n' +
    '- Code/dev (github.com, gitlab.com, stackoverflow.com, npmjs.com)\n' +
    '- Reference (wikipedia.org, mdn.mozilla.org)\n' +
    '- Banking, finance, government, healthcare portals\n' +
    '- Productivity (docs.google.com, notion.so, linear.app)\n' +
    '- Mainstream news (nytimes.com, bbc.com, cnn.com) — news photos are not sexual\n' +
    '- Shopping for non-apparel goods (amazon.com is borderline because of swimwear/lingerie listings — return skip=false to be safe)\n\n' +
    'Return skip=false (run the scanner) if:\n' +
    '- The site hosts user-generated images or video (reddit.com, twitter.com/x.com, instagram.com, tiktok.com, tumblr.com, imgur.com, pinterest.com, 4chan.org, discord.com)\n' +
    '- The site is an adult site, image board, dating app, or known to mix adult content\n' +
    '- The site sells apparel, swimwear, lingerie, or fitness gear (product photos can be suggestive)\n' +
    '- The hostname is unfamiliar or generic (random blogs, unknown domains, image CDNs) — when in doubt, run the scanner\n\n' +
    'Be conservative: it is FAR worse to skip a site that turns out to host NSFW than to waste a few API calls on a site that turns out to be safe. If you have any doubt, return skip=false.\n\n' +
    'Respond ONLY with JSON, no prose:\n' +
    '{"skip": true|false, "reason": "one short sentence"}';

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Hostname: ' + hostname }]
    }],
    max_tokens: 100
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text in response');
  const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    skip: Boolean(parsed.skip),
    reason: typeof parsed.reason === 'string' ? parsed.reason : ''
  };
}

// ============================================================
// Layer 3: batch post text classification
// ============================================================

async function classifyPosts(posts, hostname) {
  if (!Array.isArray(posts) || posts.length === 0) return { verdicts: [] };

  const stored = await chrome.storage.local.get(['apiKey', 'rules', 'enablePostScanner', 'personalContext', 'personalContextOnHotPaths', 'contentStrictness']);
  if (!stored.apiKey || !stored.enablePostScanner) return { verdicts: [] };

  const host = (hostname || '').toLowerCase();
  const scopedRules = (Array.isArray(stored.rules) ? stored.rules : []).filter((r) => ruleAppliesToHost(r, host));
  const { blockRules, allowRules, onlyAllowRules } = splitRulesByMode(scopedRules);

  if (blockRules.length === 0 && onlyAllowRules.length === 0) return { verdicts: [] };

  const useOnHotPaths = stored.personalContextOnHotPaths !== false; // default ON
  const personalContext = useOnHotPaths ? (stored.personalContext || '').trim() : '';
  const contentStrictness = stored.contentStrictness || 'balanced';

  try {
    const verdicts = await callClaudeForPosts(posts, blockRules, allowRules, onlyAllowRules, stored.apiKey, personalContext, contentStrictness);
    return { verdicts };
  } catch (e) {
    console.error('[AISF] classifyPosts failed:', e);
    return { verdicts: [], error: String(e && e.message || e) };
  }
}

async function callClaudeForPosts(posts, blockRules, allowRules, onlyAllowRules, apiKey, personalContext, contentStrictness) {
  const blockListText = blockRules.length
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';

  const contextBlock = buildPersonalContextBlock(personalContext);
  const strictnessDirective = buildStrictnessDirective(contentStrictness, 'content');

  const systemPrompt = onlyAllowRules.length > 0 ? [
    contextBlock,
    strictnessDirective,
    'You classify a list of social media / feed posts against the user\'s rules.',
    '',
    'The user is in ALLOWLIST mode: by default, each post is BLOCKED unless it clearly matches at least one ONLY-ALLOW rule.',
    '',
    'ONLY-ALLOW rules (post must match one of these to be allowed):',
    onlyAllowListText,
    '',
    'ALLOW rules (exception-overrides; force-allow even when a block rule fires):',
    allowListText,
    '',
    'BLOCK rules (block even if a post matches an only-allow rule):',
    blockListText,
    '',
    'For each post, in order:',
    '1. If it clearly matches an ALLOW rule -> blocked=false, matchedRule = that allow rule.',
    '2. Else if it clearly matches a BLOCK rule -> blocked=true, matchedRule = that block rule.',
    '3. Else if it clearly matches an ONLY-ALLOW rule -> blocked=false, matchedRule = that only-allow rule.',
    '4. Otherwise -> blocked=true, matchedRule=null, reason = "off-topic".',
    '',
    'Be reasonable. Posts ABOUT a topic in an only-allow rule (news, educational, discussion) count as a match. Do not invent matches.',
    '',
    'Respond with ONLY a valid JSON array, one object per input post in the same order:',
    '[{"id": <post id>, "blocked": true|false, "matchedRule": "rule text or null", "reason": "brief one-line reason"}, ...]'
  ].join('\n') : [
    contextBlock,
    strictnessDirective,
    'You classify a list of social media / feed posts against the user\'s rules.',
    '',
    'BLOCK rules:',
    blockListText,
    '',
    'ALLOW rules (override block rules):',
    allowListText,
    '',
    'For each post, decide if it should be blocked. Allow > block > default-allow.',
    'Be reasonable. Posts ABOUT a blocked topic (recovery, news, educational) are usually allowed.',
    'Default to allowing posts that are clearly off-topic from any rule.',
    '',
    'Respond with ONLY a valid JSON array, one object per input post in the same order:',
    '[{"id": <post id>, "blocked": true|false, "matchedRule": "rule text or null", "reason": "brief one-line reason"}, ...]'
  ].join('\n');

  const userContent =
    'Classify each of these posts:\n\n' +
    posts.map((p) => `id ${p.id}: ${p.text}`).join('\n---\n');

  const data = await callAnthropic({
    apiKey,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 1500
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text in response');
  const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');

  return parsed.map((v) => ({
    id: v.id,
    blocked: Boolean(v.blocked),
    matchedRule: (typeof v.matchedRule === 'string' && v.matchedRule.trim()) ? v.matchedRule.trim() : null,
    reason: (typeof v.reason === 'string' && v.reason.trim()) ? v.reason.trim() : null
  }));
}

// ============================================================
// Appeals (Claude Sonnet reviews user-submitted block appeals)
// ============================================================

async function handleAppeal({ originalUrl, query, matchedRule, originalReason, appealText }) {
  const appeal = (appealText || '').trim();
  if (!appeal) {
    return { overturned: false, reason: 'Write something in the appeal box explaining why this block is wrong.' };
  }
  if (!originalUrl) {
    return { overturned: false, reason: 'Missing original URL — cannot process appeal.' };
  }

  const { apiKey = '', personalContext = '', appealStrictness = 'strict' } = await chrome.storage.local.get(['apiKey', 'personalContext', 'appealStrictness']);
  if (!apiKey) {
    return { overturned: false, reason: 'No API key configured.' };
  }

  let decision;
  try {
    decision = await callClaudeForAppeal({
      apiKey,
      originalUrl,
      query: query || '',
      matchedRule: matchedRule || '',
      originalReason: originalReason || '',
      appealText: appeal,
      personalContext: (personalContext || '').trim(),
      appealStrictness
    });
  } catch (e) {
    console.error('[AISF] appeal call failed:', e);
    return { overturned: false, reason: 'Appeal review failed: ' + String(e && e.message || e), error: String(e) };
  }

  if (decision.overturned) {
    await setAppealGrant(originalUrl);
  }
  return decision;
}

async function callClaudeForAppeal({ apiKey, originalUrl, query, matchedRule, originalReason, appealText, personalContext, appealStrictness }) {
  const hasContext = !!(personalContext && personalContext.trim());
  const strictnessDirective = buildStrictnessDirective(appealStrictness, 'appeal');
  const systemPrompt = [
    strictnessDirective ? strictnessDirective.trimEnd() : null,
    strictnessDirective ? '' : null,
    'You review appeals against a self-imposed content filter. The user previously set rules to block certain content for THEMSELVES, as a precommitment against their own weaker moments. A page was just blocked and the user is now appealing.',
    '',
    'Your job is to decide whether the appeal is genuinely valid. Be STRICT but REASONABLE. You are not here to be agreeable — you are here to enforce the user\'s own better judgment against their in-the-moment urges.',
    '',
    'OVERTURN the block (overturned=true) ONLY if the appeal substantively raises one of:',
    '- False positive: the user explains the content is genuinely different from what the classifier thought (e.g. "this is a documentary ABOUT X, not X itself")',
    '- Legitimate scoped exception that fits the SPIRIT of the rule: a specific work/research/safety need that the rule clearly was not aimed at (e.g. journalist researching the topic, clinician looking up a medication, parent verifying something for a child)',
    '- Clear classifier error: the matched rule plainly does not apply to what the page actually is',
    '',
    'UPHOLD the block (overturned=false) when:',
    '- The appeal is "I want to see it", "just this once", "I changed my mind", "the rule is too strict", or pure frustration without substance',
    '- The appeal admits the content IS what the rule covers, or asks for an exception "this time"',
    '- The appeal is empty, vague, one word, or does not address WHY the rule should not apply HERE',
    '- The user appears to be trying to circumvent their own precommitment',
    hasContext ? '- The appeal relies on an identity, profession, or life-circumstance claim that conflicts with the "ABOUT THE USER" block below. Do not accept unverifiable identity claims in the appeal that the user\'s stated identity does not support.' : null,
    '- You are not clearly persuaded — DEFAULT is to UPHOLD',
    '',
    hasContext ? 'You will be given an "ABOUT THE USER" block describing who the user actually is — they wrote it in advance, in a calm moment, as ground truth. Treat it as authoritative. If the appeal contradicts it (e.g. claims a profession the user has not stated, or a livelihood/research justification that depends on an identity the user does not have), default to UPHOLD. The user wrote the about-you block specifically to stop themselves from spoofing you in the heat of the moment.' : null,
    hasContext ? '' : null,
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"overturned": true|false, "reason": "1-2 sentences addressed directly to the user explaining your decision"}'
  ].filter((l) => l !== null).join('\n');

  const userContent = [
    hasContext ? 'ABOUT THE USER (the user wrote this themselves, in advance, as ground truth):' : null,
    hasContext ? personalContext.trim() : null,
    hasContext ? '' : null,
    'BLOCKED CONTENT',
    'URL: ' + originalUrl,
    query ? 'Shown as: ' + query : null,
    '',
    'THE USER\'S RULE THAT MATCHED:',
    matchedRule || '(none reported)',
    '',
    'ORIGINAL CLASSIFIER\'S REASON FOR BLOCKING:',
    originalReason || '(none reported)',
    '',
    'THE USER\'S APPEAL:',
    appealText
  ].filter((l) => l !== null).join('\n');

  const data = await callAnthropic({
    apiKey,
    model: APPEAL_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 400,
    timeoutMs: 20000
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in appeal response');
  const rawText = textBlock.text.trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  const reason = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : 'No reason given.';
  return { overturned: Boolean(parsed.overturned), reason, rawResponse: rawText };
}

// ============================================================
// Rule-change appeals (Sonnet reviews settings edits that weaken the filter)
// ============================================================

async function handleRuleChangeAppeal({ diff, appealText }) {
  const appeal = (appealText || '').trim();
  if (!appeal) {
    return { approved: false, reason: 'Write something in the appeal box explaining why you want to weaken your filter.' };
  }
  const renderedDiff = renderDiffForPrompt(diff);
  if (!renderedDiff) {
    return { approved: false, reason: 'No changes detected to review.' };
  }

  const { apiKey = '', personalContext = '' } = await chrome.storage.local.get(['apiKey', 'personalContext']);
  if (!apiKey) {
    return { approved: false, reason: 'No API key configured.' };
  }

  try {
    return await callClaudeForRuleChangeAppeal({
      apiKey,
      renderedDiff,
      appealText: appeal,
      personalContext: (personalContext || '').trim()
    });
  } catch (e) {
    console.error('[AISF] rule-change appeal call failed:', e);
    return { approved: false, reason: 'Appeal review failed: ' + String(e && e.message || e), error: String(e) };
  }
}

async function callClaudeForRuleChangeAppeal({ apiKey, renderedDiff, appealText, personalContext }) {
  const hasContext = !!(personalContext && personalContext.trim());
  const systemPrompt = [
    'You review proposals to weaken a self-imposed content filter. The user set rules in advance to block certain content for THEMSELVES, as a precommitment against their own weaker moments. They are now proposing edits that would make the filter LESS restrictive — fewer block rules, broader allow rules, disabled scanners, expanded skip-lists, or a changed "ABOUT THE USER" identity blurb.',
    '',
    'Your job is to decide whether the appeal substantively justifies the proposed weakening. Be STRICT but REASONABLE. You are not here to be agreeable — you are here to enforce the user\'s own better judgment against their in-the-moment urges.',
    '',
    'APPROVE the change (approved=true) ONLY if the appeal substantively raises one of:',
    '- A specific, concrete real-life need with a stated reason (work project, research deadline, parenting situation, medical context) that the rule clearly was not aimed at',
    '- A genuine fix to a poorly-worded rule that has been generating obvious false positives the user can describe — not a generic complaint that "the filter is too strict"',
    '- A legitimate scoped exception that fits the SPIRIT of the rule (e.g. narrowing a global block to specific sites the user has a job/research reason to access)',
    '- An identity-blurb update that reflects a real change in the user\'s life, described concretely, not invented to spoof future appeals',
    '',
    'DENY the change (approved=false) when:',
    '- The appeal is "I want to look at it", "just this once", "I changed my mind", "the rule is too strict", or vague frustration without substance',
    '- The appeal admits the content IS what the rule was meant to block, and just asks for relief',
    '- The appeal is empty, one word, or does not address WHY the weakening is necessary',
    '- The user appears to be in a moment of weakness, trying to dismantle their own precommitment',
    hasContext ? '- The appeal relies on an identity, profession, or life-circumstance claim that conflicts with the "ABOUT THE USER" block below. Do not accept unverifiable identity claims that the user\'s stated identity does not support.' : null,
    '- The proposed edit changes the "ABOUT THE USER" blurb itself in a way that conveniently unlocks future appeals (e.g. adding "I\'m a journalist researching X") without a concrete, verifiable reason',
    '- You are not clearly persuaded — DEFAULT is to DENY',
    '',
    hasContext ? 'You will be given an "ABOUT THE USER" block describing who the user actually is — they wrote it in advance, in a calm moment, as ground truth. Treat it as authoritative. If the appeal contradicts it, default to DENY. The user wrote the about-you block specifically to stop themselves from spoofing you in the heat of the moment.' : null,
    hasContext ? '' : null,
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"approved": true|false, "reason": "1-2 sentences addressed directly to the user explaining your decision"}'
  ].filter((l) => l !== null).join('\n');

  const userContent = [
    hasContext ? 'ABOUT THE USER (the user wrote this themselves, in advance, as ground truth):' : null,
    hasContext ? personalContext.trim() : null,
    hasContext ? '' : null,
    'PROPOSED CHANGES TO THE FILTER (each bullet weakens or is unclassified):',
    renderedDiff,
    '',
    'THE USER\'S JUSTIFICATION:',
    appealText
  ].filter((l) => l !== null).join('\n');

  const data = await callAnthropic({
    apiKey,
    model: APPEAL_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 400,
    timeoutMs: 20000
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in appeal response');
  const rawText = textBlock.text.trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  const reason = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : 'No reason given.';
  return { approved: Boolean(parsed.approved), reason, rawResponse: rawText };
}

function renderDiffForPrompt(diff) {
  if (!diff || typeof diff !== 'object') return '';
  const bullets = [];

  const rules = diff.rules || {};
  for (const r of (rules.added || [])) {
    const disabledNote = (r.enabled === false) ? ', DISABLED' : '';
    bullets.push(`- ADD rule (${r.mode}${ruleScopeText(r)}${disabledNote}): "${truncate(r.text, 200)}"`);
  }
  for (const r of (rules.removed || [])) {
    const disabledNote = (r.enabled === false) ? ', was DISABLED' : '';
    bullets.push(`- REMOVE rule (${r.mode}${ruleScopeText(r)}${disabledNote}): "${truncate(r.text, 200)}"`);
  }
  for (const m of (rules.modified || [])) {
    const parts = [];
    if (m.textChanged) parts.push(`text: "${truncate(m.oldText, 120)}" -> "${truncate(m.newText, 120)}"`);
    if (m.modeChanged) parts.push(`mode: ${m.oldMode} -> ${m.newMode}`);
    if (m.scopeChanged) parts.push(`scope: [${(m.oldScope || []).join(', ') || 'all sites'}] -> [${(m.newScope || []).join(', ') || 'all sites'}]`);
    if (m.enabledChanged) parts.push(m.newEnabled ? 'ENABLED' : 'DISABLED (rule will no longer be enforced)');
    bullets.push(`- EDIT rule "${truncate(m.newText || m.oldText, 120)}": ${parts.join('; ')}`);
  }

  const settings = diff.settings || {};
  for (const key of Object.keys(settings)) {
    const { old: o, new: n } = settings[key];
    bullets.push(`- CHANGE ${key}: ${formatSettingValue(o)} -> ${formatSettingValue(n)}`);
  }

  if (diff.personalContext) {
    const oldPc = diff.personalContext.old || '';
    const newPc = diff.personalContext.new || '';
    bullets.push(`- EDIT "ABOUT THE USER" blurb:\n    BEFORE: ${truncate(oldPc, 400) || '(empty)'}\n    AFTER:  ${truncate(newPc, 400) || '(empty)'}`);
  }

  return bullets.join('\n');
}

function ruleScopeText(r) {
  if (Array.isArray(r.scope) && r.scope.length) return `, scope=[${r.scope.join(', ')}]`;
  return '';
}

function formatSettingValue(v) {
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '[empty]';
  if (v === '' || v == null) return '(empty)';
  return String(v);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function hasAppealGrant(navigationUrl) {
  const key = normalizeUrl(navigationUrl);
  if (!key) return false;
  const { [APPEAL_GRANT_KEY]: grants = {} } = await chrome.storage.local.get(APPEAL_GRANT_KEY);
  const entry = grants[key];
  if (!entry) return false;
  if (Date.now() - entry.t > APPEAL_GRANT_TTL_MS) {
    delete grants[key];
    await chrome.storage.local.set({ [APPEAL_GRANT_KEY]: grants });
    return false;
  }
  return true;
}

async function setAppealGrant(navigationUrl) {
  const key = normalizeUrl(navigationUrl);
  if (!key) return;
  const { [APPEAL_GRANT_KEY]: grants = {} } = await chrome.storage.local.get(APPEAL_GRANT_KEY);
  for (const k of Object.keys(grants)) {
    if (Date.now() - grants[k].t > APPEAL_GRANT_TTL_MS) delete grants[k];
  }
  grants[key] = { t: Date.now() };
  await chrome.storage.local.set({ [APPEAL_GRANT_KEY]: grants });
}

function cacheIdFromContent(content) {
  if (!content) return null;
  if (content.type === 'search') return `search:${content.query.toLowerCase().trim()}`;
  if (content.type === 'youtube_video') return `yt:${content.videoId}`;
  if (content.type === 'page') return 'page:' + normalizeUrl(content.url);
  return null;
}

async function invalidateCacheByPrefix(storeKey, prefix) {
  const { [storeKey]: cache = {} } = await chrome.storage.local.get(storeKey);
  let changed = false;
  for (const k of Object.keys(cache)) {
    if (k.startsWith(prefix)) {
      delete cache[k];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [storeKey]: cache });
}

// ============================================================
// Shared helpers
// ============================================================

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`timeout after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic({ apiKey, system, messages, max_tokens, model, timeoutMs }) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: model || MODEL, max_tokens, system, messages })
  }, timeoutMs || 7000);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return await res.json();
}

async function getCached(storeKey, key, ttl) {
  const { [storeKey]: cache = {} } = await chrome.storage.local.get(storeKey);
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.t > ttl) return null;
  return entry.v;
}

async function setCached(storeKey, key, value, maxEntries) {
  const { [storeKey]: cache = {} } = await chrome.storage.local.get(storeKey);
  cache[key] = { v: value, t: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > maxEntries) {
    const sorted = keys.sort((a, b) => cache[a].t - cache[b].t);
    sorted.slice(0, keys.length - maxEntries).forEach((k) => delete cache[k]);
  }
  await chrome.storage.local.set({ [storeKey]: cache });
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

const CONTENT_STRICTNESS_DIRECTIVES = {
  'very-lenient': 'STRICTNESS: very lenient. Strongly favor allowing content. Block only when content unambiguously matches a block rule; in any uncertain case, allow it. In ALLOWLIST mode, allow content that plausibly relates to any only-allow rule.',
  'lenient':      'STRICTNESS: lenient. Lean toward allowing content. When evidence is mixed, allow rather than block. In ALLOWLIST mode, give the benefit of the doubt to content that arguably fits an only-allow rule.',
  'strict':       'STRICTNESS: strict. Lean toward blocking. When a block rule plausibly applies, block. In ALLOWLIST mode, require a clear fit with an only-allow rule before allowing.',
  'very-strict':  'STRICTNESS: very strict. Strongly favor blocking. Block on any reasonable match to a block rule, even when uncertain. In ALLOWLIST mode, allow only content that clearly and primarily matches an only-allow rule.'
};

const APPEAL_STRICTNESS_DIRECTIVES = {
  'very-lenient': 'APPEAL STRICTNESS: very lenient. Overturn the block whenever the appeal is at all credible. Resolve doubt in favor of the user.',
  'lenient':      'APPEAL STRICTNESS: lenient. Favor overturning. A plausible reason from the user should usually be enough.',
  'strict':       'APPEAL STRICTNESS: strict. Default to upholding. Overturn only when the appeal clearly demonstrates a false positive or a legitimate scoped exception.',
  'very-strict':  'APPEAL STRICTNESS: very strict. Overturn only on obvious classifier errors. Treat all other appeals as the precommitted-self circumventing itself.'
};

function buildStrictnessDirective(tier, kind) {
  if (!tier || tier === 'balanced') return '';
  const map = kind === 'appeal' ? APPEAL_STRICTNESS_DIRECTIVES : CONTENT_STRICTNESS_DIRECTIVES;
  const text = map[tier];
  return text ? text + '\n' : '';
}

function buildPersonalContextBlock(personalContext) {
  const raw = (personalContext || '').trim();
  if (!raw) return '';
  const capped = raw.length > PERSONAL_CONTEXT_MAX_CHARS
    ? raw.slice(0, PERSONAL_CONTEXT_MAX_CHARS) + '…'
    : raw;
  return [
    'ABOUT THE USER (the user wrote this themselves, in advance, as ground truth):',
    capped,
    '',
    'Treat this as authoritative when interpreting whether content matches the user\'s rules. If a rule references the user\'s identity, profession, or situation, anchor it to this block.',
    ''
  ].join('\n');
}

function rand() {
  return Math.random().toString(36).slice(2, 10);
}

function splitRulesByMode(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const valid = (r) => r && r.text && r.text.trim() && r.enabled !== false;
  return {
    blockRules:     list.filter((r) => r.mode === 'block'      && valid(r)),
    allowRules:     list.filter((r) => r.mode === 'allow'      && valid(r)),
    onlyAllowRules: list.filter((r) => r.mode === 'only-allow' && valid(r))
  };
}

function hostFromContent(content) {
  if (!content) return null;
  if (content.type === 'page')          return (content.hostname || '').toLowerCase();
  if (content.type === 'youtube_video') return 'www.youtube.com';
  if (content.type === 'search')        return (content.hostname || content.engine || '').toLowerCase();
  return null;
}

function ruleAppliesToHost(rule, host) {
  if (!rule) return false;
  if (!Array.isArray(rule.scope) || rule.scope.length === 0) return true;
  if (!host) return false;
  const h = String(host).toLowerCase();
  return rule.scope.some((s) => {
    const norm = String(s || '').toLowerCase().trim();
    if (!norm) return false;
    if (h === norm || h.endsWith('.' + norm)) return true;
    // Bare-word entry (e.g. "youtube"): match if any host label equals it.
    if (!norm.includes('.')) return h.split('.').includes(norm);
    return false;
  });
}
