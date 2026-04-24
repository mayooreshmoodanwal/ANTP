/**
 * ANTP Dashboard — Application Logic (v2 with JWT Auth)
 * Decentralized Edge-Compute Platform
 */

const API_BASE = 'https://antp-nlc8.onrender.com';
const POLL_INTERVAL_MS = 5000;

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let isOnline = false;
let pollTimer = null;
let currentUser = null; // null if not logged in
let authToken = localStorage.getItem('antp_jwt');
let wasmFileBase64 = null;

// ─────────────────────────────────────────────
// DOM Helpers
// ─────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'block';
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function showToast(message, type = 'info') {
  const existing = $('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(16px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─────────────────────────────────────────────
// API Client (Authenticated)
// ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    // Auto-logout on token expiration
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') {
      logout();
      throw new Error('Session expired');
    }

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    return body;
  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      setOffline();
      throw new Error('Network error — orchestrator unreachable');
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Init & Auth Flow
// ─────────────────────────────────────────────
async function initApp() {
  // Check for email verification token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const verifyToken = urlParams.get('verify');
  if (verifyToken) {
    await verifyEmail(verifyToken);
    return;
  }

  // Attempt to resume session
  if (authToken) {
    try {
      const data = await apiFetch('/api/auth/me');
      currentUser = data; // Set current user session
      renderApp();
    } catch (err) {
      console.warn("Session invalid, clearing.");
      logout();
    }
  } else {
    // Show auth screen immediately
    show('auth-screen');
    hide('dashboard-screen');
  }

  initAuthUI();
  loadPricing(); // Pricing is public
}

function renderApp() {
  hide('auth-screen');
  show('dashboard-screen');
  
  // Clean URL params
  window.history.replaceState({}, document.title, window.location.pathname);

  // Setup user menu
  const initial = currentUser.name.charAt(0).toUpperCase();
  setText('user-avatar', initial);
  setText('dropdown-name', currentUser.name);
  setText('dropdown-email', currentUser.email);
  setText('dropdown-role', currentUser.role);

  // Setup tabs
  initTabs();

  // Load initial data
  if (currentUser.role === 'DEVELOPER' || currentUser.role === 'ADMIN') {
    initSubmitForm();
    loadMyTasks();
    loadApiKeys();
  }
  
  if (currentUser.role === 'NODE_PROVIDER' || currentUser.role === 'ADMIN') {
    initNodePairing();
    loadMyEarnings();
  }

  initTracker();
  initNodeLookup();

  refreshOverview();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshOverview, POLL_INTERVAL_MS);
}

// ─────────────────────────────────────────────
// Auth UI Logic
// ─────────────────────────────────────────────
function initAuthUI() {
  // Toggle between Login and Signup
  $('#show-signup')?.addEventListener('click', (e) => {
    e.preventDefault();
    hide('login-form');
    show('signup-form');
  });

  $('#show-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    hide('signup-form');
    show('login-form');
  });

  // Login Submit
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const errBox = $('#login-error');
    errBox.style.display = 'none';
    
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#login-email').value,
          password: $('#login-password').value
        })
      });

      authToken = res.token;
      localStorage.setItem('antp_jwt', authToken);
      currentUser = res.user;
      renderApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  // Signup Submit
  $('#signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#signup-btn');
    const errBox = $('#signup-error');
    const sucBox = $('#signup-success');
    errBox.style.display = 'none';
    sucBox.style.display = 'none';
    
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    try {
      const res = await apiFetch('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#signup-name').value,
          email: $('#signup-email').value,
          password: $('#signup-password').value,
          role: $('#signup-role').value
        })
      });

      sucBox.textContent = res.message;
      sucBox.style.display = 'block';
      setTimeout(() => {
        hide('signup-form');
        show('login-form');
        $('#login-email').value = $('#signup-email').value;
      }, 3000);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  // Logout
  $('#btn-logout')?.addEventListener('click', logout);

  // User menu toggle
  $('#user-avatar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#user-dropdown');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => {
    hide('user-dropdown');
  });
}

async function verifyEmail(token) {
  try {
    const res = await apiFetch('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    
    // Auto-login after verification
    authToken = res.token;
    localStorage.setItem('antp_jwt', authToken);
    currentUser = res.user;
    showToast('Email verified successfully!', 'success');
    renderApp();
  } catch (err) {
    showToast(`Verification failed: ${err.message}`, 'error');
    show('auth-screen');
    hide('dashboard-screen');
  }
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('antp_jwt');
  if (pollTimer) clearInterval(pollTimer);
  show('auth-screen');
  hide('dashboard-screen');
}

// ─────────────────────────────────────────────
// Tab Routing (Role Based)
// ─────────────────────────────────────────────
function initTabs() {
  const isDev = currentUser.role === 'DEVELOPER' || currentUser.role === 'ADMIN';
  const isNode = currentUser.role === 'NODE_PROVIDER' || currentUser.role === 'ADMIN';

  // Build tab nav based on role
  let tabHtml = `
    <button class="tab-btn active" data-tab="overview"><span class="tab-icon">📊</span> Overview</button>
  `;
  
  if (isDev) {
    tabHtml += `
      <button class="tab-btn" data-tab="submit"><span class="tab-icon">🚀</span> Submit Task</button>
      <button class="tab-btn" data-tab="my-tasks"><span class="tab-icon">📋</span> My Tasks</button>
      <button class="tab-btn" data-tab="api-keys"><span class="tab-icon">🔑</span> API Keys</button>
    `;
  }

  if (isNode) {
    tabHtml += `
      <button class="tab-btn" data-tab="my-nodes"><span class="tab-icon">🖥️</span> My Fleet</button>
      <button class="tab-btn" data-tab="earnings"><span class="tab-icon">💰</span> Earnings</button>
    `;
  }

  tabHtml += `
    <button class="tab-btn" data-tab="tracker"><span class="tab-icon">🔍</span> Task Tracker</button>
    <button class="tab-btn" data-tab="node-lookup"><span class="tab-icon">🖥️</span> Node Lookup</button>
    <button class="tab-btn" data-tab="pricing"><span class="tab-icon">💵</span> Pricing</button>
  `;

  setHtml('tab-nav', tabHtml);

  // Bind click logic
  const tabBtns = $$('.tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      // Update active button
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      // Update active panel
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      const panel = $(`#panel-${tab}`);
      if (panel) panel.classList.add('active');
    });
  });

  // Ensure first tab is active
  $$('.tab-panel').forEach(p => p.classList.remove('active'));
  $('#panel-overview').classList.add('active');
}

// ─────────────────────────────────────────────
// Connection Status
// ─────────────────────────────────────────────
function setOnline() {
  if (isOnline) return;
  isOnline = true;
  $('#live-dot')?.classList.remove('offline');
  setText('live-status', 'Live');
}

function setOffline() {
  isOnline = false;
  $('#live-dot')?.classList.add('offline');
  setText('live-status', 'Offline');
}

// ─────────────────────────────────────────────
// Format Helpers
// ─────────────────────────────────────────────
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function truncId(id, len = 12) {
  if (!id || id.length <= len) return id || '—';
  return id.substring(0, len) + '…';
}

function encodeBytesBase64(inputString) {
  try {
    return btoa(inputString);
  } catch {
    const bytes = new TextEncoder().encode(inputString);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }
}

// ═══════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════
async function refreshOverview() {
  try {
    const [systemStats, queueStats, health] = await Promise.all([
      apiFetch('/api/system/stats'),
      apiFetch('/api/queue/stats'),
      apiFetch('/api/health'),
    ]);

    setOnline();

    setText('stat-nodes', health.connectedNodes ?? 0);
    setText('stat-total-tasks', systemStats.database?.tasks?.totalTasks ?? 0);
    setText('stat-completed', systemStats.database?.tasks?.completedTasks ?? 0);
    setText('stat-pending', systemStats.database?.tasks?.pendingTasks ?? 0);

    const qTier1 = queueStats.TIER_1?.depth ?? 0;
    const qTier2 = queueStats.TIER_2?.depth ?? 0;
    const qTier3 = queueStats.TIER_3?.depth ?? 0;
    const qTotal = qTier1 + qTier2 + qTier3;
    setText('queue-t1', qTier1);
    setText('queue-t2', qTier2);
    setText('queue-t3', qTier3);
    setText('queue-total-badge', `${qTotal} queued`);

    const nodes = systemStats.database?.nodes || {};
    setText('nodes-t1', nodes.tier1Nodes ?? 0);
    setText('nodes-t2', nodes.tier2Nodes ?? 0);
    setText('nodes-t3', nodes.tier3Nodes ?? 0);
    setText('nodes-online-badge', `${nodes.onlineNodes ?? 0} online`);

    setText('stat-uptime', formatUptime(health.uptime ?? 0));
    setText('stat-fallbacks', systemStats.database?.tasks?.cloudFallbacks ?? 0);
    setText('stat-failed', systemStats.database?.tasks?.failedTasks ?? 0);
    setText('stat-sla-timeout', formatMs(systemStats.sla?.timeoutMs ?? 5000));
  } catch (err) {
    console.warn('[Overview] Refresh failed:', err.message);
  }
}

// ═══════════════════════════════════════════════
// SUBMIT TASK TAB (Developer)
// ═══════════════════════════════════════════════
function initSubmitForm() {
  const fileInput = $('#wasm-file');
  const uploadArea = $('#wasm-upload');
  const form = $('#submit-form');

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleWasmFile(file);
    });
  }

  if (uploadArea) {
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('drag-over');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleWasmFile(file);
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitTask();
    });
  }
}

function handleWasmFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const bytes = new Uint8Array(e.target.result);
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    wasmFileBase64 = btoa(binary);

    $('#wasm-upload').classList.add('has-file');
    setText('wasm-file-name', `✓ ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
  };
  reader.readAsArrayBuffer(file);
}

async function submitTask() {
  const btn = $('#submit-btn');
  const inputText = $('#task-input').value.trim();
  
  btn.disabled = true;
  btn.textContent = '⏳ Submitting…';

  try {
    const body = {
      tier: $('#task-tier').value,
      timeoutMs: parseInt($('#task-timeout').value, 10) || 5000,
    };
    if (wasmFileBase64) body.wasmBytes = wasmFileBase64;
    if (inputText) body.input = encodeBytesBase64(inputText);

    const result = await apiFetch('/api/task', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    showToast('Task submitted successfully!', 'success');
    loadMyTasks(); // Refresh history table

    setHtml('submit-result', `
      <div class="result-panel">
        <div class="result-row"><span class="result-key">Task ID</span><span class="result-value mono">${result.taskId}</span></div>
        <div class="result-row"><span class="result-key">Tier</span><span class="result-value">${result.tier}</span></div>
        <div class="result-row"><span class="result-key">Status</span><span class="result-value"><span class="badge badge-online">${result.status}</span></span></div>
        <div class="mt-md">
          <button class="btn btn-secondary btn-full btn-sm" onclick="trackTaskFromExt('${result.taskId}')">🔍 Track Real-time Progress</button>
        </div>
      </div>
    `);
  } catch (err) {
    showToast(`Submit failed: ${err.message}`, 'error');
    setHtml('submit-result', `
      <div class="result-panel" style="border-color: var(--red);">
        <div class="empty-state">
          <div class="empty-state-icon">❌</div>
          <div class="empty-state-title">Submission Failed</div>
          <div class="empty-state-desc">${err.message}</div>
        </div>
      </div>
    `);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Submit to Network';
  }
}

// ═══════════════════════════════════════════════
// MY TASKS TAB (Developer)
// ═══════════════════════════════════════════════
async function loadMyTasks() {
  try {
    const data = await apiFetch('/api/my/tasks?limit=50');
    setText('my-tasks-total', `${data.stats?.total || 0} tasks`);

    if (data.tasks.length === 0) return;

    let html = `
      <table class="data-table mt-md">
        <thead>
          <tr>
            <th>ID</th>
            <th>Submitted</th>
            <th>Tier</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    data.tasks.forEach(t => {
      const date = new Date(t.submittedAt).toLocaleString();
      let badgeClass = 'badge-pending';
      if (t.status === 'COMPLETED') badgeClass = 'badge-online';
      if (t.status === 'FAILED' || t.status === 'SLA_BREACHED') badgeClass = 'badge-offline';

      html += `
        <tr class="clickable" onclick="trackTaskFromExt('${t.id}')">
          <td>${truncId(t.id)}</td>
          <td>${date}</td>
          <td>${t.tier}</td>
          <td><span class="badge ${badgeClass}">${t.status}</span></td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    setHtml('my-tasks-list', html);
  } catch (err) {
    console.error("Failed to load task history", err);
  }
}

// Helper to jump to tracker tab
window.trackTaskFromExt = function(taskId) {
  $$('.tab-btn').forEach((b) => b.classList.remove('active'));
  $$('.tab-panel').forEach((p) => p.classList.remove('active'));
  $('[data-tab="tracker"]').classList.add('active');
  $('#panel-tracker').classList.add('active');
  $('#tracker-task-id').value = taskId;
  trackTask();
};

// ═══════════════════════════════════════════════
// API KEYS TAB (Developer)
// ═══════════════════════════════════════════════
async function loadApiKeys() {
  try {
    const data = await apiFetch('/api/auth/api-keys');
    
    if (data.keys.length === 0) {
      setHtml('api-keys-list', `
        <div class="empty-state">
          <div class="empty-state-icon">🔑</div>
          <div class="empty-state-title">No API Keys</div>
          <div class="empty-state-desc">Generate an API key for programmatic access.</div>
        </div>
      `);
      return;
    }

    let html = '';
    data.keys.forEach(k => {
      const created = new Date(k.createdAt).toLocaleDateString();
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never';
      
      html += `
        <div class="api-key-item">
          <div class="api-key-info">
            <div class="api-key-name">${k.name}</div>
            <div class="api-key-prefix">${k.prefix}••••••••••••••••••••</div>
            <div class="api-key-meta">Created ${created} · Last used: ${lastUsed}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="revokeKey('${k.id}')">Revoke</button>
        </div>
      `;
    });
    setHtml('api-keys-list', html);
  } catch (err) {
    console.error("Failed to load API keys", err);
  }
}

$('#create-key-btn')?.addEventListener('click', async () => {
  const name = prompt("Name for this API Key (e.g. 'Production Worker')");
  if (!name) return;

  try {
    const res = await apiFetch('/api/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    
    // Show the raw key once
    show('new-key-display');
    const val = $('#new-key-value');
    val.textContent = res.key;
    val.onclick = () => {
      navigator.clipboard.writeText(res.key);
      showToast('Copied to clipboard!', 'success');
    };
    
    showToast('API Key generated', 'success');
    loadApiKeys();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

window.revokeKey = async function(id) {
  if (!confirm('Are you sure? This immediately breaks any integrations using this key.')) return;
  try {
    await apiFetch(`/api/auth/api-keys/${id}`, { method: 'DELETE' });
    showToast('Key revoked', 'success');
    loadApiKeys();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ═══════════════════════════════════════════════
// MY NODES & PAIRING (Node Provider)
// ═══════════════════════════════════════════════
function initNodePairing() {
  $('#pair-node-btn')?.addEventListener('click', () => {
    show('pair-modal');
    $('#pair-code-input').focus();
    $('#pair-code-input').value = '';
    hide('pair-error');
  });

  $('#pair-cancel-btn')?.addEventListener('click', () => {
    hide('pair-modal');
  });

  $('#pair-confirm-btn')?.addEventListener('click', async () => {
    const code = $('#pair-code-input').value.trim();
    if (code.length !== 6) return;

    const btn = $('#pair-confirm-btn');
    btn.disabled = true;
    hide('pair-error');

    try {
      await apiFetch('/api/auth/pair-node', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      showToast('Node Paired successfully!', 'success');
      hide('pair-modal');
      
      // Update session & refresh dashboard
      const me = await apiFetch('/api/auth/me');
      currentUser = me;
      loadMyEarnings();
    } catch (err) {
      $('#pair-error').textContent = err.message;
      show('pair-error');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderFleet(node) {
  if (!node) {
    setHtml('my-nodes-content', `
      <div class="empty-state">
        <div class="empty-state-icon">🖥️</div>
        <div class="empty-state-title">No Node Paired</div>
        <div class="empty-state-desc">Open the Edge Daemon app, copy your 6-character code, and pair it.</div>
      </div>
    `);
    return;
  }

  const isOnline = node.status === 'ONLINE' || node.status === 'BUSY';
  const html = `
    <div class="result-panel">
      <div class="flex justify-between items-center mb-md">
        <div>
          <div class="mono" style="font-size: 14px; font-weight: 700;">${truncId(node.nodeId, 16)}</div>
          <div class="text-muted mt-sm" style="font-size: 11px;">Tier: ${node.tier}</div>
        </div>
        <span class="badge ${isOnline ? 'badge-online' : 'badge-offline'}">${node.status}</span>
      </div>
      <div class="stats-grid mt-md">
        <div class="stat-card">
          <div class="stat-label">Tasks Executed</div>
          <div class="stat-value text-green">${node.totalTasksCompleted}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Reputation</div>
          <div class="stat-value text-accent">${node.reputationScore.toFixed(1)}</div>
        </div>
      </div>
      <div class="result-row mt-md">
        <span class="result-key">Last Seen</span>
        <span class="result-value">${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : 'Never'}</span>
      </div>
    </div>
  `;
  setHtml('my-nodes-content', html);
}

// ═══════════════════════════════════════════════
// EARNINGS (Node Provider)
// ═══════════════════════════════════════════════
async function loadMyEarnings() {
  renderFleet(currentUser.linkedNode);

  try {
    const res = await apiFetch('/api/my/earnings');
    const { earnings } = res;
    
    setText('earn-balance', `$${(earnings.unpaidBalance || 0).toFixed(3)}`);
    setText('earn-total', `$${(earnings.totalEarned || 0).toFixed(3)}`);
    setText('earn-tasks', earnings.taskCount || 0);
    setText('earn-reputation', (earnings.reputationScore || 100).toFixed(1));

    if (!earnings.history || earnings.history.length === 0) return;

    let html = `
      <table class="data-table mt-md">
        <thead><tr><th>Time</th><th>Task</th><th>Amount</th></tr></thead>
        <tbody>
    `;
    earnings.history.forEach(p => {
      html += `
        <tr>
          <td>${new Date(p.createdAt).toLocaleString()}</td>
          <td class="mono">${truncId(p.taskId)}</td>
          <td class="text-green">+$${p.amount.toFixed(3)}</td>
        </tr>
      `;
    });
    html += '</tbody></table>';
    setHtml('earnings-history', html);

  } catch (err) {
    console.error("Failed to load earnings", err);
  }
}

// ═══════════════════════════════════════════════
// TASK TRACKER TAB
// ═══════════════════════════════════════════════
function initTracker() {
  $('#tracker-btn')?.addEventListener('click', trackTask);
  $('#tracker-task-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') trackTask();
  });
}

async function trackTask() {
  const taskId = $('#tracker-task-id').value.trim();
  if (!taskId) return;

  try {
    const task = await apiFetch(`/api/task/${taskId}/status`);
    renderTaskStatus(task);
  } catch (err) {
    setHtml('tracker-result', `
      <div class="result-panel" style="border-color: var(--red);">
        <div class="text-center text-red p-4">${err.message}</div>
      </div>
    `);
  }
}

function renderTaskStatus(task) {
  // Same logic as before, just kept intact
  const statusColor = task.status === 'COMPLETED' ? 'badge-online' : 
                      task.status === 'FAILED' ? 'badge-offline' : 'badge-accent';
                      
  const deadline = new Date(task.slaDeadlineAt).getTime();
  const remaining = deadline - Date.now();
  const slaText = remaining > 0 ? `${(remaining/1000).toFixed(1)}s left` : 'BREACHED';

  const clonesHtml = (task.cloneIds || []).map((cid, i) => {
    const res = task.results?.[cid];
    const status = res ? (res.status === 'OK' ? 'completed' : 'failed') : 'queued';
    return `<div class="clone-row"><span class="clone-index">Clone ${i+1}</span><div class="clone-bar"><div class="clone-fill ${status}"></div></div></div>`;
  }).join('');

  setHtml('tracker-result', `
    <div class="result-panel">
      <div class="flex justify-between items-center mb-md">
        <div class="mono" style="font-size: 13px;">${task.taskId}</div>
        <span class="badge ${statusColor}">${task.status}</span>
      </div>
      <div class="sla-countdown ${remaining>0 ? 'ok' : 'breached'}">${slaText}</div>
      <div class="mt-md">${clonesHtml}</div>
    </div>
  `);
}

// ═══════════════════════════════════════════════
// NODE LOOKUP & PRICING
// ═══════════════════════════════════════════════
function initNodeLookup() {
  $('#node-lookup-btn')?.addEventListener('click', async () => {
    const id = $('#node-lookup-id').value.trim();
    if (!id) return;
    try {
      const node = await apiFetch(`/api/node/${id}/stats`);
      setHtml('node-result', `
        <div class="result-panel">
          <div class="flex justify-between"><span class="mono">${id}</span><span class="badge ${node.isConnected ? 'badge-online' : 'badge-offline'}">Status</span></div>
          <div class="stats-grid mt-md">
            <div class="stat-card"><div class="stat-label">Tasks Done</div><div class="stat-value text-green">${node.totalTasksCompleted||0}</div></div>
            <div class="stat-card"><div class="stat-label">Reputation</div><div class="stat-value text-accent">${(node.reputation||100).toFixed(1)}</div></div>
          </div>
        </div>
      `);
    } catch(err) {
      setHtml('node-result', `<div class="text-red p-4">${err.message}</div>`);
    }
  });
}

async function loadPricing() {
  try {
    const res = await fetch(`${API_BASE}/api/tiers`);
    const tiers = await res.json();
    // Assuming tiers returns { TIER_1: 0.001, ... }
    // Hardcoded logic was fine here since we didn't add IDs to pricing rates in rewrite, 
    // but preserving if needed.
  } catch {}
}

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initApp);
