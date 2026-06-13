const $ = (id) => document.getElementById(id);

let rules = [];
let usageLimitRules = [];
const expandedUsageIds = new Set();

const SETTINGS_STORAGE_KEYS = [
  'apiKey', 'rules', 'failMode', 'allowDomains', 'imageScannerExcludeDomains',
  'enableSiteFilters', 'enableImageScanner', 'enablePostScanner',
  'intelligentImageScanner', 'imageMinSize', 'imageStrictness', 'imageUnverifiedAction',
  'postAction', 'personalContext', 'personalContextOnHotPaths',
  'contentStrictness', 'appealStrictness', 'usageLimits'
];

const STRICTNESS_ORDER = ['very-lenient', 'lenient', 'balanced', 'strict', 'very-strict'];
function strictnessRank(v) {
  const i = STRICTNESS_ORDER.indexOf(v);
  return i === -1 ? STRICTNESS_ORDER.indexOf('balanced') : i;
}

const IMAGE_STRICTNESS_ORDER = ['standard', 'strict', 'maximum'];
function imageStrictnessRank(v) {
  const i = IMAGE_STRICTNESS_ORDER.indexOf(v);
  return i === -1 ? IMAGE_STRICTNESS_ORDER.indexOf('strict') : i;
}

// Un-verifiable-image fallback, ordered weakest -> strongest.
const UNVERIFIED_ORDER = ['reveal', 'blur', 'hide'];
function unverifiedRank(v) {
  const i = UNVERIFIED_ORDER.indexOf(v);
  return i === -1 ? UNVERIFIED_ORDER.indexOf('reveal') : i;
}

let pendingDiff = null;
let pendingSettings = null;

// Keyword → suggested scope hosts. Word-boundary regex so "linkedin" inside a longer
// phrase doesn't false-positive on arbitrary text. Kept short on purpose.
const KNOWN_SITES = [
  { kw: /\b(youtube|yt|shorts)\b/i, hosts: ['youtube.com'] },
  { kw: /\b(twitter|tweet)\b/i, hosts: ['twitter.com', 'x.com'] },
  { kw: /\bx\.com\b/i, hosts: ['x.com', 'twitter.com'] },
  { kw: /\b(reddit|subreddit)\b/i, hosts: ['reddit.com'] },
  { kw: /\b(instagram|insta)\b/i, hosts: ['instagram.com'] },
  { kw: /\btiktok\b/i, hosts: ['tiktok.com'] },
  { kw: /\b(facebook|fb)\b/i, hosts: ['facebook.com'] },
  { kw: /\blinkedin\b/i, hosts: ['linkedin.com'] },
  { kw: /\bamazon\b/i, hosts: ['amazon.com'] },
  { kw: /\bgithub\b/i, hosts: ['github.com'] },
  { kw: /\btwitch\b/i, hosts: ['twitch.tv'] },
  { kw: /\bpinterest\b/i, hosts: ['pinterest.com'] },
  { kw: /\b(pornhub|xvideos|xhamster|redtube)\b/i, hosts: ['pornhub.com', 'xvideos.com', 'xhamster.com'] }
];

// In-memory only: dismissals reset on page reload by design.
const dismissedSuggestions = new Set();
// Track which rules have the scope editor expanded, keyed by rule.id (survives re-renders).
const expandedScopeEditors = new Set();

function suggestScopeForText(text) {
  if (!text || text.length < 6) return [];
  const hits = new Set();
  for (const entry of KNOWN_SITES) {
    if (entry.kw.test(text)) entry.hosts.forEach((h) => hits.add(h));
  }
  return Array.from(hits).slice(0, 3);
}

function computeScopeSummary(rs) {
  const total = rs.length;
  let scoped = 0;
  for (const r of rs) {
    if (Array.isArray(r.scope) && r.scope.length > 0) scoped++;
  }
  return { total, scoped, universal: total - scoped };
}

function renderScopeSummary() {
  const el = $('rulesSummary');
  if (!el) return;
  const { total, scoped, universal } = computeScopeSummary(rules);
  if (total === 0) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '';
  const line = document.createElement('span');
  line.innerHTML =
    `<strong>${total}</strong> rule${total === 1 ? '' : 's'} · ` +
    `<strong>${scoped}</strong> scoped to specific sites · ` +
    `<strong>${universal}</strong> fire${universal === 1 ? 's' : ''} on every page`;
  el.appendChild(line);
  if (universal >= 5) {
    const nudge = document.createElement('span');
    nudge.className = 'scope-nudge';
    nudge.textContent = 'Scoping rules to specific sites means they aren’t sent to Claude on other sites — faster and cheaper.';
    el.appendChild(nudge);
  }
}

const STRICT_PRESET_RULES = [
  'Anything someone would seek out, look for, or look at to find any sort of sexual pleasure or sexual stimulation'
];

async function load() {
  const stored = await chrome.storage.local.get([
    'apiKey', 'rules', 'blocklist', 'failMode', 'allowDomains',
    'enableSiteFilters', 'enableImageScanner', 'enablePostScanner',
    'imageMinSize', 'postAction', 'imageScannerExcludeDomains', 'personalContext',
    'personalContextOnHotPaths', 'intelligentImageScanner',
    'imageStrictness', 'imageUnverifiedAction',
    'contentStrictness', 'appealStrictness', 'usageLimits'
  ]);

  $('apiKey').value = stored.apiKey || '';
  $('failMode').value = stored.failMode || 'open';
  $('allowDomains').value = Array.isArray(stored.allowDomains) ? stored.allowDomains.join('\n') : '';
  $('personalContext').value = stored.personalContext || '';
  $('contentStrictness').value = stored.contentStrictness || 'strict';
  $('appealStrictness').value = stored.appealStrictness || 'strict';
  $('imageScannerExcludeDomains').value = Array.isArray(stored.imageScannerExcludeDomains) ? stored.imageScannerExcludeDomains.join('\n') : '';

  $('enableSiteFilters').checked = stored.enableSiteFilters !== false; // default ON
  $('enableImageScanner').checked = stored.enableImageScanner !== false; // default ON
  $('enablePostScanner').checked = stored.enablePostScanner === true;
  $('intelligentImageScanner').checked = stored.intelligentImageScanner !== false; // default ON
  $('personalContextOnHotPaths').checked = stored.personalContextOnHotPaths !== false; // default ON

  $('imageMinSize').value = stored.imageMinSize || 80;
  $('imageStrictness').value = stored.imageStrictness || 'strict';
  $('imageUnverifiedAction').value = stored.imageUnverifiedAction || 'reveal';
  $('postAction').value = stored.postAction || 'hide';

  // Rules + migration
  if (Array.isArray(stored.rules) && stored.rules.length) {
    const anyMissingId = stored.rules.some((r) => !r.id);
    rules = stored.rules.map((r) => ({ ...r, id: r.id || genId() }));
    if (anyMissingId) await chrome.storage.local.set({ rules });
  } else if (typeof stored.blocklist === 'string' && stored.blocklist.trim()) {
    rules = stored.blocklist.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((text) => ({ id: genId(), text, mode: 'block' }));
    await chrome.storage.local.set({ rules });
    await chrome.storage.local.remove('blocklist');
  } else {
    rules = [];
  }
  renderRules();

  // Usage limits
  usageLimitRules = Array.isArray(stored.usageLimits) ? stored.usageLimits.map((r) => ({ ...r, id: r.id || genId() })) : [];
  renderUsageLimits();
  loadUsageStatus();
}

function renderRules() {
  const container = $('rules');
  container.innerHTML = '';

  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No rules yet. Add one to start filtering.';
    container.appendChild(empty);
    renderScopeSummary();
    return;
  }

  rules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    if (rule.enabled === false) row.classList.add('disabled');
    row.dataset.mode = rule.mode;

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'switch rule-enabled-switch';
    enabledLabel.title = rule.enabled === false
      ? 'Rule is disabled — not sent to Claude. Click to re-enable.'
      : 'Rule is active. Click to disable without deleting.';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = rule.enabled !== false;
    enabledInput.addEventListener('change', (e) => {
      rules[idx].enabled = e.target.checked;
      renderRules();
    });
    const enabledSlider = document.createElement('span');
    enabledSlider.className = 'slider';
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(enabledSlider);
    row.appendChild(enabledLabel);

    const input = document.createElement('textarea');
    input.rows = 1;
    input.className = 'rule-text';
    input.value = rule.text;
    input.placeholder =
      rule.mode === 'only-allow' ? 'e.g. Real estate, business, AI, or tech videos' :
      rule.mode === 'allow'      ? 'e.g. Gaming and tech content' :
                                   'e.g. Pornography and sexual content';
    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    };
    input.addEventListener('input', (e) => {
      rules[idx].text = e.target.value;
      autosize();
      updateSuggestion(idx, suggestionContainer);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); }
    });
    requestAnimationFrame(autosize);

    const toggle = document.createElement('div');
    toggle.className = 'toggle';

    const blockBtn = document.createElement('button');
    blockBtn.textContent = 'Block';
    blockBtn.dataset.mode = 'block';
    if (rule.mode === 'block') blockBtn.classList.add('active');
    blockBtn.addEventListener('click', () => setMode(idx, 'block'));

    const allowBtn = document.createElement('button');
    allowBtn.textContent = 'Allow';
    allowBtn.dataset.mode = 'allow';
    if (rule.mode === 'allow') allowBtn.classList.add('active');
    allowBtn.addEventListener('click', () => setMode(idx, 'allow'));

    const onlyAllowBtn = document.createElement('button');
    onlyAllowBtn.textContent = 'Only allow';
    onlyAllowBtn.dataset.mode = 'only-allow';
    if (rule.mode === 'only-allow') onlyAllowBtn.classList.add('active');
    onlyAllowBtn.addEventListener('click', () => setMode(idx, 'only-allow'));

    toggle.appendChild(blockBtn);
    toggle.appendChild(allowBtn);
    toggle.appendChild(onlyAllowBtn);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => { rules.splice(idx, 1); renderRules(); });

    row.appendChild(input);
    row.appendChild(toggle);
    row.appendChild(del);

    // Per-rule strictness override dropdown.
    const strictnessRow = document.createElement('div');
    strictnessRow.className = 'rule-strictness-row';
    const strictnessLabel = document.createElement('span');
    strictnessLabel.className = 'rule-strictness-label';
    strictnessLabel.textContent = 'Strictness:';
    const strictnessSelect = document.createElement('select');
    strictnessSelect.className = 'rule-strictness-select' + (rule.strictness ? ' has-override' : '');
    for (const [val, label] of [
      ['', 'Default (inherit global)'],
      ['very-lenient', 'Very Lenient'],
      ['lenient', 'Lenient'],
      ['strict', 'Strict'],
      ['very-strict', 'Very Strict'],
    ]) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if ((rule.strictness || '') === val) o.selected = true;
      strictnessSelect.appendChild(o);
    }
    strictnessSelect.addEventListener('change', (e) => {
      rules[idx].strictness = e.target.value || null;
      strictnessSelect.className = 'rule-strictness-select' + (rules[idx].strictness ? ' has-override' : '');
    });
    strictnessRow.appendChild(strictnessLabel);
    strictnessRow.appendChild(strictnessSelect);
    row.appendChild(strictnessRow);

    // Scope chip (always visible) + collapsible editor below.
    const chipRow = document.createElement('div');
    chipRow.className = 'rule-scope-chip-row';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rule-scope-chip';
    chipRow.appendChild(chip);
    row.appendChild(chipRow);

    const editor = document.createElement('div');
    editor.className = 'rule-scope-editor';
    editor.hidden = !expandedScopeEditors.has(rule.id);

    const scopeInput = document.createElement('input');
    scopeInput.type = 'text';
    scopeInput.value = Array.isArray(rule.scope) ? rule.scope.join(', ') : '';
    scopeInput.placeholder = 'e.g. youtube.com, reddit.com — leave blank to apply everywhere';

    const help = document.createElement('div');
    help.className = 'scope-help';
    help.textContent = 'Scoping a rule means it isn’t sent to Claude on other sites — faster and cheaper.';

    editor.appendChild(scopeInput);
    editor.appendChild(help);
    row.appendChild(editor);

    // Suggestion strip — re-computed on rule-text changes via the input handler above.
    const suggestionContainer = document.createElement('div');
    suggestionContainer.className = 'rule-scope-suggestion-container';
    row.appendChild(suggestionContainer);

    paintChip(chip, rules[idx]);

    scopeInput.addEventListener('input', (e) => {
      rules[idx].scope = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      paintChip(chip, rules[idx]);
      renderScopeSummary();
      updateSuggestion(idx, suggestionContainer);
    });

    chip.addEventListener('click', () => {
      const willExpand = editor.hidden;
      editor.hidden = !willExpand;
      if (willExpand) {
        expandedScopeEditors.add(rule.id);
        scopeInput.focus();
      } else {
        expandedScopeEditors.delete(rule.id);
      }
    });

    updateSuggestion(idx, suggestionContainer);

    container.appendChild(row);
  });

  renderScopeSummary();
}

function paintChip(chip, rule) {
  const isScoped = Array.isArray(rule.scope) && rule.scope.length > 0;
  chip.dataset.state = isScoped ? 'scoped' : 'universal';
  chip.innerHTML = '';
  if (isScoped) {
    chip.appendChild(document.createTextNode('Only on: '));
    const hostSpan = document.createElement('span');
    hostSpan.className = 'sg-host';
    hostSpan.textContent = rule.scope.join(', ');
    chip.appendChild(hostSpan);
  } else {
    chip.appendChild(document.createTextNode('Fires on every site'));
  }
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▾';
  chip.appendChild(caret);
}

function updateSuggestion(idx, container) {
  container.innerHTML = '';
  const rule = rules[idx];
  if (!rule) return;
  if (Array.isArray(rule.scope) && rule.scope.length > 0) return;
  if (dismissedSuggestions.has(rule.id)) return;
  const suggested = suggestScopeForText(rule.text || '');
  if (suggested.length === 0) return;

  const strip = document.createElement('div');
  strip.className = 'rule-scope-suggestion';

  const label = document.createElement('span');
  label.textContent = 'Suggested scope:';

  const host = document.createElement('span');
  host.className = 'sg-host';
  host.textContent = suggested.join(', ');

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sg-add';
  add.textContent = suggested.length > 1 ? 'Add all' : 'Add';
  add.addEventListener('click', () => {
    rules[idx].scope = suggested.slice();
    renderRules();
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'sg-dismiss';
  dismiss.innerHTML = '&times;';
  dismiss.title = 'Dismiss suggestion';
  dismiss.addEventListener('click', () => {
    dismissedSuggestions.add(rule.id);
    updateSuggestion(idx, container);
  });

  strip.appendChild(label);
  strip.appendChild(host);
  strip.appendChild(add);
  strip.appendChild(dismiss);
  container.appendChild(strip);
}

function setMode(idx, mode) {
  rules[idx].mode = mode;
  renderRules();
}

function genId() { return Math.random().toString(36).slice(2, 10); }

$('addRule').addEventListener('click', () => {
  rules.push({ id: genId(), text: '', mode: 'block' });
  renderRules();
  const rows = document.querySelectorAll('.rule-row .rule-text');
  if (rows.length) rows[rows.length - 1].focus();
});

$('addStrictPreset').addEventListener('click', () => {
  const existing = new Set(rules.map((r) => (r.text || '').trim()));
  let added = 0;
  for (const text of STRICT_PRESET_RULES) {
    if (existing.has(text)) continue;
    rules.push({ id: genId(), text, mode: 'block' });
    added++;
  }
  renderRules();
  showStatus(added ? `Added ${added} preset rule${added === 1 ? '' : 's'}. Click Save to apply.` : 'Preset rules are already present.', 'ok');
});

function normHost(s) {
  return String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

// Expands one user-typed scope/domain entry into canonical hostnames.
// Bare words known to KNOWN_SITES (e.g. "yt", "twitter") become their proper hosts;
// unknown bare words pass through so the runtime label-matcher can still handle them.
function expandHost(s) {
  const n = normHost(s);
  if (!n) return [];
  if (n.includes('.')) return [n];
  for (const site of KNOWN_SITES) {
    if (site.kw.test(n)) return site.hosts.slice();
  }
  return [n];
}

// ============================================================
// Usage Limits UI
// ============================================================

function renderUsageLimits() {
  const container = $('usage-limits-list');
  if (!container) return;
  container.innerHTML = '';

  if (!usageLimitRules.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#888;font-size:13px;margin-bottom:8px;';
    empty.textContent = 'No limits yet. Click "+ Add limit" to create one.';
    container.appendChild(empty);
    return;
  }

  usageLimitRules.forEach((rule, idx) => {
    const card = document.createElement('div');
    card.className = 'layer-card';
    if (!rule.enabled) card.classList.add('disabled');
    card.style.marginBottom = '10px';

    const isExpanded = expandedUsageIds.has(rule.id);

    // Collapsed header row
    const header = document.createElement('div');
    header.className = 'layer-header';
    header.style.cursor = 'pointer';
    header.title = 'Click to edit';

    const left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';

    // Enable toggle
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'switch';
    toggleLabel.style.flexShrink = '0';
    toggleLabel.addEventListener('click', (e) => e.stopPropagation());
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = rule.enabled !== false;
    toggleInput.addEventListener('change', (e) => { usageLimitRules[idx].enabled = e.target.checked; renderUsageLimits(); });
    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'slider';
    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleSlider);
    left.appendChild(toggleLabel);

    // Type badge
    const badge = document.createElement('span');
    const badgeLabels = { visit: 'visit', time: 'time', 'ai-match': 'AI-match', 'ai-goal': 'AI-goal' };
    badge.textContent = badgeLabels[rule.type] || rule.type;
    badge.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:#e8e8e8;color:#555;flex-shrink:0;white-space:nowrap;';
    left.appendChild(badge);

    // Label + pattern summary
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = rule.type === 'ai-goal' ? (rule.label || '(no goal)') : (rule.label || '(unnamed)');
    left.appendChild(titleEl);

    const summaryEl = document.createElement('span');
    summaryEl.style.cssText = 'font-size:12px;color:#888;white-space:nowrap;margin-left:6px;';
    const unit = rule.type === 'time' ? 'min' : (rule.limit === 1 ? 'time' : 'times');
    const locationStr = rule.type === 'ai-goal' ? 'any site' : (rule.pattern || '(no pattern)');
    summaryEl.textContent = `${rule.limit} ${unit}/${rule.period === 'week' ? 'wk' : 'day'} · ${locationStr}`;
    left.appendChild(summaryEl);

    header.appendChild(left);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.style.cssText = 'background:none;border:none;color:#bbb;cursor:pointer;font-size:15px;padding:2px 6px;margin-left:8px;flex-shrink:0;';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); usageLimitRules.splice(idx, 1); expandedUsageIds.delete(rule.id); renderUsageLimits(); });
    header.appendChild(delBtn);

    card.appendChild(header);

    // Usage status line
    const statusEl = document.createElement('div');
    statusEl.id = `usage-status-${rule.id}`;
    statusEl.style.cssText = 'font-size:12px;color:#888;margin-top:3px;min-height:16px;';
    card.appendChild(statusEl);

    header.addEventListener('click', () => {
      expandedUsageIds.has(rule.id) ? expandedUsageIds.delete(rule.id) : expandedUsageIds.add(rule.id);
      renderUsageLimits();
    });

    // Expanded inline editor
    if (isExpanded) {
      const ed = document.createElement('div');
      ed.style.cssText = 'margin-top:12px;border-top:1px solid #f0f0f0;padding-top:12px;display:flex;flex-direction:column;gap:10px;';

      const field = (labelText, el) => {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'font-size:13px;color:#555;display:flex;flex-direction:column;gap:4px;';
        wrap.appendChild(Object.assign(document.createElement('span'), { textContent: labelText }));
        wrap.appendChild(el);
        return wrap;
      };
      const inputStyle = 'padding:6px 8px;border:1px solid #d4d4d4;border-radius:4px;font-size:13px;font-family:inherit;';

      // Type select
      const typeEl = document.createElement('select');
      typeEl.style.cssText = inputStyle + 'background:white;';
      [['visit', 'Visit count — block after N distinct page opens'],
       ['time', 'Time on page — block after N minutes (visible tab time)'],
       ['ai-match', 'AI-match override — allow up to N AI-blocked pages through'],
       ['ai-goal', 'AI goal — describe what to limit; AI decides per page, any site']
      ].forEach(([v, l]) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = l;
        if (rule.type === v) opt.selected = true;
        typeEl.appendChild(opt);
      });
      typeEl.addEventListener('change', (e) => { usageLimitRules[idx].type = e.target.value; renderUsageLimits(); });
      ed.appendChild(field('Type', typeEl));

      if (rule.type === 'ai-goal') {
        // Goal textarea (replaces label + pattern for ai-goal rules)
        const goalInp = document.createElement('textarea');
        goalInp.value = rule.label || '';
        goalInp.placeholder = 'e.g. watch an episode of a TV show';
        goalInp.rows = 2;
        goalInp.style.cssText = inputStyle + 'resize:vertical;';
        goalInp.addEventListener('input', (e) => { usageLimitRules[idx].label = e.target.value; });
        ed.appendChild(field('Goal (plain English — AI evaluates this against each page you visit)', goalInp));
      } else {
        // Label input
        const labelInp = Object.assign(document.createElement('input'), { type: 'text', value: rule.label || '', placeholder: 'e.g. Netflix episodes' });
        labelInp.style.cssText = inputStyle;
        labelInp.addEventListener('input', (e) => { usageLimitRules[idx].label = e.target.value; });
        ed.appendChild(field('Label', labelInp));

        // Pattern input
        const patInp = Object.assign(document.createElement('input'), { type: 'text', value: rule.pattern || '', placeholder: 'netflix.com/watch/*' });
        patInp.style.cssText = inputStyle;
        patInp.addEventListener('input', (e) => { usageLimitRules[idx].pattern = e.target.value.trim(); });
        ed.appendChild(field('URL pattern (glob: * = any chars in path segment, *.domain = any subdomain)', patInp));
      }

      // Limit + period row
      const limitRow = document.createElement('div');
      limitRow.style.cssText = 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;';
      const limitInp = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: rule.type === 'time' ? '1440' : '100', step: '1', value: rule.limit || 1 });
      limitInp.style.cssText = inputStyle + 'width:80px;';
      limitInp.addEventListener('input', (e) => { usageLimitRules[idx].limit = Math.max(1, parseInt(e.target.value, 10) || 1); });
      const limitUnit = rule.type === 'time' ? 'Minutes per' : 'Times per';
      limitRow.appendChild(field(limitUnit, limitInp));
      const periodEl = document.createElement('select');
      periodEl.style.cssText = inputStyle + 'background:white;';
      [['day', 'Day (resets at midnight)'], ['week', 'Week (resets Monday)']].forEach(([v, l]) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = l;
        if (rule.period === v) opt.selected = true;
        periodEl.appendChild(opt);
      });
      periodEl.addEventListener('change', (e) => { usageLimitRules[idx].period = e.target.value; });
      limitRow.appendChild(field('Period', periodEl));
      ed.appendChild(limitRow);

      card.appendChild(ed);
    }

    container.appendChild(card);
  });
}

async function loadUsageStatus() {
  if (!usageLimitRules.length) return;
  const countRules = usageLimitRules.filter((r) => r.type !== 'time');
  const timeRules = usageLimitRules.filter((r) => r.type === 'time');

  if (countRules.length) {
    chrome.runtime.sendMessage({ type: 'get-usage-counts' }, (res) => {
      if (!res) return;
      for (const rule of countRules) {
        const el = document.getElementById(`usage-status-${rule.id}`);
        if (!el) continue;
        const count = res[rule.id] || 0;
        const period = rule.period === 'week' ? 'this week' : 'today';
        el.textContent = `${period}: ${count} / ${rule.limit} ${rule.type === 'ai-match' ? 'overrides used' : (rule.limit === 1 ? 'time opened' : 'times opened')}`;
      }
    });
  }
  if (timeRules.length) {
    chrome.runtime.sendMessage({ type: 'get-time-status' }, (res) => {
      if (!res) return;
      for (const rule of timeRules) {
        const el = document.getElementById(`usage-status-${rule.id}`);
        if (!el) continue;
        const ms = res[rule.id] || 0;
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        const period = rule.period === 'week' ? 'this week' : 'today';
        el.textContent = `${period}: ${mins}m ${secs}s / ${rule.limit}m`;
      }
    });
  }
}

$('add-usage-limit') && $('add-usage-limit').addEventListener('click', () => {
  const newRule = { id: genId(), label: '', type: 'visit', pattern: '', limit: 1, period: 'day', enabled: true };
  usageLimitRules.push(newRule);
  expandedUsageIds.add(newRule.id);
  renderUsageLimits();
  // Scroll new card into view
  const last = $('usage-limits-list').lastElementChild;
  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function buildNewSettings() {
  const cleanRules = rules.filter((r) => r.text && r.text.trim()).map((r) => ({
    id: r.id || genId(),
    text: r.text,
    mode: r.mode || 'block',
    enabled: r.enabled !== false,
    scope: Array.isArray(r.scope) ? Array.from(new Set(r.scope.flatMap(expandHost))) : [],
    strictness: r.strictness || null
  }));
  const allowDomains = Array.from(new Set($('allowDomains').value.split('\n').flatMap(expandHost)));
  const imageScannerExcludeDomains = Array.from(new Set($('imageScannerExcludeDomains').value.split('\n').flatMap(expandHost)));
  return {
    apiKey: $('apiKey').value.trim(),
    rules: cleanRules,
    failMode: $('failMode').value,
    allowDomains,
    imageScannerExcludeDomains,
    enableSiteFilters: $('enableSiteFilters').checked,
    enableImageScanner: $('enableImageScanner').checked,
    enablePostScanner: $('enablePostScanner').checked,
    intelligentImageScanner: $('intelligentImageScanner').checked,
    imageMinSize: Math.max(50, Math.min(500, parseInt($('imageMinSize').value, 10) || 80)),
    imageStrictness: $('imageStrictness').value,
    imageUnverifiedAction: $('imageUnverifiedAction').value,
    postAction: $('postAction').value,
    personalContext: $('personalContext').value.trim(),
    personalContextOnHotPaths: $('personalContextOnHotPaths').checked,
    contentStrictness: $('contentStrictness').value,
    appealStrictness: $('appealStrictness').value,
    usageLimits: usageLimitRules.filter((r) => r.pattern).map((r) => ({
      id: r.id || genId(),
      label: (r.label || '').trim(),
      type: r.type || 'visit',
      pattern: r.pattern.trim(),
      limit: Math.max(1, parseInt(r.limit, 10) || 1),
      period: r.period || 'day',
      enabled: r.enabled !== false
    }))
  };
}

function normalizeStoredSettings(stored) {
  const s = stored || {};
  return {
    apiKey: (s.apiKey || '').trim(),
    rules: Array.isArray(s.rules) ? s.rules.map((r) => ({
      id: r.id || '',
      text: r.text || '',
      mode: r.mode || 'block',
      enabled: r.enabled !== false,
      scope: Array.isArray(r.scope) ? r.scope : [],
      strictness: r.strictness || null
    })) : [],
    failMode: s.failMode || 'open',
    allowDomains: Array.isArray(s.allowDomains) ? s.allowDomains : [],
    imageScannerExcludeDomains: Array.isArray(s.imageScannerExcludeDomains) ? s.imageScannerExcludeDomains : [],
    enableSiteFilters: s.enableSiteFilters !== false,
    enableImageScanner: s.enableImageScanner !== false,
    enablePostScanner: s.enablePostScanner === true,
    intelligentImageScanner: s.intelligentImageScanner !== false,
    imageMinSize: Math.max(50, Math.min(500, parseInt(s.imageMinSize, 10) || 80)),
    imageStrictness: s.imageStrictness || 'strict',
    imageUnverifiedAction: s.imageUnverifiedAction || 'reveal',
    postAction: s.postAction || 'hide',
    personalContext: (s.personalContext || '').trim(),
    personalContextOnHotPaths: s.personalContextOnHotPaths !== false,
    contentStrictness: s.contentStrictness || 'strict',
    appealStrictness: s.appealStrictness || 'strict',
    usageLimits: Array.isArray(s.usageLimits) ? s.usageLimits : []
  };
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function computeDiff(current, next) {
  const diff = { rules: { added: [], removed: [], modified: [] }, settings: {} };

  const cById = new Map();
  for (const r of current.rules) if (r.id) cById.set(r.id, r);
  const nIds = new Set();

  for (const r of next.rules) {
    if (r.id) nIds.add(r.id);
    if (!r.id || !cById.has(r.id)) {
      diff.rules.added.push({ id: r.id, text: r.text, mode: r.mode, scope: r.scope, enabled: r.enabled });
    } else {
      const old = cById.get(r.id);
      const textChanged = (old.text || '').trim() !== (r.text || '').trim();
      const modeChanged = (old.mode || 'block') !== (r.mode || 'block');
      const oldScope = Array.isArray(old.scope) ? old.scope : [];
      const newScope = Array.isArray(r.scope) ? r.scope : [];
      const scopeChanged = !sameArray(oldScope, newScope);
      const oldEnabled = old.enabled !== false;
      const newEnabled = r.enabled !== false;
      const enabledChanged = oldEnabled !== newEnabled;
      const oldStrictness = old.strictness || null;
      const newStrictness = r.strictness || null;
      const strictnessChanged = oldStrictness !== newStrictness;
      if (textChanged || modeChanged || scopeChanged || enabledChanged || strictnessChanged) {
        diff.rules.modified.push({
          id: r.id,
          oldText: old.text, newText: r.text,
          oldMode: old.mode, newMode: r.mode,
          oldScope, newScope,
          oldEnabled, newEnabled,
          oldStrictness, newStrictness,
          textChanged, modeChanged, scopeChanged, enabledChanged, strictnessChanged
        });
      }
    }
  }
  for (const r of current.rules) {
    if (r.id && !nIds.has(r.id)) {
      diff.rules.removed.push({ id: r.id, text: r.text, mode: r.mode, scope: r.scope, enabled: r.enabled });
    }
  }

  const compareKeys = [
    'apiKey', 'failMode', 'allowDomains', 'imageScannerExcludeDomains',
    'enableSiteFilters', 'enableImageScanner', 'enablePostScanner',
    'intelligentImageScanner', 'imageMinSize', 'imageStrictness', 'imageUnverifiedAction',
    'postAction', 'personalContextOnHotPaths',
    'contentStrictness', 'appealStrictness'
  ];
  for (const key of compareKeys) {
    const o = current[key];
    const n = next[key];
    const equal = Array.isArray(o) || Array.isArray(n)
      ? sameArray(Array.isArray(o) ? o : [], Array.isArray(n) ? n : [])
      : o === n;
    if (!equal) diff.settings[key] = { old: o, new: n };
  }

  if (current.personalContext !== next.personalContext) {
    diff.personalContext = { old: current.personalContext, new: next.personalContext };
  }
  if (JSON.stringify(current.usageLimits || []) !== JSON.stringify(next.usageLimits || [])) {
    diff.usageLimits = true;
  }
  return diff;
}

function isDiffEmpty(diff) {
  return !diff.personalContext &&
    !diff.usageLimits &&
    diff.rules.added.length === 0 &&
    diff.rules.removed.length === 0 &&
    diff.rules.modified.length === 0 &&
    Object.keys(diff.settings).length === 0;
}

function isUniversalScope(s) { return !Array.isArray(s) || s.length === 0; }

function scopeGrewForBlockOrOnlyAllow(oldS, newS) {
  if (isUniversalScope(newS)) return !isUniversalScope(oldS); // list -> all = grew
  if (isUniversalScope(oldS)) return false;                   // all -> list = shrank
  for (const h of oldS) if (!newS.includes(h)) return false;  // old item lost -> not pure grow
  return newS.length > oldS.length;
}

function scopeShrankForAllow(oldS, newS) {
  if (isUniversalScope(oldS)) return !isUniversalScope(newS); // all -> list = shrank
  if (isUniversalScope(newS)) return false;                   // list -> all = grew
  for (const h of newS) if (!oldS.includes(h)) return false;  // new item not in old -> not pure shrink
  return newS.length < oldS.length;
}

function arrayOnlyRemoved(oldA, newA) {
  const o = Array.isArray(oldA) ? oldA : [];
  const n = Array.isArray(newA) ? newA : [];
  for (const item of n) if (!o.includes(item)) return false;
  return n.length < o.length;
}

function isPurelyStrengthening(diff) {
  if (diff.personalContext) return false;

  for (const r of diff.rules.added) {
    if (r.enabled === false) continue; // disabled = no effect, neither strengthens nor weakens
    if (r.mode !== 'block' && r.mode !== 'only-allow') return false;
  }
  for (const r of diff.rules.removed) {
    if (r.enabled === false) continue; // already had no effect
    if (r.mode !== 'allow') return false;
  }
  for (const m of diff.rules.modified) {
    if (m.textChanged) return false;
    const effectiveMode = m.modeChanged ? m.newMode : m.oldMode;
    if (m.modeChanged) {
      const okModeChange =
        (m.oldMode === 'allow' && (m.newMode === 'block' || m.newMode === 'only-allow')) ||
        (m.oldMode === 'only-allow' && m.newMode === 'block');
      if (!okModeChange) return false;
    }
    if (m.scopeChanged) {
      if (effectiveMode === 'allow') {
        if (!scopeShrankForAllow(m.oldScope, m.newScope)) return false;
      } else {
        if (!scopeGrewForBlockOrOnlyAllow(m.oldScope, m.newScope)) return false;
      }
    }
    if (m.enabledChanged) {
      if (m.newEnabled) {
        // Enabling an allow rule = weakening
        if (effectiveMode === 'allow') return false;
      } else {
        // Disabling a block/only-allow rule = weakening
        if (effectiveMode === 'block' || effectiveMode === 'only-allow') return false;
      }
    }
    if (m.strictnessChanged) return false;
  }

  for (const key of Object.keys(diff.settings)) {
    const { old: o, new: n } = diff.settings[key];
    if (key === 'apiKey') continue;
    if (key === 'enableSiteFilters' || key === 'enableImageScanner' ||
        key === 'enablePostScanner' || key === 'intelligentImageScanner' ||
        key === 'personalContextOnHotPaths') {
      if (!(o === false && n === true)) return false;
      continue;
    }
    if (key === 'failMode') {
      if (!(o === 'open' && n === 'closed')) return false;
      continue;
    }
    if (key === 'postAction') {
      if (!(o === 'dim' && n === 'hide')) return false;
      continue;
    }
    if (key === 'imageMinSize') {
      if (!(typeof o === 'number' && typeof n === 'number' && n < o)) return false;
      continue;
    }
    if (key === 'allowDomains' || key === 'imageScannerExcludeDomains') {
      if (!arrayOnlyRemoved(o, n)) return false;
      continue;
    }
    if (key === 'contentStrictness' || key === 'appealStrictness') {
      if (strictnessRank(n) < strictnessRank(o)) return false;
      continue;
    }
    if (key === 'imageStrictness') {
      if (imageStrictnessRank(n) < imageStrictnessRank(o)) return false;
      continue;
    }
    if (key === 'imageUnverifiedAction') {
      if (unverifiedRank(n) < unverifiedRank(o)) return false;
      continue;
    }
    return false;
  }
  return true;
}

async function commitSave(next) {
  await chrome.storage.local.set({
    apiKey: next.apiKey,
    rules: next.rules,
    failMode: next.failMode,
    allowDomains: next.allowDomains,
    imageScannerExcludeDomains: next.imageScannerExcludeDomains,
    enableSiteFilters: next.enableSiteFilters,
    enableImageScanner: next.enableImageScanner,
    enablePostScanner: next.enablePostScanner,
    intelligentImageScanner: next.intelligentImageScanner,
    imageMinSize: next.imageMinSize,
    imageStrictness: next.imageStrictness,
    imageUnverifiedAction: next.imageUnverifiedAction,
    postAction: next.postAction,
    personalContext: next.personalContext,
    personalContextOnHotPaths: next.personalContextOnHotPaths,
    contentStrictness: next.contentStrictness,
    appealStrictness: next.appealStrictness,
    usageLimits: next.usageLimits
  });
  await chrome.storage.local.remove('aisf-cache');
  rules = next.rules;
  renderRules();
  usageLimitRules = next.usageLimits;
  renderUsageLimits();
  loadUsageStatus();
  $('allowDomains').value = next.allowDomains.join('\n');
  $('imageScannerExcludeDomains').value = next.imageScannerExcludeDomains.join('\n');
  showStatus('Saved.', 'ok');
}

$('save').addEventListener('click', async () => {
  hideRuleAppealPanel();
  const next = buildNewSettings();
  const storedRaw = await chrome.storage.local.get(SETTINGS_STORAGE_KEYS);
  const current = normalizeStoredSettings(storedRaw);
  const diff = computeDiff(current, next);

  if (isDiffEmpty(diff)) {
    showStatus('No changes.', 'ok');
    return;
  }
  if (unlocked) {
    return commitSave(next);
  }
  if (isPurelyStrengthening(diff)) {
    return commitSave(next);
  }
  openRuleAppealPanel(diff, next);
});

// ===== Rule-change appeal panel =====

function openRuleAppealPanel(diff, next) {
  pendingDiff = diff;
  pendingSettings = next;
  $('ruleAppealPanel').hidden = false;
  $('ruleAppealResult').hidden = true;
  $('ruleAppealStatus').hidden = true;
  $('ruleAppealText').value = '';
  $('ruleAppealText').disabled = false;
  $('ruleAppealSubmit').disabled = false;
  $('ruleAppealCancel').disabled = false;
  renderDiffList(diff);
  $('ruleAppealText').focus();
  $('ruleAppealPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideRuleAppealPanel() {
  $('ruleAppealPanel').hidden = true;
  pendingDiff = null;
  pendingSettings = null;
}

function renderDiffList(diff) {
  const ul = $('ruleAppealDiff');
  ul.innerHTML = '';
  for (const text of describeDiff(diff)) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
}

function describeDiff(diff) {
  const items = [];
  for (const r of diff.rules.added) {
    const disabledNote = (r.enabled === false) ? ' (disabled)' : '';
    items.push(`Add ${r.mode} rule${disabledNote}: "${r.text}"`);
  }
  for (const r of diff.rules.removed) {
    const disabledNote = (r.enabled === false) ? ' (was disabled)' : '';
    items.push(`Remove ${r.mode} rule${disabledNote}: "${r.text}"`);
  }
  for (const m of diff.rules.modified) {
    if (m.enabledChanged && !m.textChanged && !m.modeChanged && !m.scopeChanged) {
      items.push(`${m.newEnabled ? 'Enable' : 'Disable'} ${m.newMode || m.oldMode} rule: "${m.newText || m.oldText}"`);
      continue;
    }
    const parts = [];
    if (m.textChanged) parts.push(`text "${m.oldText}" → "${m.newText}"`);
    if (m.modeChanged) parts.push(`mode ${m.oldMode} → ${m.newMode}`);
    if (m.scopeChanged) parts.push(`scope [${(m.oldScope || []).join(', ') || 'all sites'}] → [${(m.newScope || []).join(', ') || 'all sites'}]`);
    if (m.enabledChanged) parts.push(m.newEnabled ? 'enabled' : 'disabled');
    items.push(`Edit rule: ${parts.join('; ')}`);
  }
  for (const key of Object.keys(diff.settings)) {
    const { old: o, new: n } = diff.settings[key];
    items.push(`${key}: ${formatVal(o)} → ${formatVal(n)}`);
  }
  if (diff.personalContext) items.push('Update "About you" identity blurb');
  return items;
}

function formatVal(v) {
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '[empty]';
  if (v === '' || v == null) return '(empty)';
  return String(v);
}

function showRuleAppealResult(approved, reason) {
  const card = $('ruleAppealResult');
  card.hidden = false;
  card.classList.toggle('approved', approved);
  card.classList.toggle('denied', !approved);
  $('ruleAppealResultLabel').textContent = approved ? 'Approved' : 'Denied';
  $('ruleAppealResultReason').textContent = reason;
}

$('ruleAppealSubmit').addEventListener('click', () => {
  const text = $('ruleAppealText').value.trim();
  if (!text) {
    showRuleAppealResult(false, 'Please state your reasoning for these changes before submitting.');
    return;
  }
  if (!pendingDiff || !pendingSettings) {
    showRuleAppealResult(false, 'The pending changes were lost — close this panel and try again from Save.');
    return;
  }

  $('ruleAppealText').disabled = true;
  $('ruleAppealSubmit').disabled = true;
  $('ruleAppealCancel').disabled = true;
  $('ruleAppealStatus').hidden = false;
  $('ruleAppealResult').hidden = true;

  const settingsToSave = pendingSettings;

  chrome.runtime.sendMessage({ type: 'appealRuleChange', diff: pendingDiff, appealText: text }, async (response) => {
    $('ruleAppealStatus').hidden = true;
    if (chrome.runtime.lastError) {
      showRuleAppealResult(false, 'Error: ' + chrome.runtime.lastError.message);
      $('ruleAppealText').disabled = false;
      $('ruleAppealSubmit').disabled = false;
      $('ruleAppealCancel').disabled = false;
      return;
    }
    if (response && response.approved) {
      showRuleAppealResult(true, response.reason || 'Approved.');
      await commitSave(settingsToSave);
      pendingDiff = null;
      pendingSettings = null;
      $('ruleAppealCancel').disabled = false;
      $('ruleAppealCancel').textContent = 'Close';
    } else {
      showRuleAppealResult(false, (response && response.reason) || 'Denied.');
      $('ruleAppealText').disabled = false;
      $('ruleAppealSubmit').disabled = false;
      $('ruleAppealCancel').disabled = false;
    }
  });
});

$('ruleAppealCancel').addEventListener('click', () => {
  $('ruleAppealCancel').textContent = 'Cancel';
  hideRuleAppealPanel();
});

$('clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove(['aisf-cache', 'aisf-img-cache', 'aisf-host-skip-cache']);
  showStatus('Caches cleared.', 'ok');
});

$('testBtn').addEventListener('click', async () => {
  if (!(await isWriteAllowed())) return;
  const raw = $('testInput').value.trim();
  if (!raw) return;

  if (!unlocked) {
    const next = buildNewSettings();
    const storedRaw = await chrome.storage.local.get(SETTINGS_STORAGE_KEYS);
    const current = normalizeStoredSettings(storedRaw);
    const diff = computeDiff(current, next);
    if (!isDiffEmpty(diff) && !isPurelyStrengthening(diff)) {
      showStatus('Submit the pending changes for approval before testing.', 'err');
      openRuleAppealPanel(diff, next);
      return;
    }
  }
  const result = $('testResult');
  result.textContent = 'Checking…';
  result.className = 'test-result show';

  const clean = rules.filter((r) => r.text && r.text.trim());
  const allowDomains = $('allowDomains').value.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    rules: clean, failMode: $('failMode').value, allowDomains
  });

  const content = parseTestInput(raw);
  chrome.runtime.sendMessage({ type: 'check', content }, (response) => {
    if (chrome.runtime.lastError) {
      result.className = 'test-result show err';
      result.textContent = 'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    renderTestResult(response);
  });
});

function renderTestResult(response) {
  const result = $('testResult');
  const blocked = response.blocked;
  result.className = 'test-result show ' + (blocked ? 'blocked' : 'allowed');
  const parts = [];
  parts.push(`<div><span class="label">Verdict:</span>${blocked ? 'BLOCKED' : 'ALLOWED'}</div>`);
  if (response.matchedRule) parts.push(`<div><span class="label">Matched rule:</span><code>${escapeHtml(response.matchedRule)}</code></div>`);
  if (response.reason) parts.push(`<div><span class="label">Reason:</span>${escapeHtml(response.reason)}</div>`);
  if (response.fromCache) parts.push('<div style="font-size: 11px; opacity: 0.7; margin-top: 8px;">(from cache)</div>');
  if (response.error) parts.push(`<div style="margin-top: 6px;"><span class="label">Note:</span>${escapeHtml(response.error)}</div>`);
  result.innerHTML = parts.join('');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseTestInput(raw) {
  const ytMatch = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  if (ytMatch) return { type: 'youtube_video', videoId: ytMatch[1], url: raw };
  if (/^[\w-]{11}$/.test(raw)) return { type: 'youtube_video', videoId: raw, url: 'https://youtube.com/watch?v=' + raw };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return { type: 'page', url: raw, hostname: u.hostname, pathname: u.pathname, title: '', description: '' };
    } catch (e) {}
  }
  return { type: 'search', engine: 'test', query: raw };
}

function showStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = `status show ${kind}`;
  setTimeout(() => { el.className = 'status'; }, 2500);
}

// ===== Password lock =====

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const RESET_DELAY_MS = 24 * 60 * 60 * 1000;

let unlocked = false;
let countdownTimer = null;

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function generateSalt() {
  const buf = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(buf);
  return buf;
}

async function deriveHash(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

async function verifyPassword(password, storedHashB64, storedSaltB64) {
  if (!password || !storedHashB64 || !storedSaltB64) return false;
  const derived = await deriveHash(password, b64decode(storedSaltB64));
  const derivedB64 = b64encode(derived);
  if (derivedB64.length !== storedHashB64.length) return false;
  let mismatch = 0;
  for (let i = 0; i < derivedB64.length; i++) {
    mismatch |= derivedB64.charCodeAt(i) ^ storedHashB64.charCodeAt(i);
  }
  return mismatch === 0;
}

async function getLockState() {
  const { passwordHash, passwordSalt, passwordResetAt } = await chrome.storage.local.get([
    'passwordHash', 'passwordSalt', 'passwordResetAt'
  ]);
  const hasPassword = !!(passwordHash && passwordSalt);
  const resetAt = typeof passwordResetAt === 'number' ? passwordResetAt : null;
  return {
    hasPassword,
    passwordHash: passwordHash || null,
    passwordSalt: passwordSalt || null,
    resetAt,
    resetReady: !!(resetAt && Date.now() >= resetAt)
  };
}

async function isWriteAllowed() {
  if (unlocked) return true;
  const state = await getLockState();
  return !state.hasPassword;
}

function showUnlockStatus(text, kind) {
  const el = $('unlockStatus');
  el.textContent = text;
  el.className = `status show ${kind || ''}`;
}

function showPasswordStatus(text, kind) {
  const el = $('passwordStatus');
  el.textContent = text;
  el.className = `status show ${kind || ''}`;
  setTimeout(() => { el.className = 'status'; }, 3500);
}

function showLockScreen(state) {
  $('content').style.display = 'none';
  $('lockScreen').style.display = '';
  $('unlockPassword').value = '';
  updateResetUI(state);
  $('unlockPassword').focus();
}

function updateResetUI(state) {
  const idle = $('resetIdle');
  const pending = $('resetPending');
  const countdown = $('resetCountdown');
  const completeBtn = $('completeResetBtn');

  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

  if (!state.resetAt) {
    idle.style.display = '';
    pending.style.display = 'none';
    return;
  }

  idle.style.display = 'none';
  pending.style.display = '';

  const tick = () => {
    const remaining = state.resetAt - Date.now();
    if (remaining <= 0) {
      countdown.textContent = 'Reset is ready. Click "Complete reset" to clear the password.';
      completeBtn.style.display = '';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      return;
    }
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    countdown.textContent = `Reset available in ${h}h ${m}m ${s}s`;
    completeBtn.style.display = 'none';
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function unlockWith(password) {
  const state = await getLockState();
  if (!state.hasPassword) return;
  showUnlockStatus('Checking…');
  const ok = await verifyPassword(password, state.passwordHash, state.passwordSalt);
  if (!ok) {
    showUnlockStatus('Wrong password.', 'err');
    return;
  }
  unlocked = true;
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  $('lockScreen').style.display = 'none';
  $('content').style.display = '';
  $('appealModeBanner').hidden = true;
  await load();
  showPasswordMode('change');
}

async function enterAppealMode() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  $('lockScreen').style.display = 'none';
  $('content').style.display = '';
  $('appealModeBanner').hidden = false;
  await load();
  showPasswordMode('change');
}

async function startReset() {
  await chrome.storage.local.set({ passwordResetAt: Date.now() + RESET_DELAY_MS });
  updateResetUI(await getLockState());
}

async function cancelReset() {
  await chrome.storage.local.remove('passwordResetAt');
  updateResetUI(await getLockState());
}

async function completeReset() {
  const state = await getLockState();
  if (!state.resetReady) return;
  await chrome.storage.local.remove(['passwordHash', 'passwordSalt', 'passwordResetAt']);
  location.reload();
}

function showPasswordMode(mode) {
  $('passwordSetMode').style.display = mode === 'set' ? '' : 'none';
  $('passwordChangeMode').style.display = mode === 'change' ? '' : 'none';
}

$('unlockBtn').addEventListener('click', () => unlockWith($('unlockPassword').value));
$('unlockPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('unlockBtn').click(); }
});
$('bypassBtn').addEventListener('click', enterAppealMode);
$('forgotLink').addEventListener('click', (e) => { e.preventDefault(); startReset(); });
$('cancelResetBtn').addEventListener('click', cancelReset);
$('completeResetBtn').addEventListener('click', completeReset);

$('setPasswordBtn').addEventListener('click', async () => {
  const pw = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  if (!pw) { showPasswordStatus('Enter a password.', 'err'); return; }
  if (pw.length < 4) { showPasswordStatus('Password must be at least 4 characters.', 'err'); return; }
  if (pw !== confirm) { showPasswordStatus('Passwords do not match.', 'err'); return; }
  showPasswordStatus('Saving…');
  const salt = generateSalt();
  const hash = await deriveHash(pw, salt);
  await chrome.storage.local.set({
    passwordHash: b64encode(hash),
    passwordSalt: b64encode(salt)
  });
  await chrome.storage.local.remove('passwordResetAt');
  unlocked = true;
  $('newPassword').value = '';
  $('confirmPassword').value = '';
  showPasswordMode('change');
  showPasswordStatus('Password set. Settings will lock the next time you open this page.', 'ok');
});

$('changePasswordBtn').addEventListener('click', async () => {
  const state = await getLockState();
  if (!state.hasPassword) { showPasswordStatus('No password set.', 'err'); return; }
  const current = $('currentPassword').value;
  const pw = $('changeNewPassword').value;
  const confirm = $('changeConfirmPassword').value;
  if (!(await verifyPassword(current, state.passwordHash, state.passwordSalt))) {
    showPasswordStatus('Current password is wrong.', 'err'); return;
  }
  if (!pw) { showPasswordStatus('Enter a new password (or click Remove password).', 'err'); return; }
  if (pw.length < 4) { showPasswordStatus('Password must be at least 4 characters.', 'err'); return; }
  if (pw !== confirm) { showPasswordStatus('New passwords do not match.', 'err'); return; }
  showPasswordStatus('Saving…');
  const salt = generateSalt();
  const hash = await deriveHash(pw, salt);
  await chrome.storage.local.set({
    passwordHash: b64encode(hash),
    passwordSalt: b64encode(salt)
  });
  await chrome.storage.local.remove('passwordResetAt');
  $('currentPassword').value = '';
  $('changeNewPassword').value = '';
  $('changeConfirmPassword').value = '';
  showPasswordStatus('Password changed.', 'ok');
});

$('removePasswordBtn').addEventListener('click', async () => {
  const state = await getLockState();
  if (!state.hasPassword) { showPasswordStatus('No password set.', 'err'); return; }
  const current = $('currentPassword').value;
  if (!(await verifyPassword(current, state.passwordHash, state.passwordSalt))) {
    showPasswordStatus('Current password is wrong.', 'err'); return;
  }
  await chrome.storage.local.remove(['passwordHash', 'passwordSalt', 'passwordResetAt']);
  $('currentPassword').value = '';
  $('changeNewPassword').value = '';
  $('changeConfirmPassword').value = '';
  showPasswordMode('set');
  showPasswordStatus('Password removed.', 'ok');
});

async function init() {
  const state = await getLockState();
  if (state.hasPassword) {
    showLockScreen(state);
  } else {
    unlocked = true;
    $('content').style.display = '';
    $('appealModeBanner').hidden = true;
    await load();
    showPasswordMode('set');
  }
}

init();
