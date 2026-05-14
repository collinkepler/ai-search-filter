const $ = (id) => document.getElementById(id);

let rules = [];

const STRICT_PRESET_RULES = [
  'Sexually explicit content: pornography, nudity, sex acts, exposed genitals, exposed breasts, explicit sexual imagery or descriptions',
  'Sexually suggestive content: lingerie/underwear photoshoots, swimwear in sexualized poses, thirst-trap content, OnlyFans/Patreon-style adult creators, cleavage- or body-emphasis framing, sexualized fitness/gym content',
  'Dating, hookup, and sexual-encounter content: Tinder/Bumble/Grindr discussion, hookup advice, sexting tips, NSFW dating subreddits',
  'Romance, erotica, and NSFW fiction: smut, erotica subreddits, sexual fanfiction, NSFW art, fan service'
];

async function load() {
  const stored = await chrome.storage.local.get([
    'apiKey', 'rules', 'blocklist', 'failMode', 'allowDomains',
    'enableSiteFilters', 'enableImageScanner', 'enablePostScanner',
    'imageMinSize', 'postAction', 'imageScannerExcludeDomains', 'personalContext',
    'personalContextOnHotPaths', 'intelligentImageScanner'
  ]);

  $('apiKey').value = stored.apiKey || '';
  $('failMode').value = stored.failMode || 'open';
  $('allowDomains').value = Array.isArray(stored.allowDomains) ? stored.allowDomains.join('\n') : '';
  $('personalContext').value = stored.personalContext || '';
  $('imageScannerExcludeDomains').value = Array.isArray(stored.imageScannerExcludeDomains) ? stored.imageScannerExcludeDomains.join('\n') : '';

  $('enableSiteFilters').checked = stored.enableSiteFilters !== false; // default ON
  $('enableImageScanner').checked = stored.enableImageScanner === true;
  $('enablePostScanner').checked = stored.enablePostScanner === true;
  $('intelligentImageScanner').checked = stored.intelligentImageScanner !== false; // default ON
  $('personalContextOnHotPaths').checked = stored.personalContextOnHotPaths !== false; // default ON

  $('imageMinSize').value = stored.imageMinSize || 80;
  $('postAction').value = stored.postAction || 'hide';

  // Rules + migration
  if (Array.isArray(stored.rules) && stored.rules.length) {
    rules = stored.rules;
  } else if (typeof stored.blocklist === 'string' && stored.blocklist.trim()) {
    rules = stored.blocklist.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((text) => ({ id: genId(), text, mode: 'block' }));
    await chrome.storage.local.set({ rules });
    await chrome.storage.local.remove('blocklist');
  } else {
    rules = [];
  }
  renderRules();
}

function renderRules() {
  const container = $('rules');
  container.innerHTML = '';

  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No rules yet. Add one to start filtering.';
    container.appendChild(empty);
    return;
  }

  rules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.mode = rule.mode;

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
    input.addEventListener('input', (e) => { rules[idx].text = e.target.value; autosize(); });
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

    const scopeRow = document.createElement('div');
    scopeRow.className = 'rule-scope-row';
    const scopeLabel = document.createElement('label');
    scopeLabel.textContent = 'Applies to:';
    const scopeInput = document.createElement('input');
    scopeInput.type = 'text';
    scopeInput.value = Array.isArray(rule.scope) ? rule.scope.join(', ') : '';
    scopeInput.placeholder = 'any site (e.g. youtube.com, twitter.com)';
    scopeInput.addEventListener('input', (e) => {
      rules[idx].scope = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
    });
    scopeRow.appendChild(scopeLabel);
    scopeRow.appendChild(scopeInput);
    row.appendChild(scopeRow);

    container.appendChild(row);
  });
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

$('save').addEventListener('click', async () => {
  if (!(await isWriteAllowed())) return;
  const normHost = (s) => String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const clean = rules.filter((r) => r.text && r.text.trim()).map((r) => ({
    ...r,
    scope: Array.isArray(r.scope) ? Array.from(new Set(r.scope.map(normHost).filter(Boolean))) : []
  }));
  const allowDomains = $('allowDomains').value.split('\n')
    .map((l) => normHost(l))
    .filter(Boolean);
  const imageScannerExcludeDomains = $('imageScannerExcludeDomains').value.split('\n')
    .map((l) => normHost(l))
    .filter(Boolean);

  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    rules: clean,
    failMode: $('failMode').value,
    allowDomains,
    imageScannerExcludeDomains,
    enableSiteFilters: $('enableSiteFilters').checked,
    enableImageScanner: $('enableImageScanner').checked,
    enablePostScanner: $('enablePostScanner').checked,
    intelligentImageScanner: $('intelligentImageScanner').checked,
    imageMinSize: Math.max(50, Math.min(500, parseInt($('imageMinSize').value, 10) || 80)),
    postAction: $('postAction').value,
    personalContext: $('personalContext').value.trim(),
    personalContextOnHotPaths: $('personalContextOnHotPaths').checked
  });
  await chrome.storage.local.remove('aisf-cache');
  rules = clean;
  renderRules();
  $('allowDomains').value = allowDomains.join('\n');
  $('imageScannerExcludeDomains').value = imageScannerExcludeDomains.join('\n');
  showStatus('Saved.', 'ok');
});

$('clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove(['aisf-cache', 'aisf-img-cache', 'aisf-host-skip-cache']);
  showStatus('Caches cleared.', 'ok');
});

$('testBtn').addEventListener('click', async () => {
  if (!(await isWriteAllowed())) return;
  const raw = $('testInput').value.trim();
  if (!raw) return;
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
    $('content').style.display = '';
    await load();
    showPasswordMode('set');
  }
}

init();
