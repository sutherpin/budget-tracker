const API = location.origin;

let state = {
  categories: [],
  dashboard: { month: '', categories: [] },
  pending: [],
  recurringTransactions: [],
  currentTxn: null,
  currentMonth: new Date().toISOString().slice(0, 7),
};

let activeView = 'dashboard';
let saveBudgetsTimer = null;
let transactionFilters = {
  month: '',
  categoryId: '',
  search: ''
};
let loadedTransactions = [];

window.addEventListener('DOMContentLoaded', async () => {
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

  // Add event listener for the new notification button with logging
  const enableNotificationsButton = document.getElementById('btn-enable-notifications');
  if (enableNotificationsButton) {
    console.log('Found "Enable Notifications" button.');
    enableNotificationsButton.addEventListener('click', registerPush);
    console.log('Event listener added to "Enable Notifications" button.');
  } else {
    console.warn('"Enable Notifications" button not found!');
  }

  // Add event listeners for notes modal buttons
  document.getElementById('btn-cancel-notes')?.addEventListener('click', closeNotesModal);
  document.getElementById('btn-save-notes')?.addEventListener('click', saveNotes);

  // Add event listeners for edit category modal buttons
  document.getElementById('btn-cancel-edit')?.addEventListener('click', closeEditModal);
  document.getElementById('btn-save-edit')?.addEventListener('click', saveCategoryEdit);

  // Add event listener for category detail modal close button
  document.getElementById('btn-close-category-detail')?.addEventListener('click', closeCategoryDetail);
  document.getElementById('modal-category-detail')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-category-detail') closeCategoryDetail();
  });

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
    // Removed automatic registerPush() call
    switchView('pending');
  } else {
    await loadAll();
    showApp();
    // Removed automatic registerPush() call
  }
});

function showApp() {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
}

async function loadAll() {
  await Promise.all([loadDashboard(), loadPending(), loadCategories(), loadRecurringTransactions()]);
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
  animateNumber(document.getElementById('pie-remaining'), totalBudgeted - totalSpent);

  drawPie(data.categories);

  const list = document.getElementById('category-list');
  list.innerHTML = '';
  data.categories.forEach((cat) => {
    const pct = cat.allotted > 0 ? Math.min((cat.spent / cat.allotted) * 100, 100) : 0;
    const remaining = cat.allotted - cat.spent;
    const overBudget = remaining < 0;
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <div class="cat-icon">${cat.icon}</div>
      <div class="cat-info">
        <div class="cat-name">${cat.name}</div>
        <div class="cat-amounts">${fmt(cat.spent)} of ${fmt(cat.allotted)}</div>
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

let pieSlices = [];
let pieHoverBound = false;

function drawPie(categories) {
  const canvas = document.getElementById('pie-chart');
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const outerR = 220;
  const innerR = 144;

  const cats = categories.filter((c) => c.spent > 0);
  const total = cats.reduce((s, c) => s + c.spent, 0);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  pieSlices = [];

  if (total === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
    ctx.fillStyle = '#243055';
    ctx.fill();
    hidePieTooltip();
    return;
  }

  let startAngle = -Math.PI / 2;
  const gap = 0.03;

  cats.forEach((cat) => {
    const sliceAngle = (cat.spent / total) * (Math.PI * 2) - gap;
    const endAngle = startAngle + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = cat.color;
    ctx.fill();
    pieSlices.push({ cat, startAngle, endAngle, innerR, outerR, cx, cy });
    startAngle = endAngle + gap;
  });

  bindPieHoverEvents(canvas);
}

function bindPieHoverEvents(canvas) {
  if (pieHoverBound) return;
  pieHoverBound = true;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const slice = findPieSliceAt(x, y);
    if (slice) {
      showPieTooltip(slice.cat, e.clientX, e.clientY);
    } else {
      hidePieTooltip();
    }
  });

  canvas.addEventListener('mouseleave', hidePieTooltip);

  // Basic touch support: tap a slice to show its tooltip briefly.
  canvas.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (touch.clientX - rect.left) * scaleX;
    const y = (touch.clientY - rect.top) * scaleY;
    const slice = findPieSliceAt(x, y);
    if (slice) {
      showPieTooltip(slice.cat, touch.clientX, touch.clientY);
      setTimeout(hidePieTooltip, 1800);
    }
  }, { passive: true });
}

function findPieSliceAt(x, y) {
  for (const slice of pieSlices) {
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

function showPieTooltip(cat, clientX, clientY) {
  const tooltip = document.getElementById('pie-tooltip');
  const wrap = document.querySelector('.pie-wrap');
  if (!tooltip || !wrap) return;

  const wrapRect = wrap.getBoundingClientRect();
  tooltip.innerHTML = `
    <div class="pie-tooltip-name"><span class="pie-tooltip-swatch" style="background:${cat.color}"></span>${cat.icon || ''} ${cat.name}</div>
    <div class="pie-tooltip-amount">${fmt(cat.spent)}</div>
  `;
  tooltip.style.left = `${clientX - wrapRect.left}px`;
  tooltip.style.top = `${clientY - wrapRect.top}px`;
  tooltip.classList.remove('hidden');
}

function hidePieTooltip() {
  const tooltip = document.getElementById('pie-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}

// ============================================================
// Category Detail Modal — shows transactions within a category
// ============================================================
async function openCategoryDetail(cat) {
  const modal = document.getElementById('modal-category-detail');
  const iconEl = document.getElementById('category-detail-icon');
  const nameEl = document.getElementById('category-detail-name');
  const summaryEl = document.getElementById('category-detail-summary');
  const listEl = document.getElementById('category-detail-list');

  iconEl.textContent = cat.icon || '🏷️';
  nameEl.textContent = cat.name;
  summaryEl.textContent = `${fmt(cat.spent)} of ${fmt(cat.allotted)} spent`;
  listEl.innerHTML = '<div class="empty-state">Loading…</div>';
  modal.classList.remove('hidden');

  try {
    const data = await apiFetch(`/api/transactions?month=${state.dashboard.month}&categoryId=${cat.categoryId}`);
    renderCategoryDetailList(data.transactions);
  } catch (err) {
    console.error('Category detail load failed:', err);
    listEl.innerHTML = '<div class="empty-state">Failed to load transactions</div>';
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
    item.className = 'transaction-item';
    item.innerHTML = `
      <div class="transaction-info">
        <div class="transaction-merchant">${txn.merchant || 'Unknown merchant'}</div>
        <div class="transaction-date">${formatDate(txn.occurred_at)}</div>
        ${txn.notes ? `<div class="transaction-notes">${txn.notes}</div>` : ''}
      </div>
      <div class="transaction-amount">${fmt(txn.amount)}</div>
    `;
    listEl.appendChild(item);
  });
}

function closeCategoryDetail() {
  document.getElementById('modal-category-detail').classList.add('hidden');
}

async function loadPending() {
  try {
    const data = await apiFetch('/api/pending');
    state.pending = data.transactions;
    renderPending(data.transactions);
    updatePendingBadge(data.transactions.length);
  } catch (err) {
    console.error('Pending load failed:', err);
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
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <div class="pending-info">
        <div class="pending-merchant">${txn.merchant || 'Unknown merchant'}</div>
        <div class="pending-date">${formatDate(txn.occurred_at)}</div>
      </div>
      <div class="pending-amount">${fmt(txn.amount)}</div>
    `;
    card.addEventListener('click', () => openCategorizeModal(txn));
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
    console.error('Categorize failed:', err);
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
    console.error('Delete recurring transaction failed:', err);
    alert('Failed to delete recurring transaction');
  }
}

function renderSettings(categories) {
  const list = document.getElementById('settings-list');
  list.innerHTML = '';
  categories.forEach((cat) => {
    const existing = state.dashboard.categories?.find((c) => c.categoryId === cat.id);
    const amount = existing?.allotted || 0;
    const included = cat.included_in_budget === undefined ? true : !!cat.included_in_budget;
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-icon">${cat.icon}</div>
      <div class="settings-main">
        <div class="settings-name" data-cat-id="${cat.id}">${cat.name}</div>
        <label class="settings-toggle">
          <input type="checkbox" class="settings-toggle-input" data-cat-id="${cat.id}" ${included ? 'checked' : ''} />
          <span class="settings-toggle-slider"></span>
          <span class="settings-toggle-label">Include in budget</span>
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
    input.addEventListener('input', scheduleSaveBudgets);

    const toggleInput = row.querySelector('.settings-toggle-input');
    toggleInput.addEventListener('change', () => toggleCategoryInclusion(cat.id, toggleInput.checked));

    const editBtn = row.querySelector('.btn-edit-cat');
    editBtn.addEventListener('click', () => editCategoryName(cat.id, cat.name));

    const deleteBtn = row.querySelector('.btn-delete-cat');
    deleteBtn.addEventListener('click', () => deleteCategory(cat.id, cat.name));

    list.appendChild(row);
  });
}

async function toggleCategoryInclusion(categoryId, includedInBudget) {
  try {
    await apiFetch(`/api/categories/${categoryId}/inclusion`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includedInBudget }),
    });
    const cat = state.categories.find((c) => c.id === categoryId);
    if (cat) cat.included_in_budget = includedInBudget ? 1 : 0;
    await loadDashboard();
  } catch (err) {
    console.error('Toggle category inclusion failed:', err);
    alert('Failed to update category. Please try again.');
    renderSettings(state.categories); // revert the toggle UI
  }
}

async function deleteCategory(id, name) {
  if (!confirm('Delete category "' + name + '"? Existing categorized transactions keep their history, but you will not be able to assign new ones to it.')) return;
  try {
    await apiFetch('/api/categories/' + id, { method: 'DELETE' });
    await loadCategories();
    await loadDashboard();
    renderSettings(state.categories);
  } catch (err) {
    console.error('Delete category failed:', err);
    alert('Failed to delete category');
  }
}

// Global variable to track the category being edited
let currentEditingCategory = null;

async function editCategoryName(categoryId, currentName) {
  // Set the current editing category
  currentEditingCategory = { id: categoryId, name: currentName };

  // Show the edit modal
  const modal = document.getElementById('modal-edit-category');
  const input = document.getElementById('edit-category-input');
  input.value = currentName;
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

  try {
    await apiFetch(`/api/categories/${currentEditingCategory.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
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
  const inputs = document.querySelectorAll('.settings-input[data-cat-id]');
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
  try {
    await Promise.all(saves);
    const btn = document.getElementById('btn-save-budgets');
    btn.textContent = 'Saved ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Save Budgets';
      btn.style.background = '';
    }, 1800);
    await loadDashboard();
  } catch (err) {
    console.error('Save budgets failed:', err);
  }
}

async function addCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  const icon = document.getElementById('new-cat-icon').value.trim() || '💳';
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
    document.getElementById('new-cat-icon').value = '';
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
    console.error('Add manual transaction failed:', err);
    alert('Failed to add transaction');
  }
}

// ============================================================
// Web Push subscription registration
// ============================================================
async function registerPush() {
  if (!('PushManager' in window)) {
    alert('FAIL: PushManager not supported in this browser.');
    return;
  }
  try {
    alert('Step 1: Getting service worker...');
    const reg = await navigator.serviceWorker.ready;
    alert('Step 2: Checking existing subscription...');
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      alert('Already subscribed! Endpoint: ' + existing.endpoint.slice(0, 50));
      return;
    }
    alert('Step 3: Requesting permission...');
    const permission = await Notification.requestPermission();
    alert('Step 4: Permission result = ' + permission);
    if (permission !== 'granted') {
      alert('FAIL: Permission denied. Go to Chrome site settings and allow notifications for this site.');
      return;
    }
    alert('Step 5: Subscribing to push...');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(
        'BMFTguCzw91x3-qNsNiXCPDGebbL_NQem6Rl57YpUXbHedQ0Q_aQZgPlXjFtqZOwfAefcAQtjnAlNmduea5elNM'
      ),
    });
    alert('Step 6: Sending subscription to server...');
    await apiFetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    alert('SUCCESS: Push notifications enabled!');
  } catch (err) {
    alert('ERROR at some step: ' + err.message);
  }
}
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map((c) => c.charCodeAt(0)));
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
    console.error('Transactions load failed:', err);
  }
}

function filterTransactionsBySearch(transactions) {
  const query = transactionFilters.search.toLowerCase();
  if (query.length < 3) return transactions;
  return transactions.filter((txn) => {
    const merchant = (txn.merchant || '').toLowerCase();
    const notes = (txn.notes || '').toLowerCase();
    return merchant.includes(query) || notes.includes(query);
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
      item.className = 'transaction-item';
      item.innerHTML = `
        <div class="transaction-info">
          <div class="transaction-merchant">${txn.merchant || 'Unknown merchant'}</div>
          <div class="transaction-date">${formatDate(txn.occurred_at)}</div>
          ${txn.notes ? `<div class="transaction-notes">${txn.notes}</div>` : ''}
        </div>
        <div class="transaction-amount">${fmt(txn.amount)}</div>
        <button class="btn-edit-notes" data-txn-id="${txn.id}">📝</button>
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
    }

    list.appendChild(item);
  });

  // Add event listeners for edit notes buttons
  document.querySelectorAll('.btn-edit-notes').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const transactionId = btn.dataset.txnId;
      const transaction = transactions.find(t => t.id == transactionId);
      openNotesModal(transaction);
    });
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
    await loadTransactions(); // Refresh the transaction list
    await loadDashboard(); // Refresh dashboard in case this affects budget calculations
  } catch (err) {
    console.error('Delete transaction failed:', err);
    alert('Failed to delete transaction');
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

function openNotesModal(transaction) {
  state.currentTxn = transaction;
  const modal = document.getElementById('modal-notes');
  document.getElementById('notes-merchant').textContent = transaction.merchant || 'Unknown merchant';
  document.getElementById('notes-amount').textContent = fmt(transaction.amount);
  document.getElementById('notes-date').textContent = formatDate(transaction.occurred_at);
  document.getElementById('notes-input').value = transaction.notes || '';

  // Populate category dropdown
  const categorySelect = document.getElementById('notes-category');
  categorySelect.innerHTML = '<option value="">No category</option>';

  state.categories.forEach((cat) => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = `${cat.icon} ${cat.name}`;
    categorySelect.appendChild(option);
  });

  // Set current category if transaction has one
  if (transaction.category_id) {
    categorySelect.value = transaction.category_id;
  } else {
    categorySelect.value = '';
  }

  modal.classList.remove('hidden');
}

function closeNotesModal() {
  document.getElementById('modal-notes').classList.add('hidden');
  state.currentTxn = null;
}

async function saveNotes() {
  const notes = document.getElementById('notes-input').value.trim();
  const categoryId = document.getElementById('notes-category').value;
  const transactionId = state.currentTxn.id;

  console.log(`Attempting to save notes and category for transaction ${transactionId}:`, { notes, categoryId });

  try {
    console.log('Calling apiFetch...');
    const response = await apiFetch(`/api/transactions/${transactionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: notes,
        categoryId: categoryId || null // Send null if no category selected
      }),
    });

    console.log('Notes and category saved successfully, response:', response);
    closeNotesModal();
    await Promise.all([loadTransactions(), loadDashboard()]); // Refresh both transaction list and dashboard

    const btn = document.getElementById('btn-save-notes');
    btn.textContent = 'Saved ✓';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      btn.textContent = 'Save Notes';
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
let csvImportState = {
  fileContent: null,
  potentialDuplicates: [],
  currentDuplicateIndex: 0
};

async function importCSVTransactions(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.name.endsWith('.csv')) {
    alert('Please select a CSV file');
    event.target.value = '';
    return;
  }

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const csvContent = e.target.result;

        // Store the file content for later use
        csvImportState.fileContent = csvContent;
        csvImportState.potentialDuplicates = [];
        csvImportState.currentDuplicateIndex = 0;

        const btn = document.getElementById('btn-csv-import');
        btn.textContent = 'Scanning for duplicates...';
        btn.disabled = true;

        // First scan for potential duplicates
        const scanResponse = await fetch('/api/transactions/csv?scanOnly=true', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/csv',
          },
          body: csvContent,
        });

        if (!scanResponse.ok) {
          const errorData = await scanResponse.json();
          throw new Error(errorData.error || `CSV scan failed: ${scanResponse.status}`);
        }

        const scanResult = await scanResponse.json();

        if (scanResult.potentialDuplicates && scanResult.potentialDuplicates.length > 0) {
          // Show duplicate resolution dialog
          csvImportState.potentialDuplicates = scanResult.potentialDuplicates;
          showDuplicateResolutionDialog(0);
        } else {
          // No duplicates found, proceed with automatic import
          proceedWithCSVImport();
        }

      } catch (err) {
        console.error('CSV import failed:', err);
        alert('CSV import failed: ' + err.message);
        const btn = document.getElementById('btn-csv-import');
        btn.textContent = 'Import CSV Transactions';
        btn.style.background = '';
        btn.disabled = false;
        event.target.value = '';
      }
    };
    reader.readAsText(file);

  } catch (err) {
    console.error('CSV import failed:', err);
    alert('CSV import failed: ' + err.message);
    const btn = document.getElementById('btn-csv-import');
    btn.textContent = 'Import CSV Transactions';
    btn.style.background = '';
    btn.disabled = false;
    event.target.value = '';
  }
}

async function proceedWithCSVImport() {
  const btn = document.getElementById('btn-csv-import');
  btn.textContent = 'Importing...';
  btn.disabled = true;

  try {
    // Get all transactions that were approved by user (not skipped)
    const approvedTransactions = csvImportState.potentialDuplicates
      .filter(dup => {
        // In our current implementation, we skip all duplicates
        // In a full implementation, we would track user choices here
        return false; // Currently skipping all duplicates
      })
      .map(dup => dup.transaction);

    const response = await fetch('/api/transactions/csv', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv',
      },
      body: csvImportState.fileContent,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `CSV import failed: ${response.status}`);
    }

    const result = await response.json();

    // Show success feedback
    btn.textContent = 'Imported ✓';
    btn.style.background = '#16a34a';
    setTimeout(() => {
      btn.textContent = 'Import CSV Transactions';
      btn.style.background = '';
      btn.disabled = false;
    }, 1500);

    // Clear the file input
    document.getElementById('csv-file-input').value = '';

    // Refresh data
    await Promise.all([loadPending(), loadDashboard()]);
    if (activeView === 'transactions') {
      await loadTransactions();
    }

    // Calculate actual results based on what was imported
    // Use the total transactions count from the backend and subtract skipped transactions
    const totalTransactions = result.totalTransactions || 0;
    const actuallySkippedDuplicates = csvImportState.potentialDuplicates.length; // Duplicates that were skipped
    const nonCurrentMonthSkipped = result.skippedCount; // Transactions not from current month
    const totalSkipped = actuallySkippedDuplicates + nonCurrentMonthSkipped;
    const actuallyImported = totalTransactions - totalSkipped; // Calculate imported count

    // Show detailed results to user with accurate imported count
    alert(`CSV Import Complete!\n\n${actuallyImported} transactions imported\n${actuallySkippedDuplicates} duplicates skipped\n${nonCurrentMonthSkipped} transactions not from current month\n${result.errorCount} errors encountered`);

  } catch (err) {
    console.error('CSV import failed:', err);
    alert('CSV import failed: ' + err.message);
    const btn = document.getElementById('btn-csv-import');
    btn.textContent = 'Import CSV Transactions';
    btn.style.background = '';
    btn.disabled = false;
    document.getElementById('csv-file-input').value = '';
  }
}

function showDuplicateResolutionDialog(duplicateIndex) {
  if (duplicateIndex >= csvImportState.potentialDuplicates.length) {
    // All duplicates resolved, proceed with import
    proceedWithCSVImport();
    return;
  }

  const duplicate = csvImportState.potentialDuplicates[duplicateIndex];
  const newTxn = duplicate.transaction;
  const existingTxn = duplicate.existingTransaction;

  // Format dates for display
  const formatDateForDisplay = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  // Create modal HTML
  const modalHTML = `
    <div class="modal-overlay">
      <div class="duplicate-modal">
        <h3>Potential Duplicate Transaction</h3>
        <p>We found a potential duplicate transaction. Please review and choose an action:</p>

        <div class="duplicate-comparison">
          <div class="transaction-existing">
            <h4>Existing Transaction</h4>
            <p><strong>Merchant:</strong> ${existingTxn.merchant}</p>
            <p><strong>Amount:</strong> $${existingTxn.amount.toFixed(2)}</p>
            <p><strong>Date:</strong> ${formatDateForDisplay(existingTxn.occurred_at)}</p>
          </div>

          <div class="transaction-new">
            <h4>New Transaction</h4>
            <p><strong>Merchant:</strong> ${newTxn.merchant}</p>
            <p><strong>Amount:</strong> $${newTxn.amount.toFixed(2)}</p>
            <p><strong>Date:</strong> ${formatDateForDisplay(newTxn.occurredAt)}</p>
          </div>
        </div>

        <p style="margin-top: 16px; font-size: 14px; color: var(--text-dim);">
          These transactions have the same amount and similar merchant names (8+ character match).
        </p>

        <div class="duplicate-actions">
          <button id="btn-skip-duplicate" class="btn-skip">Skip This Transaction</button>
          <button id="btn-import-duplicate" class="btn-import">Import Anyway</button>
        </div>

        <div class="duplicate-progress">
          Processing duplicate ${duplicateIndex + 1} of ${csvImportState.potentialDuplicates.length}
        </div>
      </div>
    </div>
  `;

  // Add modal to body
  const modalContainer = document.createElement('div');
  modalContainer.id = 'duplicate-resolution-modal';
  modalContainer.innerHTML = modalHTML;
  document.body.appendChild(modalContainer);

  // Add event listeners
  document.getElementById('btn-skip-duplicate').addEventListener('click', () => {
    document.body.removeChild(modalContainer);
    showDuplicateResolutionDialog(duplicateIndex + 1);
  });

  document.getElementById('btn-import-duplicate').addEventListener('click', () => {
    document.body.removeChild(modalContainer);
    // For now, we'll skip all duplicates in the first pass
    // In a full implementation, we would track user choices and import selected ones
    showDuplicateResolutionDialog(duplicateIndex + 1);
  });
}
