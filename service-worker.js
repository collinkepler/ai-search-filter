// Background service worker. Handles three classification request types:
//  - check       → page/search/youtube classification (Layer 0)
//  - classifyImage → NSFW image check via Claude vision (Layer 1)
//  - classifyPosts → batch text classification of feed posts (Layer 3)

const CACHE_KEY = 'aisf-cache';
const CACHE_VERSION_KEY = 'aisf-cache-version';
const CACHE_VERSION = 12; // bump when callClaudeForContext / callClaudeForPosts prompt changes meaningfully
const IMG_CACHE_KEY = 'aisf-img-cache';
const IMG_CACHE_VERSION_KEY = 'aisf-img-cache-version';
const IMG_CACHE_VERSION = 3; // bump when callClaudeForImage prompt changes meaningfully
const HOST_SKIP_CACHE_KEY = 'aisf-host-skip-cache';
const HOST_SKIP_CACHE_VERSION_KEY = 'aisf-host-skip-cache-version';
const HOST_SKIP_CACHE_VERSION = 2; // bump when classifyHostNeedsImageScan prompt changes meaningfully
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
const UNVERIFIED_DEFAULT_MIGRATION_KEY = 'aisf-image-unverified-default-reveal-v1';
const USAGE_COUNTS_KEY = 'aisf-usage-counts';
const USAGE_TIME_KEY = 'aisf-usage-time';

const NON_USER_POLICY_GUARD = [
  'Important boundary: classify only against the user-provided rules.',
  'Do not enforce or mention outside policies such as copyright, piracy, illegal streaming, legality, morality, platform terms, or website reputation unless a user rule explicitly names that topic.',
  'For a porn/sexual-content rule, a movie or TV streaming site being unauthorized, pirated, or legally questionable is irrelevant. Block only when the page/query/post itself has sexual or pornographic evidence matching the rule.'
].join('\n');

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

// One-time: unverified images used to default to hiding. That made protected movie
// poster/CDN thumbnails disappear even when the image scanner had no NSFW verdict.
(async () => {
  try {
    const { [UNVERIFIED_DEFAULT_MIGRATION_KEY]: done, imageUnverifiedAction } =
      await chrome.storage.local.get([UNVERIFIED_DEFAULT_MIGRATION_KEY, 'imageUnverifiedAction']);
    if (!done) {
      if (!imageUnverifiedAction || imageUnverifiedAction === 'hide') {
        await chrome.storage.local.set({ imageUnverifiedAction: 'reveal' });
        if (DEBUG) console.log('[AISF] image unverified default changed to reveal');
      }
      await chrome.storage.local.set({ [UNVERIFIED_DEFAULT_MIGRATION_KEY]: true });
    }
  } catch (e) { console.warn('[AISF] image unverified migration failed:', e); }
})();

// One-time: the default Content strictness was raised from 'balanced' to 'strict'.
// Bring installs still on the old default (or unset) up to the new default.
const STRICTNESS_DEFAULT_MIGRATION_KEY = 'aisf-content-strictness-default-v2';
(async () => {
  try {
    const { [STRICTNESS_DEFAULT_MIGRATION_KEY]: done, contentStrictness: cs } =
      await chrome.storage.local.get([STRICTNESS_DEFAULT_MIGRATION_KEY, 'contentStrictness']);
    if (!done) {
      if (!cs || cs === 'balanced') {
        await chrome.storage.local.set({ contentStrictness: 'strict' });
        if (DEBUG) console.log('[AISF] content strictness default raised to strict');
      }
      await chrome.storage.local.set({ [STRICTNESS_DEFAULT_MIGRATION_KEY]: true });
    }
  } catch (e) { console.warn('[AISF] strictness default migration failed:', e); }
})();

// One-time: seed the strict anti-sexual-content block rule so it is on by default.
// Text must stay in sync with STRICT_PRESET_RULES in options.js. Guarded by a key so
// it runs exactly once — a user who later deletes the rule keeps it deleted.
const STRICT_PRESET_RULE_TEXT =
  'Anything someone would seek out, look for, or look at to find any sort of sexual pleasure or sexual stimulation';
const STRICT_PRESET_SEED_MIGRATION_KEY = 'aisf-strict-sexual-preset-seed-v1';
(async () => {
  try {
    const { [STRICT_PRESET_SEED_MIGRATION_KEY]: done } =
      await chrome.storage.local.get(STRICT_PRESET_SEED_MIGRATION_KEY);
    if (done) return;

    const stored = await chrome.storage.local.get(['rules', 'blocklist']);
    let rules = Array.isArray(stored.rules) ? stored.rules : null;
    if (!rules && typeof stored.blocklist === 'string' && stored.blocklist.trim()) {
      rules = stored.blocklist.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((text) => ({ id: rand(), text, mode: 'block' }));
      await chrome.storage.local.remove('blocklist');
    }
    if (!rules) rules = [];

    const present = rules.some((r) => r && (r.text || '').trim() === STRICT_PRESET_RULE_TEXT);
    if (!present) {
      rules.push({ id: rand(), text: STRICT_PRESET_RULE_TEXT, mode: 'block' });
      if (DEBUG) console.log('[AISF] seeded strict anti-sexual-content block rule');
    }
    await chrome.storage.local.set({ rules, [STRICT_PRESET_SEED_MIGRATION_KEY]: true });
  } catch (e) { console.warn('[AISF] strict preset seed migration failed:', e); }
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

  if (msg.type === 'applyAppealFix') {
    applyAppealFix(msg.rule).then(sendResponse).catch((err) => {
      console.error('[AISF] applyAppealFix threw:', err);
      sendResponse({ ok: false, error: String(err && err.message || err) });
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

  if (msg.type === 'time-heartbeat') {
    (async () => {
      try {
        const exceeded = [];
        for (const ruleId of (msg.ruleIds || [])) {
          const r = await accumulateTime(ruleId, msg.intervalMs || 30000);
          if (r.exceeded) exceeded.push(ruleId);
        }
        sendResponse({ exceededRuleIds: exceeded });
      } catch (err) {
        console.error('[AISF] time-heartbeat threw:', err);
        sendResponse({ exceededRuleIds: [] });
      }
    })();
    return true;
  }

  if (msg.type === 'get-time-status') {
    (async () => {
      try {
        const { usageLimits = [] } = await chrome.storage.local.get('usageLimits');
        const { [USAGE_TIME_KEY]: raw = {} } = await chrome.storage.local.get(USAGE_TIME_KEY);
        const result = {};
        for (const rule of (usageLimits || []).filter((r) => r.type === 'time')) {
          result[rule.id] = ((raw[rule.id] || {})[usagePeriodKey(rule.period)]) || 0;
        }
        sendResponse(result);
      } catch (err) {
        console.error('[AISF] get-time-status threw:', err);
        sendResponse({});
      }
    })();
    return true;
  }

  if (msg.type === 'get-usage-counts') {
    (async () => {
      try {
        const { usageLimits = [] } = await chrome.storage.local.get('usageLimits');
        const { [USAGE_COUNTS_KEY]: raw = {} } = await chrome.storage.local.get(USAGE_COUNTS_KEY);
        const result = {};
        for (const rule of (usageLimits || []).filter((r) => r.type !== 'time')) {
          const key = usagePeriodKey(rule.period);
          result[rule.id] = Array.isArray((raw[rule.id] || {})[key]) ? (raw[rule.id] || {})[key].length : 0;
        }
        sendResponse(result);
      } catch (err) {
        console.error('[AISF] get-usage-counts threw:', err);
        sendResponse({});
      }
    })();
    return true;
  }
});

// ============================================================
// Usage Limits helpers
// ============================================================

function matchesUsagePattern(pattern, url) {
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

function usagePeriodKey(period) {
  const d = new Date();
  if (period === 'week') {
    const day = d.getDay() || 7;
    const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
    const wk = Math.floor((mon - new Date(mon.getFullYear(), 0, 1)) / 604800000) + 1;
    return `${mon.getFullYear()}-W${String(wk).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkUsageEntry(ruleId, limit, period, navigationUrl) {
  const key = usagePeriodKey(period);
  const urlHash = hashStr(normalizeUrl(navigationUrl));
  const { [USAGE_COUNTS_KEY]: raw = {} } = await chrome.storage.local.get(USAGE_COUNTS_KEY);
  const todaySet = Array.isArray((raw[ruleId] || {})[key]) ? (raw[ruleId] || {})[key] : [];
  if (todaySet.includes(urlHash)) return { outcome: 'already-seen', count: todaySet.length };
  if (todaySet.length >= limit) return { outcome: 'limit-hit', count: todaySet.length };
  return { outcome: 'ok', count: todaySet.length, meta: { raw, ruleId, key, urlHash, todaySet } };
}

async function recordUsageEntry({ raw, ruleId, key, urlHash, todaySet }) {
  await chrome.storage.local.set({ [USAGE_COUNTS_KEY]: { ...raw, [ruleId]: { [key]: [...todaySet, urlHash] } } });
}

async function accumulateTime(ruleId, intervalMs) {
  const { usageLimits = [] } = await chrome.storage.local.get('usageLimits');
  const rule = (usageLimits || []).find((r) => r.id === ruleId);
  if (!rule || !rule.enabled) return { exceeded: false };
  const key = usagePeriodKey(rule.period);
  const { [USAGE_TIME_KEY]: raw = {} } = await chrome.storage.local.get(USAGE_TIME_KEY);
  const prev = ((raw[ruleId] || {})[key]) || 0;
  const next = prev + intervalMs;
  await chrome.storage.local.set({ [USAGE_TIME_KEY]: { ...raw, [ruleId]: { [key]: next } } });
  return { exceeded: next >= rule.limit * 60000, spent: next };
}

// ============================================================
// Layer 0: page/search/youtube classification
// ============================================================

async function checkContent(content, navigationUrl) {
  if (DEBUG) console.log('[AISF] checkContent', content);

  const granted = navigationUrl ? await hasAppealGrant(navigationUrl) : false;
  if (granted) {
    // Stale blocked verdicts are purged at appeal time (handleAppeal), which also
    // writes an allowed verdict — invalidating here would delete that fresh entry.
    if (DEBUG) console.log('[AISF] checkContent: appeal grant honored for', navigationUrl);
    return { blocked: false, reason: 'appeal-granted' };
  }

  // Usage limits: visit type (no AI needed — purely URL-pattern-based)
  let visitMeta = null;
  if (navigationUrl) {
    const { usageLimits: ul = [] } = await chrome.storage.local.get('usageLimits');
    for (const rule of (ul || []).filter((r) => r.enabled && r.type === 'visit' && matchesUsagePattern(r.pattern, navigationUrl))) {
      const ep = await checkUsageEntry(rule.id, rule.limit, rule.period, navigationUrl);
      if (ep.outcome === 'limit-hit') {
        const period = rule.period === 'week' ? 'weekly' : 'daily';
        const resets = rule.period === 'week' ? 'next Monday' : 'at midnight';
        return {
          blocked: true,
          matchedRule: `Usage limit: ${rule.label}`,
          reason: `You've opened ${ep.count} of your ${rule.limit} allowed ${period} visit${rule.limit === 1 ? '' : 's'}. Resets ${resets}.`
        };
      }
      if (ep.outcome === 'ok' && !visitMeta) visitMeta = ep.meta;
    }
  }

  const stored = await chrome.storage.local.get(['apiKey', 'rules', 'blocklist', 'failMode', 'personalContext', 'personalContextOnHotPaths', 'contentStrictness', 'usageLimits']);
  const apiKey = stored.apiKey || '';
  const failMode = stored.failMode || 'open';
  const useOnHotPaths = stored.personalContextOnHotPaths !== false; // default ON
  const personalContext = useOnHotPaths ? (stored.personalContext || '').trim() : '';
  const contentStrictness = stored.contentStrictness || 'strict';
  const aiGoalRules = (stored.usageLimits || []).filter((r) => r.enabled && r.type === 'ai-goal');

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

  if (!apiKey || (blockRules.length === 0 && onlyAllowRules.length === 0 && aiGoalRules.length === 0)) {
    if (visitMeta) await recordUsageEntry(visitMeta);
    return { blocked: false, reason: 'not-configured' };
  }

  let context, cacheId;
  try {
    const built = await buildContext(content);
    if (!built) {
      if (visitMeta) await recordUsageEntry(visitMeta);
      return { blocked: false, reason: 'no-context' };
    }
    context = built.context;
    cacheId = built.cacheId;
  } catch (e) {
    return { blocked: failMode === 'closed', reason: 'context-error', error: String(e && e.message || e) };
  }

  const ruleForHash = (r) => {
    const obj = { t: r.text, s: r.scope || [] };
    if (r.strictness) obj.st = r.strictness;
    return obj;
  };
  const hashSource = {
    b: blockRules.map(ruleForHash),
    a: allowRules.map(ruleForHash)
  };
  if (onlyAllowRules.length) hashSource.oa = onlyAllowRules.map(ruleForHash);
  if (personalContext) hashSource.pc = hashStr(personalContext);
  if (contentStrictness && contentStrictness !== 'balanced') hashSource.cs = contentStrictness;
  if (aiGoalRules.length) hashSource.ag = aiGoalRules.map((r) => ({ id: r.id, label: r.label }));
  const rulesHash = hashStr(JSON.stringify(hashSource));
  const cacheKey = `${cacheId}::${rulesHash}`;

  const cached = await getCached(CACHE_KEY, cacheKey, CACHE_TTL_MS);
  if (cached) {
    if (cached.blocked && navigationUrl) {
      const { usageLimits: ul2 = [] } = await chrome.storage.local.get('usageLimits');
      for (const rule of (ul2 || []).filter((r) => r.enabled && r.type === 'ai-match' && matchesUsagePattern(r.pattern, navigationUrl))) {
        const ep = await checkUsageEntry(rule.id, rule.limit, rule.period, navigationUrl);
        if (ep.outcome === 'already-seen') { if (visitMeta) await recordUsageEntry(visitMeta); return { blocked: false, reason: `usage-limit-grace:${rule.id}`, fromCache: true }; }
        if (ep.outcome === 'ok') { await recordUsageEntry(ep.meta); if (visitMeta) await recordUsageEntry(visitMeta); return { blocked: false, reason: `usage-limit-grace:${rule.id}`, fromCache: true }; }
      }
    }
    // AI-goal limits: re-evaluate the goal count on every cache hit (limits reset daily/weekly)
    if (navigationUrl && Array.isArray(cached.matchedGoalIds) && cached.matchedGoalIds.length) {
      for (const goalId of cached.matchedGoalIds) {
        const goalRule = aiGoalRules.find((r) => r.id === goalId);
        if (!goalRule) continue;
        const ep = await checkUsageEntry(goalRule.id, goalRule.limit, goalRule.period, navigationUrl);
        if (ep.outcome === 'limit-hit') {
          const resets = goalRule.period === 'week' ? 'next Monday' : 'at midnight';
          return { blocked: true, matchedRule: `Goal limit: ${goalRule.label}`, reason: `You've reached your ${goalRule.period === 'week' ? 'weekly' : 'daily'} limit of ${goalRule.limit} for: ${goalRule.label}. Resets ${resets}.`, fromCache: true };
        }
        if (ep.outcome === 'ok') await recordUsageEntry(ep.meta);
      }
    }
    if (visitMeta && !cached.blocked) await recordUsageEntry(visitMeta);
    return { ...cached, fromCache: true, cacheKey };
  }

  try {
    const decision = await callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey, personalContext, contentStrictness, aiGoalRules);

    // AI-match limits: override Claude's block verdict if the user still has grace budget
    if (decision.blocked && navigationUrl) {
      const { usageLimits: ul3 = [] } = await chrome.storage.local.get('usageLimits');
      for (const rule of (ul3 || []).filter((r) => r.enabled && r.type === 'ai-match' && matchesUsagePattern(r.pattern, navigationUrl))) {
        const ep = await checkUsageEntry(rule.id, rule.limit, rule.period, navigationUrl);
        if (ep.outcome === 'already-seen') {
          if (visitMeta) await recordUsageEntry(visitMeta);
          await setCached(CACHE_KEY, cacheKey, decision, MAX_CACHE_ENTRIES);
          return { blocked: false, reason: `usage-limit-grace:${rule.id}` };
        }
        if (ep.outcome === 'ok') {
          await recordUsageEntry(ep.meta);
          if (visitMeta) await recordUsageEntry(visitMeta);
          await setCached(CACHE_KEY, cacheKey, decision, MAX_CACHE_ENTRIES);
          return { blocked: false, reason: `usage-limit-grace:${rule.id}` };
        }
        // 'limit-hit' → fall through, enforce the block
      }
    }

    // AI-goal limits: check if this page satisfied any goals and enforce their budgets
    if (navigationUrl && decision.matchedGoalIds && decision.matchedGoalIds.length) {
      for (const goalId of decision.matchedGoalIds) {
        const goalRule = aiGoalRules.find((r) => r.id === goalId);
        if (!goalRule) continue;
        const ep = await checkUsageEntry(goalRule.id, goalRule.limit, goalRule.period, navigationUrl);
        if (ep.outcome === 'limit-hit') {
          // Cache the content decision (with matchedGoalIds) so future hits re-evaluate the count.
          // Do NOT cache this as blocked:true — the goal limit resets and the block.html flow differs.
          await setCached(CACHE_KEY, cacheKey, decision, MAX_CACHE_ENTRIES);
          const resets = goalRule.period === 'week' ? 'next Monday' : 'at midnight';
          return { blocked: true, matchedRule: `Goal limit: ${goalRule.label}`, reason: `You've reached your ${goalRule.period === 'week' ? 'weekly' : 'daily'} limit of ${goalRule.limit} for: ${goalRule.label}. Resets ${resets}.`, cacheKey };
        }
        if (ep.outcome === 'ok') await recordUsageEntry(ep.meta);
      }
    }

    await setCached(CACHE_KEY, cacheKey, decision, MAX_CACHE_ENTRIES);
    if (visitMeta && !decision.blocked) await recordUsageEntry(visitMeta);
    return { ...decision, cacheKey };
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

async function callClaudeForContext(context, blockRules, allowRules, onlyAllowRules, apiKey, personalContext, contentStrictness, aiGoalRules = []) {
  const blockListText = blockRules.length
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';

  const contextBlock = buildPersonalContextBlock(personalContext);
  const strictnessDirective = buildStrictnessDirective(contentStrictness, 'content');
  const overrideExplanation = anyRuleHasStrictness(blockRules, allowRules, onlyAllowRules)
    ? 'Rules annotated with [strictness: <tier>] override the global strictness for that rule only.'
    : '';

  const goalSection = aiGoalRules.length > 0 ? [
    '',
    'GOAL TRACKING:',
    'In addition to the block/allow verdict, determine whether this page satisfies any of the following user goals. Add a "matchedGoalIds" array to your JSON response with IDs of goals this page satisfies (empty array if none). A goal is satisfied when the page\'s primary content or purpose clearly fulfills it — e.g. "watch an episode of a TV show" is satisfied by an episode page on any streaming site, but not a homepage, trailer, or search page.',
    'Goals:',
    ...aiGoalRules.map((r) => `- ID "${r.id}": "${r.label}"`),
  ] : [];

  const systemPrompt = onlyAllowRules.length > 0 ? [
    contextBlock,
    strictnessDirective,
    overrideExplanation,
    'You classify web content against the user\'s rules.',
    NON_USER_POLICY_GUARD,
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
    'The reason must explain specifically why matchedRule applies to this content. Do not mention or reference any other rule — even if the content could have triggered one.',
    '',
    'Be reasonable: educational/news content ABOUT a topic in an only-allow rule counts as a match. Do not invent matches — if it is truly unrelated, block it.',
    '',
    'Judge only the page\'s subject matter against the rule text. Do not factor in whether the site appears to involve piracy, illegal streaming, copyright infringement, scams, or anything you personally consider harmful or unethical — none of that affects rule matching unless a rule explicitly names it. A page whose topic matches an only-allow rule is allowed even if the site itself is one you would personally avoid; the reason field must cite the actual rule fit, never the site\'s legality.',
    ...goalSection,
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    `{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "1-2 sentence substantive explanation, required"${aiGoalRules.length > 0 ? ', "matchedGoalIds": []' : ''}}`
  ].join('\n') : [
    contextBlock,
    strictnessDirective,
    overrideExplanation,
    'You classify web content against the user\'s rules.',
    NON_USER_POLICY_GUARD,
    '',
    'BLOCK rules:',
    blockListText,
    '',
    'ALLOW rules (override block rules):',
    allowListText,
    '',
    'Process: allow > block > default-allow. Be reasonable; educational/recovery/news content ABOUT a blocked topic is usually allowed.',
    'The reason field must explain specifically why matchedRule applies to this content. Do not mention or reference any other rule — even if the content could have triggered one.',
    '',
    'Classify the page ONLY against the rules above — they are the sole authority. Do NOT block a page for any reason the user did not list. In particular, do not block it because the site appears to involve piracy, illegal streaming, copyright infringement, scams, malware, or because you personally consider it harmful, unsafe, sketchy, or unethical — those judgments are not yours to make here. If no block rule matches the page\'s actual subject matter, you MUST return blocked=false, even for a site you would personally avoid.',
    '',
    'When a rule describes content by the purpose it serves or the impulse it satisfies — whether phrased in the first person ("block things I\'d look up if I was X") or generally ("block anything someone would search for to find Y") — treat any search query or page that plausibly serves that purpose as a match, even when the wording is mild, euphemistic, or indirect. Such a rule is a precommitment by the user against their own weaker moments; on ambiguous or borderline cases, err toward honoring it. Apply it consistently: if one query matches the rule, near-synonyms and paraphrases of that query must receive the same verdict. This overrides the educational/news carve-out only for such intent-phrased rules.',
    ...goalSection,
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    `{"blocked": true|false, "matchedRule": "exact rule text or null", "reason": "one-sentence explanation, required"${aiGoalRules.length > 0 ? ', "matchedGoalIds": []' : ''}}`
  ].join('\n');

  const data = await callAnthropic({
    apiKey,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: context }],
    max_tokens: aiGoalRules.length > 0 ? 400 : 300
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in API response');
  const rawText = textBlock.text.trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  const matchedRule = (typeof parsed.matchedRule === 'string' && parsed.matchedRule.trim()) ? parsed.matchedRule.trim() : null;
  const reason = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : null;
  const matchedGoalIds = Array.isArray(parsed.matchedGoalIds) ? parsed.matchedGoalIds.filter((id) => typeof id === 'string') : [];
  return { blocked: Boolean(parsed.blocked), matchedRule, category: matchedRule, reason, matchedGoalIds, rawResponse: rawText };
}

// ============================================================
// Layer 1: image NSFW classification via vision
// ============================================================

async function classifyImage(imageUrl) {
  if (!imageUrl) return { nsfw: false, reason: 'no-url' };

  const { apiKey = '', enableImageScanner = true, imageStrictness } =
    await chrome.storage.local.get(['apiKey', 'enableImageScanner', 'imageStrictness']);
  if (!apiKey || enableImageScanner === false) return { nsfw: false, reason: 'disabled' };

  const strictness = IMAGE_STRICTNESS_DIRECTIVES[imageStrictness] !== undefined ? imageStrictness : 'strict';

  // Strictness is folded into the cache key so flipping the setting re-classifies,
  // the same way the Layer 0 key folds in the rules hash.
  const cacheKey = 'img:' + strictness + ':' + hashStr(imageUrl);
  const cached = await getCached(IMG_CACHE_KEY, cacheKey, IMG_CACHE_TTL_MS);
  if (cached) return { ...cached, fromCache: true };

  try {
    const result = await callClaudeForImage(imageUrl, apiKey, strictness);
    await setCached(IMG_CACHE_KEY, cacheKey, result, MAX_IMG_CACHE);
    return result;
  } catch (e) {
    console.warn('[AISF] image classify failed:', e);
    const msg = String(e && e.message || e);
    // A 400 from the API on an image-classify call means Claude could not fetch or
    // decode the image URL (hotlink-protected CDNs, dead URLs), so let the content
    // script apply the user's unverified-image fallback. 401/403/429/5xx/network
    // errors are our infra, not the image, so leave failClosed unset (fail open).
    // The catch path does not setCached, so failClosed verdicts retry next visit.
    const failClosed = msg.includes('API 400');
    return { nsfw: false, failClosed, error: msg };
  }
}

// Builds the Anthropic image source block. http(s) URLs are fetched server-side;
// data: URIs already carry the bytes inline, so we forward them as base64.
function buildImageSource(imageUrl) {
  if (imageUrl.startsWith('data:')) {
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(imageUrl);
    if (!m) throw new Error('unsupported data URI');
    let mediaType = m[1].toLowerCase();
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
    const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!SUPPORTED.includes(mediaType)) throw new Error('unsupported media type: ' + mediaType);
    return { type: 'base64', media_type: mediaType, data: m[2] };
  }
  return { type: 'url', url: imageUrl };
}

async function callClaudeForImage(imageUrl, apiKey, strictness) {
  const strictnessDirective = IMAGE_STRICTNESS_DIRECTIVES[strictness] || '';
  const systemPrompt =
    (strictnessDirective ? strictnessDirective + '\n\n' : '') +
    'You are a strict image classifier. The user does not want to see sexual content of ANY kind, including suggestive imagery — not just explicit pornography.\n\n' +
    'Categories (pick the most specific that applies):\n' +
    '- "porn": pornography, nudity, sex acts, exposed genitals, exposed breasts, masturbation, explicit sexual imagery\n' +
    '- "suggestive": sexually suggestive but not explicit. Includes: ANY person in a bikini, swimsuit, lingerie, or underwear (regardless of setting — beach, family, vacation, or casual all count); sheer or tight clothing emphasizing the body, cleavage as a focal point, lower-body / butt close-ups, "thirst trap" framing, sexualized fitness/gym content, implied-nude posing, partial nudity, sexually suggestive cartoon/anime art, OnlyFans-style promotional images\n' +
    '- "violence": graphic violence, gore, injury\n' +
    '- "none": safe for general viewing — people fully clothed in ordinary attire, landscapes, objects, screenshots, diagrams, memes without sexual content, etc.\n\n' +
    'Rules:\n' +
    '- Both "porn" AND "suggestive" return nsfw=true. Only "none" and "violence" return nsfw=false (violence is tracked separately but does not trigger NSFW for this user).\n' +
    '- Be conservative on sexual content: if you are uncertain, choose "suggestive" rather than "none".\n' +
    '- Do NOT exempt swimwear because of context: a bikini or swimsuit on a person is "suggestive" whether the photo is a posed glamour shot or a casual beach snapshot. The user wants all of it filtered.\n\n' +
    'Respond ONLY with JSON, no prose:\n' +
    '{"nsfw": true|false, "category": "porn"|"suggestive"|"violence"|"none", "confidence": 0.0-1.0}';

  const data = await callAnthropic({
    apiKey,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: buildImageSource(imageUrl) },
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

  const { apiKey = '', enableImageScanner = true } = await chrome.storage.local.get(['apiKey', 'enableImageScanner']);
  if (!apiKey || enableImageScanner === false) return { skip: false, reason: 'disabled' };

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
    '- The site is a search engine, image search, or result aggregator (google.com, bing.com, duckduckgo.com, yahoo.com, yandex.com, baidu.com, brave.com, ecosia.org). These surface arbitrary images from across the entire web, including NSFW thumbnails — NEVER skip them.\n' +
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
  const contentStrictness = stored.contentStrictness || 'strict';

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
    ? blockRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';
  const allowListText = allowRules.length
    ? allowRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';
  const onlyAllowListText = onlyAllowRules.length
    ? onlyAllowRules.map((r, i) => `${i + 1}. ${r.text}${ruleStrictnessText(r)}`).join('\n')
    : '(none)';

  const contextBlock = buildPersonalContextBlock(personalContext);
  const strictnessDirective = buildStrictnessDirective(contentStrictness, 'content');
  const overrideExplanation = anyRuleHasStrictness(blockRules, allowRules, onlyAllowRules)
    ? 'Rules annotated with [strictness: <tier>] override the global strictness for that rule only.'
    : '';

  const systemPrompt = onlyAllowRules.length > 0 ? [
    contextBlock,
    strictnessDirective,
    overrideExplanation,
    'You classify a list of social media / feed posts against the user\'s rules.',
    NON_USER_POLICY_GUARD,
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
    overrideExplanation,
    'You classify a list of social media / feed posts against the user\'s rules.',
    NON_USER_POLICY_GUARD,
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
    'When a rule describes content by the purpose it serves or the impulse it satisfies (whether phrased "things I\'d look up if I was X" or "anything someone would seek out for Y"), treat any post that plausibly serves that purpose as a match, even when the wording is mild or euphemistic, and apply it consistently across near-synonyms. Such a rule is a precommitment — err toward honoring it on borderline cases.',
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

async function handleAppeal({ originalUrl, query, matchedRule, originalReason, appealText, cacheKey }) {
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
    // Grant stays as a 1-hour fallback for blocks without a cacheKey (e.g. usage limits).
    await setAppealGrant(originalUrl);
    if (typeof cacheKey === 'string' && cacheKey.includes('::')) {
      // Purge the stale blocked verdict (all rules-hash variants), then persist the
      // overturn as a normal allowed verdict so the page stays unblocked for the
      // standard cache lifetime instead of just the grant window. Rule edits
      // invalidate it like any other verdict.
      await invalidateCacheByPrefix(CACHE_KEY, cacheKey.split('::')[0] + '::');
      await setCached(CACHE_KEY, cacheKey, {
        blocked: false,
        matchedRule: null,
        category: null,
        reason: 'Appeal granted: ' + decision.reason,
        appealOverturned: true
      }, MAX_CACHE_ENTRIES);
      if (DEBUG) console.log('[AISF] appeal overturn cached for', cacheKey);
    }
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
    '- Outside-policy error: the block was based on piracy, copyright, illegal streaming, legality, platform terms, or website reputation, and the matched user rule did not explicitly name that topic',
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
    'RULE-FIX SUGGESTION (the "fix" field):',
    'When you overturn AND the false positive looks like a recurring pattern (the rule will keep wrongly matching this kind of content), also propose a minimal exception rule the user can choose to add. It becomes an allow-mode rule that force-allows matching content even when a block rule fires, so word it NARROWLY: it must cover only the false-positive class, never gut the original rule (e.g. for a "gambling" rule wrongly blocking game journalism: "news and reviews about video games that mention loot boxes or in-game purchases").',
    'Set "scope" to the relevant bare hostname(s) (e.g. ["example.com"]) when the problem is specific to a site; use [] when the false-positive class is site-independent (e.g. search queries).',
    'Set fix to null when you uphold, when the overturn is a one-off scoped exception (a single work/research/safety need rather than a misfiring rule), or when you cannot word an exception that would not weaken the rule.',
    '',
    'Respond with ONLY valid JSON, no fences or prose:',
    '{"overturned": true|false, "reason": "1-2 sentences addressed directly to the user explaining your decision", "fix": {"text": "narrow allow-rule text", "scope": ["host.com"]} | null}'
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
    max_tokens: 600,
    timeoutMs: 20000
  });

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in appeal response');
  const rawText = textBlock.text.trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  const reason = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : 'No reason given.';
  let suggestedFix = null;
  if (parsed.overturned && parsed.fix && typeof parsed.fix === 'object' &&
      typeof parsed.fix.text === 'string' && parsed.fix.text.trim()) {
    suggestedFix = {
      text: parsed.fix.text.trim().slice(0, 300),
      scope: Array.isArray(parsed.fix.scope)
        ? parsed.fix.scope.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
        : []
    };
  }
  return { overturned: Boolean(parsed.overturned), reason, suggestedFix, rawResponse: rawText };
}

// Applies a Sonnet-suggested exception rule from a granted appeal. The weakening was
// already adjudicated by the strict appeal review and the rule text comes from Sonnet,
// not the user, so this does not go through the rule-change appeal gate.
async function applyAppealFix(rule) {
  const text = (rule && typeof rule.text === 'string') ? rule.text.trim().slice(0, 300) : '';
  if (!text) return { ok: false, error: 'No rule text provided.' };
  const scope = (rule && Array.isArray(rule.scope))
    ? rule.scope.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
    : [];

  const stored = await chrome.storage.local.get(['rules', 'blocklist']);
  let rules = Array.isArray(stored.rules) ? stored.rules : null;
  if (!rules && typeof stored.blocklist === 'string' && stored.blocklist.trim()) {
    rules = stored.blocklist.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((t) => ({ id: rand(), text: t, mode: 'block' }));
    await chrome.storage.local.remove('blocklist');
  }
  if (!rules) rules = [];

  const exists = rules.some((r) => r && r.mode === 'allow' && r.enabled !== false && (r.text || '').trim() === text);
  if (exists) return { ok: true, dedup: true };

  rules.push({ id: rand(), text, mode: 'allow', enabled: true, scope });
  await chrome.storage.local.set({ rules });
  await chrome.storage.local.remove(CACHE_KEY); // rules changed — mirror options.js Save
  if (DEBUG) console.log('[AISF] appeal fix applied: allow rule added:', text, scope);
  return { ok: true };
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

function ruleStrictnessText(r) {
  return r.strictness ? ` [strictness: ${r.strictness}]` : '';
}

function anyRuleHasStrictness(...lists) {
  return lists.some((l) => l.some((r) => r.strictness));
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

// Layer 1 image-scanner strictness tiers. Prepended to the callClaudeForImage prompt.
// 'strict' is the default and matches the base prompt as-is (no extra directive).
const IMAGE_STRICTNESS_DIRECTIVES = {
  'standard': 'STRICTNESS: standard. Apply context — a swimsuit in a clearly non-sexualized setting (a family beach scene, children, or athletes mid-competition in standard sport attire) is "none"; only posed / sex-appeal framing is "suggestive". This overrides the "do NOT exempt swimwear" rule below.',
  'strict':   '',
  'maximum':  'STRICTNESS: maximum. In addition to the rules below, also treat bare midriffs, visible cleavage as a focal point, shirtless people, very short shorts, and skin-revealing activewear or gym wear as "suggestive". Block on essentially any notable skin exposure.'
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
