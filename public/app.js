const API = location.origin;

// Shared visible feedback for actions that fail silently otherwise (a tap
// that just... does nothing). Always logs to console too, so the message is
// never only in one place.
let errorToastTimer = null;
function showErrorToast(message) {
  console.error(message);
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    toast.className = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = `⚠️ ${message}`;
  toast.classList.add('show');
  clearTimeout(errorToastTimer);
  errorToastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// Pending Walmart/Amazon/Target/Costco charges get auto-categorized from a
// matched receipt within ~30 min (see the receipt-check cron) — flag them so
// the user doesn't jump in and categorize manually while that's still in
// flight.
function isReturnTrackedVendor(merchant) {
  return /wal[\s-]?mart|wm\s*supercenter|amazon|ebay|target|costco/i.test(merchant || '');
}

const RECEIPT_MERCHANT_LABELS = {
  walmart: 'Walmart',
  amazon: 'Amazon',
  ebay: 'eBay',
  target: 'Target',
  costco: 'Costco',
};

function receiptMerchantLabel(source) {
  return RECEIPT_MERCHANT_LABELS[source] || 'Receipt';
}

// A 'deposit'-typed transaction is any credit — paycheck, internal transfer,
// interest, a card payment posting, or an actual vendor return. Only the
// last one should trigger the return-matching flow; exclude merchant
// strings that look like the generic bank-deposit language already used
// server-side to classify these as credits in the first place (see
// parseTransactionFromCSV / syncPlaidTransactions).
const GENERIC_DEPOSIT_PATTERN = /deposit|transfer|payroll|salary|interest|credit\s*card|e-?payment|auto\s*pay|card\s*pymt|\bxfr\b|pymnt/i;

function looksLikeVendorReturn(txn) {
  return txn.transaction_type === 'deposit' && !GENERIC_DEPOSIT_PATTERN.test(txn.merchant || '');
}

function awaitingReceiptBadgeHtml(txn) {
  if (txn.status !== 'pending' || txn.transaction_type === 'deposit' || !isReturnTrackedVendor(txn.merchant)) return '';
  return ' <span class="awaiting-receipt-badge">awaiting receipt</span>';
}

let state = {
  categories: [],
  dashboard: { month: '', categories: [] },
  pending: [],
  recurringTransactions: [],
  duplicates: [],
  autoLog: [],
  csvDuplicates: [],
  currentTxn: null,
  currentSplitTxn: null,
  currentReturnTxn: null,
  currentCategoryDetailId: null,
  currentMonth: new Date().toISOString().slice(0, 7),
};

let activeView = 'dashboard';
let saveBudgetsTimer = null;
let saveCategoryNoteTimer = null;
let transactionFilters = {
  month: '',
  categoryId: '',
  search: ''
};
let loadedTransactions = [];

function applyThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  applyThemeIcon();
}

window.addEventListener('DOMContentLoaded', async () => {
  applyThemeIcon();
  document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'OPEN_PENDING') switchView('pending');
      });
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && activeView === 'settings') {
      saveBudgets();
    }
  });

  document.getElementById('btn-prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('btn-next-month').addEventListener('click', () => changeMonth(1));
  document.getElementById('btn-save-budgets').addEventListener('click', saveBudgets);
  document.getElementById('btn-add-cat').addEventListener('click', addCategory);
  document.getElementById('btn-add-recurring').addEventListener('click', addRecurringTransaction);
  document.getElementById('btn-add-manual').addEventListener('click', addManualTransaction);
  document.getElementById('btn-skip').addEventListener('click', () => {
    closeModal();
    loadPending();
  });

  // Transaction log filter event listeners
  document.getElementById('transaction-month-filter').addEventListener('change', (e) => {
    transactionFilters.month = e.target.value;
    loadTransactions();
  });

  document.getElementById('transaction-category-filter').addEventListener('change', (e) => {
    transactionFilters.categoryId = e.target.value;
    loadTransactions();
  });

  document.getElementById('transaction-search').addEventListener('input', (e) => {
    transactionFilters.search = e.target.value.trim();
    renderTransactions(filterTransactionsBySearch(loadedTransactions));
  });

  // Add event listeners for notes modal buttons
  document.getElementById('btn-cancel-notes')?.addEventListener('click', () => {
    closeNotesModal();
    restoreCategoryDetailModalIfNeeded();
  });
  document.getElementById('btn-save-notes')?.addEventListener('click', saveNotes);
  document.getElementById('btn-split-transaction')?.addEventListener('click', openSplitModal);

  // Add event listeners for split modal buttons
  document.getElementById('btn-cancel-split')?.addEventListener('click', () => {
    closeSplitModal();
    restoreCategoryDetailModalIfNeeded();
  });
  document.getElementById('btn-save-split')?.addEventListener('click', saveSplit);
  document.getElementById('btn-add-split-row')?.addEventListener('click', () => addSplitRow());
  document.getElementById('btn-categorize-single')?.addEventListener('click', categorizeSplitAsSingleCategory);
  document.getElementById('modal-split')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-split') {
      closeSplitModal();
      restoreCategoryDetailModalIfNeeded();
    }
  });

  // Esc closes whichever dialog is currently open. At most one of these is
  // ever visible at a time (opening one hides any other it stacks over,
  // e.g. Notes/Split hide Category Detail underneath), so check innermost
  // dialogs first and mirror each one's own Cancel/backdrop-click behavior
  // exactly (including restoring Category Detail where applicable) rather
  // than just hiding the element.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('modal-split')?.classList.contains('hidden')) {
      closeSplitModal();
      restoreCategoryDetailModalIfNeeded();
    } else if (!document.getElementById('modal-notes')?.classList.contains('hidden')) {
      closeNotesModal();
      restoreCategoryDetailModalIfNeeded();
    } else if (!document.getElementById('modal-categorize')?.classList.contains('hidden')) {
      closeModal();
    } else if (!document.getElementById('modal-edit-category')?.classList.contains('hidden')) {
      closeEditModal();
    } else if (!document.getElementById('modal-duplicates')?.classList.contains('hidden')) {
      closeDuplicatesModal();
    } else if (!document.getElementById('modal-auto-log')?.classList.contains('hidden')) {
      closeAutoLogModal();
    } else if (!document.getElementById('modal-match-receipt')?.classList.contains('hidden')) {
      closeMatchReceiptModal();
    } else if (!document.getElementById('modal-csv-duplicates')?.classList.contains('hidden')) {
      closeCsvDuplicatesModal();
    } else if (!document.getElementById('modal-return-match')?.classList.contains('hidden')) {
      closeReturnMatchModal();
    } else if (!document.getElementById('modal-category-detail')?.classList.contains('hidden')) {
      closeCategoryDetail();
    }
  });

  // Icon picker setup
  initIconPicker('new-cat-icon-toggle', 'new-cat-icon-grid', '🏷️');
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.icon-picker-grid').forEach((grid) => {
      if (!grid.classList.contains('hidden') && !grid.parentElement.contains(e.target)) {
        grid.classList.add('hidden');
      }
    });
  });

  // Add event listeners for edit category modal buttons
  document.getElementById('btn-cancel-edit')?.addEventListener('click', closeEditModal);
  document.getElementById('btn-save-edit')?.addEventListener('click', saveCategoryEdit);

  // Pending badge jumps to the Pending view when clicked
  document.getElementById('pending-badge')?.addEventListener('click', () => switchView('pending'));

  // Add event listener for category detail modal close button
  document.getElementById('btn-close-category-detail')?.addEventListener('click', closeCategoryDetail);
  document.getElementById('modal-category-detail')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-category-detail') closeCategoryDetail();
  });
  document.getElementById('category-note-input')?.addEventListener('input', () => {
    clearTimeout(saveCategoryNoteTimer);
    saveCategoryNoteTimer = setTimeout(saveCategoryNote, 800);
  });

  // Add event listeners for possible-duplicates badge/modal
  document.getElementById('duplicate-badge')?.addEventListener('click', openDuplicatesModal);
  document.getElementById('btn-close-duplicates')?.addEventListener('click', closeDuplicatesModal);
  document.getElementById('modal-duplicates')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-duplicates') closeDuplicatesModal();
  });

  // Add event listeners for auto-categorization-log badge/modal
  document.getElementById('auto-log-badge')?.addEventListener('click', openAutoLogModal);
  document.getElementById('btn-close-auto-log')?.addEventListener('click', closeAutoLogModal);
  document.getElementById('modal-auto-log')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-auto-log') closeAutoLogModal();
  });

  // Add event listeners for the manual receipt-match modal
  document.getElementById('btn-close-match-receipt')?.addEventListener('click', closeMatchReceiptModal);
  document.getElementById('modal-match-receipt')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-match-receipt') closeMatchReceiptModal();
  });

  // Add event listeners for the CSV import duplicates badge/modal
  document.getElementById('csv-duplicates-badge')?.addEventListener('click', openCsvDuplicatesModal);
  document.getElementById('btn-close-csv-duplicates')?.addEventListener('click', closeCsvDuplicatesModal);
  document.getElementById('modal-csv-duplicates')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-csv-duplicates') closeCsvDuplicatesModal();
  });

  // Add event listeners for the return/refund match modal
  document.getElementById('btn-close-return-match')?.addEventListener('click', closeReturnMatchModal);
  document.getElementById('modal-return-match')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-return-match') closeReturnMatchModal();
  });

  document.getElementById('btn-sync-plaid')?.addEventListener('click', syncPlaidNow);
  document.getElementById('btn-connect-bank')?.addEventListener('click', connectBank);
  document.getElementById('btn-check-receipts')?.addEventListener('click', checkReceiptsNow);
  setInterval(loadReceiptStatus, 60000);
  setInterval(loadAutoCategorizationLog, 60000);
  setInterval(loadCsvDuplicates, 60000);

  // Add event listeners for import/export buttons
  document.getElementById('btn-export')?.addEventListener('click', exportDatabase);
  document.getElementById('btn-import')?.addEventListener('click', () => document.getElementById('import-file-input')?.click());
  document.getElementById('import-file-input')?.addEventListener('change', importDatabase);

  // Add event listener for CSV import button
  document.getElementById('btn-csv-import')?.addEventListener('click', () => document.getElementById('csv-file-input')?.click());
  document.getElementById('csv-file-input')?.addEventListener('change', importCSVTransactions);

  if (new URLSearchParams(window.location.search).get('pending')) {
    await loadAll();
    showApp();
    switchView('pending');
  } else {
    await loadAll();
    showApp();
  }

  if (new URLSearchParams(window.location.search).get('review-duplicates')) {
    openCsvDuplicatesModal();
  }

  if (window.location.href.includes('oauth_state_id=')) {
    switchView('settings');
    resumePlaidOAuthIfNeeded();
  }
});

function showApp() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
}

function setLoadingStatus(text, percent) {
  const statusEl = document.getElementById('loading-status');
  const fillEl = document.getElementById('loading-progress-fill');
  if (statusEl) statusEl.textContent = text;
  if (fillEl) fillEl.style.width = percent + '%';
}

async function loadAll() {
  const steps = [
    { label: 'Dashboard', fn: loadDashboard },
    { label: 'Pending transactions', fn: loadPending },
    { label: 'Categories', fn: loadCategories },
    { label: 'Recurring transactions', fn: loadRecurringTransactions },
    { label: 'Account balance', fn: loadBalance },
    { label: 'Duplicate check', fn: loadDuplicates },
    { label: 'Receipt status', fn: loadReceiptStatus },
    { label: 'Auto-categorization log', fn: loadAutoCategorizationLog },
    { label: 'CSV import duplicates', fn: loadCsvDuplicates },
  ];
  const completedLabels = new Set();
  setLoadingStatus(`Loading ${steps.map((s) => s.label).join(', ')}…`, 5);
  await Promise.all(steps.map(async (step) => {
    await step.fn();
    completedLabels.add(step.label);
    const percent = Math.round((completedLabels.size / steps.length) * 100);
    if (completedLabels.size < steps.length) {
      const remaining = steps.filter((s) => !completedLabels.has(s.label)).map((s) => s.label);
      setLoadingStatus(`${step.label} ready — waiting on ${remaining.join(', ')}…`, percent);
    } else {
      setLoadingStatus('Ready!', 100);
    }
  }));
}

async function loadDuplicates() {
  try {
    const data = await apiFetch('/api/duplicates');
    state.duplicates = data.duplicates;
    updateDuplicateBadge(data.duplicates.length);
  } catch (err) {
    console.error('Duplicates load failed:', err);
  }
}

function updateDuplicateBadge(count) {
  const badge = document.getElementById('duplicate-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderDuplicates() {
  const list = document.getElementById('duplicate-list');
  if (!state.duplicates.length) {
    list.innerHTML = '<div class="empty-state">No possible duplicates 🎉</div>';
    return;
  }
  list.innerHTML = '';
  state.duplicates.forEach((dup) => {
    const pair = document.createElement('div');
    pair.className = 'duplicate-pair';
    const renderTxn = (txn, otherId) => `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">${txn.merchant || 'Unknown merchant'}</div>
          <div class="duplicate-txn-meta">${formatDate(txn.occurredAt)} · ${txn.source} · #${txn.id}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(txn.amount)}</div>
          <button class="btn-keep-duplicate" data-keep="${txn.id}" data-remove="${otherId}">Keep this one</button>
        </div>
      </div>
    `;
    pair.innerHTML = renderTxn(dup.a, dup.b.id) + renderTxn(dup.b, dup.a.id) +
      `<button class="btn-dismiss-duplicate" data-flag-id="${dup.flagId}">Not a duplicate — keep both</button>`;
    pair.querySelectorAll('.btn-keep-duplicate').forEach((btn) => {
      btn.addEventListener('click', () => resolveDuplicate(dup.flagId, Number(btn.dataset.keep), Number(btn.dataset.remove)));
    });
    pair.querySelector('.btn-dismiss-duplicate').addEventListener('click', () => dismissDuplicate(dup.flagId));
    list.appendChild(pair);
  });
}

async function resolveDuplicate(flagId, keepId, removeId) {
  if (!confirm(`Keep transaction #${keepId} and permanently delete #${removeId}?`)) return;
  try {
    await apiFetch(`/api/transactions/${removeId}`, { method: 'DELETE' });
    state.duplicates = state.duplicates.filter((d) => d.flagId !== flagId);
    updateDuplicateBadge(state.duplicates.length);
    renderDuplicates();
    await loadDashboard();
    await loadPending();
    if (activeView === 'transactions') await loadTransactions();
  } catch (err) {
    showErrorToast(`Failed to resolve duplicate: ${err.message}`);
  }
}

async function dismissDuplicate(flagId) {
  try {
    await apiFetch(`/api/duplicates/${flagId}/dismiss`, { method: 'POST' });
    state.duplicates = state.duplicates.filter((d) => d.flagId !== flagId);
    updateDuplicateBadge(state.duplicates.length);
    renderDuplicates();
  } catch (err) {
    showErrorToast(`Failed to dismiss duplicate: ${err.message}`);
  }
}

function openDuplicatesModal() {
  renderDuplicates();
  document.getElementById('modal-duplicates').classList.remove('hidden');
}

function closeDuplicatesModal() {
  document.getElementById('modal-duplicates').classList.add('hidden');
}

async function loadAutoCategorizationLog() {
  try {
    const data = await apiFetch('/api/auto-categorizations');
    state.autoLog = data.entries;
    updateAutoLogBadge(data.entries.length);
  } catch (err) {
    console.error('Auto-categorization log load failed:', err);
  }
}

function updateAutoLogBadge(count) {
  const badge = document.getElementById('auto-log-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function autoLogMethodLabel(entry) {
  if (entry.method === 'receipt') {
    return `🧾 ${receiptMerchantLabel(entry.source)} receipt`;
  }
  if (entry.method === 'merchant_map') return '🔁 remembered merchant';
  if (entry.method === 'auto_label') return '🏷️ auto-detected';
  return entry.method;
}

function renderAutoLog() {
  const list = document.getElementById('auto-log-list');
  if (!state.autoLog.length) {
    list.innerHTML = '<div class="empty-state">No auto-categorized transactions in the last 10 days</div>';
    return;
  }
  list.innerHTML = '';
  state.autoLog.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'duplicate-pair auto-log-row';
    const categoryLabel = entry.categoryName ? `${entry.categoryIcon || ''} ${entry.categoryName}` : 'Split across categories';
    row.innerHTML = `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">${entry.merchant || 'Unknown merchant'}</div>
          <div class="duplicate-txn-meta">${categoryLabel} · ${autoLogMethodLabel(entry)} · ${formatRelativeTime(entry.createdAt)}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(entry.amount)}</div>
        </div>
      </div>
    `;
    row.addEventListener('click', () => openAutoLogEntryDetail(entry.transactionId));
    list.appendChild(row);
  });
}

async function openAutoLogEntryDetail(transactionId) {
  if (!transactionId) return;
  try {
    const txn = await apiFetch(`/api/transactions/${transactionId}`);
    closeAutoLogModal();
    openNotesModal(txn);
  } catch (err) {
    console.error('Failed to load transaction from auto-log:', err);
    alert('That transaction could not be found (it may have been deleted).');
  }
}

function openAutoLogModal() {
  renderAutoLog();
  document.getElementById('modal-auto-log').classList.remove('hidden');
}

function closeAutoLogModal() {
  document.getElementById('modal-auto-log').classList.add('hidden');
}

function formatRelativeTime(isoString) {
  const then = new Date(isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - then.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Shared transient status line under the compact header — replaces the
// permanently-visible sync/receipt status text that used to sit in the
// header at all times. Both actions share one line since only one is ever
// likely to be running at a time.
let headerStatusTimer = null;
function showHeaderStatus(text, ms) {
  const el = document.getElementById('header-status-line');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(headerStatusTimer);
  headerStatusTimer = setTimeout(() => el.classList.add('hidden'), ms || 3000);
}

// Auto-refresh runs twice daily (~12h apart) — if it's been meaningfully
// longer than that since the balance last updated, the cron may have missed
// a run, so nudge toward a manual sync with a dot instead of silently
// showing stale numbers.
const BALANCE_STALE_HOURS = 13;

async function loadBalance() {
  try {
    const data = await apiFetch('/api/plaid/balance');
    const el = document.getElementById('account-balance');
    const dot = document.getElementById('sync-dot');
    const btn = document.getElementById('btn-sync-plaid');
    if (data.checking === null && data.savings === null) {
      el.classList.add('hidden');
      return;
    }
    document.getElementById('account-balance-checking').textContent = fmt(data.checking ?? 0);
    document.getElementById('account-balance-savings').textContent = fmt(data.savings ?? 0);
    if (btn) {
      btn.title = data.asOf
        ? `Sync now — updated ${formatRelativeTime(data.asOf)}`
        : 'Sync now';
    }
    if (dot) {
      const hoursSince = data.asOf ? (Date.now() - new Date(data.asOf).getTime()) / 3600000 : 0;
      dot.classList.toggle('hidden', !data.asOf || hoursSince < BALANCE_STALE_HOURS);
    }
    el.classList.remove('hidden');
  } catch (err) {
    console.error('Balance load failed:', err);
  }
}

// Mirrors what handlePlaidSyncNow actually does server-side (refresh call,
// a 5s wait for Plaid to check the bank, then paging through /transactions/sync,
// then a balance refresh) so the status line means something instead of
// just saying "syncing" for up to 30s straight.
const SYNC_STATUS_STEPS = [
  { at: 0, text: 'Asking Plaid to check your bank…' },
  { at: 2000, text: 'Waiting for your bank to respond…' },
  { at: 6000, text: 'Pulling new transactions…' },
  { at: 14000, text: 'Still pulling — larger syncs take longer…' },
  { at: 24000, text: 'Updating account balance…' },
];

async function syncPlaidNow() {
  const btn = document.getElementById('btn-sync-plaid');
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('busy');
  const timers = SYNC_STATUS_STEPS.map((step) => setTimeout(() => {
    showHeaderStatus(step.text, 10000);
  }, step.at));
  try {
    const data = await apiFetch('/api/plaid/sync-now', { method: 'POST' });
    if (data.errors && data.errors.length > 0) {
      const names = data.errors.map((e) => e.institution_name || e.item_id).join(', ');
      showHeaderStatus(`✗ Sync failed for ${names} — reconnect in Settings`, 8000);
      showErrorToast(`Plaid connection broken for ${names}. Go to Settings to reconnect.`);
    } else {
      showHeaderStatus(data.added > 0 ? `✓ Added ${data.added} new transaction(s)` : '✓ Nothing new since last check');
    }
    await Promise.all([loadDashboard(), loadPending(), loadBalance(), loadDuplicates(), loadLinkedAccounts()]);
    if (activeView === 'transactions') await loadTransactions();
  } catch (err) {
    showHeaderStatus(`✗ Sync failed: ${err.message}`, 5000);
  } finally {
    timers.forEach(clearTimeout);
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

const RECEIPT_CHECK_INTERVAL_MINUTES = 30;

function renderReceiptStatusText(data) {
  const btn = document.getElementById('btn-check-receipts');
  if (!btn) return;
  if (!data.lastRunAt) {
    btn.title = 'Check the receipt inbox — not checked yet';
    return;
  }
  const lastRun = new Date(data.lastRunAt.includes('T') ? data.lastRunAt : data.lastRunAt.replace(' ', 'T') + 'Z');
  const minutesSince = Math.floor((Date.now() - lastRun.getTime()) / 60000);
  const minutesLeft = Math.max(0, RECEIPT_CHECK_INTERVAL_MINUTES - minutesSince);
  const foundText = data.lastRunCount ? ` (found ${data.lastRunCount})` : '';
  const nextText = minutesLeft > 0 ? `next check in ~${minutesLeft}m` : 'checking again soon';
  btn.title = `Checked ${formatRelativeTime(data.lastRunAt)}${foundText} · ${nextText}`;
}

// Builds the same "header line + bullet lines" text shape that
// renderReceiptItemsNote() already knows how to render, from a receipt's raw
// parsed_json — lets the unclaimed-receipt list and match modal show what
// was actually scanned, to help pick the right transaction to attach to.
function receiptItemsNoteText(receipt) {
  if (!receipt.parsed_json) return '';
  let parsed;
  try {
    parsed = JSON.parse(receipt.parsed_json);
  } catch {
    return '';
  }
  if (!parsed.items || !parsed.items.length) return '';
  const merchantLabel = receiptMerchantLabel(receipt.source);
  const lines = parsed.items.map((i) =>
    `• ${i.description}${i.friendlyName ? ` (≈ ${i.friendlyName})` : ''} — ${fmt(i.amount)} (${i.category})`
  );
  return [`${merchantLabel} items:`, ...lines].join('\n');
}

function renderUnclaimedReceipts(receipts) {
  const listEl = document.getElementById('unclaimed-receipts-list');
  const dot = document.getElementById('receipts-dot');
  if (dot) dot.classList.toggle('hidden', !receipts || !receipts.length);
  if (!listEl) return;
  if (!receipts || !receipts.length) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  listEl.classList.remove('hidden');
  listEl.innerHTML = '';
  receipts.forEach((r) => {
    const row = document.createElement('div');
    const isConflict = r.status === 'already_complete';
    row.className = `unclaimed-receipt-row unclaimed-receipt-row-clickable${isConflict ? ' unclaimed-receipt-row-conflict' : ''}`;
    const merchantLabel = receiptMerchantLabel(r.source);
    const icon = isConflict ? '⚠️' : '🧾';
    const message = isConflict
      ? `${merchantLabel} receipt for ${fmt(r.receipt_total)} on ${formatDate(r.receipt_date)} — a matching transaction was already categorized (tap to review & re-categorize)`
      : `${merchantLabel} receipt for ${fmt(r.receipt_total)} on ${formatDate(r.receipt_date)} — waiting for the bank to report this transaction (tap to attach manually)`;
    row.innerHTML = `
      <span class="unclaimed-receipt-icon">${icon}</span>
      <span class="unclaimed-receipt-text">${message}</span>
    `;
    row.addEventListener('click', () => openMatchReceiptModal(r));
    listEl.appendChild(row);
    const itemsText = receiptItemsNoteText(r);
    if (itemsText) {
      const itemsEl = document.createElement('div');
      itemsEl.className = 'split-receipt-items transaction-notes';
      renderReceiptItemsNote(itemsEl, itemsText);
      listEl.appendChild(itemsEl);
    }
  });
}

// ============================================================
// Manual Receipt Match Modal
// ============================================================

async function openMatchReceiptModal(receipt) {
  const merchantLabel = receiptMerchantLabel(receipt.source);
  const labelText = receipt.status === 'already_complete'
    ? `$${receipt.receipt_total.toFixed(2)} ${merchantLabel} receipt (${formatDate(receipt.receipt_date)}) already matched a categorized transaction — re-categorize to:`
    : `Attach $${receipt.receipt_total.toFixed(2)} ${merchantLabel} receipt (${formatDate(receipt.receipt_date)}) to:`;
  document.getElementById('match-receipt-label').textContent = labelText;
  renderReceiptItemsNote(document.getElementById('match-receipt-items'), receiptItemsNoteText(receipt));
  const listEl = document.getElementById('match-receipt-candidates');
  listEl.innerHTML = '<div class="empty-state">Loading…</div>';
  document.getElementById('modal-match-receipt').classList.remove('hidden');
  let data;
  try {
    data = await apiFetch(`/api/receipts/${receipt.id}/candidates`);
  } catch (err) {
    console.error('Failed to load match candidates:', err);
    listEl.innerHTML = `<div class="empty-state empty-state-error">⚠️ Failed to load candidate transactions: ${err.message}</div>`;
    return;
  }
  if (!data.candidates.length) {
    listEl.innerHTML = '<div class="empty-state">No nearby transactions found for this merchant</div>';
    return;
  }
  listEl.innerHTML = '';
  data.candidates.forEach((txn) => {
    const row = document.createElement('div');
    row.className = 'duplicate-pair auto-log-row';
    const statusLabel = txn.status === 'categorized' ? '(currently categorized — will be overridden)' : `(${txn.status})`;
    row.innerHTML = `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">${txn.merchant || 'Unknown merchant'}</div>
          <div class="duplicate-txn-meta">${formatDate(txn.occurred_at)} · ${statusLabel}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(txn.amount)}</div>
        </div>
      </div>
    `;
    row.addEventListener('click', () => matchReceiptToTransaction(receipt.id, txn.id));
    listEl.appendChild(row);
  });
}

async function matchReceiptToTransaction(receiptId, transactionId) {
  try {
    await apiFetch(`/api/receipts/${receiptId}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId }),
    });
    closeMatchReceiptModal();
    await Promise.all([loadReceiptStatus(), refreshAfterTransactionChange(), loadAutoCategorizationLog()]);
  } catch (err) {
    console.error('Match receipt failed:', err);
    alert(`Failed to attach receipt: ${err.message}`);
  }
}

function closeMatchReceiptModal() {
  document.getElementById('modal-match-receipt').classList.add('hidden');
}

// ============================================================
// Return/Refund Match Modal
// ============================================================

async function openReturnMatchModal(txn) {
  state.currentReturnTxn = txn;
  document.getElementById('return-match-label').textContent = `${txn.merchant} credited $${txn.amount.toFixed(2)} on ${formatDate(txn.occurred_at)} — what was returned?`;
  const suggestedEl = document.getElementById('return-match-suggested');
  const listEl = document.getElementById('return-match-candidates');
  suggestedEl.innerHTML = '';
  suggestedEl.classList.add('hidden');
  listEl.innerHTML = '<div class="empty-state">Loading…</div>';
  document.getElementById('modal-return-match').classList.remove('hidden');

  let data;
  try {
    data = await apiFetch(`/api/returns/candidates?merchant=${encodeURIComponent(txn.merchant || '')}&amount=${txn.amount}`);
  } catch (err) {
    console.error('Failed to load return candidates:', err);
    listEl.innerHTML = `<div class="empty-state empty-state-error">⚠️ Failed to load candidate items: ${err.message}</div>`;
    return;
  }

  if (!data.supported) {
    renderReturnCategoryPicker("This vendor doesn't have itemized receipt history yet — pick a category to remove this amount from:");
    return;
  }

  const suggested = data.candidates.find((c) => c.candidateId === data.suggestedCandidateId);
  const rest = data.candidates.filter((c) => c.candidateId !== data.suggestedCandidateId);

  if (suggested) {
    suggestedEl.classList.remove('hidden');
    suggestedEl.innerHTML = `
      <div class="modal-label">Suggested match</div>
      <div class="duplicate-pair auto-log-row" id="return-suggested-row">
        <div class="duplicate-txn">
          <div class="duplicate-txn-info">
            <div class="duplicate-txn-merchant">${suggested.description}</div>
            <div class="duplicate-txn-meta">${formatDate(suggested.receiptDate)} · ${suggested.category}</div>
          </div>
          <div class="duplicate-txn-right">
            <div class="duplicate-txn-amount">${fmt(suggested.amount)}</div>
          </div>
        </div>
      </div>
      <button type="button" class="btn-save-notes" id="btn-confirm-return-match">Confirm this match</button>
    `;
    document.getElementById('btn-confirm-return-match').addEventListener('click', () => confirmReturnMatch(suggested.candidateId));
  }

  if (!data.candidates.length) {
    renderReturnCategoryPicker(`No itemized purchases found from ${txn.merchant} in the last 60 days — pick a category to remove this amount from:`);
    return;
  }

  listEl.innerHTML = rest.length ? '<div class="modal-label">Not this one? Pick the actual item:</div>' : '';
  rest.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'duplicate-pair auto-log-row';
    row.innerHTML = `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">${c.description}</div>
          <div class="duplicate-txn-meta">${formatDate(c.receiptDate)} · ${c.category}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(c.amount)}</div>
        </div>
      </div>
    `;
    row.addEventListener('click', () => confirmReturnMatch(c.candidateId));
    listEl.appendChild(row);
  });
}

async function confirmReturnMatch(candidateId) {
  if (!state.currentReturnTxn) return;
  try {
    await apiFetch(`/api/returns/${state.currentReturnTxn.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId }),
    });
    closeReturnMatchModal();
    await refreshAfterTransactionChange();
  } catch (err) {
    console.error('Resolve return failed:', err);
    alert(`Failed to match return: ${err.message}`);
  }
}

function closeReturnMatchModal() {
  document.getElementById('modal-return-match').classList.add('hidden');
  state.currentReturnTxn = null;
}

// Fallback for vendors with no itemized receipt history (e.g. Target): skip
// item-matching entirely and just let the user pick which category this
// credit should be removed from — same negative-amount mechanism underneath.
function renderReturnCategoryPicker(message) {
  const suggestedEl = document.getElementById('return-match-suggested');
  const listEl = document.getElementById('return-match-candidates');
  listEl.innerHTML = '';
  suggestedEl.classList.remove('hidden');
  suggestedEl.innerHTML = `
    <div class="empty-state">${message}</div>
    <div class="modal-cats" id="return-category-picker"></div>
  `;
  const picker = document.getElementById('return-category-picker');
  state.categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'modal-cat-btn';
    btn.innerHTML = `<span class="modal-cat-icon">${cat.icon}</span>${cat.name}`;
    btn.addEventListener('click', () => confirmReturnCategoryOnly(cat.id));
    picker.appendChild(btn);
  });
}

async function confirmReturnCategoryOnly(categoryId) {
  if (!state.currentReturnTxn) return;
  try {
    await apiFetch(`/api/returns/${state.currentReturnTxn.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId }),
    });
    closeReturnMatchModal();
    await refreshAfterTransactionChange();
  } catch (err) {
    console.error('Resolve return failed:', err);
    alert(`Failed to match return: ${err.message}`);
  }
}

async function loadReceiptStatus() {
  try {
    const data = await apiFetch('/api/receipts/status');
    renderReceiptStatusText(data);
    renderUnclaimedReceipts(data.unclaimedReceipts);
  } catch (err) {
    console.error('Loading receipt status failed:', err);
  }
}

async function checkReceiptsNow() {
  const btn = document.getElementById('btn-check-receipts');
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('busy');
  showHeaderStatus('Checking receipt inbox…', 10000);
  try {
    const data = await apiFetch('/api/receipts/sync-now', { method: 'POST' });
    showHeaderStatus(data.count > 0 ? `✓ ${data.count} receipt(s) processed` : '✓ Nothing new');
    await loadReceiptStatus();
    await loadPending();
  } catch (err) {
    showErrorToast(`Receipt check failed: ${err.message}`);
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

async function loadLinkedAccounts() {
  const listEl = document.getElementById('linked-accounts-list');
  if (!listEl) return;
  try {
    const data = await apiFetch('/api/plaid/items');
    if (!data.items || data.items.length === 0) {
      listEl.innerHTML = '<div class="linked-accounts-empty">No banks connected yet</div>';
      return;
    }
    listEl.innerHTML = data.items.map((item) => {
      const broken = item.status && item.status !== 'ok';
      return `
      <div class="linked-account-row${broken ? ' linked-account-row-broken' : ''}">
        <div class="linked-account-info">
          <span class="linked-account-name">${item.institution_name || 'Unknown institution'}</span>
          <span class="linked-account-since">${broken
            ? `⚠️ Connection broken${item.error_code ? ` (${item.error_code})` : ''}`
            : `Connected ${formatDate(item.created_at)}`}</span>
        </div>
        ${broken ? `<button class="btn-reconnect-bank" data-item-id="${item.id}">Reconnect</button>` : ''}
      </div>
    `;
    }).join('');
    listEl.querySelectorAll('.btn-reconnect-bank').forEach((btn) => {
      btn.addEventListener('click', () => reconnectBank(btn.dataset.itemId, btn));
    });
  } catch (err) {
    console.error('Loading linked accounts failed:', err);
    listEl.innerHTML = '<div class="linked-accounts-empty">Couldn\'t load linked accounts</div>';
  }
}

// OAuth institutions (Discover, Chase, etc.) send the user to the bank's own
// login page, then redirect back to us with an `oauth_state_id` query param.
// Link has to be re-opened with the *same* link_token plus the redirect URL
// to resume where it left off, so we stash the token across that reload.
function createPlaidLinkHandler(token, btn) {
  const isOAuthResume = window.location.href.includes('oauth_state_id=');
  const originalLabel = btn ? btn.textContent : null;
  return Plaid.create({
    token,
    receivedRedirectUri: isOAuthResume ? window.location.href : void 0,
    onSuccess: async (public_token, metadata) => {
      sessionStorage.removeItem('plaid_link_token');
      if (btn) btn.textContent = 'Connecting…';
      try {
        await apiFetch('/api/plaid/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            public_token,
            institution_name: metadata?.institution?.name || null
          })
        });
        await loadLinkedAccounts();
      } catch (err) {
        showErrorToast(`Connected to Plaid, but saving the account failed: ${err.message}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      }
    },
    onExit: (err) => {
      sessionStorage.removeItem('plaid_link_token');
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
      if (err) console.error('Plaid Link exited with error:', err);
    }
  });
}

async function connectBank() {
  const btn = document.getElementById('btn-connect-bank');
  if (!btn || typeof Plaid === 'undefined') return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const { link_token } = await apiFetch('/api/plaid/link-token', { method: 'POST' });
    sessionStorage.setItem('plaid_link_token', link_token);
    createPlaidLinkHandler(link_token, btn).open();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '+ Connect a bank';
    showErrorToast(`Could not start bank connection: ${err.message}`);
  }
}

// Update-mode reconnect: reuses the broken Item instead of linking a new
// one, by asking the server for a link_token scoped to that item's
// access_token (see handlePlaidCreateLinkToken). Button state is handed off
// to createPlaidLinkHandler's onSuccess/onExit once Link opens, same as
// connectBank() does.
async function reconnectBank(itemDbId, btn) {
  if (!itemDbId || typeof Plaid === 'undefined') return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const { link_token } = await apiFetch('/api/plaid/link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemDbId })
    });
    sessionStorage.setItem('plaid_link_token', link_token);
    createPlaidLinkHandler(link_token, btn).open();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Reconnect';
    showErrorToast(`Could not start reconnect: ${err.message}`);
  }
}

function resumePlaidOAuthIfNeeded() {
  if (typeof Plaid === 'undefined') return;
  const token = sessionStorage.getItem('plaid_link_token');
  if (!token) return;
  const btn = document.getElementById('btn-connect-bank');
  createPlaidLinkHandler(token, btn).open();
  window.history.replaceState({}, document.title, window.location.pathname);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, { cache: 'no-store', ...options });
  if (!res.ok) {
    let errorMessage = `API error ${res.status}`;
    try {
      const errorData = await res.json();
      if (errorData.error) {
        errorMessage = errorData.error;
      }
    } catch (e) {
      // Couldn't parse error response, use default message
    }
    throw new Error(errorMessage);
  }
  return res.json();
}

function changeMonth(delta) {
  const [year, month] = state.currentMonth.split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1);
  state.currentMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  loadDashboard();

  // Keep the Transactions tab's month filter in sync with the top month picker.
  transactionFilters.month = state.currentMonth;
  if (activeView === 'transactions') {
    loadTransactions();
    populateTransactionFilters();
  }
}

async function loadDashboard() {
  try {
    const data = await apiFetch('/api/dashboard?month=' + state.currentMonth);
    state.dashboard = data;
    renderDashboard(data);
  } catch (err) {
    console.error('Dashboard load failed:', err);
  }
}

// ============================================================
// Database Export/Import Functions
// ============================================================

async function exportDatabase() {
  try {
    const response = await fetch('/api/export');
    if (!response.ok) {
      throw new Error(`Export failed: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budget-tracker-export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    // Show success feedback
    const btn = document.getElementById('btn-export');
    btn.textContent = 'Exported ✓';
    btn.style.background = '#16a34a';
    setTimeout(() => {
      btn.textContent = 'Export Database';
      btn.style.background = '';
    }, 1500);

  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed: ' + err.message);
  }
}

async function importDatabase(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.name.endsWith('.csv')) {
    alert('Please select a CSV file');
    event.target.value = '';
    return;
  }

  if (!confirm('WARNING: This will replace all your current data (except default categories). Are you sure you want to import this backup?')) {
    event.target.value = '';
    return;
  }

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const csvContent = e.target.result;

        const btn = document.getElementById('btn-import');
        btn.textContent = 'Importing...';
        btn.disabled = true;

        const response = await fetch('/api/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/csv',
          },
          body: csvContent,
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Import failed: ${response.status}`);
        }

        const result = await response.json();

        // Show success feedback
        btn.textContent = 'Imported ✓';
        btn.style.background = '#16a34a';
        setTimeout(() => {
          btn.textContent = 'Import Database';
          btn.style.background = '';
          btn.disabled = false;
        }, 1500);

        // Clear the file input
        event.target.value = '';

        // Refresh all data
        await loadAll();
        if (activeView === 'settings') {
          renderSettings(state.categories);
          renderRecurringTransactions();
        }
        if (activeView === 'transactions') {
          await loadTransactions();
        }

        alert('Database imported successfully! All data has been refreshed.');

      } catch (err) {
        console.error('Import failed:', err);
        alert('Import failed: ' + err.message);
        const btn = document.getElementById('btn-import');
        btn.textContent = 'Import Database';
        btn.style.background = '';
        btn.disabled = false;
        event.target.value = '';
      }
    };
    reader.readAsText(file);

  } catch (err) {
    console.error('Import failed:', err);
    alert('Import failed: ' + err.message);
    const btn = document.getElementById('btn-import');
    btn.textContent = 'Import Database';
    btn.style.background = '';
    btn.disabled = false;
    event.target.value = '';
  }
}


function renderDashboard(data) {
  const [year, month] = data.month.split('-');
  const monthName = new Date(year, parseInt(month) - 1).toLocaleString('default', { month: 'long' });
  document.getElementById('topbar-month').textContent = `${monthName} ${year}`;

  const totalBudgeted = data.categories.reduce((s, c) => s + c.allotted, 0);
  const totalSpent = data.categories.reduce((s, c) => s + c.spent, 0);

  document.getElementById('stat-budgeted').textContent = fmt(totalBudgeted);
  document.getElementById('stat-spent').textContent = fmt(totalSpent);
  const remaining = totalBudgeted - totalSpent;
  const pieRemainingEl = document.getElementById('pie-remaining');
  pieRemainingEl.style.color = remaining < 0 ? '#ff3b30' : '#34c759';
  animateNumber(pieRemainingEl, remaining);

  drawPie(data.categories);
  renderBudgetExtremes(data.categories);
  renderTopMerchants(data.topMerchants || [], 'pie-chart-merchants', 'pie-tooltip-merchants', 'legend-merchants', 'pie-merchants-total');
  renderTopMerchants(data.lifetimeTopMerchants || [], 'pie-chart-merchants-lifetime', 'pie-tooltip-merchants-lifetime', 'legend-merchants-lifetime', 'pie-merchants-lifetime-total');

  const list = document.getElementById('category-list');
  list.innerHTML = '';
  const sortedCategories = [...data.categories].sort((a, b) => (b.allotted - b.spent) - (a.allotted - a.spent));
  sortedCategories.forEach((cat) => {
    const pct = cat.allotted > 0 ? Math.min((cat.spent / cat.allotted) * 100, 100) : 0;
    const remaining = cat.allotted - cat.spent;
    const overBudget = remaining < 0;
    const rolloverNote = cat.rollover && cat.rolledOver
      ? `<div class="cat-rollover-note">🔁 ${cat.rolledOver >= 0 ? '+' : '-'}${fmt(Math.abs(cat.rolledOver))} rolled ${cat.rolledOver >= 0 ? 'in' : '(deficit)'} from prior months</div>`
      : '';
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <div class="cat-icon">${cat.icon}</div>
      <div class="cat-info">
        <div class="cat-name">${cat.name}</div>
        <div class="cat-amounts">${fmt(cat.spent)} of ${fmt(cat.allotted)}</div>
        ${rolloverNote}
        ${cat.note ? `<div class="cat-note">${cat.note}</div>` : ''}
        <div class="cat-bar-wrap">
          <div class="cat-bar" style="width:0%;background:${cat.color}" data-pct="${pct}"></div>
        </div>
      </div>
      <div class="cat-remaining" style="color:${overBudget ? 'var(--danger)' : 'var(--accent)'}">
        ${overBudget ? '-' : ''}${fmt(Math.abs(remaining))}
      </div>
    `;
    card.addEventListener('click', () => openCategoryDetail(cat));
    list.appendChild(card);
    requestAnimationFrame(() => {
      setTimeout(() => { card.querySelector('.cat-bar').style.width = pct + '%'; }, 50);
    });
  });
}

const chartSlices = {}; // canvasId -> [{ startAngle, endAngle, innerR, outerR, cx, cy, data }]
const chartHoverBound = {}; // canvasId -> bool

const PIE_OTHERS_THRESHOLD = 0.05;

function drawPie(categories) {
  const cats = categories.filter((c) => c.spent > 0);
  const total = cats.reduce((s, c) => s + c.spent, 0);
  // Visual-only grouping: anything under 5% of total spend gets folded into
  // a single "Others" slice so the chart doesn't turn into a wall of tiny
  // slivers. Doesn't touch the underlying category data anywhere else.
  const major = [];
  let othersTotal = 0;
  cats.forEach((cat) => {
    if (total > 0 && cat.spent / total < PIE_OTHERS_THRESHOLD) {
      othersTotal += cat.spent;
    } else {
      major.push(cat);
    }
  });
  const items = major.map((cat) => ({ label: cat.name, icon: cat.icon, color: cat.color, amount: cat.spent }));
  if (othersTotal > 0) {
    items.push({ label: 'Others', icon: '➕', color: '#4b5563', amount: othersTotal });
  }
  drawDonut('pie-chart', 'pie-tooltip', items, { outerR: 220, innerR: 144, gap: 0 });
}

function drawDonut(canvasId, tooltipId, items, { outerR, innerR, gap } = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const or = outerR ?? cx - 6;
  const ir = innerR ?? or * 0.62;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  chartSlices[canvasId] = [];

  const total = items.reduce((s, item) => s + item.amount, 0);
  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, or, 0, Math.PI * 2);
    ctx.arc(cx, cy, ir, 0, Math.PI * 2, true);
    ctx.fillStyle = '#243055';
    ctx.fill();
    hideChartTooltip(tooltipId);
    return;
  }

  let startAngle = -Math.PI / 2;
  const sliceGap = gap ?? (items.length > 1 ? 0.05 : 0);

  items.forEach((item) => {
    // Clamp at 0: for a slice thinner than the gap itself (a very small
    // category), the raw share minus the gap goes negative, which makes
    // endAngle < startAngle. ctx.arc() with no anticlockwise flag then
    // sweeps the long way around (clockwise, wrapping past 2π) instead of
    // drawing a tiny sliver — painting almost the entire donut in that
    // item's color and clobbering everything drawn before it. Clamping
    // means a slice that thin just doesn't get a visible gap-separated
    // wedge, which is correct — it's too small to show one anyway.
    const sliceAngle = Math.max(0, (item.amount / total) * (Math.PI * 2) - sliceGap);
    const endAngle = startAngle + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, or, startAngle, endAngle);
    ctx.arc(cx, cy, ir, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    chartSlices[canvasId].push({ startAngle, endAngle, innerR: ir, outerR: or, cx, cy, data: item });
    startAngle = endAngle + sliceGap;
  });

  bindChartHover(canvasId, tooltipId);
}

function bindChartHover(canvasId, tooltipId) {
  if (chartHoverBound[canvasId]) return;
  chartHoverBound[canvasId] = true;

  const canvas = document.getElementById(canvasId);
  const wrap = canvas.closest('.pie-wrap');
  if (!canvas || !wrap) return;

  const pick = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return findSliceAt(chartSlices[canvasId] || [], x, y);
  };

  canvas.addEventListener('mousemove', (e) => {
    const slice = pick(e.clientX, e.clientY);
    if (slice) showChartTooltip(tooltipId, wrap, slice.data, e.clientX, e.clientY);
    else hideChartTooltip(tooltipId);
  });

  canvas.addEventListener('mouseleave', () => hideChartTooltip(tooltipId));

  // Basic touch support: tap a slice to show its tooltip briefly.
  canvas.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const slice = pick(touch.clientX, touch.clientY);
    if (slice) {
      showChartTooltip(tooltipId, wrap, slice.data, touch.clientX, touch.clientY);
      setTimeout(() => hideChartTooltip(tooltipId), 1800);
    }
  }, { passive: true });
}

function findSliceAt(slices, x, y) {
  for (const slice of slices) {
    const dx = x - slice.cx;
    const dy = y - slice.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < slice.innerR || dist > slice.outerR) continue;

    let angle = Math.atan2(dy, dx);
    // Normalize angle range to match the -PI/2 start used when drawing.
    while (angle < slice.startAngle) angle += Math.PI * 2;
    while (angle > slice.startAngle + Math.PI * 2) angle -= Math.PI * 2;

    if (angle >= slice.startAngle && angle <= slice.endAngle) {
      return slice;
    }
  }
  return null;
}

function showChartTooltip(tooltipId, wrap, data, clientX, clientY) {
  const tooltip = document.getElementById(tooltipId);
  if (!tooltip || !wrap) return;

  const wrapRect = wrap.getBoundingClientRect();
  tooltip.innerHTML = `
    <div class="pie-tooltip-name"><span class="pie-tooltip-swatch" style="background:${data.color}"></span>${data.icon || ''} ${data.label}</div>
    <div class="pie-tooltip-amount">${fmt(data.amount)}</div>
  `;
  tooltip.style.left = `${clientX - wrapRect.left}px`;
  tooltip.style.top = `${clientY - wrapRect.top}px`;
  tooltip.classList.remove('hidden');
}

function hideChartTooltip(tooltipId) {
  const tooltip = document.getElementById(tooltipId);
  if (tooltip) tooltip.classList.add('hidden');
}

function renderBudgetExtremes(categories) {
  const withRemaining = categories.map((c) => ({ ...c, remaining: c.allotted - c.spent }));
  const over = withRemaining
    .filter((c) => c.remaining < 0)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 3);
  const under = withRemaining
    .filter((c) => c.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 3);

  const overTotal = over.reduce((s, c) => s + Math.abs(c.remaining), 0);
  const underTotal = under.reduce((s, c) => s + c.remaining, 0);

  drawDonut('pie-chart-over', 'pie-tooltip-over', over.map((c) => ({
    label: c.name, icon: c.icon, color: c.color, amount: Math.abs(c.remaining)
  })), { outerR: 220, innerR: 144 });
  drawDonut('pie-chart-under', 'pie-tooltip-under', under.map((c) => ({
    label: c.name, icon: c.icon, color: c.color, amount: c.remaining
  })), { outerR: 220, innerR: 144 });
  renderMiniLegend('legend-over', over, (c) => Math.abs(c.remaining), 'No categories over budget 🎉');
  renderMiniLegend('legend-under', under, (c) => c.remaining, 'None yet');

  animateNumber(document.getElementById('pie-over-total'), overTotal);
  animateNumber(document.getElementById('pie-under-total'), underTotal);
}

// Distinct palette from category colors, since merchants have no color of their own.
const MERCHANT_PALETTE = ['#7c3aed', '#0ea5e9', '#f43f5e', '#f59e0b', '#10b981'];

function renderTopMerchants(topMerchants, canvasId, tooltipId, legendId, totalId) {
  const merchants = topMerchants.map((m, i) => ({
    name: m.merchant,
    icon: '💸',
    color: MERCHANT_PALETTE[i % MERCHANT_PALETTE.length],
    total: m.total
  }));
  const total = merchants.reduce((s, m) => s + m.total, 0);

  drawDonut(canvasId, tooltipId, merchants.map((m) => ({
    label: m.name, icon: m.icon, color: m.color, amount: m.total
  })), { outerR: 220, innerR: 144 });
  renderMiniLegend(legendId, merchants, (m) => m.total, 'No spending yet');
  animateNumber(document.getElementById(totalId), total);
}

function renderMiniLegend(containerId, cats, valueFn, emptyText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!cats.length) {
    container.innerHTML = `<div class="mini-pie-legend-empty">${emptyText}</div>`;
    return;
  }
  cats.forEach((cat) => {
    const row = document.createElement('div');
    row.className = 'mini-pie-legend-row';
    row.innerHTML = `
      <span class="mini-pie-legend-swatch" style="background:${cat.color}"></span>
      <span class="mini-pie-legend-name">${cat.icon || ''} ${cat.name}</span>
      <span class="mini-pie-legend-amount">${fmt(valueFn(cat))}</span>
    `;
    container.appendChild(row);
  });
}

// ============================================================
// Category Detail Modal — shows transactions within a category
// ============================================================
async function openCategoryDetail(cat) {
  state.currentCategoryDetailId = cat.categoryId;
  const modal = document.getElementById('modal-category-detail');
  const iconEl = document.getElementById('category-detail-icon');
  const nameEl = document.getElementById('category-detail-name');
  const summaryEl = document.getElementById('category-detail-summary');
  const listEl = document.getElementById('category-detail-list');
  const noteEl = document.getElementById('category-note-input');

  iconEl.textContent = cat.icon || '🏷️';
  nameEl.textContent = cat.name;
  summaryEl.textContent = `${fmt(cat.spent)} of ${fmt(cat.allotted)} spent`;
  if (noteEl) noteEl.value = cat.note || '';
  listEl.innerHTML = '<div class="empty-state">Loading…</div>';
  modal.classList.remove('hidden');

  try {
    const data = await apiFetch(`/api/transactions?month=${state.dashboard.month}&categoryId=${cat.categoryId}`);
    renderCategoryDetailList(data.transactions);
  } catch (err) {
    console.error('Category detail load failed:', err);
    listEl.innerHTML = `<div class="empty-state empty-state-error">⚠️ Failed to load transactions: ${err.message}</div>`;
  }
}

function renderCategoryDetailList(transactions) {
  const listEl = document.getElementById('category-detail-list');
  if (!transactions.length) {
    listEl.innerHTML = '<div class="empty-state">No transactions in this category</div>';
    return;
  }
  listEl.innerHTML = '';
  transactions.forEach((txn) => {
    const item = document.createElement('div');
    item.className = 'transaction-item transaction-item-clickable';
    item.innerHTML = `
      <span class="transaction-id" title="Transaction ID">#${txn.id}</span>
      <div class="transaction-info">
        <div class="transaction-merchant">${txn.merchant || 'Unknown merchant'}${txn.is_split ? ' <span class="split-badge">split</span>' : ''}${txn.plaid_pending ? ' <span class="pending-badge-inline">pending</span>' : ''}${txn.status === 'needs_review' ? ' <span class="needs-review-badge">⚠️ needs categorization</span>' : ''}${awaitingReceiptBadgeHtml(txn)}</div>
        <div class="transaction-date">${formatDate(txn.occurred_at)}</div>
        ${txn.notes ? `<div class="transaction-notes">${txn.notes}</div>` : ''}
      </div>
      <div class="transaction-amount">${fmt(txn.amount)}</div>
      <button class="btn-delete-txn" data-txn-id="${txn.id}">🗑️</button>
    `;
    item.addEventListener('click', () => openNotesModal(txn));
    listEl.appendChild(item);
  });

  listEl.querySelectorAll('.btn-delete-txn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTransaction(btn.dataset.txnId);
    });
  });
}

async function saveCategoryNote() {
  clearTimeout(saveCategoryNoteTimer);
  if (state.currentCategoryDetailId == null) return;
  const noteEl = document.getElementById('category-note-input');
  try {
    await apiFetch(`/api/categories/${state.currentCategoryDetailId}/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: state.dashboard.month, note: noteEl.value }),
    });
    const cat = state.dashboard.categories.find((c) => c.categoryId === state.currentCategoryDetailId);
    if (cat) cat.note = noteEl.value;
  } catch (err) {
    showErrorToast(`Note didn't save: ${err.message}`);
  }
}

function closeCategoryDetail() {
  document.getElementById('modal-category-detail').classList.add('hidden');
  state.currentCategoryDetailId = null;
}

async function refreshAfterTransactionChange() {
  await loadDashboard();
  await loadPending();
  await loadDuplicates();
  if (activeView === 'transactions') await loadTransactions();
  if (state.currentCategoryDetailId != null) {
    const cat = state.dashboard.categories.find((c) => c.categoryId === state.currentCategoryDetailId);
    if (cat) await openCategoryDetail(cat);
    else closeCategoryDetail();
  }
}

async function loadPending() {
  try {
    const data = await apiFetch('/api/pending');
    state.pending = data.transactions;
    renderPending(data.transactions);
    updatePendingBadge(data.transactions.length);
  } catch (err) {
    showErrorToast(`Failed to load pending transactions: ${err.message}`);
  }
}

function renderPending(transactions) {
  const list = document.getElementById('pending-list');
  if (!transactions.length) {
    list.innerHTML = '<div class="empty-state">No pending transactions 🎉</div>';
    return;
  }
  list.innerHTML = '';
  transactions.forEach((txn) => {
    // status = 'needs_review' is only ever set by the receipt-scan pipeline
    // (see flagTransactionNeedsReceiptReview), so it's a reliable signal on
    // its own that this transaction has receipt items to review.
    const isReceiptFlagged = txn.status === 'needs_review';
    const isLikelyReturn = looksLikeVendorReturn(txn);
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <span class="transaction-id" title="Transaction ID">#${txn.id}</span>
      <div class="pending-info">
        <div class="pending-merchant">${txn.merchant || 'Unknown merchant'}${txn.plaid_pending ? ' <span class="pending-badge-inline">pending</span>' : ''}${txn.status === 'needs_review' ? ' <span class="needs-review-badge">⚠️ needs categorization</span>' : ''}${awaitingReceiptBadgeHtml(txn)}</div>
        <div class="pending-date">${formatDate(txn.occurred_at)}</div>
        ${isReceiptFlagged ? '<div class="pending-receipt-hint">🧾 tap to review items &amp; categorize</div>' : ''}
        ${isLikelyReturn ? '<div class="pending-receipt-hint">🔁 tap to match this return</div>' : ''}
      </div>
      <div class="pending-amount">${fmt(txn.amount)}</div>
    `;
    card.addEventListener('click', () => {
      if (isReceiptFlagged) {
        openNotesModal(txn);
      } else if (isLikelyReturn) {
        openReturnMatchModal(txn);
      } else {
        openCategorizeModal(txn);
      }
    });
    list.appendChild(card);
  });
}

function updatePendingBadge(count) {
  const badge = document.getElementById('pending-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openCategorizeModal(txn) {
  state.currentTxn = txn;
  document.getElementById('modal-merchant').textContent = txn.merchant || 'Unknown merchant';
  document.getElementById('modal-amount').textContent = fmt(txn.amount);
  document.getElementById('modal-date').textContent = formatDate(txn.occurred_at);

  const catsEl = document.getElementById('modal-cats');
  catsEl.innerHTML = '';
  state.categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'modal-cat-btn' + (cat.id === txn.suggestedCategoryId ? ' suggested' : '');
    btn.innerHTML = `<span class="modal-cat-icon">${cat.icon}</span>${cat.name}`;
    btn.addEventListener('click', () => categorize(txn.id, cat.id));
    catsEl.appendChild(btn);
  });

  document.getElementById('modal-categorize').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-categorize').classList.add('hidden');
  state.currentTxn = null;
}

async function categorize(transactionId, categoryId) {
  try {
    await apiFetch('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId, categoryId }),
    });
    closeModal();
    await Promise.all([loadPending(), loadDashboard()]);
    if (state.pending.length > 0) openCategorizeModal(state.pending[0]);
  } catch (err) {
    showErrorToast(`Failed to categorize: ${err.message}`);
  }
}

async function loadCategories() {
  try {
    const data = await apiFetch('/api/categories');
    state.categories = data.categories;
    populateRecurringCategorySelect();
    populateManualCategorySelect();
  } catch (err) {
    console.error('Categories load failed:', err);
  }
}

function populateRecurringCategorySelect() {
  populateManualCategorySelect();
  const select = document.getElementById('recurring-category');
  select.innerHTML = '<option value="">Select category...</option>';
  state.categories.forEach((cat) => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = `${cat.icon} ${cat.name}`;
    select.appendChild(option);
  });
}

async function loadRecurringTransactions() {
  try {
    const data = await apiFetch('/api/recurring-transactions');
    state.recurringTransactions = data.recurringTransactions;
  } catch (err) {
    console.error('Recurring transactions load failed:', err);
  }
}

function renderRecurringTransactions() {
  const list = document.getElementById('recurring-list');
  if (!state.recurringTransactions.length) {
    list.innerHTML = '<div class="empty-state">No recurring transactions</div>';
    return;
  }
  list.innerHTML = '';
  state.recurringTransactions.forEach((txn) => {
    const card = document.createElement('div');
    card.className = 'recurring-card';
    const endDateText = txn.end_date ? ` - ends ${new Date(txn.end_date).toLocaleDateString()}` : ' - ongoing';
    card.innerHTML = `
      <div class="recurring-info">
        <div class="recurring-name">${txn.icon} ${txn.name}</div>
        <div class="recurring-details">Day ${txn.day_of_month} of month • ${txn.category_name}${endDateText}</div>
      </div>
      <div class="recurring-amount">${fmt(txn.amount)}</div>
      <button class="btn-delete-recurring" data-id="${txn.id}">Delete</button>
    `;
    const deleteBtn = card.querySelector('.btn-delete-recurring');
    deleteBtn.addEventListener('click', () => deleteRecurringTransaction(txn.id));
    list.appendChild(card);
  });
}

async function addRecurringTransaction() {
  const name = document.getElementById('recurring-name').value.trim();
  const amount = parseFloat(document.getElementById('recurring-amount').value);
  const categoryId = parseInt(document.getElementById('recurring-category').value);
  const dayOfMonth = parseInt(document.getElementById('recurring-day').value);
  const startDate = document.getElementById('recurring-start').value;
  const endDate = document.getElementById('recurring-end').value;

  if (!name || !amount || !categoryId || !dayOfMonth || !startDate) {
    alert('Please fill in all required fields');
    return;
  }

  // Validate day of month range
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    alert('Day of month must be between 1 and 31');
    return;
  }

  // Validate date format and ensure start date is not in the past
  const today = new Date();
  const startDateObj = new Date(startDate);
  if (isNaN(startDateObj.getTime())) {
    alert('Invalid start date format');
    return;
  }

  // If end date is provided, validate it
  let endDateObj = null;
  if (endDate) {
    endDateObj = new Date(endDate);
    if (isNaN(endDateObj.getTime())) {
      alert('Invalid end date format');
      return;
    }
    if (endDateObj < startDateObj) {
      alert('End date must be after start date');
      return;
    }
  }

  try {
    await apiFetch('/api/recurring-transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        amount,
        categoryId,
        dayOfMonth,
        startDate,
        endDate: endDate || null,
      }),
    });
    document.getElementById('recurring-name').value = '';
    document.getElementById('recurring-amount').value = '';
    document.getElementById('recurring-category').value = '';
    document.getElementById('recurring-day').value = '';
    document.getElementById('recurring-start').value = '';
    document.getElementById('recurring-end').value = '';
    await loadRecurringTransactions();
    renderRecurringTransactions();
  } catch (err) {
    console.error('Add recurring transaction failed:', err);
    alert('Failed to add recurring transaction: ' + (err.message || err));
  }
}

async function deleteRecurringTransaction(id) {
  if (!confirm('Delete this recurring transaction?')) return;
  try {
    await apiFetch(`/api/recurring-transactions/${id}`, {
      method: 'DELETE',
    });
    await loadRecurringTransactions();
    renderRecurringTransactions();
  } catch (err) {
    showErrorToast(`Failed to delete recurring transaction: ${err.message}`);
  }
}

function renderSettings(categories) {
  const list = document.getElementById('settings-list');
  list.innerHTML = '';
  categories.forEach((cat) => {
    const existing = state.dashboard.categories?.find((c) => c.categoryId === cat.id);
    // Always the raw stored budget, never the rollover-adjusted display
    // total shown on the dashboard — editing/saving here must not bake an
    // accumulated rollover surplus into next month's base amount.
    const amount = existing?.baseAllotted || 0;
    const included = cat.included_in_budget === undefined ? true : !!cat.included_in_budget;
    const rollover = !!cat.rollover;
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.style.borderLeftColor = cat.color || 'transparent';
    row.innerHTML = `
      <div class="settings-icon">${cat.icon}</div>
      <div class="settings-main">
        <div class="settings-name" data-cat-id="${cat.id}">${cat.name}</div>
        <label class="settings-toggle">
          <input type="checkbox" class="settings-toggle-input" data-cat-id="${cat.id}" ${included ? 'checked' : ''} />
          <span class="settings-toggle-slider"></span>
          <span class="settings-toggle-label">Include in budget</span>
        </label>
        <label class="settings-toggle" title="Unused budget carries into next month instead of resetting (and overspending carries forward as a deficit)">
          <input type="checkbox" class="settings-toggle-input settings-rollover-input" data-cat-id="${cat.id}" ${rollover ? 'checked' : ''} />
          <span class="settings-toggle-slider"></span>
          <span class="settings-toggle-label">🔁 Roll over unused budget</span>
        </label>
      </div>
      <input
        class="settings-input"
        type="text"
        inputmode="numeric"
        pattern="[0-9]*[.,]?[0-9]*"
        min="0"
        step="10"
        placeholder="0"
        value="${amount > 0 ? amount : ''}"
        data-cat-id="${cat.id}"
      />
      <button class="btn-edit-cat" data-cat-id="${cat.id}" data-cat-name="${cat.name}" data-cat-icon="${cat.icon}" data-cat-color="${cat.color}">✏️</button>
      <button class="btn-delete-cat" data-cat-id="${cat.id}">🗑️</button>
    `;
    const input = row.querySelector('.settings-input');
    input.addEventListener('input', () => {
      input.dataset.dirty = '1';
      scheduleSaveBudgets();
    });

    const toggleInput = row.querySelector('.settings-toggle-input');
    toggleInput.addEventListener('change', () => toggleCategoryInclusion(cat.id, toggleInput.checked));

    const rolloverInput = row.querySelector('.settings-rollover-input');
    rolloverInput.addEventListener('change', () => toggleCategoryRollover(cat.id, rolloverInput.checked));

    const editBtn = row.querySelector('.btn-edit-cat');
    editBtn.addEventListener('click', () => editCategoryName(cat.id, cat.name, cat.icon, cat.color));

    const deleteBtn = row.querySelector('.btn-delete-cat');
    deleteBtn.addEventListener('click', () => deleteCategory(cat.id, cat.name));

    list.appendChild(row);
  });
}

// Both category toggles (include-in-budget, rollover) hit a differently-named
// endpoint/body-key/state-field for the same boolean-flip operation.
async function toggleCategoryBoolean(categoryId, value, { endpoint, bodyKey, stateField }) {
  try {
    await apiFetch(`/api/categories/${categoryId}/${endpoint}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [bodyKey]: value }),
    });
    const cat = state.categories.find((c) => c.id === categoryId);
    if (cat) cat[stateField] = value ? 1 : 0;
    await loadDashboard();
  } catch (err) {
    showErrorToast(`Failed to update category: ${err.message}`);
    renderSettings(state.categories); // revert the toggle UI
  }
}

function toggleCategoryInclusion(categoryId, includedInBudget) {
  return toggleCategoryBoolean(categoryId, includedInBudget, {
    endpoint: 'inclusion', bodyKey: 'includedInBudget', stateField: 'included_in_budget',
  });
}

function toggleCategoryRollover(categoryId, rollover) {
  return toggleCategoryBoolean(categoryId, rollover, {
    endpoint: 'rollover', bodyKey: 'rollover', stateField: 'rollover',
  });
}

async function deleteCategory(id, name) {
  if (!confirm('Delete category "' + name + '"? Existing categorized transactions keep their history, but you will not be able to assign new ones to it.')) return;
  try {
    await apiFetch('/api/categories/' + id, { method: 'DELETE' });
    await loadCategories();
    await loadDashboard();
    renderSettings(state.categories);
  } catch (err) {
    showErrorToast(`Failed to delete category: ${err.message}`);
  }
}

// ============================================================
// Icon Picker
// ============================================================

const ICON_CHOICES = [
  '🛒', '🍽️', '⛽', '💡', '📺', '🛍️', '💊', '🎮', '🏠', '📦', '💳', '🚗',
  '✈️', '🎓', '👶', '🐾', '💇', '🏋️', '📱', '💻', '🎁', '☕', '🍺', '🏥',
  '🧾', '💵', '🏦', '🔧', '🎵', '📚', '🧹', '👕', '🏷️'
];

function initIconPicker(toggleId, gridId, initialIcon) {
  const toggle = document.getElementById(toggleId);
  const grid = document.getElementById(gridId);
  if (!toggle || !grid) return;
  toggle.textContent = initialIcon || '🏷️';
  toggle.dataset.value = initialIcon || '🏷️';
  grid.innerHTML = ICON_CHOICES.map((emoji) =>
    `<button type="button" class="icon-picker-option" data-emoji="${emoji}">${emoji}</button>`
  ).join('');
  grid.classList.add('hidden');
  toggle.onclick = () => grid.classList.toggle('hidden');
  grid.querySelectorAll('.icon-picker-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggle.textContent = btn.dataset.emoji;
      toggle.dataset.value = btn.dataset.emoji;
      grid.classList.add('hidden');
    });
  });
}

function getIconPickerValue(toggleId) {
  return document.getElementById(toggleId)?.dataset.value || '🏷️';
}

// Global variable to track the category being edited
let currentEditingCategory = null;

async function editCategoryName(categoryId, currentName, currentIcon, currentColor) {
  // Set the current editing category
  currentEditingCategory = { id: categoryId, name: currentName };

  // Show the edit modal
  const modal = document.getElementById('modal-edit-category');
  const input = document.getElementById('edit-category-input');
  input.value = currentName;
  initIconPicker('edit-cat-icon-toggle', 'edit-cat-icon-grid', currentIcon);
  document.getElementById('edit-cat-color').value = currentColor || '#6366f1';
  modal.classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('modal-edit-category').classList.add('hidden');
  currentEditingCategory = null;
}

async function saveCategoryEdit() {
  if (!currentEditingCategory) return;

  const input = document.getElementById('edit-category-input');
  const newName = input.value.trim();

  if (!newName) {
    alert('Category name cannot be empty');
    return;
  }

  const icon = getIconPickerValue('edit-cat-icon-toggle');
  const color = document.getElementById('edit-cat-color').value;

  try {
    await apiFetch(`/api/categories/${currentEditingCategory.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, icon, color }),
    });

    // Close the modal
    closeEditModal();

    // Refresh all views
    await loadCategories();
    await loadDashboard();
    renderSettings(state.categories);
  } catch (err) {
    console.error('Edit category failed:', err);
    alert('Failed to edit category: ' + err.message);
  }
}

function scheduleSaveBudgets() {
  clearTimeout(saveBudgetsTimer);
  saveBudgetsTimer = setTimeout(saveBudgets, 800);
}

async function saveBudgets() {
  clearTimeout(saveBudgetsTimer);
  // Only send inputs the user actually touched (see the 'input' listener in
  // renderSettings) — every field here is pre-filled from baseAllotted, but
  // re-saving an untouched field is still worth avoiding on principle, since
  // any future drift between "displayed" and "raw" would otherwise get
  // silently baked back in the moment any other field is edited.
  const inputs = document.querySelectorAll('.settings-input[data-cat-id][data-dirty="1"]');
  const month = state.currentMonth;
  const saves = Array.from(inputs).map((el) =>
    apiFetch('/api/budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryId: parseInt(el.dataset.catId),
        month,
        amount: el.value === '' ? 0 : parseFloat(el.value),
      }),
    })
  );
  if (!saves.length) return;
  try {
    await Promise.all(saves);
    inputs.forEach((el) => delete el.dataset.dirty);
    const btn = document.getElementById('btn-save-budgets');
    btn.textContent = 'Saved ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Save Budgets';
      btn.style.background = '';
    }, 1800);
    await loadDashboard();
  } catch (err) {
    showErrorToast(`Failed to save budgets: ${err.message}`);
  }
}

async function addCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  const icon = getIconPickerValue('new-cat-icon-toggle');
  const color = document.getElementById('new-cat-color').value;
  if (!name) return;

  const addCatBtn = document.getElementById('btn-add-cat');
  const originalText = addCatBtn.textContent;

  try {
    await apiFetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, color }),
    });

    // Show success feedback
    addCatBtn.textContent = 'Added ✓';
    addCatBtn.style.background = '#22c55e';
    setTimeout(() => {
      addCatBtn.textContent = originalText;
      addCatBtn.style.background = '';
    }, 1500);

    document.getElementById('new-cat-name').value = '';
    initIconPicker('new-cat-icon-toggle', 'new-cat-icon-grid', '🏷️');
    document.getElementById('new-cat-color').value = '#6366f1';
    await loadCategories();
    await loadDashboard();
    // Refresh settings view immediately if we're on it
    if (activeView === 'settings') {
      renderSettings(state.categories);
    }
  } catch (err) {
    console.error('Add category failed:', err);
    alert('Failed to add category: ' + err.message);
    addCatBtn.textContent = originalText;
    addCatBtn.style.background = '';
  }
}

async function switchView(name) {
  if (activeView === 'settings' && name !== 'settings') {
    await saveBudgets();
  }
  activeView = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');
  if (name === 'pending') loadPending();
  if (name === 'settings') {
    renderSettings(state.categories);
    renderRecurringTransactions();
    loadLinkedAccounts();
  }
  if (name === 'transactions') {
    await loadTransactions();
    populateTransactionFilters();
  }
}

function fmt(amount) {
  return '$' + (amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  // Date-only strings ("YYYY-MM-DD") have no time-of-day info (most Plaid
  // transactions). Parsing them with `new Date()` treats them as UTC
  // midnight, which shifts to the wrong local day/time — so render them as
  // a plain local calendar date instead of fabricating a clock time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  if (dateOnly) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d2 = new Date(year, month - 1, day);
    return d2.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function animateNumber(el, target) {
  const duration = 800;
  const start = parseFloat(el.textContent.replace(/[^0-9.-]/g, '')) || 0;
  const startTime = performance.now();
  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (target - start) * eased;
    el.textContent = fmt(current);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ============================================================
// Manual Transaction Functions
// ============================================================

function populateManualCategorySelect() {
  const select = document.getElementById('manual-category');
  const currentValue = select.value;
  select.innerHTML = '<option value="">Category (optional)</option>';
  state.categories.forEach((cat) => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = `${cat.icon} ${cat.name}`;
    select.appendChild(option);
  });
  select.value = currentValue;
}

async function addManualTransaction() {
  const description = document.getElementById('manual-description').value.trim();
  const amount = parseFloat(document.getElementById('manual-amount').value);
  const categoryId = parseInt(document.getElementById('manual-category').value) || null;
  const date = document.getElementById('manual-date').value;
  const autoCategorize = document.getElementById('manual-auto-categorize').checked;

  if (!description || !amount || !date) {
    alert('Please fill in description, amount, and date');
    return;
  }

  try {
    const response = await apiFetch('/api/transactions/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        amount,
        categoryId,
        date,
        autoCategorize,
      }),
    });

    document.getElementById('manual-description').value = '';
    document.getElementById('manual-amount').value = '';
    document.getElementById('manual-category').value = '';
    document.getElementById('manual-date').value = '';
    document.getElementById('manual-auto-categorize').checked = false;

    const btn = document.getElementById('btn-add-manual');
    btn.textContent = 'Added! ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Add Transaction';
      btn.style.background = '';
    }, 1500);

    await Promise.all([loadPending(), loadDashboard()]);
  } catch (err) {
    showErrorToast(`Failed to add transaction: ${err.message}`);
  }
}

// ============================================================
// Transaction Log Functions
// ============================================================

async function loadTransactions() {
  try {
    let url = '/api/transactions?';
    if (transactionFilters.month) {
      url += `month=${transactionFilters.month}&`;
    }
    if (transactionFilters.categoryId) {
      url += `categoryId=${transactionFilters.categoryId}&`;
    }

    const data = await apiFetch(url);
    loadedTransactions = data.transactions;
    renderTransactions(filterTransactionsBySearch(loadedTransactions));
  } catch (err) {
    showErrorToast(`Failed to load transactions: ${err.message}`);
  }
}

function filterTransactionsBySearch(transactions) {
  const query = transactionFilters.search.toLowerCase();
  if (query.length < 3) return transactions;
  const amountQuery = query.replace(/^\$/, '');
  const isAmountQuery = /^\d+(\.\d{1,2})?$/.test(amountQuery);
  return transactions.filter((txn) => {
    const merchant = (txn.merchant || '').toLowerCase();
    const notes = (txn.notes || '').toLowerCase();
    if (merchant.includes(query) || notes.includes(query)) return true;
    if (isAmountQuery) {
      return Math.abs(txn.amount).toFixed(2).includes(amountQuery);
    }
    return false;
  });
}

function renderTransactions(transactions) {
  const list = document.getElementById('transaction-list');
  if (!transactions.length) {
    list.innerHTML = '<div class="empty-state">No transactions found</div>';
    return;
  }
  list.innerHTML = '';
  transactions.forEach((txn) => {
      const item = document.createElement('div');
      item.className = 'transaction-item transaction-item-clickable';
      item.innerHTML = `
        <span class="transaction-id" title="Transaction ID">#${txn.id}</span>
        <div class="transaction-info">
          <div class="transaction-merchant">${txn.merchant || 'Unknown merchant'}${txn.is_split ? ' <span class="split-badge">split</span>' : ''}${txn.plaid_pending ? ' <span class="pending-badge-inline">pending</span>' : ''}${txn.status === 'needs_review' ? ' <span class="needs-review-badge">⚠️ needs categorization</span>' : ''}${awaitingReceiptBadgeHtml(txn)}</div>
          <div class="transaction-date">${formatDate(txn.occurred_at)}</div>
          ${txn.notes ? `<div class="transaction-notes">${txn.notes}</div>` : ''}
        </div>
        <div class="transaction-amount">${fmt(txn.amount)}</div>
        <button class="btn-delete-txn" data-txn-id="${txn.id}">🗑️</button>
      `;

    if (txn.category_id) {
      const categoryInfo = document.createElement('div');
      categoryInfo.className = 'transaction-category';
      categoryInfo.innerHTML = `
        <span class="category-icon" style="color: ${txn.color}">${txn.icon}</span>
        <span class="category-name">${txn.category_name}</span>
      `;
      item.querySelector('.transaction-info').appendChild(categoryInfo);
    } else if (txn.is_split && Array.isArray(txn.splits)) {
      // Each split gets its own chip (rather than one flat inline-nowrap row)
      // so 3+ categories wrap onto additional lines instead of overflowing
      // the transaction row off the edge of the screen — see transaction-category's
      // flex-wrap in style.css.
      const categoryInfo = document.createElement('div');
      categoryInfo.className = 'transaction-category';
      categoryInfo.innerHTML = txn.splits.map((s) =>
        `<span class="category-chip"><span class="category-icon" style="color: ${s.color}">${s.icon}</span><span class="category-name">${s.name} (${fmt(s.amount)})</span></span>`
      ).join('');
      item.querySelector('.transaction-info').appendChild(categoryInfo);
    }

    item.addEventListener('click', () => openNotesModal(txn));
    list.appendChild(item);
  });

  // Add event listeners for delete buttons
  document.querySelectorAll('.btn-delete-txn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const transactionId = btn.dataset.txnId;
      deleteTransaction(transactionId);
    });
  });
}

async function deleteTransaction(transactionId) {
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  try {
    await apiFetch(`/api/transactions/${transactionId}`, {
      method: 'DELETE',
    });
    await refreshAfterTransactionChange();
  } catch (err) {
    showErrorToast(`Failed to delete transaction: ${err.message}`);
  }
}

async function populateTransactionFilters() {
  // Populate month filter
  const monthFilter = document.getElementById('transaction-month-filter');
  monthFilter.innerHTML = '<option value="">All Months</option>';

  // Get all available months from transactions
  try {
    const allData = await apiFetch('/api/transactions');
    const months = new Set();
    allData.transactions.forEach(txn => {
      const month = txn.occurred_at.slice(0, 7); // YYYY-MM
      months.add(month);
    });

    // Add months in reverse chronological order
    const sortedMonths = Array.from(months).sort((a, b) => b.localeCompare(a));
    sortedMonths.forEach(month => {
      const [year, monthNum] = month.split('-');
      const monthName = new Date(year, parseInt(monthNum) - 1).toLocaleString('default', { month: 'long' });
      const option = document.createElement('option');
      option.value = month;
      option.textContent = `${monthName} ${year}`;
      monthFilter.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to populate month filter:', err);
  }

  // Populate category filter
  const categoryFilter = document.getElementById('transaction-category-filter');
  categoryFilter.innerHTML = '<option value="">All Categories</option>';
  state.categories.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = `${cat.icon} ${cat.name}`;
    categoryFilter.appendChild(option);
  });

  // Set current filters
  monthFilter.value = transactionFilters.month;
  categoryFilter.value = transactionFilters.categoryId;
}

// ============================================================
// Notes Modal Functions
// ============================================================

function hideCategoryDetailModal() {
  document.getElementById('modal-category-detail')?.classList.add('hidden');
}

function restoreCategoryDetailModalIfNeeded() {
  if (state.currentCategoryDetailId != null) {
    document.getElementById('modal-category-detail')?.classList.remove('hidden');
  }
}

async function openNotesModal(transaction) {
  // If this was opened from the category-detail modal, hide it underneath
  // so it can't stack on top of the notes modal (both are visible via
  // .hidden toggling only, so DOM order otherwise decides who wins).
  hideCategoryDetailModal();
  const modal = document.getElementById('modal-notes');
  document.getElementById('notes-merchant').textContent = transaction.merchant || 'Unknown merchant';
  document.getElementById('notes-amount').textContent = fmt(transaction.amount);
  document.getElementById('notes-date').textContent = formatDate(transaction.occurred_at);
  document.getElementById('notes-input').value = transaction.notes || '';
  modal.classList.remove('hidden');

  // Callers only ever have a partial transaction (list views don't include
  // receiptItems), so re-fetch the full record to know whether this is a
  // receipt-backed transaction before deciding which editor to show.
  let txn = transaction;
  try {
    txn = await apiFetch(`/api/transactions/${transaction.id}`);
  } catch (err) {
    console.error('Failed to load full transaction for notes:', err);
  }
  state.currentTxn = txn;
  document.getElementById('notes-input').value = txn.notes || '';

  const modalCard = document.querySelector('#modal-notes .modal-card');
  if (txn.receiptItems && txn.receiptItems.length) {
    modalCard.classList.add('modal-card-expanded');
    document.getElementById('notes-category-editor').classList.add('hidden');
    document.getElementById('notes-items-editor').classList.remove('hidden');
    renderItemCategoryRows(document.getElementById('notes-item-rows'), txn.receiptItems, {
      transactionId: txn.id,
      returnable: txn.source === 'sms',
    });
    return;
  }

  modalCard.classList.remove('modal-card-expanded');
  document.getElementById('notes-items-editor').classList.add('hidden');
  document.getElementById('notes-category-editor').classList.remove('hidden');

  const categorySelect = document.getElementById('notes-category');
  categorySelect.innerHTML = '<option value="">No category</option>' +
    state.categories.map((cat) => `<option value="${cat.id}">${cat.icon} ${cat.name}</option>`).join('');
  categorySelect.value = txn.category_id || '';
}

// ============================================================
// Split Transaction Modal Functions
// ============================================================

// Renders an auto-generated note (e.g. "⚠️ Auto-flagged by receipt scan...")
// as one block per line, with bullet lines given a hanging indent so a long
// item description wraps under the text rather than under the bullet.
function renderReceiptItemsNote(container, notesText) {
  container.innerHTML = '';
  if (!notesText) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  notesText.split('\n').forEach((line) => {
    const bulletMatch = line.match(/^\s*•\s*(.*)$/);
    const div = document.createElement('div');
    if (bulletMatch) {
      div.className = 'split-receipt-item-line';
      div.textContent = `• ${bulletMatch[1]}`;
    } else {
      div.className = 'split-receipt-items-header';
      div.textContent = line;
    }
    container.appendChild(div);
  });
}

async function openSplitModal() {
  const transactionId = state.currentTxn.id;

  // Close the notes modal and show the split modal immediately so there's
  // no dead gap while the transaction details are fetched. Only reachable
  // for transactions with no receipt attached — receipt-backed transactions
  // categorize items inline in the notes modal instead (see openNotesModal).
  closeNotesModal();
  document.getElementById('split-merchant').textContent = 'Loading…';
  document.getElementById('split-total').textContent = '';
  document.getElementById('split-rows').innerHTML = '';
  document.getElementById('split-remaining').textContent = '';
  document.getElementById('modal-split').classList.remove('hidden');

  let txn;
  try {
    txn = await apiFetch(`/api/transactions/${transactionId}`);
  } catch (err) {
    showErrorToast(`Failed to load transaction details: ${err.message}`);
    closeSplitModal();
    return;
  }
  state.currentSplitTxn = txn;
  document.getElementById('split-merchant').textContent = txn.merchant || 'Unknown merchant';
  document.getElementById('split-total').textContent = fmt(txn.amount);

  const initialRows = txn.is_split && txn.splits?.length
    ? txn.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }))
    : [{ categoryId: '', amount: '' }, { categoryId: '', amount: '' }];
  initialRows.forEach((row) => addSplitRow(row.categoryId, row.amount));
  updateSplitRemaining();

  const singleCategorySelect = document.getElementById('split-single-category');
  singleCategorySelect.innerHTML = '<option value="">Choose category</option>' +
    state.categories.map((cat) => `<option value="${cat.id}">${cat.icon} ${cat.name}</option>`).join('');
  singleCategorySelect.value = !txn.is_split && txn.category_id ? txn.category_id : '';
}

// Renders one row per receipt item with a category dropdown pre-filled from
// the parsed/suggested category — used inline in the notes modal for any
// receipt-backed transaction, so a manual re-categorization is always just
// as available as the original auto-categorized guess.
function renderItemCategoryRows(containerEl, items, { transactionId, returnable } = {}) {
  containerEl.innerHTML = '';
  const categoryOptions = state.categories.map((cat) => `<option value="${cat.id}">${cat.icon} ${cat.name}</option>`).join('');
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'split-item-row';
    row.innerHTML = `
      <span class="split-item-desc-wrap">
        <span class="split-item-desc">${item.description}${item.uncertain ? ' <span class="split-item-uncertain" title="Low-confidence guess">⚠️</span>' : ''}</span>
        ${item.friendlyName ? `<span class="split-item-friendly">≈ ${item.friendlyName}</span>` : ''}
      </span>
      <span class="split-item-amount">${fmt(item.amount)}</span>
      <select class="split-item-category">
        <option value="">Choose category</option>
        ${categoryOptions}
      </select>
      ${returnable ? '<button type="button" class="btn-return-item" title="Mark item as returned">↩️</button>' : ''}
    `;
    row.querySelector('select').value = item.categoryId || '';
    if (returnable) {
      row.querySelector('.btn-return-item').addEventListener('click', () => returnTransactionItem(transactionId, index, item, items.length));
    }
    containerEl.appendChild(row);
  });
}

// Only offered for SMS-sourced transactions (a card Plaid/CSV never sees) —
// see transactionSource on the backend for why every other source is
// expected to reconcile through its own refund transaction instead.
async function returnTransactionItem(transactionId, itemIndex, item, itemCount) {
  const isLastItem = itemCount === 1;
  const confirmMessage = isLastItem
    ? `Mark "${item.description}" (${fmt(item.amount)}) as returned? This is the only item on the receipt, so the whole $${item.amount.toFixed(2)} transaction will be deleted.`
    : `Mark "${item.description}" (${fmt(item.amount)}) as returned? It'll be removed from this transaction and your budget.`;
  if (!confirm(confirmMessage)) return;

  try {
    const result = await apiFetch(`/api/transactions/${transactionId}/items/${itemIndex}/return`, { method: 'POST' });
    if (result.deleted) {
      closeNotesModal();
      showHeaderStatus('✓ Item returned — transaction removed (it was the only item)');
    } else {
      showHeaderStatus(`✓ Item returned — transaction reduced to ${fmt(result.newAmount)}`);
      const refreshed = await apiFetch(`/api/transactions/${transactionId}`);
      state.currentTxn = refreshed;
      document.getElementById('notes-amount').textContent = fmt(refreshed.amount);
      renderItemCategoryRows(document.getElementById('notes-item-rows'), refreshed.receiptItems, {
        transactionId: refreshed.id,
        returnable: refreshed.source === 'sms',
      });
    }
    await refreshAfterTransactionChange();
  } catch (err) {
    showErrorToast(`Failed to mark item as returned: ${err.message}`);
  }
}

async function categorizeSplitAsSingleCategory() {
  const categoryId = Number(document.getElementById('split-single-category').value);
  if (!categoryId) {
    alert('Choose a category first');
    return;
  }
  try {
    await apiFetch('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: state.currentSplitTxn.id, categoryId }),
    });
    closeSplitModal();
    restoreCategoryDetailModalIfNeeded();
    await refreshAfterTransactionChange();
  } catch (err) {
    showErrorToast(`Failed to categorize: ${err.message}`);
  }
}

function addSplitRow(categoryId, amount) {
  const rowsEl = document.getElementById('split-rows');
  if (rowsEl.children.length >= 3) return;

  const row = document.createElement('div');
  row.className = 'split-row';
  const categoryOptions = state.categories.map((cat) =>
    `<option value="${cat.id}">${cat.icon} ${cat.name}</option>`
  ).join('');
  row.innerHTML = `
    <select class="split-category">
      <option value="">Choose category</option>
      ${categoryOptions}
    </select>
    <input type="number" class="split-amount" step="0.01" min="0" placeholder="0.00" />
    <button type="button" class="btn-remove-split-row">✕</button>
  `;
  row.querySelector('.split-category').value = categoryId || '';
  row.querySelector('.split-amount').value = amount || '';
  row.querySelector('.split-amount').addEventListener('input', updateSplitRemaining);
  row.querySelector('.split-category').addEventListener('change', updateSplitRemaining);
  row.querySelector('.btn-remove-split-row').addEventListener('click', () => {
    if (rowsEl.children.length <= 2) return;
    row.remove();
    updateSplitRemaining();
  });
  rowsEl.appendChild(row);
  document.getElementById('btn-add-split-row').disabled = rowsEl.children.length >= 3;
}

function getSplitRows() {
  return Array.from(document.querySelectorAll('.split-row')).map((row) => ({
    categoryId: Number(row.querySelector('.split-category').value) || null,
    amount: parseFloat(row.querySelector('.split-amount').value) || 0
  }));
}

function updateSplitRemaining() {
  const total = state.currentSplitTxn?.amount || 0;
  const allocated = getSplitRows().reduce((sum, r) => sum + r.amount, 0);
  const remaining = Math.round((total - allocated) * 100) / 100;
  const el = document.getElementById('split-remaining');
  if (Math.abs(remaining) < 0.01) {
    el.textContent = `Balanced — ${fmt(total)} total`;
    el.className = 'split-remaining balanced';
  } else {
    el.textContent = `${fmt(Math.abs(remaining))} ${remaining > 0 ? 'remaining' : 'over'}`;
    el.className = 'split-remaining unbalanced';
  }
}

async function saveSplit() {
  const rows = getSplitRows();
  if (rows.some((r) => !r.categoryId || r.amount <= 0)) {
    alert('Every row needs a category and a positive amount');
    return;
  }
  const total = state.currentSplitTxn.amount;
  const allocated = rows.reduce((sum, r) => sum + r.amount, 0);
  if (Math.abs(total - allocated) > 0.01) {
    alert(`Splits must add up to ${fmt(total)} (currently ${fmt(allocated)})`);
    return;
  }
  try {
    await apiFetch(`/api/transactions/${state.currentSplitTxn.id}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ splits: rows.map((r) => ({ categoryId: r.categoryId, amount: r.amount })) }),
    });
    closeSplitModal();
    await refreshAfterTransactionChange();
  } catch (err) {
    console.error('Save split failed:', err);
    alert(`Failed to save split: ${err.message}`);
  }
}

function closeSplitModal() {
  document.getElementById('modal-split').classList.add('hidden');
  state.currentSplitTxn = null;
}

function closeNotesModal() {
  document.getElementById('modal-notes').classList.add('hidden');
  state.currentTxn = null;
}

async function saveNotes() {
  const notes = document.getElementById('notes-input').value.trim();
  const transactionId = state.currentTxn.id;
  const isReceiptBacked = state.currentTxn.receiptItems && state.currentTxn.receiptItems.length;

  try {
    if (isReceiptBacked) {
      const selects = [...document.querySelectorAll('#notes-item-rows .split-item-category')];
      const categoryIds = [];
      for (const sel of selects) {
        if (!sel.value) {
          alert('Choose a category for every item');
          return;
        }
        categoryIds.push(Number(sel.value));
      }
      await apiFetch(`/api/transactions/${transactionId}/categorize-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryIds }),
      });
      await apiFetch(`/api/transactions/${transactionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
    } else {
      const categoryId = document.getElementById('notes-category').value;
      await apiFetch(`/api/transactions/${transactionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: notes,
          categoryId: categoryId || null // Send null if no category selected
        }),
      });
    }

    closeNotesModal();
    restoreCategoryDetailModalIfNeeded();
    await refreshAfterTransactionChange();

    const btn = document.getElementById('btn-save-notes');
    btn.textContent = 'Saved ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Save';
      btn.style.background = '';
    }, 1500);
  } catch (err) {
    console.error('Save notes and category failed:', err);
    // Show the exact error message from the backend
    alert(`Failed to save changes: ${err.message}`);
  }
}

// ============================================================
// CSV Transaction Import Function
// ============================================================

// Global variable to track CSV import state
async function importCSVTransactions(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.name.endsWith('.csv')) {
    alert('Please select a CSV file');
    event.target.value = '';
    return;
  }

  const btn = document.getElementById('btn-csv-import');
  btn.textContent = 'Importing...';
  btn.disabled = true;

  try {
    const csvContent = await file.text();
    const response = await fetch('/api/transactions/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csvContent,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `CSV import failed: ${response.status}`);
    }

    const result = await response.json();

    btn.textContent = 'Imported ✓';
    btn.style.background = '#16a34a';
    setTimeout(() => {
      btn.textContent = 'Import CSV Transactions';
      btn.style.background = '';
      btn.disabled = false;
    }, 1500);

    document.getElementById('csv-file-input').value = '';

    await Promise.all([loadPending(), loadDashboard(), loadCsvDuplicates()]);
    if (activeView === 'transactions') {
      await loadTransactions();
    }

    alert(`CSV Import Complete!\n\n${result.importedCount} transactions imported\n${result.autoSkippedCount} exact duplicates auto-skipped\n${result.queuedForReviewCount} possible duplicates flagged for review\n${result.skippedCount} transactions not from current month\n${result.errorCount} errors encountered`);

    // Same-tap convenience: if this import just flagged anything ambiguous,
    // let the user resolve it immediately instead of having to go find the
    // badge. Exact duplicates never reach here — they're auto-skipped.
    if (result.queuedForReviewCount > 0) {
      openCsvDuplicatesModal();
    }
  } catch (err) {
    console.error('CSV import failed:', err);
    alert('CSV import failed: ' + err.message);
    btn.textContent = 'Import CSV Transactions';
    btn.style.background = '';
    btn.disabled = false;
    document.getElementById('csv-file-input').value = '';
  }
}

// ============================================================
// CSV Import Duplicate Review (manual button + unattended
// watch_downloads.py watcher both flow through the same backend queue)
// ============================================================

async function loadCsvDuplicates() {
  try {
    const data = await apiFetch('/api/csv-duplicates');
    state.csvDuplicates = data.duplicates;
    updateCsvDuplicatesBadge(data.duplicates.length);
  } catch (err) {
    console.error('Loading CSV duplicates failed:', err);
  }
}

function updateCsvDuplicatesBadge(count) {
  const badge = document.getElementById('csv-duplicates-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openCsvDuplicatesModal() {
  renderCsvDuplicates();
  document.getElementById('modal-csv-duplicates').classList.remove('hidden');
}

function closeCsvDuplicatesModal() {
  document.getElementById('modal-csv-duplicates').classList.add('hidden');
}

function renderCsvDuplicates() {
  const list = document.getElementById('csv-duplicates-list');
  if (!state.csvDuplicates.length) {
    list.innerHTML = '<div class="empty-state">No possible duplicates waiting for review 🎉</div>';
    return;
  }
  list.innerHTML = '';
  state.csvDuplicates.forEach((dup) => {
    const row = document.createElement('div');
    row.className = 'duplicate-pair';
    const existing = dup.existingTransaction;
    row.innerHTML = `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">New: ${dup.merchant || 'Unknown merchant'}</div>
          <div class="duplicate-txn-meta">${formatDate(dup.occurredAt)}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(dup.amount)}</div>
        </div>
      </div>
      ${existing ? `
      <div class="duplicate-txn">
        <div class="duplicate-txn-info">
          <div class="duplicate-txn-merchant">Existing: ${existing.merchant || 'Unknown merchant'}</div>
          <div class="duplicate-txn-meta">${formatDate(existing.occurredAt)} · ${existing.status}</div>
        </div>
        <div class="duplicate-txn-right">
          <div class="duplicate-txn-amount">${fmt(existing.amount)}</div>
        </div>
      </div>` : ''}
      <div class="csv-duplicate-actions">
        <button type="button" class="btn-cancel-notes btn-skip-csv-duplicate">Skip</button>
        <button type="button" class="btn-save-notes btn-import-csv-duplicate">Import Anyway</button>
      </div>
    `;
    row.querySelector('.btn-skip-csv-duplicate').addEventListener('click', () => resolveCsvDuplicate(dup.id, 'skip'));
    row.querySelector('.btn-import-csv-duplicate').addEventListener('click', () => resolveCsvDuplicate(dup.id, 'import'));
    list.appendChild(row);
  });
}

async function resolveCsvDuplicate(duplicateId, action) {
  try {
    await apiFetch(`/api/csv-duplicates/${duplicateId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    await loadCsvDuplicates();
    renderCsvDuplicates();
    await refreshAfterTransactionChange();
  } catch (err) {
    console.error('Resolve CSV duplicate failed:', err);
    alert(`Failed to resolve: ${err.message}`);
  }
}
