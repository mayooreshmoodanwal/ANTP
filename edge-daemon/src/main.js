// ANTP Edge Daemon Dashboard — Tauri IPC frontend

const { invoke } = window.__TAURI__.core;

// DOM elements
const els = {
  connectionBadge: document.getElementById('connection-badge'),
  nodeId: document.getElementById('node-id'),
  tierBadge: document.getElementById('tier-badge'),
  statusText: document.getElementById('status-text'),
  pairingSection: document.getElementById('pairing-section'),
  pairingCodeDisplay: document.getElementById('pairing-code-display'),
  tasksCompleted: document.getElementById('tasks-completed'),
  tasksProgress: document.getElementById('tasks-progress'),
  totalEarnings: document.getElementById('total-earnings'),
  reputation: document.getElementById('reputation'),
  hwCpu: document.getElementById('hw-cpu'),
  hwGpu: document.getElementById('hw-gpu'),
  hwRam: document.getElementById('hw-ram'),
  ramBar: document.getElementById('ram-bar'),
  ramUsed: document.getElementById('ram-used'),
  ramPressure: document.getElementById('ram-pressure'),
  ramAvailable: document.getElementById('ram-available'),
  uptime: document.getElementById('uptime'),
};

// Format uptime from milliseconds
function formatUptime(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);

  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

// Format currency
function formatEarnings(amount) {
  return `$${amount.toFixed(3)}`;
}

// Tier display names
const tierNames = {
  'TIER_1': 'Tier 1',
  'TIER_2': 'Tier 2',
  'TIER_3': 'Tier 3 (VIP)',
  'PENDING_PROFILE': 'Pending',
};

// Update dashboard from daemon status
async function updateDashboard() {
  try {
    const status = await invoke('get_status');

    // Connection badge
    els.connectionBadge.textContent = status.connected ? 'ONLINE' : 'OFFLINE';
    els.connectionBadge.className = `badge badge--${status.connected ? 'online' : 'offline'}`;

    // Node identity
    els.nodeId.textContent = status.node_id || 'Generating...';
    els.tierBadge.textContent = tierNames[status.tier] || status.tier;
    els.statusText.textContent = status.status;

    // Pairing code UI
    if (status.pairing_code) {
      els.pairingSection.style.display = 'block';
      els.pairingCodeDisplay.textContent = status.pairing_code;
    } else {
      els.pairingSection.style.display = 'none';
    }

    // Stats
    els.tasksCompleted.textContent = status.tasks_completed.toLocaleString();
    els.tasksProgress.textContent = status.tasks_in_progress;
    els.totalEarnings.textContent = formatEarnings(status.total_earnings);
    els.reputation.textContent = status.reputation.toFixed(1);

    // Hardware
    els.hwCpu.textContent = status.cpu_model || '—';
    els.hwGpu.textContent = status.gpu_model || 'None';
    els.hwRam.textContent = `${status.total_ram_mb} MB total`;

    // Uptime
    els.uptime.textContent = formatUptime(status.uptime_ms);

    // Pulse animation color based on status
    const pulse = document.querySelector('.logo-pulse');
    if (status.connected) {
      pulse.style.background = '#22c55e';
      pulse.style.boxShadow = '0 0 8px rgba(34, 197, 94, 0.3)';
    } else {
      pulse.style.background = '#ef4444';
      pulse.style.boxShadow = '0 0 8px rgba(239, 68, 68, 0.3)';
    }
  } catch (err) {
    console.error('Failed to get status:', err);
  }
}

// Update RAM monitor
async function updateRam() {
  try {
    const ram = await invoke('get_ram_status');

    const usagePercent = ram.usage_percent;
    els.ramBar.style.width = `${usagePercent}%`;

    // Color coding
    if (usagePercent > 85) {
      els.ramBar.classList.add('high');
    } else {
      els.ramBar.classList.remove('high');
    }

    els.ramUsed.textContent = `${ram.used_mb} MB used`;
    els.ramAvailable.textContent = `${ram.available_mb} MB available`;

    // Pressure badge
    els.ramPressure.textContent = ram.pressure_level;
    const pressureClass = ram.pressure_level.toLowerCase();
    els.ramPressure.className = `badge badge--${pressureClass}`;
  } catch (err) {
    console.error('Failed to get RAM status:', err);
  }
}

// Initial load
updateDashboard();
updateRam();

// Polling intervals
setInterval(updateDashboard, 2000);  // Status every 2s
setInterval(updateRam, 1000);        // RAM every 1s
