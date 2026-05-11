// Background service worker. Handles three classification request types:
//  - check       → page/search/youtube classification (Layer 0)
//  - classifyImage → NSFW image check via Claude vision (Layer 1)
//  - classifyPosts → batch text classification of feed posts (Layer 3)

const CACHE_KEY = 'aisf-cache';
const CACHE_VERSION_KEY = 'aisf-cache-version';
const CACHE_VERSION = 2; // bump when callClaudeForContext / callClaudeForPosts prompt changes meaningfully
const IMG_CACHE_KEY = 'aisf-img-cache';
const IMG_CACHE_VERSION_KEY = 'aisf-img-cache-version';
const IMG_CACHE_VERSION = 2; // bump when callClaudeForImage prompt changes meaningfully
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const IMG_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days for images
const MAX_CACHE_ENTRIES = 2000;
const MAX_IMG_CACHE = 5000;
const MODEL = 'claude-haiku-4-5-20251001';
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'check') {
    checkContent(msg.content).then(sendResponse).catch((err) => {
      console.error('[AISF] check threw:', err);
      sendResponse({ blocked: false, reason: 'internal-error', error: String(err) });
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

async function checkContent(content) {
  if (DEBUG) console.log('[AISF] checkContent', content);
  const stored = await chrome.storage.local.get(['apiKey', 'rules', 'blocklist', 'failMode']);
  const apiKey = stored.apiKey || '';
  const failMode = stored.failMode || 'open';

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
  const rulesHash = hashStr(JSON.stringify(hashSource));
  const cacheKey = `${cacheId}::${rulesHash}`;

  const cached = await getCached(CACHE_KEY, cacheKey, CACHE_TTL_MS);
  if (cached) return { ...cached, fromCache: true };

  try {
    const decision = await callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey);
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

async function callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey) {
  const blockListText = blockRules.length
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';

  const systemPrompt = onlyAllowRules.length > 0 ? [
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
    '4. Otherwise -> blocked=true, matchedRule=null, reason = "did not match any only-allow rule".',
    '',
    'Be reasonable: educational/news content ABOUT a topic in an only-allow rule counts as a match. Do not invent matches — if it is truly unrelated, block it.',
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "one-sentence explanation, required"}'
  ].join('\n') : [
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
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "one-sentence explanation, required"}'
  ].join('\n');

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
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
// Layer 3: batch post text classification
// ============================================================

async function classifyPosts(posts, hostname) {
  if (!Array.isArray(posts) || posts.length === 0) return { verdicts: [] };

  const stored = await chrome.storage.local.get(['apiKey', 'rules', 'enablePostScanner']);
  if (!stored.apiKey || !stored.enablePostScanner) return { verdicts: [] };

  const host = (hostname || '').toLowerCase();
  const scopedRules = (Array.isArray(stored.rules) ? stored.rules : []).filter((r) => ruleAppliesToHost(r, host));
  const { blockRules, allowRules, onlyAllowRules } = splitRulesByMode(scopedRules);

  if (blockRules.length === 0 && onlyAllowRules.length === 0) return { verdicts: [] };

  try {
    const verdicts = await callClaudeForPosts(posts, blockRules, allowRules, onlyAllowRules, stored.apiKey);
    return { verdicts };
  } catch (e) {
    console.error('[AISF] classifyPosts failed:', e);
    return { verdicts: [], error: String(e && e.message || e) };
  }
}

async function callClaudeForPosts(posts, blockRules, allowRules, onlyAllowRules, apiKey) {
  const blockListText = blockRules.length
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
    : '(none)';

  const systemPrompt = onlyAllowRules.length > 0 ? [
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
    system: systemPrompt,
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

async function callAnthropic({ apiKey, system, messages, max_tokens }) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages })
  }, 7000);
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

function rand() {
  return Math.random().toString(36).slice(2, 10);
}

function splitRulesByMode(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const valid = (r) => r && r.text && r.text.trim();
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
    return h === norm || h.endsWith('.' + norm);
  });
}
