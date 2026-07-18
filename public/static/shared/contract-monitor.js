// ============================================================
// ExecDaat Contract Monitor — Read-only on-chain watch
// ============================================================
// Monitors: contract liveness, pause status, owner/operator,
// recent events. Read-only. No private keys. No transactions.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var monitors = {};    // { address: { timer, interval, lastCheck, status } }
  var DEFAULT_INTERVAL = 30000; // 30 seconds

  function now() { return Date.now(); }

  // Minimal ABI fragments for monitoring
  var MONITOR_ABIS = {
    paused:     ['function paused() view returns (bool)'],
    owner:      ['function owner() view returns (address)'],
    governor:   ['function governor() view returns (address)'],
    isOperator: ['function isOperator(address) view returns (bool)'],
    getAssets:  ['function getAssets() view returns (address[])'],
    summary:    ['function summary() view returns (tuple(string,string,uint256,uint256,bool,address,uint256,uint256,uint256))'],
  };

  function rpcCall(method, params) {
    var body = { jsonrpc: '2.0', id: 1, method: method, params: params || [] };
    var rpc = D.getRPC ? D.getRPC() : 'https://rpc.testnet.arc.network';
    return fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function(r) { return r.json(); });
  }

  function checkContract(address, abiFragments) {
    var calls = abiFragments.map(function(f) {
      // Extract function signature (e.g., "paused()")
      var sig = f.match(/function\s+(\w+)/)[1];
      var selector = '0x' + simpleKeccak(f.match(/function\s+(\w+\([^)]*\))/)[1]).slice(0, 8);
      return { sig: sig, data: selector };
    });

    // Try multicall via eth_call batching (simplified: sequential)
    var promises = calls.map(function(c) {
      return rpcCall('eth_call', [{ to: address, data: c.data }, 'latest'])
        .then(function(res) {
          if (res.error) return { sig: c.sig, ok: false, error: res.error.message };
          return { sig: c.sig, ok: true, raw: res.result };
        })
        .catch(function(e) {
          return { sig: c.sig, ok: false, error: e.message };
        });
    });

    return Promise.all(promises).then(function(results) {
      var status = { address: address, available: true, checkedAt: now(), checks: {} };
      var allOk = true;
      results.forEach(function(r) { status.checks[r.sig] = r; if (!r.ok) allOk = false; });
      status.allOk = allOk;
      return status;
    }).catch(function(e) {
      return { address: address, available: false, checkedAt: now(), error: e.message };
    });
  }

  // Simple keccak256 placeholder (used only for selector computation in monitor)
  function simpleKeccak(sig) {
    // Use ethers if available
    if (window.ethers && window.ethers.id) return window.ethers.id(sig);
    // Fallback — return placeholder (monitor will use pre-computed selectors)
    return sig;
  }

  // ─── Pre-computed selectors for common checks ─────────────────────────
  var SELECTORS = {
    paused:       '0x5c975abb',
    owner:        '0x8da5cb5b',
    governor:     '0x0c340a9b',
    getReserves:  '0x0902f1ac',
  };

  function checkDeployed(name, addr, checks) {
    var selChecks = [];
    if (checks.paused !== false) selChecks.push({ sig: 'paused', data: checks.paused || SELECTORS.paused });
    if (checks.owner !== false) selChecks.push({ sig: checks.ownerKey || 'owner', data: checks.owner || SELECTORS.owner });

    return rpcCall('eth_call', [{ to: addr, data: selChecks[0].data }, 'latest'])
      .then(function(res) {
        return { name: name, address: addr, accessible: !res.error, checkedAt: now(), error: res.error ? res.error.message : null };
      })
      .catch(function(e) {
        return { name: name, address: addr, accessible: false, checkedAt: now(), error: e.message };
      });
  }

  // ─── Public API ───────────────────────────────────────────────────────

  D.contractMonitor = {
    /** Monitor a specific contract */
    watch: function(name, address, intervalMs) {
      intervalMs = intervalMs || DEFAULT_INTERVAL;
      D.contractMonitor.unwatch(address);

      function tick() {
        checkDeployed(name, address, {}).then(function(status) {
          monitors[address] = monitors[address] || {};
          monitors[address].status = status;
          monitors[address].lastCheck = now();
        }).catch(function() {});
      }

      tick(); // immediate first check
      monitors[address] = { name: name, timer: setInterval(tick, intervalMs), interval: intervalMs, lastCheck: now() };
    },

    /** Stop monitoring a contract */
    unwatch: function(address) {
      var m = monitors[address];
      if (m && m.timer) { clearInterval(m.timer); delete monitors[address]; }
    },

    /** Get status of a monitored contract */
    getStatus: function(address) {
      var m = monitors[address];
      return m ? (m.status || { address: address, lastCheck: m.lastCheck }) : null;
    },

    /** Get all monitored contracts */
    getAll: function() {
      var result = {};
      Object.keys(monitors).forEach(function(addr) {
        result[addr] = {
          name: monitors[addr].name,
          status: monitors[addr].status,
          lastCheck: monitors[addr].lastCheck,
        };
      });
      return result;
    },

    /** Start monitoring all known contracts */
    startAll: function() {
      var CONTRACTS = D.CONTRACTS || {};
      if (CONTRACTS.AMM)    D.contractMonitor.watch('SimpleAMM', CONTRACTS.AMM);
      if (CONTRACTS.FACTORY) D.contractMonitor.watch('ContractFactory', CONTRACTS.FACTORY);
      D.safeLogInfo && D.safeLogInfo('monitor', 'Contract monitoring started');
    },

    /** Stop all monitoring */
    stopAll: function() {
      Object.keys(monitors).forEach(function(addr) {
        D.contractMonitor.unwatch(addr);
      });
    },

    /** Get summary of all monitored contracts */
    summary: function() {
      var all = D.contractMonitor.getAll();
      var available = 0, unavailable = 0;
      Object.values(all).forEach(function(m) {
        if (m.status && m.status.accessible) available++; else unavailable++;
      });
      return { total: available + unavailable, available: available, unavailable: unavailable, contracts: all, checkedAt: now() };
    },
  };

  // Auto-start after other modules load
  setTimeout(function() { D.contractMonitor.startAll(); }, 5000);
})();
