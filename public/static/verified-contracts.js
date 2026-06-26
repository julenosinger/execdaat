/**
 * verified-contracts.js — ExecDaat Platform
 * Central registry of all smart contracts deployed on Arc Testnet.
 * Updated after each deployment/verification cycle.
 * 
 * ArcScan Base URL: https://testnet.arcscan.app
 * Arc Testnet RPC:  https://rpc.testnet.arc.network
 * Chain ID:         5042002 (0x4CEF52)
 */

// ─── Arc Testnet Configuration ────────────────────────────────────────────────
const VC_ARCSCAN_BASE   = 'https://testnet.arcscan.app';
const VC_CHAIN_ID       = 5042002;
const VC_NETWORK_NAME   = 'Arc Testnet';

// ─── Verification Status Constants ────────────────────────────────────────────
const VC_STATUS = {
  VERIFIED:    'verified',
  PENDING:     'pending',
  DEPLOYED:    'deployed',     // deployed but not verified on explorer
  PLACEHOLDER: 'placeholder',  // address not yet deployed
};

// ─── Master Contract Registry ─────────────────────────────────────────────────
// Each entry: { id, name, address, description, status, arcscanUrl, deployTx, constructorArgs, sourceFile, category }
window.VERIFIED_CONTRACTS = [
  // ── Tokens (verified by Circle/native) ─────────────────────────────────────
  {
    id: 'usdc',
    name: 'USDC Token',
    contractName: 'FiatTokenProxy',
    address: '0x3600000000000000000000000000000000000000',
    description: 'USD Coin — ERC-20 stablecoin used as primary payment token on Arc Testnet.',
    category: 'token',
    status: VC_STATUS.VERIFIED,
    verifiedAt: '2024-01-01',
    arcscanUrl: 'https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000',
    deployTx: null,
    constructorArgs: [],
    sourceFile: 'FiatTokenProxy (Circle)',
    security: ['ERC-20 Standard', 'Upgradeable Proxy', 'Verified on ArcScan'],
    abi: null, // use wallet.js USDC_ABI
  },
  {
    id: 'eurc',
    name: 'EURC Token',
    contractName: 'FiatTokenProxy',
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    description: 'Euro Coin — ERC-20 stablecoin (Euro-backed) by Circle on Arc Testnet.',
    category: 'token',
    status: VC_STATUS.VERIFIED,
    verifiedAt: '2024-01-01',
    arcscanUrl: 'https://testnet.arcscan.app/address/0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    deployTx: null,
    constructorArgs: [],
    sourceFile: 'FiatTokenProxy (Circle)',
    security: ['ERC-20 Standard', 'Upgradeable Proxy', 'Verified on ArcScan'],
    abi: null,
  },

  // ── Infrastructure ──────────────────────────────────────────────────────────
  {
    id: 'permit2',
    name: 'Permit2',
    contractName: 'Permit2',
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    description: 'Canonical Permit2 by Uniswap Labs. Enables gasless token approvals via EIP-2612 signatures.',
    category: 'infrastructure',
    status: VC_STATUS.VERIFIED,
    verifiedAt: '2024-01-01',
    arcscanUrl: 'https://testnet.arcscan.app/address/0x000000000022D473030F116dDEE9F6B43aC78BA3',
    deployTx: null,
    constructorArgs: [],
    sourceFile: 'Uniswap Permit2',
    security: ['Verified on ArcScan', 'Uniswap Labs Canonical Deploy', 'No Admin Keys'],
    abi: null,
  },
  {
    id: 'multicall3',
    name: 'Multicall3',
    contractName: 'Multicall3',
    address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    description: 'Multicall3 — batches multiple read calls into a single RPC request for efficiency.',
    category: 'infrastructure',
    status: VC_STATUS.VERIFIED,
    verifiedAt: '2024-01-01',
    arcscanUrl: 'https://testnet.arcscan.app/address/0xcA11bde05977b3631167028862bE2a173976CA11',
    deployTx: null,
    constructorArgs: [],
    sourceFile: 'MakerDAO Multicall3',
    security: ['Verified on ArcScan', 'Read-only Aggregator', 'No State Changes'],
    abi: null,
  },

  // ── Core Platform Contracts ─────────────────────────────────────────────────
  {
    id: 'contract_factory',
    name: 'ContractFactory',
    contractName: 'ContractFactory',
    address: '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A',
    description: 'Milestone-based escrow factory. Creates work contracts with USDC escrow per milestone.',
    category: 'core',
    status: VC_STATUS.DEPLOYED,
    verifiedAt: null,
    verificationPending: true,
    arcscanUrl: 'https://testnet.arcscan.app/address/0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A',
    deployTx: null,
    constructorArgs: ['0x3600000000000000000000000000000000000000'], // USDC address
    sourceFile: 'ContractFactory.sol',
    solcVersion: '0.8.20',
    optimizer: { enabled: true, runs: 200 },
    security: [
      'Reentrancy Protection',
      'USDC Escrow (ERC-20)',
      'Milestone-based Release',
      'Client-controlled Cancel',
      'No Admin Keys',
      'Testnet Only',
    ],
    functions: {
      write: ['createContract', 'signContract', 'completeMilestone', 'cancelContract'],
      read:  ['contractCount', 'getContract', 'getMilestones', 'getByClient', 'getByContractor'],
    },
  },
  {
    id: 'simple_amm',
    name: 'SimpleAMM (USDC/EURC)',
    contractName: 'SimpleAMM',
    address: '0x3148E2807F172D1cC354F35fB4fC4104e8b6b561',
    description: 'x*y=k AMM for USDC/EURC swaps. LP token: ARC-LP-EURC-USDC. 0.3% fee.',
    category: 'defi',
    status: VC_STATUS.DEPLOYED,
    verifiedAt: null,
    verificationPending: true,
    arcscanUrl: 'https://testnet.arcscan.app/address/0x3148E2807F172D1cC354F35fB4fC4104e8b6b561',
    deployTx: '0x35d96b9659ab438b84c606c6d47d16c883388b6552465a21f9a97d75680c5022',
    constructorArgs: [
      '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', // EURC = tokenA
      '0x3600000000000000000000000000000000000000', // USDC = tokenB
    ],
    sourceFile: 'SimpleAMM.sol',
    solcVersion: '0.8.20',
    optimizer: { enabled: true, runs: 200 },
    security: [
      'Reentrancy Protection',
      'Constant Product Formula (x*y=k)',
      '0.3% Swap Fee',
      'Minimum Liquidity Lock',
      'No Admin Keys — Fully Permissionless',
      'Testnet Only',
    ],
    functions: {
      write: ['addLiquidity', 'removeLiquidity', 'swapAforB', 'swapBforA'],
      read:  ['tokenA', 'tokenB', 'reserveA', 'reserveB', 'totalSupply', 'getReserves', 'getAmountOut', 'quoteAforB', 'quoteBforA', 'priceImpactBps'],
    },
    lpToken: {
      name:    'ARC-LP-EURC-USDC',
      symbol:  'ARC-LP',
      decimals: 6,
    },
  },
  {
    id: 'otc_escrow',
    name: 'OTCEscrow v4',
    contractName: 'OTCEscrow',
    address: '0x1B58895D02856598d29C8D4f7EFD98D9d5d9332d',
    description: 'OTC escrow for trustless token deals. Supports Permit2, dispute resolution, and proof submission.',
    category: 'defi',
    status: VC_STATUS.DEPLOYED,
    verifiedAt: null,
    verificationPending: true,
    arcscanUrl: 'https://testnet.arcscan.app/address/0x1B58895D02856598d29C8D4f7EFD98D9d5d9332d',
    deployTx: null,
    constructorArgs: ['0x0000000000000000000000000000000000000000'], // arbiter (set at deploy)
    sourceFile: 'OTCEscrow.sol',
    solcVersion: '0.8.20',
    optimizer: { enabled: true, runs: 200 },
    security: [
      'Reentrancy Protection',
      'Arbiter-controlled Dispute Resolution',
      'EIP-2612 Permit Support',
      'Proof Submission',
      'Trustless & Standard Modes',
      'Testnet Only',
    ],
    functions: {
      write: ['createDeal', 'signDeal', 'fundDeal', 'fundDealWithPermit', 'release', 'cancel', 'openDispute', 'raiseDispute', 'resolveDispute', 'depositSeller', 'submitProof', 'setTradeMode'],
      read:  ['getDeal', 'getDealsByBuyer', 'getDealsBySeller'],
    },
  },
  {
    id: 'escrow_registry',
    name: 'EscrowRegistry',
    contractName: 'EscrowRegistry',
    address: null, // Will be set after deployment
    description: 'USDC milestone escrow registry. Creates individual escrow instances per agreement.',
    category: 'core',
    status: VC_STATUS.PLACEHOLDER,
    verifiedAt: null,
    arcscanUrl: null,
    deployTx: null,
    constructorArgs: ['0x3600000000000000000000000000000000000000'], // USDC
    sourceFile: 'EscrowRegistry.sol',
    solcVersion: '0.8.20',
    optimizer: { enabled: true, runs: 200 },
    security: [
      'Reentrancy Protection',
      'USDC Escrow',
      'Client-controlled Release/Refund',
      'Testnet Only',
    ],
    functions: {
      write: ['createEscrow', 'releaseEscrow', 'refundEscrow'],
      read:  ['escrowCount', 'escrows', 'getByClient', 'getByContractor'],
    },
  },
];

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Get contract by ID
 */
window.vcGetContract = function(id) {
  return window.VERIFIED_CONTRACTS.find(c => c.id === id) || null;
};

/**
 * Get all contracts by category
 */
window.vcGetByCategory = function(category) {
  return window.VERIFIED_CONTRACTS.filter(c => c.category === category);
};

/**
 * Short address display (0x1234...5678)
 */
window.vcShortAddr = function(addr) {
  if (!addr) return 'Not deployed';
  return addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
};

/**
 * Copy address to clipboard
 */
window.vcCopyAddress = function(address, btnEl) {
  if (!address) return;
  navigator.clipboard.writeText(address).then(() => {
    if (btnEl) {
      const orig = btnEl.innerHTML;
      btnEl.innerHTML = '<i class="fas fa-check"></i>';
      btnEl.style.color = '#10b981';
      setTimeout(() => {
        btnEl.innerHTML = orig;
        btnEl.style.color = '';
      }, 1500);
    }
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = address;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
};

/**
 * Get status badge HTML
 */
window.vcStatusBadge = function(status) {
  const map = {
    verified:    { color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)', icon: 'fa-check-circle', label: 'Verified' },
    pending:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.4)',  icon: 'fa-clock',       label: 'Pending Verification' },
    deployed:    { color: '#6366f1', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.4)',  icon: 'fa-rocket',      label: 'Deployed' },
    placeholder: { color: '#64748b', bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.4)', icon: 'fa-circle-notch', label: 'Not Deployed' },
  };
  const s = map[status] || map.placeholder;
  return `<span style="display:inline-flex;align-items:center;gap:5px;background:${s.bg};border:1px solid ${s.border};border-radius:999px;padding:3px 10px;color:${s.color};font-size:11px;font-weight:700;letter-spacing:0.03em;">
    <i class="fas ${s.icon}" style="font-size:10px;"></i>${s.label}
  </span>`;
};

/**
 * Get category badge HTML
 */
window.vcCategoryBadge = function(category) {
  const map = {
    token:          { color: '#fbbf24', icon: 'fa-coins',         label: 'Token'          },
    infrastructure: { color: '#38bdf8', icon: 'fa-layer-group',   label: 'Infrastructure' },
    core:           { color: '#a78bfa', icon: 'fa-cube',          label: 'Core'           },
    defi:           { color: '#34d399', icon: 'fa-exchange-alt',  label: 'DeFi'           },
  };
  const c = map[category] || { color: '#94a3b8', icon: 'fa-question', label: category };
  return `<span style="display:inline-flex;align-items:center;gap:5px;color:${c.color};font-size:11px;font-weight:600;">
    <i class="fas ${c.icon}"></i>${c.label}
  </span>`;
};

/**
 * Render the full Verified Contracts panel into a container element
 */
window.vcRenderPanel = function(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const contracts = window.VERIFIED_CONTRACTS;
  const stats = {
    total:    contracts.length,
    verified: contracts.filter(c => c.status === 'verified').length,
    deployed: contracts.filter(c => c.status === 'deployed' || c.status === 'verified').length,
    pending:  contracts.filter(c => c.status === 'pending').length,
  };

  // Group by category
  const categories = ['token', 'infrastructure', 'core', 'defi'];
  const catLabels  = {
    token:          '🪙 Tokens',
    infrastructure: '🏗️ Infrastructure',
    core:           '🔷 Core Platform',
    defi:           '🔄 DeFi',
  };

  let html = `
    <!-- Stats bar -->
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
      <div style="flex:1;min-width:120px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:10px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#10b981;">${stats.verified}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">Verified</div>
      </div>
      <div style="flex:1;min-width:120px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:10px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#818cf8;">${stats.deployed}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">Deployed</div>
      </div>
      <div style="flex:1;min-width:120px;background:rgba(15,23,42,0.5);border:1px solid rgba(71,85,105,0.3);border-radius:10px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:#f1f5f9;">${stats.total}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">Total</div>
      </div>
    </div>
  `;

  // Render each category
  categories.forEach(cat => {
    const list = contracts.filter(c => c.category === cat);
    if (!list.length) return;

    html += `<div style="margin-bottom:22px;">
      <h3 style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid rgba(71,85,105,0.3);">
        ${catLabels[cat] || cat}
      </h3>
      <div style="display:flex;flex-direction:column;gap:10px;">`;

    list.forEach(c => {
      const isDeployed = c.address && c.address !== null;
      const shortAddr  = isDeployed ? window.vcShortAddr(c.address) : 'Not deployed';
      const scanLink   = c.arcscanUrl
        ? `<a href="${c.arcscanUrl}" target="_blank" rel="noopener noreferrer"
             style="display:inline-flex;align-items:center;gap:5px;color:#6366f1;font-size:12px;font-weight:600;text-decoration:none;"
             onmouseover="this.style.color='#a5b4fc'" onmouseout="this.style.color='#6366f1'">
             <i class="fas fa-external-link-alt" style="font-size:10px;"></i>ArcScan
           </a>`
        : `<span style="color:#475569;font-size:12px;">Not deployed</span>`;

      const securityItems = (c.security || []).map(s =>
        `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(15,23,42,0.6);border:1px solid rgba(71,85,105,0.25);border-radius:6px;padding:2px 8px;color:#94a3b8;font-size:11px;">
          <i class="fas fa-shield-alt" style="color:#34d399;font-size:9px;"></i>${s}
        </span>`
      ).join('');

      html += `
        <div style="background:rgba(15,23,42,0.5);border:1px solid rgba(71,85,105,0.25);border-radius:12px;padding:16px 18px;">
          <!-- Header row -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="color:#f1f5f9;font-size:14px;font-weight:700;">${c.name}</span>
                ${window.vcCategoryBadge(c.category)}
              </div>
              <p style="color:#94a3b8;font-size:12px;margin:4px 0 0;line-height:1.6;">${c.description}</p>
            </div>
            ${window.vcStatusBadge(c.status)}
          </div>

          <!-- Address row -->
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <code style="background:rgba(0,0,0,0.3);border:1px solid rgba(71,85,105,0.3);border-radius:6px;padding:4px 10px;color:${isDeployed ? '#a5b4fc' : '#475569'};font-size:12px;font-family:monospace;letter-spacing:0.02em;">
              ${isDeployed ? c.address : 'Awaiting deployment'}
            </code>
            ${isDeployed ? `<button onclick="window.vcCopyAddress('${c.address}', this)" title="Copy address"
              style="background:none;border:none;cursor:pointer;color:#64748b;font-size:12px;padding:4px 6px;border-radius:5px;transition:color 0.2s;"
              onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">
              <i class="fas fa-copy"></i>
            </button>` : ''}
            ${scanLink}
            ${c.deployTx ? `<a href="${VC_ARCSCAN_BASE}/tx/${c.deployTx}" target="_blank" rel="noopener noreferrer"
              style="display:inline-flex;align-items:center;gap:4px;color:#475569;font-size:11px;text-decoration:none;"
              onmouseover="this.style.color='#6b7280'" onmouseout="this.style.color='#475569'">
              <i class="fas fa-receipt" style="font-size:10px;"></i>Deploy Tx
            </a>` : ''}
          </div>

          <!-- Security badges -->
          ${securityItems ? `<div style="display:flex;flex-wrap:wrap;gap:5px;">${securityItems}</div>` : ''}
        </div>`;
    });

    html += `</div></div>`;
  });

  // Footer note
  html += `
    <div style="background:rgba(15,23,42,0.5);border:1px solid rgba(71,85,105,0.2);border-radius:10px;padding:14px 18px;margin-top:16px;">
      <p style="color:#475569;font-size:11px;line-height:1.8;margin:0;">
        <i class="fas fa-info-circle" style="color:#6366f1;margin-right:6px;"></i>
        All contracts operate on <strong style="color:#64748b;">Arc Testnet</strong> (Chain ID: ${VC_CHAIN_ID}).
        Verification status "Deployed" means the contract is live on-chain but source code is pending
        submission to ArcScan. "Verified" means source code has been submitted and matched.
        No contracts involve real funds.
      </p>
    </div>`;

  container.innerHTML = html;
};

/**
 * Async: fetch real-time on-chain data (reserves, contract count, etc.)
 * Calls the backend /api/contracts/verified endpoint
 */
window.vcFetchLiveData = async function() {
  try {
    const res  = await fetch('/api/contracts/verified');
    const data = await res.json();
    if (data && data.contracts) {
      // Merge live data into registry
      data.contracts.forEach(live => {
        const local = window.VERIFIED_CONTRACTS.find(c => c.id === live.id);
        if (local && live.address) {
          local.address = live.address;
          if (live.status) local.status = live.status;
          if (live.liveData) local.liveData = live.liveData;
        }
      });
    }
  } catch (e) {
    // Silently fail — static data is always shown
    console.debug('[vc] live data unavailable:', e.message);
  }
};

// Auto-init when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  // Load live data in background
  window.vcFetchLiveData().then(() => {
    // If panel already rendered, refresh it
    if (document.getElementById('vc-panel')) {
      window.vcRenderPanel('vc-panel');
    }
  });
});

console.log('[VC] verified-contracts.js loaded —', window.VERIFIED_CONTRACTS.length, 'contracts registered');
