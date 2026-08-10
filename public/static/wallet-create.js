// ============================================================
// ExecDaat — Decentralized Wallet Creation (Feature 1)
// Client-side only: private key / seed phrase NEVER sent to server
// Uses Web Crypto API (AES-GCM 256) + ethers.js HDNode
// Build: 20260407b  (fix: HTML-attribute injection broke onclick)
// ============================================================
'use strict';

/* ── Constants ─────────────────────────────────────────────── */
const WC_STORAGE_KEY  = 'execdaat_wallet_enc_v1';   // localStorage key for encrypted keystore
const WC_SESSION_KEY  = 'execdaat_wallet_session';  // sessionStorage key for in-memory session
const WC_VERSION      = '20260407b';

/* ── In-memory pending wallet ────────────────────────────────
   CRITICAL FIX: wallet data (JSON with double-quotes) must NOT
   be embedded inside an HTML onclick="..." attribute.
   The double-quotes in JSON.stringify() break the HTML parser
   and silently truncate the onclick handler, making the button
   appear clickable but doing nothing.
   Solution: store wallet + password in a module-level variable
   and reference it from onclick via a zero-arg wrapper.         */
let _wcPendingWallet = null;   // { address, privateKey, mnemonic }
let _wcPendingPw     = null;   // password string (in memory only, never persisted here)

/* ── Helpers: sanitise / escape ──────────────────────────────
   All user-supplied strings are escaped before insertion into
   innerHTML to prevent XSS.                                    */
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/* ── Web Crypto helpers ──────────────────────────────────────  */
async function _deriveKey(password, salt) {
  const enc  = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function _encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await _deriveKey(password, salt);
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  // encode as base64
  const buf  = new Uint8Array(salt.length + iv.length + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv,   salt.length);
  buf.set(new Uint8Array(ct), salt.length + iv.length);
  return btoa(String.fromCharCode(...buf));
}

async function _decrypt(b64, password) {
  const buf  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const salt = buf.slice(0, 16);
  const iv   = buf.slice(16, 28);
  const ct   = buf.slice(28);
  const key  = await _deriveKey(password, salt);
  const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(dec);
}

/* ── Wallet generation using ethers.js HDNode ────────────────  */
function _generateWallet() {
  if (!window.ethers) throw new Error('ethers.js not loaded');
  // ethers v6
  const wallet = window.ethers.Wallet
    ? window.ethers.Wallet.createRandom()
    : window.ethers.HDNodeWallet?.createRandom();
  if (!wallet) throw new Error('Unable to create wallet — ethers.js version incompatible');
  return {
    address:    wallet.address,
    privateKey: wallet.privateKey,
    mnemonic:   wallet.mnemonic?.phrase || null,
  };
}

function _walletFromMnemonic(mnemonic) {
  if (!window.ethers) throw new Error('ethers.js not loaded');
  const w = window.ethers.Wallet
    ? window.ethers.Wallet.fromPhrase(mnemonic)
    : window.ethers.HDNodeWallet?.fromPhrase(mnemonic);
  if (!w) throw new Error('Invalid mnemonic');
  return { address: w.address, privateKey: w.privateKey, mnemonic };
}

function _walletFromPrivateKey(pk) {
  if (!window.ethers) throw new Error('ethers.js not loaded');
  const key = pk.trim().startsWith('0x') ? pk.trim() : '0x' + pk.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid private key format');
  const w = new window.ethers.Wallet(key);
  return { address: w.address, privateKey: w.privateKey, mnemonic: null };
}

/* ── Keystore: save / load / clear ──────────────────────────  */
async function wcSaveKeystore(walletData, password) {
  const plain = JSON.stringify({
    address:    walletData.address,
    privateKey: walletData.privateKey,
    mnemonic:   walletData.mnemonic,
    createdAt:  Date.now(),
    version:    WC_VERSION,
  });
  const encrypted = await _encrypt(plain, password);
  localStorage.setItem(WC_STORAGE_KEY, encrypted);
}

async function wcLoadKeystore(password) {
  const enc = localStorage.getItem(WC_STORAGE_KEY);
  if (!enc) return null;
  const plain = await _decrypt(enc, password);
  return JSON.parse(plain);
}

function wcHasKeystore() {
  return !!localStorage.getItem(WC_STORAGE_KEY);
}

function wcClearKeystore() {
  localStorage.removeItem(WC_STORAGE_KEY);
  sessionStorage.removeItem(WC_SESSION_KEY);
}

/* ── Session (in-memory, cleared on tab close) ──────────────  */
function wcSaveSession(walletData) {
  // Only store address in session; privateKey is in-memory (ethers Wallet object).
  // Session restore will prompt for password via the Unlock dialog.
  sessionStorage.setItem(WC_SESSION_KEY, JSON.stringify({
    address:    walletData.address,
    hasMnemonic: !!walletData.mnemonic,
    ts: Date.now(),
  }));
}

function wcGetSession() {
  try {
    const raw = sessionStorage.getItem(WC_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function wcClearSession() {
  sessionStorage.removeItem(WC_SESSION_KEY);
}

/* ── Build EIP-1193 compatible provider from private key ──── */
function _buildLocalProvider(privateKey) {
  if (!window.ethers) throw new Error('ethers.js not loaded');
  // Same-origin failover proxy: distributes reads/broadcasts across all 4
  // public Arc RPCs server-side (immune to per-IP "request limit reached").
  const ARC_RPC = (window.location && String(window.location.origin).indexOf('http') === 0)
    ? window.location.origin + '/api/rpc'
    : 'https://rpc.testnet.arc.network';
  const rpcProvider = new window.ethers.JsonRpcProvider(ARC_RPC);
  const signer      = new window.ethers.Wallet(privateKey, rpcProvider);

  // Minimal EIP-1193 shim so existing dApp code works transparently
  const eip1193 = {
    _isSoftWallet: true,
    _signer: signer,
    request: async ({ method, params }) => {
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [signer.address];
        case 'eth_chainId':
          return '0x4cef52';  // 5042002
        case 'net_version':
          return '5042002';
        case 'eth_getBalance':
          return rpcProvider.send('eth_getBalance', params || [signer.address, 'latest']);
        case 'eth_call':
          return rpcProvider.send('eth_call', params);
        case 'eth_estimateGas':
          return rpcProvider.send('eth_estimateGas', params);
        case 'eth_gasPrice':
          return rpcProvider.send('eth_gasPrice', []);
        case 'eth_blockNumber':
          return rpcProvider.send('eth_blockNumber', []);
        case 'eth_getTransactionCount':
          return rpcProvider.send('eth_getTransactionCount', params || [signer.address, 'latest']);
        case 'eth_getTransactionReceipt':
          return rpcProvider.send('eth_getTransactionReceipt', params);
        case 'eth_sendTransaction': {
          const tx     = params[0];
          const signed = await signer.sendTransaction(tx);
          return signed.hash;
        }
        case 'eth_sendRawTransaction':
          return rpcProvider.send('eth_sendRawTransaction', params);
        case 'eth_sign':
          return signer.signMessage(params[1]);
        case 'personal_sign':
          return signer.signMessage(
            params[0].startsWith('0x')
              ? window.ethers.getBytes(params[0])
              : params[0]
          );
        case 'eth_signTypedData_v4': {
          const { domain, types, message } = JSON.parse(params[1]);
          // remove EIP712Domain from types if present
          const filteredTypes = Object.fromEntries(
            Object.entries(types).filter(([k]) => k !== 'EIP712Domain')
          );
          return signer.signTypedData(domain, filteredTypes, message);
        }
        case 'wallet_addEthereumChain':
        case 'wallet_switchEthereumChain':
          return null; // already on Arc Testnet
        default:
          return rpcProvider.send(method, params || []);
      }
    },
    on: (event, handler) => {
      // minimal event emitter
      if (!eip1193._handlers) eip1193._handlers = {};
      if (!eip1193._handlers[event]) eip1193._handlers[event] = [];
      eip1193._handlers[event].push(handler);
    },
    removeListener: (event, handler) => {
      if (eip1193._handlers?.[event]) {
        eip1193._handlers[event] = eip1193._handlers[event].filter(h => h !== handler);
      }
    },
  };
  return eip1193;
}

/* ── Connect created / imported wallet into dApp state ──────  */
async function wcActivateWallet(walletData) {
  const provider = _buildLocalProvider(walletData.privateKey);
  const address  = walletData.address;

  window.walletState = {
    connected:    true,
    address,
    shortAddress: address.slice(0,8) + '…' + address.slice(-6),
    chainId:      5042002,
    onArcNetwork: true,
    usdcBalance:  null,
    eurcBalance:  null,
    provider,
    _isSoftWallet: true,
  };

  // Save session
  wcSaveSession(walletData);

  // Fire the same events the external wallet connection fires
  window.dispatchEvent(new CustomEvent('walletConnected', { detail: { address, chainId: 5042002 } }));
  if (typeof window.updateWalletUI === 'function') window.updateWalletUI();
  if (typeof window.refreshBalance  === 'function') setTimeout(() => window.refreshBalance(), 600);

  // Update arc-pay-session
  const ARC_SESSION_KEY = 'arc-pay-session-v3';
  const session = { wallet: address, ts: Date.now(), network: 'arc-testnet', source: 'soft-wallet' };
  sessionStorage.setItem(ARC_SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(ARC_SESSION_KEY, JSON.stringify(session));

  console.log('[WC] Soft-wallet activated:', address);
}

/* ──────────────────────────────────────────────────────────────
   UI — CSS (injected once)
   ────────────────────────────────────────────────────────────── */
function _injectWcStyles() {
  if (document.getElementById('wc-styles')) return;
  const s = document.createElement('style');
  s.id = 'wc-styles';
  s.textContent = `
    @keyframes wcSlideUp  { from{opacity:0;transform:translateY(20px) scale(.97)} to{opacity:1;transform:none} }
    @keyframes wcFadeIn   { from{opacity:0} to{opacity:1} }
    @keyframes wcSpin     { to{transform:rotate(360deg)} }
    @keyframes wcShake    { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-6px)} 40%,80%{transform:translateX(6px)} }
    .wc-overlay { animation:wcFadeIn .2s ease; position:fixed;inset:0;z-index:10000;
      display:flex;align-items:center;justify-content:center;padding:16px;
      background:rgba(0,0,0,.8);backdrop-filter:blur(14px); }
    .wc-panel  { animation:wcSlideUp .3s cubic-bezier(.22,.68,0,1.2);
      background:linear-gradient(160deg,#0d1a2a,#0a1220);
      border:1px solid rgba(255,255,255,.09);border-radius:22px;
      width:100%;max-width:460px;overflow:hidden;
      box-shadow:0 40px 100px rgba(0,0,0,.9),0 0 0 1px rgba(99,102,241,.1); }
    .wc-input  { width:100%;padding:11px 14px;border-radius:12px;outline:none;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
      color:#f1f5f9;font-size:14px;transition:border-color .15s;
      font-family:monospace; }
    .wc-input:focus { border-color:rgba(139,92,246,.6);background:rgba(139,92,246,.07); }
    .wc-input.error { border-color:#f87171 !important;animation:wcShake .35s ease; }
    .wc-btn-primary { display:flex;align-items:center;justify-content:center;gap:8px;
      width:100%;padding:13px 20px;border-radius:14px;font-size:14px;font-weight:700;
      cursor:pointer;transition:all .18s;letter-spacing:.01em;
      background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;
      box-shadow:0 4px 20px rgba(124,58,237,.35); }
    .wc-btn-primary:hover  { transform:scale(1.02);box-shadow:0 6px 28px rgba(124,58,237,.5); }
    .wc-btn-primary:active { transform:scale(.98); }
    .wc-btn-secondary { display:flex;align-items:center;justify-content:center;gap:8px;
      width:100%;padding:12px 20px;border-radius:14px;font-size:14px;font-weight:600;
      cursor:pointer;transition:all .18s;
      background:rgba(255,255,255,.05);color:#d1d5db;
      border:1px solid rgba(255,255,255,.09); }
    .wc-btn-secondary:hover { background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.18);color:#f1f5f9; }
    .wc-btn-danger { background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.25); }
    .wc-btn-danger:hover { background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.5); }
    .wc-seed-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:14px 0; }
    .wc-seed-word { display:flex;align-items:center;gap:6px;
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);
      border-radius:10px;padding:7px 10px;font-size:13px; }
    .wc-seed-word .num { color:#4b5563;font-size:10px;min-width:16px;text-align:right;font-weight:600; }
    .wc-seed-word .word { color:#e2e8f0;font-weight:600;font-family:monospace; }
    .wc-warn-box { background:rgba(251,146,60,.07);border:1px solid rgba(251,146,60,.25);
      border-radius:12px;padding:12px 14px;font-size:12px;color:#fdba74;line-height:1.6; }
    .wc-tab-btn { flex:1;padding:9px 0;font-size:13px;font-weight:600;border-radius:10px;
      cursor:pointer;transition:all .15s;border:none;background:transparent;color:#6b7280; }
    .wc-tab-btn.active { background:rgba(124,58,237,.2);color:#a78bfa;
      box-shadow:inset 0 0 0 1px rgba(124,58,237,.3); }
    .wc-tab-btn:hover:not(.active) { color:#d1d5db; }
    .wc-strength { height:4px;border-radius:2px;transition:width .3s,background .3s; }
    .wc-toggle-pw { position:absolute;right:12px;top:50%;transform:translateY(-50%);
      background:none;border:none;color:#6b7280;cursor:pointer;padding:4px; }
    .wc-toggle-pw:hover { color:#d1d5db; }
    .wc-scroll { overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.08) transparent; }
    .wc-scroll::-webkit-scrollbar{width:4px} .wc-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
    .wc-spinner { width:32px;height:32px;border-radius:50%;border:3px solid rgba(124,58,237,.3);
      border-top-color:#7c3aed;animation:wcSpin .8s linear infinite;margin:0 auto; }
  `;
  document.head.appendChild(s);
}

/* ──────────────────────────────────────────────────────────────
   MAIN MODAL — openCreateWalletModal()
   ────────────────────────────────────────────────────────────── */
function openCreateWalletModal() {
  _injectWcStyles();
  const existing = document.getElementById('wc-modal');
  if (existing) existing.remove();

  // Close the wallet selection modal first
  if (typeof window.closeWalletModal === 'function') window.closeWalletModal();

  const overlay = document.createElement('div');
  overlay.id        = 'wc-modal';
  overlay.className = 'wc-overlay';
  overlay.onclick   = (e) => { if (e.target === overlay) _wcClose(); };

  overlay.innerHTML = `
    <div class="wc-panel" id="wc-panel-root">
      <!-- Top gradient bar -->
      <div style="height:3px;background:linear-gradient(90deg,#7c3aed,#4f46e5,#0ea5e9);"></div>

      <!-- Header -->
      <div style="padding:20px 24px 0;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:40px;height:40px;border-radius:11px;
            background:linear-gradient(135deg,rgba(124,58,237,.3),rgba(79,70,229,.2));
            border:1px solid rgba(124,58,237,.35);
            display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="5" width="16" height="12" rx="2" stroke="#a78bfa" stroke-width="1.4"/>
              <path d="M2 9h16" stroke="#a78bfa" stroke-width="1.4"/>
              <circle cx="14" cy="13" r="1.5" fill="#a78bfa"/>
              <path d="M6 3l4-1 4 1" stroke="#a78bfa" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <h2 style="color:#f1f5f9;font-size:17px;font-weight:800;margin:0;letter-spacing:-.02em;">Wallet Manager</h2>
            <p style="color:#4b5563;font-size:11px;margin:2px 0 0;">Non-custodial · Keys never leave your device</p>
          </div>
        </div>
        <button onclick="window._wcClose()" style="
          width:30px;height:30px;border-radius:8px;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);
          color:#6b7280;cursor:pointer;display:flex;align-items:center;justify-content:center;">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M10.5 3.5l-7 7M3.5 3.5l7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <!-- Tabs -->
      <div style="padding:14px 24px 0;">
        <div style="display:flex;gap:4px;background:rgba(0,0,0,.3);border-radius:12px;padding:4px;">
          <button class="wc-tab-btn active" id="wc-tab-create"  onclick="window._wcShowTab('create')">✨ Create New</button>
          <button class="wc-tab-btn"        id="wc-tab-import"  onclick="window._wcShowTab('import')">🔑 Import</button>
          <button class="wc-tab-btn"        id="wc-tab-unlock"  onclick="window._wcShowTab('unlock')">🔓 Unlock</button>
        </div>
      </div>

      <!-- Content -->
      <div class="wc-scroll" style="max-height:520px;padding:16px 24px 20px;" id="wc-content-area">
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Show the appropriate initial tab
  if (wcHasKeystore()) {
    _wcShowTab('unlock');
  } else {
    _wcShowTab('create');
  }
}

/* ── Tab switcher ──────────────────────────────────────────── */
function _wcShowTab(tab) {
  ['create','import','unlock'].forEach(t => {
    const btn = document.getElementById('wc-tab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  const area = document.getElementById('wc-content-area');
  if (!area) return;
  if (tab === 'create')  area.innerHTML = _wcCreateHTML();
  if (tab === 'import')  area.innerHTML = _wcImportHTML();
  if (tab === 'unlock')  area.innerHTML = _wcUnlockHTML();
}

/* ── Tab: CREATE ─────────────────────────────────────────────  */
function _wcCreateHTML() {
  return `
    <div id="wc-step-generate">
      <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin-bottom:16px;">
        Generate a brand-new EVM wallet. Your seed phrase is the <strong style="color:#f1f5f9;">only way</strong>
        to recover your funds — save it offline in a safe place.
      </p>

      <div class="wc-warn-box" style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 1.5L13 13H2L7.5 1.5z" stroke="#fb923c" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.5 6v4" stroke="#fb923c" stroke-width="1.3" stroke-linecap="round"/><circle cx="7.5" cy="11.5" r=".75" fill="#fb923c"/></svg>
          <strong>Security Warning</strong>
        </div>
        <ul style="margin:0;padding-left:16px;list-style:disc;">
          <li>Never share your seed phrase or private key with anyone.</li>
          <li>ExecDaat never stores or transmits your keys.</li>
          <li>If you lose your seed phrase, your funds are <em>unrecoverable</em>.</li>
        </ul>
      </div>

      <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Password (encrypt local keystore)</label>
      <div style="position:relative;margin-bottom:6px;">
        <input class="wc-input" type="password" id="wc-create-pw" placeholder="Choose a strong password…"
          oninput="window._wcPwStrength(this.value)"
          onkeydown="if(event.key==='Enter')window._wcGenerate()">
        <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-create-pw',this)" tabindex="-1">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
      <div style="background:rgba(255,255,255,.05);border-radius:4px;height:4px;margin-bottom:10px;overflow:hidden;">
        <div class="wc-strength" id="wc-pw-strength" style="width:0%;background:#f87171;"></div>
      </div>

      <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Confirm Password</label>
      <div style="position:relative;margin-bottom:16px;">
        <input class="wc-input" type="password" id="wc-create-pw2" placeholder="Repeat password…"
          onkeydown="if(event.key==='Enter')window._wcGenerate()">
        <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-create-pw2',this)" tabindex="-1">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>

      <div id="wc-create-err" style="color:#f87171;font-size:12px;min-height:18px;margin-bottom:8px;"></div>

      <button class="wc-btn-primary" onclick="window._wcGenerate()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v3M8 11v3M2 8h3M11 8h3" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="8" r="3" stroke="white" stroke-width="1.5"/></svg>
        Generate Wallet
      </button>
    </div>
  `;
}

/* ── Tab: IMPORT ─────────────────────────────────────────────  */
function _wcImportHTML() {
  return `
    <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin-bottom:16px;">
      Import an existing wallet using a 12/24-word seed phrase or a private key.
    </p>

    <div style="display:flex;gap:4px;background:rgba(0,0,0,.3);border-radius:10px;padding:3px;margin-bottom:14px;">
      <button class="wc-tab-btn active" id="wc-import-mnem-btn" style="font-size:12px;" onclick="window._wcImportTab('mnem')">Seed Phrase</button>
      <button class="wc-tab-btn" id="wc-import-pk-btn" style="font-size:12px;" onclick="window._wcImportTab('pk')">Private Key</button>
    </div>

    <div id="wc-import-mnem">
      <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Seed Phrase (12 or 24 words)</label>
      <textarea class="wc-input" id="wc-import-mnem-val" rows="3"
        placeholder="Enter your seed phrase separated by spaces…"
        style="resize:none;font-size:13px;line-height:1.6;"></textarea>
    </div>

    <div id="wc-import-pk" style="display:none;">
      <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Private Key (hex)</label>
      <div style="position:relative;">
        <input class="wc-input" type="password" id="wc-import-pk-val" placeholder="0x… or without 0x prefix">
        <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-import-pk-val',this)" tabindex="-1">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
    </div>

    <div style="margin-top:14px;">
      <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Encrypt with Password</label>
      <div style="position:relative;margin-bottom:4px;">
        <input class="wc-input" type="password" id="wc-import-pw" placeholder="Choose a password to protect keystore…">
        <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-import-pw',this)" tabindex="-1">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
      <div style="position:relative;margin-bottom:12px;">
        <input class="wc-input" type="password" id="wc-import-pw2" placeholder="Confirm password…">
        <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-import-pw2',this)" tabindex="-1">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
    </div>

    <div id="wc-import-err" style="color:#f87171;font-size:12px;min-height:18px;margin-bottom:8px;"></div>

    <button class="wc-btn-primary" onclick="window._wcImport()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v7M5 7l3 3 3-3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12h12" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
      Import Wallet
    </button>
  `;
}

/* ── Tab: UNLOCK ─────────────────────────────────────────────  */
function _wcUnlockHTML() {
  const hasKs = wcHasKeystore();
  if (!hasKs) {
    return `
      <div style="text-align:center;padding:24px 0;">
        <p style="color:#9ca3af;font-size:14px;margin-bottom:16px;">No encrypted keystore found. Create or import a wallet first.</p>
        <button class="wc-btn-secondary" style="width:auto;padding:10px 24px;" onclick="window._wcShowTab('create')">Create New Wallet</button>
      </div>
    `;
  }
  return `
    <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin-bottom:16px;">
      Unlock your saved wallet with the password you chose when creating it.
    </p>

    <label style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px;">Password</label>
    <div style="position:relative;margin-bottom:14px;">
      <input class="wc-input" type="password" id="wc-unlock-pw" placeholder="Enter your password…"
        onkeydown="if(event.key==='Enter')window._wcUnlock()">
      <button class="wc-toggle-pw" onclick="window._wcTogglePw('wc-unlock-pw',this)" tabindex="-1">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
      </button>
    </div>

    <div id="wc-unlock-err" style="color:#f87171;font-size:12px;min-height:18px;margin-bottom:8px;"></div>

    <button class="wc-btn-primary" onclick="window._wcUnlock()">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="7" width="8" height="7" rx="1.5" stroke="white" stroke-width="1.4"/><path d="M6 7V5a2 2 0 014 0v2" stroke="white" stroke-width="1.4" stroke-linecap="round"/></svg>
      Unlock Wallet
    </button>

    <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06);">
      <button class="wc-btn-secondary wc-btn-danger" onclick="window._wcForgetWallet()">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M10 4l-.5 7H4.5L4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Forget This Wallet
      </button>
    </div>
  `;
}

/* ── Action: show seed phrase and confirm ────────────────────  */
async function _wcGenerate() {
  const pw  = document.getElementById('wc-create-pw')?.value  || '';
  const pw2 = document.getElementById('wc-create-pw2')?.value || '';
  const err = document.getElementById('wc-create-err');

  if (pw.length < 8) { _wcShakeErr(err, 'Password must be at least 8 characters.'); return; }
  if (pw !== pw2)    { _wcShakeErr(err, 'Passwords do not match.'); return; }
  if (err) err.textContent = '';

  // Clear any previous pending state
  _wcPendingWallet = null;
  _wcPendingPw     = null;

  const area = document.getElementById('wc-content-area');
  if (area) area.innerHTML = `<div style="padding:32px 0;text-align:center;"><div class="wc-spinner"></div><p style="color:#9ca3af;margin-top:14px;font-size:13px;">Generating wallet…</p></div>`;

  try {
    const wallet = _generateWallet();
    console.log('[WC] wallet generated:', wallet.address);
    // Show seed phrase — also stores wallet + pw in _wcPendingWallet / _wcPendingPw
    area.innerHTML = _wcSeedPhraseHTML(wallet, pw);
  } catch(e) {
    if (area) area.innerHTML = `<p style="color:#f87171;font-size:13px;">Error: ${_esc(e.message)}</p>`;
  }
}

function _wcSeedPhraseHTML(wallet, pw) {
  // ── CRITICAL FIX: store wallet + pw in module variables ──────
  // DO NOT embed wallet JSON or password inside an HTML onclick attribute.
  // JSON.stringify produces double-quotes which break the HTML attribute parser,
  // silently truncating the onclick and making the button do nothing.
  _wcPendingWallet = wallet;
  _wcPendingPw     = pw;
  console.log('[WC] _wcSeedPhraseHTML: pending wallet stored', wallet.address);

  const words = (wallet.mnemonic || '').split(' ');
  const wordGrid = words.map((w, i) => `
    <div class="wc-seed-word">
      <span class="num">${i + 1}.</span>
      <span class="word">${_esc(w)}</span>
    </div>`).join('');

  return `
    <div style="margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="color:#f1f5f9;font-size:14px;font-weight:700;">Your Seed Phrase</span>
        <span style="color:#34d399;font-size:11px;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.2);border-radius:6px;padding:3px 8px;">
          ${words.length} words
        </span>
      </div>

      <div class="wc-warn-box" style="margin-bottom:12px;">
        ⚠️ <strong>Write these words down offline.</strong> Anyone with your seed phrase can access your funds.
        Never take a screenshot or store it digitally.
      </div>

      <div class="wc-seed-grid">${wordGrid}</div>

      <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px;margin-bottom:14px;">
        <div style="color:#6b7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Wallet Address</div>
        <div style="color:#a78bfa;font-size:13px;font-family:monospace;">${_esc(wallet.address)}</div>
      </div>
    </div>

    <div style="background:rgba(79,70,229,.08);border:1px solid rgba(79,70,229,.2);border-radius:12px;padding:12px 14px;margin-bottom:14px;">
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
        <input type="checkbox" id="wc-seed-confirm" style="margin-top:2px;accent-color:#7c3aed;width:15px;height:15px;flex-shrink:0;">
        <span style="color:#c4b5fd;font-size:12px;line-height:1.6;">
          I have written down my seed phrase in a safe place and understand that losing it means permanent loss of access to my funds.
        </span>
      </label>
    </div>

    <div id="wc-seed-err" style="color:#f87171;font-size:12px;min-height:18px;margin-bottom:8px;"></div>

    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="wc-btn-primary" id="wc-finish-btn" onclick="window._wcFinishCreate()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-7" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        I've saved it — Create Wallet
      </button>
      <button class="wc-btn-secondary" onclick="window._wcShowTab('create')">
        ← Back
      </button>
    </div>
  `;
}

async function _wcFinishCreate() {
  console.log('[WC] button clicked — _wcFinishCreate()');

  // ── Read from module-level pending state (not from onclick args) ──
  const wallet = _wcPendingWallet;
  const pw     = _wcPendingPw;

  const err = document.getElementById('wc-seed-err');
  const confirmed = document.getElementById('wc-seed-confirm')?.checked;

  console.log('[WC] seed confirmed?', confirmed);
  console.log('[WC] wallet exists?',  !!wallet, wallet?.address);
  console.log('[WC] password set?',   !!pw, pw?.length, 'chars');

  if (!confirmed) { _wcShakeErr(err, 'Please confirm you have saved your seed phrase.'); return; }
  if (!wallet)    { _wcShakeErr(err, 'Wallet data lost — please go back and regenerate.'); console.error('[WC] _wcPendingWallet is null!'); return; }
  if (!pw)        { _wcShakeErr(err, 'Password missing — please go back and try again.'); console.error('[WC] _wcPendingPw is null!'); return; }

  if (err) err.textContent = '';

  const area = document.getElementById('wc-content-area');
  if (area) area.innerHTML = `<div style="padding:32px 0;text-align:center;"><div class="wc-spinner"></div><p style="color:#9ca3af;margin-top:14px;font-size:13px;">Encrypting &amp; saving…</p></div>`;

  try {
    console.log('[WC] encrypting keystore…');
    await wcSaveKeystore(wallet, pw);
    console.log('[WC] encryption success — activating wallet…');
    await wcActivateWallet(wallet);
    console.log('[WC] wallet activated — showing success screen');
    // Clear pending state after successful use
    _wcPendingWallet = null;
    _wcPendingPw     = null;
    _wcShowSuccess(wallet.address);
  } catch(e) {
    console.error('[WC] _wcFinishCreate error:', e);
    if (area) area.innerHTML = `<p style="color:#f87171;font-size:13px;">Error: ${_esc(e.message)}</p><button class="wc-btn-secondary" style="margin-top:12px;" onclick="window._wcShowTab('create')">← Back</button>`;
  }
}

/* ── Action: IMPORT ─────────────────────────────────────────  */
function _wcImportTab(t) {
  const mBtn = document.getElementById('wc-import-mnem-btn');
  const pBtn = document.getElementById('wc-import-pk-btn');
  const mDiv = document.getElementById('wc-import-mnem');
  const pDiv = document.getElementById('wc-import-pk');
  if (mBtn) mBtn.classList.toggle('active', t === 'mnem');
  if (pBtn) pBtn.classList.toggle('active', t === 'pk');
  if (mDiv) mDiv.style.display = t === 'mnem' ? '' : 'none';
  if (pDiv) pDiv.style.display = t === 'pk'   ? '' : 'none';
}

async function _wcImport() {
  const isMnem = document.getElementById('wc-import-mnem')?.style.display !== 'none';
  const pw     = document.getElementById('wc-import-pw')?.value  || '';
  const pw2    = document.getElementById('wc-import-pw2')?.value || '';
  const err    = document.getElementById('wc-import-err');

  if (pw.length < 8) { _wcShakeErr(err, 'Password must be at least 8 characters.'); return; }
  if (pw !== pw2)    { _wcShakeErr(err, 'Passwords do not match.'); return; }

  const area = document.getElementById('wc-content-area');
  if (area) area.innerHTML = `<div style="padding:32px 0;text-align:center;"><div class="wc-spinner"></div><p style="color:#9ca3af;margin-top:14px;font-size:13px;">Importing wallet…</p></div>`;

  try {
    let wallet;
    if (isMnem) {
      const phrase = (document.getElementById('wc-import-mnem-val')?.value || '').trim();
      if (!phrase) throw new Error('Please enter your seed phrase.');
      wallet = _walletFromMnemonic(phrase);
    } else {
      const pk = (document.getElementById('wc-import-pk-val')?.value || '').trim();
      if (!pk) throw new Error('Please enter your private key.');
      wallet = _walletFromPrivateKey(pk);
    }

    await wcSaveKeystore(wallet, pw);
    await wcActivateWallet(wallet);
    _wcShowSuccess(wallet.address);
  } catch(e) {
    if (area) area.innerHTML = `
      <p style="color:#f87171;font-size:13px;margin-bottom:14px;">❌ ${_esc(e.message)}</p>
      <button class="wc-btn-secondary" onclick="window._wcShowTab('import')">← Back</button>`;
  }
}

/* ── Action: UNLOCK ─────────────────────────────────────────  */
async function _wcUnlock() {
  const pw  = document.getElementById('wc-unlock-pw')?.value || '';
  const err = document.getElementById('wc-unlock-err');
  if (!pw) { _wcShakeErr(err, 'Please enter your password.'); return; }

  const btn = document.querySelector('#wc-content-area .wc-btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div style="width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;animation:wcSpin .7s linear infinite;"></div>'; }

  try {
    const wallet = await wcLoadKeystore(pw);
    if (!wallet) throw new Error('No keystore found.');
    await wcActivateWallet(wallet);
    _wcShowSuccess(wallet.address);
  } catch(e) {
    const errMsg = e.message && e.message.includes('operation-specific') ? 'Wrong password.' : e.message;
    _wcShakeErr(err, '❌ ' + _esc(errMsg));
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="7" width="8" height="7" rx="1.5" stroke="white" stroke-width="1.4"/><path d="M6 7V5a2 2 0 014 0v2" stroke="white" stroke-width="1.4" stroke-linecap="round"/></svg> Unlock Wallet'; }
  }
}

async function _wcForgetWallet() {
  if (!confirm('⚠️ This will delete your encrypted keystore from this device.\n\nMake sure you have your seed phrase backed up before continuing.')) return;
  wcClearKeystore();
  _wcShowTab('create');
}

/* ── Success screen ─────────────────────────────────────────  */
function _wcShowSuccess(address) {
  const area = document.getElementById('wc-content-area');
  if (!area) { _wcClose(); return; }

  const short = address.slice(0,10) + '…' + address.slice(-8);
  area.innerHTML = `
    <div style="text-align:center;padding:20px 0;">
      <div style="width:64px;height:64px;border-radius:50%;
        background:linear-gradient(135deg,rgba(52,211,153,.2),rgba(16,185,129,.1));
        border:2px solid rgba(52,211,153,.4);
        display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M6 14l6 6 10-12" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h3 style="color:#f1f5f9;font-size:17px;font-weight:800;margin-bottom:6px;">Wallet Connected!</h3>
      <p style="color:#6b7280;font-size:12px;margin-bottom:14px;">Your wallet is active and ready to use</p>

      <div style="background:rgba(52,211,153,.07);border:1px solid rgba(52,211,153,.2);border-radius:12px;padding:10px 14px;margin-bottom:20px;">
        <div style="color:#6b7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Address</div>
        <div style="color:#34d399;font-size:13px;font-family:monospace;">${_esc(address)}</div>
      </div>

      <button class="wc-btn-primary" onclick="window._wcClose()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-7" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Start Using ExecDaat
      </button>
    </div>
  `;

  // Auto-close after 2.5 s
  setTimeout(() => _wcClose(), 2500);
}

/* ── Helpers: UX ────────────────────────────────────────────  */
function _wcClose() {
  const m = document.getElementById('wc-modal');
  if (m) m.remove();
}

function _wcShakeErr(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.animation = 'none';
  requestAnimationFrame(() => { el.style.animation = 'wcShake .35s ease'; });
}

function _wcPwStrength(pw) {
  const bar = document.getElementById('wc-pw-strength');
  if (!bar) return;
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const colors = ['#f87171','#fb923c','#facc15','#4ade80','#22c55e'];
  bar.style.width    = (score * 20) + '%';
  bar.style.background = colors[score - 1] || '#f87171';
}

function _wcTogglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.style.color = '#a78bfa';
  } else {
    inp.type = 'password';
    btn.style.color = '#6b7280';
  }
}

/* ── Download JSON keystore ─────────────────────────────────  */
async function wcDownloadKeystore(password) {
  const ks = localStorage.getItem(WC_STORAGE_KEY);
  if (!ks) { alert('No keystore saved.'); return; }
  const blob = new Blob([JSON.stringify({ version: WC_VERSION, encrypted: ks })], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'execdaat-keystore-' + Date.now() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Auto-restore session on page load ──────────────────────  */
async function wcTryRestoreSession() {
  const sess = wcGetSession();
  if (!sess) return;
  // Session exists but wallet not connected (e.g. page refresh).
  // privateKey was removed from sessionStorage — redirect to Unlock dialog.
  if (!window.walletState?.connected && sess.address) {
    console.log('[WC] Soft-wallet session found — prompting unlock:', sess.address.slice(0,10)+'...');
    if (wcHasKeystore()) {
      // Auto-open modal — user enters password to unlock
      if (typeof openCreateWalletModal === 'function') {
        openCreateWalletModal();
      }
    } else {
      // Keystore missing — clear stale session
      wcClearSession();
    }
  }
}

/* ──────────────────────────────────────────────────────────────
   INIT — expose globals
   ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  console.log('[WC] wallet-create.js loaded · v' + WC_VERSION);

  // Expose public API
  window.openCreateWalletModal = openCreateWalletModal;
  window._wcClose              = _wcClose;
  window._wcShowTab            = _wcShowTab;
  window._wcGenerate           = _wcGenerate;
  window._wcFinishCreate       = _wcFinishCreate;
  window._wcImport             = _wcImport;
  window._wcImportTab          = _wcImportTab;
  window._wcUnlock             = _wcUnlock;
  window._wcForgetWallet       = _wcForgetWallet;
  window._wcPwStrength         = _wcPwStrength;
  window._wcTogglePw           = _wcTogglePw;
  window.wcDownloadKeystore    = wcDownloadKeystore;
  window.wcHasKeystore         = wcHasKeystore;
  window.wcClearSession        = wcClearSession;
  window.wcTryRestoreSession   = wcTryRestoreSession;

  // Try to restore from session (e.g. page reload)
  setTimeout(wcTryRestoreSession, 1200);
});
