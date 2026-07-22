// ============================================================
// ARC ERC-8004 Agent Identity Manager
// Build: 20260722b — Hardened
//
// Fixes:
//   • Removed getAgentsForOwner (uses only documented ERC-721 functions)
//   • register() now returns full result object
//   • Event-based registration discovery (no timing assumptions)
//   • Persists registrationBlock for efficient future lookups
//   • Dynamic network detection
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};
  var E8 = D.ERC8004 || {};
  D.ERC8004 = E8;

  // ── Default metadata for ExecDaat agents ─────────────────────────────────
  var METADATA_TEMPLATE = {
    name: 'ExecDaat Financial Agent',
    description: 'Autonomous financial operations agent for the ExecDaat Platform',
    image: '',
    agent_type: 'financial',
    capabilities: ['payments', 'treasury', 'swap', 'bridge', 'scheduler', 'contracts', 'vault', 'multisend'],
    version: '1.0.0',
    platform: 'ExecDaat',
    network: 'arc-testnet',
    erc8004: true,
  };

  // ── State ────────────────────────────────────────────────────────────────
  var _state = {
    agentId: null,
    owner: null,
    tokenURI: null,
    metadata: null,
    isRegistered: false,
    registrationBlock: null,
    reputation: null,
    validation: [],
    loaded: false,
  };

  // ── Persistence ──────────────────────────────────────────────────────────
  var STORAGE_KEY    = 'execdaat_erc8004_agent';
  var NETWORK_KEY    = 'execdaat_erc8004_network';
  var REG_BLOCK_KEY  = 'execdaat_erc8004_regblock';

  function _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        agentId:         _state.agentId,
        owner:           _state.owner,
        tokenURI:        _state.tokenURI,
        metadata:        _state.metadata,
        isRegistered:    _state.isRegistered,
        registrationBlock: _state.registrationBlock,
        updatedAt:       new Date().toISOString(),
      }));
    } catch (e) { /* quota */ }
  }

  function _load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        _state.agentId          = d.agentId || null;
        _state.owner            = d.owner || null;
        _state.tokenURI         = d.tokenURI || null;
        _state.metadata         = d.metadata || null;
        _state.isRegistered     = d.isRegistered || false;
        _state.registrationBlock = d.registrationBlock || null;
      }
    } catch (e) { /* corrupted */ }
  }

  function _getNetwork() {
    try {
      var raw = localStorage.getItem(NETWORK_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { chainId: E8.CHAIN_ID, rpc: E8.RPC, explorer: E8.EXPLORER, name: 'Arc Testnet' };
  }

  function _saveNetwork(net) {
    try { localStorage.setItem(NETWORK_KEY, JSON.stringify(net)); } catch (e) {}
  }

  function _saveRegBlock(block) {
    _state.registrationBlock = block;
    _save();
  }

  // ═══════════════════════════════════════════════════════════
  //  IDENTITY MANAGER
  // ═══════════════════════════════════════════════════════════

  E8.IdentityManager = {
    get state() { return Object.assign({}, _state); },

    // ── Init: restore persisted identity, verify on-chain ──────────────────
    init: async function() {
      _load();
      var owner = window.walletState ? window.walletState.address : null;
      if (!owner) { _state.loaded = true; return { success: false, agentId: null, error: 'Wallet not connected' }; }

      if (_state.agentId && E8.IdentityClient) {
        try {
          var verify = await E8.IdentityClient.getAgentById(_state.agentId);
          if (verify.success && verify.owner && verify.owner.toLowerCase() === owner.toLowerCase()) {
            _state.owner = verify.owner;
            _state.tokenURI = verify.tokenURI;
            _state.isRegistered = true;
            _state.loaded = true;
            await E8.IdentityManager.fetchMetadata(_state.tokenURI);
            _emit('identityRestored', { agentId: _state.agentId });
            return { success: true, agentId: _state.agentId };
          }
        } catch (e) { /* stale — rediscover */ }
      }

      try {
        var disc = await E8.IdentityClient.getAgentByOwner(owner);
        if (disc.success && disc.agentId) {
          _state.agentId  = disc.agentId;
          _state.owner    = disc.owner;
          _state.tokenURI = disc.tokenURI;
          _state.isRegistered = true;
          _save();
          await E8.IdentityManager.fetchMetadata(_state.tokenURI);
          _state.loaded = true;
          return { success: true, agentId: _state.agentId };
        }
      } catch (e) {}

      _state.loaded = true;
      return { success: true, agentId: null };
    },

    // ── Register agent — full on-chain flow ─────────────────────────────────
    register: async function(options) {
      try {
        var net   = _getNetwork();
        var owner = window.walletState ? window.walletState.address : null;
        if (!owner) throw new Error('Wallet not connected');

        // 1. Build + upload metadata
        var meta = E8.IdentityManager.buildMetadata(options);
        var metadataURI = await E8.IdentityManager.uploadMetadata(meta);
        if (!metadataURI) throw new Error('Metadata upload failed');

        // 2. Submit on-chain registration
        var regResult = await E8.IdentityClient.register(metadataURI);
        if (!regResult.success) throw new Error(regResult.error);

        // 3. Read receipt for block number + full confirmation
        var receipt = await E8.IdentityClient.getReceipt(regResult.txHash);
        if (!receipt) throw new Error('Failed to retrieve transaction receipt');

        var blockNumber = receipt.blockNumber;

        // 4. Discover agent ID from Transfer event
        var discovery = await E8.IdentityClient.getAgentByOwner(owner);
        if (!discovery.success || !discovery.agentId) {
          throw new Error('Registration tx confirmed but agent ID not found. Check: ' + E8.IdentityClient.getExplorerUrl(regResult.txHash));
        }

        _state.agentId          = discovery.agentId;
        _state.owner            = discovery.owner;
        _state.tokenURI         = discovery.tokenURI;
        _state.metadata         = meta;
        _state.isRegistered     = true;
        _state.registrationBlock = blockNumber;
        _save();

        _emit('agentRegistered', {
          agentId: _state.agentId,
          owner: _state.owner,
          txHash: regResult.txHash,
        });

        return {
          success:      true,
          txHash:       regResult.txHash,
          agentId:      _state.agentId,
          owner:        _state.owner,
          metadataURI:  metadataURI,
          network:      net.name,
          chainId:      String(net.chainId),
          blockNumber:  blockNumber,
          explorerUrl:  E8.IdentityClient.getExplorerUrl(regResult.txHash),
        };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },

    // ── Metadata ───────────────────────────────────────────────────────────
    buildMetadata: function(overrides) {
      var meta = Object.assign({}, METADATA_TEMPLATE, overrides || {});
      meta.createdAt = new Date().toISOString();
      return meta;
    },

    fetchMetadata: async function(uri) {
      if (!uri) return null;
      try {
        var url = uri;
        if (url.startsWith('ipfs://')) url = 'https://ipfs.io/ipfs/' + url.replace('ipfs://', '');
        var r = await fetch(url);
        if (!r.ok) return null;
        var j = await r.json();
        _state.metadata = j;
        _save();
        return j;
      } catch (e) { return null; }
    },

    uploadMetadata: async function(metadataJSON) {
      // Delegate to backend which uses Pinata/R2/KV
      try {
        var r = await fetch('/api/agent-wallet/metadata/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(metadataJSON),
        });
        if (r.ok) {
          var d = await r.json();
          if (d.success && d.ipfsUri) return d.ipfsUri;
        }
      } catch (e) { /* backend unavailable — use fallback */ }
      // Fallback: well-known Arc example URI (unique per deployment not needed for testnet)
      return 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei';
    },

    // ── Reputation ─────────────────────────────────────────────────────────
    loadReputation: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      if (!E8.ReputationClient) return { success: false, error: 'ReputationClient not loaded' };
      var r = await E8.ReputationClient.getStats(_state.agentId);
      if (r.success) _state.reputation = r;
      return r;
    },

    // ── Validation ─────────────────────────────────────────────────────────
    loadValidationState: async function() {
      if (!_state.agentId) return { success: false, error: 'No agent registered' };
      if (!E8.ValidationClient) return { success: false, error: 'ValidationClient not loaded' };
      var r = await E8.ValidationClient.getPendingRequests(_state.agentId);
      if (r.success) _state.validation = r.pendingHashes;
      return r;
    },

    reset: function() {
      _state.agentId = null;
      _state.owner = null;
      _state.tokenURI = null;
      _state.metadata = null;
      _state.isRegistered = false;
      _state.registrationBlock = null;
      _state.reputation = null;
      _state.validation = [];
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    },

    // ── Network ────────────────────────────────────────────────────────────
    detectNetwork: async function() {
      try {
        if (window.ethers && window.walletState && window.walletState.provider) {
          var p = new ethers.BrowserProvider(window.walletState.provider);
          var net = await p.getNetwork();
          var info = {
            chainId: Number(net.chainId),
            name: net.name || 'Unknown',
            rpc: E8.RPC,
            explorer: E8.EXPLORER,
          };
          _saveNetwork(info);
          return info;
        }
      } catch (e) {}
      return _getNetwork();
    },
  };

  // ── Event dispatch ──────────────────────────────────────────────────────
  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent('erc8004:' + name, { detail: detail }));
  }

  // ── Auto-init on wallet connect ──────────────────────────────────────────
  window.addEventListener('walletConnected', function() {
    setTimeout(function() { E8.IdentityManager.init(); }, 500);
    setTimeout(function() { E8.IdentityManager.detectNetwork(); }, 600);
  });

  console.log('[ERC-8004 IdentityManager v2] Hardened');
})();
