// ============================================================
// ExecDaat — Settings & Profile Module
// Manages: PIN gate, Settings modal, Profile modal
// ============================================================

// ── State ─────────────────────────────────────────────────
let settingsUnlocked = false;   // PIN já verificado nesta sessão
let settingsData     = null;    // cache dos dados do servidor
let pendingModal     = null;    // qual modal abrir após PIN ('settings' | 'profile')

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettingsFromServer();

  // Atualizar wallet badge no profile quando conectar
  window.addEventListener('walletConnected', (e) => {
    const { shortAddress, onArcNetwork } = e.detail;
    const badge = document.getElementById('prof-wallet-badge');
    if (badge) {
      badge.innerHTML = `<i class="fas fa-circle text-green-400" style="font-size:6px"></i> Wallet: ${shortAddress}`;
      badge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-900/30 border border-green-700/30 text-xs text-green-400';
    }
    // Auto-fill wallet no profile
    const profWallet = document.getElementById('prof-wallet');
    if (profWallet) profWallet.value = e.detail.address || '';
  });

  window.addEventListener('walletDisconnected', () => {
    const badge = document.getElementById('prof-wallet-badge');
    if (badge) {
      badge.innerHTML = `<i class="fas fa-circle text-gray-600" style="font-size:6px"></i> Wallet: Not connected`;
      badge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800 border border-gray-700 text-xs text-gray-400';
    }
  });
});

// ── Load settings from server ─────────────────────────────
async function loadSettingsFromServer() {
  try {
    const res = await axios.get('/api/settings');
    settingsData = res.data.settings;
    applySettingsToUI();
    updateProfileButton();
    updateSettingsDot();
  } catch (e) {
    console.warn('[Settings] Could not load from server:', e.message);
  }
}

// ── Apply loaded settings to UI fields ────────────────────
function applySettingsToUI() {
  if (!settingsData) return;

  const { profile, circle, app } = settingsData;

  // --- Profile ---
  if (profile) {
    setVal('prof-name',    profile.name);
    setVal('prof-email',   profile.email);
    setVal('prof-role',    profile.role);
    setVal('prof-company', profile.company);
    setVal('prof-wallet',  profile.walletAddress);
    if (profile.createdAt) document.getElementById('prof-created').textContent = formatDate(profile.createdAt);
    if (profile.updatedAt) document.getElementById('prof-updated').textContent = formatDate(profile.updatedAt);
    updateProfilePreview();
  }

  // --- Circle ---
  if (circle) {
    if (circle.hasApiKey) {
      setVal('circle-api-key', circle.apiKeyMasked);
    }
    if (circle.hasWebhookSecret) {
      setVal('circle-webhook-secret', circle.webhookSecretMasked);
    }
    const envSandbox = document.getElementById('circle-env-sandbox');
    const envProd    = document.getElementById('circle-env-prod');
    if (envSandbox && envProd) {
      envSandbox.checked = circle.environment !== 'production';
      envProd.checked    = circle.environment === 'production';
    }
    updateCircleStatusBanner(circle);
    updateProfileIntegrations(circle);
  }

  // --- App config ---
  if (app) {
    setSelectVal('cfg-theme',    app.theme);
    setSelectVal('cfg-language', app.language);
    setSelectVal('cfg-refresh',  String(app.refreshInterval));
    setChecked('cfg-autorefresh',  app.autoRefresh);
    setChecked('cfg-notifications', app.notifications);
    // Show current-pin field if PIN exists
    const cpf = document.getElementById('current-pin-field');
    if (cpf) cpf.classList.toggle('hidden', !app.hasPIN);
  }
}

// ── Update settings dot indicator ─────────────────────────
function updateSettingsDot() {
  const dot = document.getElementById('settings-dot');
  if (!dot || !settingsData) return;
  const hasConfig = settingsData.circle?.hasApiKey || settingsData.profile?.name;
  dot.classList.toggle('hidden', !hasConfig);
}

// ── Update profile button avatar ──────────────────────────
function updateProfileButton() {
  if (!settingsData?.profile) return;
  const btn = document.getElementById('profile-avatar-btn');
  if (!btn) return;
  const initials = settingsData.profile.avatarInitials;
  btn.textContent = initials && initials !== '??' ? initials : '👤';
}

// ── Update Circle status banner ───────────────────────────
function updateCircleStatusBanner(circle) {
  const banner = document.getElementById('circle-status-banner');
  if (!banner) return;
  if (circle.isConnected) {
    banner.className = 'rounded-xl px-4 py-3 flex items-center gap-3 text-sm bg-green-900/30 border border-green-700/40 text-green-300';
    banner.innerHTML = `<i class="fas fa-check-circle text-green-400"></i><span><strong>Connected</strong> — Circle API (${circle.environment}) • Last tested: ${circle.lastTestAt ? formatDate(circle.lastTestAt) : 'never'}</span>`;
    banner.classList.remove('hidden');
    document.getElementById('circle-balances')?.classList.remove('hidden');
  } else if (circle.hasApiKey) {
    banner.className = 'rounded-xl px-4 py-3 flex items-center gap-3 text-sm bg-yellow-900/30 border border-yellow-700/40 text-yellow-300';
    banner.innerHTML = `<i class="fas fa-exclamation-circle text-yellow-400"></i><span>API key configured but not tested yet. Click <strong>Test Connection</strong> to verify.</span>`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ── Update profile integrations badges ───────────────────
function updateProfileIntegrations(circle) {
  const el = document.getElementById('profile-integrations');
  if (!el) return;
  const circleStatus = circle.isConnected
    ? `<span class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-900/30 border border-blue-700/30 text-xs text-blue-400"><i class="fas fa-circle text-blue-400" style="font-size:6px"></i> Circle API: Connected (${circle.environment})</span>`
    : `<span class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800 border border-gray-700 text-xs text-gray-400"><i class="fas fa-circle text-gray-600" style="font-size:6px"></i> Circle API: Not connected</span>`;
  const walletBadge = document.getElementById('prof-wallet-badge')?.outerHTML || '';
  el.innerHTML = circleStatus + (walletBadge || '');
}

// ════════════════════════════════════════════════════════
// PIN GATE
// ════════════════════════════════════════════════════════

function openSettingsModal() {
  pendingModal = 'settings';
  if (settingsData?.app?.hasPIN && !settingsUnlocked) {
    showPINModal();
  } else {
    showSettingsModal();
  }
}

function openProfileModal() {
  pendingModal = 'profile';
  if (settingsData?.app?.hasPIN && !settingsUnlocked) {
    showPINModal();
  } else {
    showProfileModal();
  }
}

function showPINModal() {
  const modal = document.getElementById('pin-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const inp = document.getElementById('pin-input');
  if (inp) { inp.value = ''; inp.focus(); }
  const err = document.getElementById('pin-error');
  if (err) err.classList.add('hidden');
}

function closePINModal() {
  const modal = document.getElementById('pin-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
  pendingModal = null;
}

async function verifyPIN() {
  const pin = document.getElementById('pin-input')?.value;
  if (!pin) return;
  try {
    const res = await axios.post('/api/settings/verify-pin', { pin });
    if (res.data.success) {
      settingsUnlocked = true;
      closePINModal();
      if (pendingModal === 'settings') showSettingsModal();
      else if (pendingModal === 'profile') showProfileModal();
    }
  } catch (err) {
    const errDiv = document.getElementById('pin-error');
    if (errDiv) errDiv.classList.remove('hidden');
    const inp = document.getElementById('pin-input');
    if (inp) { inp.value = ''; inp.focus(); }
  }
}

// ════════════════════════════════════════════════════════
// SETTINGS MODAL
// ════════════════════════════════════════════════════════

function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  loadSettingsFromServer(); // re-sync
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

function switchSettingsTab(tab) {
  // Tabs
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.classList.remove('border-purple-500', 'text-purple-400', 'active-stab');
    btn.classList.add('border-transparent', 'text-gray-400');
  });
  const activeBtn = document.getElementById(`stab-${tab}`);
  if (activeBtn) {
    activeBtn.classList.remove('border-transparent', 'text-gray-400');
    activeBtn.classList.add('border-purple-500', 'text-purple-400', 'active-stab');
  }
  // Contents
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
  const content = document.getElementById(`stab-content-${tab}`);
  if (content) content.classList.remove('hidden');
}

// ── Toggle password field visibility ─────────────────────
function toggleFieldVisibility(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const isHidden = inp.type === 'password';
  inp.type = isHidden ? 'text' : 'password';
  btn.innerHTML = `<i class="fas fa-${isHidden ? 'eye-slash' : 'eye'} text-xs"></i>`;
}

// ── Save Circle config ────────────────────────────────────
async function saveCircleConfig() {
  const apiKey         = document.getElementById('circle-api-key')?.value?.trim();
  const webhookSecret  = document.getElementById('circle-webhook-secret')?.value?.trim();
  const environment    = document.querySelector('input[name="circle-env"]:checked')?.value || 'sandbox';

  try {
    const res = await axios.put('/api/settings/circle', { apiKey, webhookSecret, environment });
    if (res.data.success) {
      settingsData.circle = { ...settingsData.circle, ...res.data.circle };
      updateCircleStatusBanner(settingsData.circle);
      updateSettingsDot();
      showSettingsMsg('✅ Circle configuration saved!', 'success');
      if (typeof addLog === 'function') addLog('[SETTINGS] Circle API configuration saved', 'system');
    }
  } catch (e) {
    showSettingsMsg('❌ Failed to save: ' + (e.response?.data?.error || e.message), 'error');
  }
}

// ── Test Circle connection ────────────────────────────────
async function testCircleConnection() {
  const btn = document.getElementById('circle-test-btn');
  const resultEl = document.getElementById('circle-test-result');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Testing...'; }

  try {
    const res = await axios.post('/api/settings/circle/test');
    const data = res.data;
    if (data.success) {
      if (resultEl) {
        resultEl.className = 'rounded-xl p-3 text-sm bg-green-900/30 border border-green-700/40 text-green-300';
        resultEl.innerHTML = `<i class="fas fa-check-circle mr-2"></i><strong>Connected!</strong> Circle API (${data.environment}) responded successfully.`;
        resultEl.classList.remove('hidden');
      }
      settingsData.circle.isConnected = true;
      updateCircleStatusBanner({ ...settingsData.circle, isConnected: true, lastTestAt: new Date().toISOString() });
      updateProfileIntegrations(settingsData.circle);
      if (typeof showToast === 'function') showToast('✅ Circle API connected!', 'success');
      if (typeof addLog === 'function') addLog('[SETTINGS] Circle API connection test: SUCCESS', 'success');
      loadCircleBalance();
    }
  } catch (e) {
    const errMsg = e.response?.data?.error || e.message;
    if (resultEl) {
      resultEl.className = 'rounded-xl p-3 text-sm bg-red-900/30 border border-red-700/40 text-red-300';
      resultEl.innerHTML = `<i class="fas fa-times-circle mr-2"></i><strong>Failed:</strong> ${errMsg}`;
      resultEl.classList.remove('hidden');
    }
    if (typeof showToast === 'function') showToast('❌ Circle API: ' + errMsg, 'error');
    if (typeof addLog === 'function') addLog('[SETTINGS] Circle API test FAILED: ' + errMsg, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plug mr-2"></i>Test Connection'; }
  }
}

// ── Load Circle balance ───────────────────────────────────
async function loadCircleBalance() {
  const el = document.getElementById('circle-balance-data');
  if (!el) return;
  try {
    const res = await axios.get('/api/settings/circle/balance');
    const data = res.data;
    if (data.success && data.data?.data?.available) {
      const balances = data.data.data.available;
      el.innerHTML = balances.map(b =>
        `<div class="flex justify-between py-1"><span class="text-gray-400">${b.currency}</span><span class="text-white font-semibold">$${parseFloat(b.amount).toFixed(2)}</span></div>`
      ).join('') || '<span class="text-gray-500">No balances found</span>';
    } else {
      el.innerHTML = '<span class="text-gray-500 text-xs">Unable to load balance — check your API key</span>';
    }
  } catch (e) {
    el.innerHTML = `<span class="text-red-400 text-xs">Error: ${e.response?.data?.error || e.message}</span>`;
  }
}

// ── Remove Circle config ──────────────────────────────────
async function removeCircleConfig() {
  if (!confirm('Remove Circle API configuration? This cannot be undone.')) return;
  try {
    await axios.delete('/api/settings/circle');
    setVal('circle-api-key', '');
    setVal('circle-webhook-secret', '');
    const banner = document.getElementById('circle-status-banner');
    if (banner) banner.classList.add('hidden');
    const testResult = document.getElementById('circle-test-result');
    if (testResult) testResult.classList.add('hidden');
    const balancesEl = document.getElementById('circle-balances');
    if (balancesEl) balancesEl.classList.add('hidden');
    if (settingsData) settingsData.circle = { hasApiKey: false, isConnected: false, environment: 'sandbox' };
    updateSettingsDot();
    updateProfileIntegrations(settingsData?.circle || {});
    if (typeof showToast === 'function') showToast('Circle config removed', 'info');
    if (typeof addLog === 'function') addLog('[SETTINGS] Circle API configuration removed', 'warning');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Error: ' + e.message, 'error');
  }
}

// ── Save App Config ───────────────────────────────────────
async function saveAppConfig() {
  const theme          = document.getElementById('cfg-theme')?.value;
  const language       = document.getElementById('cfg-language')?.value;
  const refreshInterval= document.getElementById('cfg-refresh')?.value;
  const autoRefresh    = document.getElementById('cfg-autorefresh')?.checked;
  const notifications  = document.getElementById('cfg-notifications')?.checked;

  try {
    const res = await axios.put('/api/settings/app', { theme, language, autoRefresh, refreshInterval, notifications });
    if (res.data.success) {
      if (typeof showToast === 'function') showToast('✅ App settings saved!', 'success');
      if (typeof addLog === 'function') addLog('[SETTINGS] App configuration saved', 'system');
      // Apply language immediately
      if (language && typeof setLang === 'function') setLang(language);
      if (settingsData) settingsData.app = { ...settingsData.app, ...res.data.app };
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Error: ' + (e.response?.data?.error || e.message), 'error');
  }
}

// ── Save PIN ──────────────────────────────────────────────
async function savePIN() {
  const currentPin = document.getElementById('sec-current-pin')?.value || '';
  const newPin     = document.getElementById('sec-new-pin')?.value?.trim();
  const confirmPin = document.getElementById('sec-confirm-pin')?.value?.trim();
  const msgEl      = document.getElementById('pin-save-msg');

  if (newPin && newPin !== confirmPin) {
    showPINMsg('PINs do not match', 'error'); return;
  }
  if (newPin && (newPin.length < 4 || newPin.length > 8)) {
    showPINMsg('PIN must be 4–8 digits', 'error'); return;
  }

  try {
    const res = await axios.put('/api/settings/app', { accessPin: newPin || '', currentPin });
    if (res.data.success) {
      settingsUnlocked = true; // já está autenticado
      if (settingsData) settingsData.app.hasPIN = !!newPin;
      const cpf = document.getElementById('current-pin-field');
      if (cpf) cpf.classList.toggle('hidden', !newPin);
      setVal('sec-current-pin', '');
      setVal('sec-new-pin', '');
      setVal('sec-confirm-pin', '');
      showPINMsg(newPin ? '✅ PIN saved!' : '✅ PIN removed!', 'success');
      if (typeof showToast === 'function') showToast(newPin ? '🔒 PIN configured' : '🔓 PIN removed', 'success');
      if (typeof addLog === 'function') addLog(`[SETTINGS] Access PIN ${newPin ? 'configured' : 'removed'}`, 'system');
    }
  } catch (e) {
    showPINMsg(e.response?.data?.error || e.message, 'error');
  }
}

function showPINMsg(msg, type) {
  const el = document.getElementById('pin-save-msg');
  if (!el) return;
  el.className = `rounded-lg p-2 text-xs text-center ${type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-700/40' : 'bg-red-900/40 text-red-300 border border-red-700/40'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function showSettingsMsg(msg, type) {
  if (typeof showToast === 'function') {
    showToast(msg, type === 'success' ? 'success' : 'error');
  }
}

// ════════════════════════════════════════════════════════
// PROFILE MODAL
// ════════════════════════════════════════════════════════

function showProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  // Sincronizar wallet address do estado global
  if (window.walletState?.address) {
    const profWallet = document.getElementById('prof-wallet');
    if (profWallet && !profWallet.value) profWallet.value = window.walletState.address;
  }

  updateProfilePreview();
  loadSettingsFromServer();
}

function closeProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

// ── Update profile avatar preview in real time ────────────
function updateProfilePreview() {
  const name = document.getElementById('prof-name')?.value?.trim() || '';
  const initials = name
    ? name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '👤';

  const displays = ['profile-avatar-display', 'profile-avatar-large'];
  displays.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
  });

  const headerName = document.getElementById('profile-header-name');
  if (headerName) headerName.textContent = name || 'My Profile';

  const email = document.getElementById('prof-email')?.value?.trim() || '';
  const headerEmail = document.getElementById('profile-header-email');
  if (headerEmail) headerEmail.textContent = email || 'Set up your profile';
}

// ── Save Profile ──────────────────────────────────────────
async function saveProfile() {
  const name          = document.getElementById('prof-name')?.value?.trim();
  const email         = document.getElementById('prof-email')?.value?.trim();
  const role          = document.getElementById('prof-role')?.value?.trim();
  const company       = document.getElementById('prof-company')?.value?.trim();
  const walletAddress = document.getElementById('prof-wallet')?.value?.trim();

  if (!name) {
    showProfileMsg('Name is required', 'error'); return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showProfileMsg('Invalid email address', 'error'); return;
  }

  try {
    const res = await axios.put('/api/settings/profile', { name, email, role, company, walletAddress });
    if (res.data.success) {
      settingsData = settingsData || {};
      settingsData.profile = res.data.profile;
      updateProfileButton();
      updateSettingsDot();
      updateProfilePreview();
      if (res.data.profile.updatedAt) {
        document.getElementById('prof-updated').textContent = formatDate(res.data.profile.updatedAt);
      }
      showProfileMsg('✅ Profile saved!', 'success');
      if (typeof showToast === 'function') showToast('✅ Profile saved!', 'success');
      if (typeof addLog === 'function') addLog(`[PROFILE] Profile updated: ${name}`, 'system');
    }
  } catch (e) {
    showProfileMsg('Error: ' + (e.response?.data?.error || e.message), 'error');
  }
}

function showProfileMsg(msg, type) {
  const el = document.getElementById('profile-save-msg');
  if (!el) return;
  el.className = `rounded-lg p-2 text-xs text-center ${type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-700/40' : 'bg-red-900/40 text-red-300 border border-red-700/40'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// Close modals on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') closeSettingsModal();
  if (e.target.id === 'profile-modal')  closeProfileModal();
  if (e.target.id === 'pin-modal')      closePINModal();
});

// Keyboard: Escape closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSettingsModal();
    closeProfileModal();
    closePINModal();
  }
});

// ════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || '';
}

function setSelectVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined) el.value = val;
}

function setChecked(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = !!checked;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}
