const params = new URLSearchParams(location.search);

// Pull all values (supporting both new 'rule' and old 'category' param names)
const q = params.get('q') || '';
const rule = params.get('rule') || params.get('category') || '';
const reason = params.get('reason') || '';
const errorMsg = params.get('error') || '';
const fromCache = params.get('fromCache') === '1';
const raw = params.get('raw') || '';
const originalUrl = params.get('originalUrl') || '';
const cacheKey = params.get('cacheKey') || '';

// Subtitle - show error context if there was one
if (errorMsg) {
  document.getElementById('subtitle').textContent =
    'Blocked due to: ' + errorMsg + ' (you\'re in fail-closed mode).';
}

// Query
const qEl = document.getElementById('q');
if (q) {
  qEl.textContent = q;
} else {
  qEl.textContent = '(query info not provided)';
  qEl.classList.add('missing');
}

// Rule
const ruleEl = document.getElementById('rule');
if (rule) {
  ruleEl.textContent = rule;
} else {
  ruleEl.textContent = "(Claude didn't specify which rule matched)";
  ruleEl.classList.add('missing');
}

// Reason
const reasonEl = document.getElementById('reason');
if (reason) {
  reasonEl.textContent = reason;
} else {
  reasonEl.textContent = '(no reason was returned)';
  reasonEl.classList.add('missing');
}

// Debug
const debugData = {
  query: q || '(empty)',
  rule: rule || '(empty)',
  reason: reason || '(empty)',
  fromCache: fromCache,
  error: errorMsg || '(none)',
  rawClaudeResponse: raw || '(not provided)',
  allUrlParams: Object.fromEntries(params)
};
document.getElementById('debugPre').textContent = JSON.stringify(debugData, null, 2);

// Auto-open debug if data is missing
if (!rule || !reason) {
  document.getElementById('debug').open = true;
}

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});
document.getElementById('opts').addEventListener('click', () => {
  chrome.runtime.openOptionsPage && chrome.runtime.openOptionsPage();
});

// ---- Appeal flow ----
const appealBtn = document.getElementById('appealBtn');
const appealPanel = document.getElementById('appealPanel');
const appealText = document.getElementById('appealText');
const appealSubmit = document.getElementById('appealSubmit');
const appealCancel = document.getElementById('appealCancel');
const appealStatus = document.getElementById('appealStatus');
const appealResult = document.getElementById('appealResult');
const appealResultLabel = document.getElementById('appealResultLabel');
const appealResultReason = document.getElementById('appealResultReason');
const appealResultActions = document.getElementById('appealResultActions');
const appealFix = document.getElementById('appealFix');
const appealFixRule = document.getElementById('appealFixRule');
const appealFixScope = document.getElementById('appealFixScope');
const appealFixAdd = document.getElementById('appealFixAdd');
const appealFixStatus = document.getElementById('appealFixStatus');

let pendingFix = null;

if (!originalUrl) {
  appealBtn.disabled = true;
  appealBtn.title = 'Appeals are unavailable — original URL was not captured.';
}

appealBtn.addEventListener('click', () => {
  appealPanel.hidden = false;
  appealBtn.disabled = true;
  setTimeout(() => appealText.focus(), 0);
});

appealCancel.addEventListener('click', () => {
  appealPanel.hidden = true;
  appealBtn.disabled = false;
  appealResult.hidden = true;
  appealStatus.hidden = true;
});

appealSubmit.addEventListener('click', () => submitAppeal());
appealText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitAppeal();
});

function submitAppeal() {
  const text = appealText.value.trim();
  if (!text) {
    appealText.focus();
    return;
  }
  appealSubmit.disabled = true;
  appealCancel.disabled = true;
  appealText.disabled = true;
  appealResult.hidden = true;
  appealStatus.hidden = false;

  chrome.runtime.sendMessage({
    type: 'appealBlock',
    originalUrl,
    query: q,
    matchedRule: rule,
    originalReason: reason,
    appealText: text,
    cacheKey
  }, (response) => {
    appealStatus.hidden = true;
    appealSubmit.disabled = false;
    appealCancel.disabled = false;
    appealText.disabled = false;

    if (chrome.runtime.lastError || !response) {
      showAppealResult(false, 'Could not reach the extension background — ' +
        (chrome.runtime.lastError && chrome.runtime.lastError.message || 'no response') + '.');
      return;
    }
    showAppealResult(Boolean(response.overturned), response.reason || '(no reason returned)', response.suggestedFix);
  });
}

function showAppealResult(overturned, reasonText, suggestedFix) {
  appealResult.hidden = false;
  appealResult.classList.toggle('overturned', overturned);
  appealResult.classList.toggle('upheld', !overturned);
  appealResultLabel.textContent = overturned ? 'Appeal granted' : 'Appeal denied';
  appealResultReason.textContent = reasonText;
  appealResultActions.innerHTML = '';
  if (overturned && originalUrl) {
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Continue to page';
    go.addEventListener('click', () => { window.location.replace(originalUrl); });
    appealResultActions.appendChild(go);
  }

  pendingFix = (overturned && suggestedFix && typeof suggestedFix.text === 'string' && suggestedFix.text.trim())
    ? suggestedFix
    : null;
  appealFix.hidden = !pendingFix;
  appealFixStatus.hidden = true;
  appealFixStatus.classList.remove('error');
  appealFixAdd.hidden = false;
  appealFixAdd.disabled = false;
  if (pendingFix) {
    appealFixRule.textContent = pendingFix.text;
    const scope = Array.isArray(pendingFix.scope) ? pendingFix.scope.filter(Boolean) : [];
    appealFixScope.hidden = scope.length === 0;
    appealFixScope.textContent = scope.length ? 'Only on: ' + scope.join(', ') : '';
  }
}

appealFixAdd.addEventListener('click', () => {
  if (!pendingFix) return;
  appealFixAdd.disabled = true;
  chrome.runtime.sendMessage({ type: 'applyAppealFix', rule: pendingFix }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      appealFixStatus.classList.add('error');
      appealFixStatus.textContent = 'Could not add the rule: ' +
        ((chrome.runtime.lastError && chrome.runtime.lastError.message) || (res && res.error) || 'no response');
      appealFixStatus.hidden = false;
      appealFixAdd.disabled = false;
      return;
    }
    appealFixAdd.hidden = true;
    appealFixStatus.classList.remove('error');
    appealFixStatus.textContent = res.dedup
      ? 'That exception rule already exists.'
      : 'Exception added — it will apply on your next visit.';
    appealFixStatus.hidden = false;
  });
});
