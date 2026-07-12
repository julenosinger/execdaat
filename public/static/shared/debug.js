// ============================================================
// ExecDaat Debug Console — Developer diagnostics overlay
// ============================================================
// Activated by: localStorage.setItem('exd_debug','1') + reload
// Or: Press Ctrl+Shift+D to toggle
// Shows: network, RPC, wallet, chain, treasury, bridge, guardian,
// pending requests, cache stats, version info.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var enabled = false;
  var panel = null;
  var refreshTimer = null;

  function isDebugMode() {
    try { return localStorage.getItem('exd_debug') === '1'; } catch(e) { return false; }
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'exd-debug-panel';
    panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;background:rgba(13,17,33,0.96);border:1px solid rgba(120,150,255,0.28);border-radius:12px;padding:14px 16px;max-width:340px;font-family:monospace;font-size:11px;color:#c9d3e7;backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.5);max-height:70vh;overflow-y:auto;display:none;';
    panel.innerHTML = '<div id="exd-debug-content">Loading...</div>' +
      '<button onclick="document.getElementById(\'exd-debug-panel\').style.display=\'none\'" style="position:absolute;top:6px;right:6px;background:none;border:none;color:#63769c;cursor:pointer;font-size:14px;">\u2715</button>';
    document.body.appendChild(panel);
  }

  function render() {
    if (!panel) buildPanel();
    var content = document.getElementById('exd-debug-content');
    if (!content) return;

    var ws = window.walletState || {};
    var health = D.health || {};
    var rpc = D.getRPCMetrics ? D.getRPCMetrics() : {};
    var telemetry = D.telemetry;
    var cache = D.cache;

    var lines = [
      '<div style="color:#818cf8;font-weight:800;margin-bottom:8px;">ExecDaat Debug Console</div>',
      '<div style="display:grid;grid-template-columns:auto auto;gap:2px 10px;">',
      kv('Chain', (D.CHAIN ? D.CHAIN.NAME : '?') + ' (' + (D.CHAIN ? D.CHAIN.ID : '?') + ')'),
      kv('RPC', rpc.activeRPC ? rpc.activeRPC.replace('https://','') : '?'),
      kv('RPC Health', rpc.healthyCount + '/' + rpc.totalCount + ' ok'),
      kv('RPC Latency', rpc.metrics ? rpc.metrics.avgLatency + 'ms' : '?'),
      kv('Wallet', ws.connected ? 'Connected' : 'Disconnected'),
      kv('Network', ws.onArcNetwork ? 'Arc Testnet' : (ws.connected ? 'Wrong' : 'N/A')),
      kv('Health', health.overall || '?'),
      kv('Treasury', (health.components && health.components.treasury) ? health.components.treasury.status : '?'),
      kv('Guardian', (health.components && health.components.guardian) ? health.components.guardian.status : '?'),
      kv('Bridge', (health.components && health.components.bridge) ? health.components.bridge.status : '?'),
      kv('Telemetry', telemetry ? telemetry.count() + ' events' : 'N/A'),
      '</div>',
    ];

    if (cache) {
      var stats = cache.stats;
      lines.push('<div style="margin-top:6px;color:#6a7aa6;">-- Cache --</div>');
      lines.push(kv('Namespaces', Object.keys(cache.stats ? {} : {}).length || 0));
    }

    lines.push('<div style="margin-top:6px;color:#6a7aa6;font-size:10px;">v20260712p4 | Phase 4</div>');
    content.innerHTML = lines.join('');
  }

  function kv(k, v) {
    return '<span style="color:#7f92b8;">' + k + '</span><span>' + (v != null ? v : '—') + '</span>';
  }

  function toggle() {
    if (!panel) buildPanel();
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    } else {
      panel.style.display = 'block';
      render();
      if (!refreshTimer) refreshTimer = setInterval(render, 3000);
    }
  }

  // Keyboard shortcut: Ctrl+Shift+D
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      if (!enabled) { enabled = true; try { localStorage.setItem('exd_debug', '1'); } catch(_) {} }
      toggle();
    }
  });

  // Init
  if (isDebugMode()) {
    enabled = true;
    setTimeout(function() { buildPanel(); }, 2000);
  }

  D.debugPanel = {
    isEnabled: function() { return enabled; },
    toggle: toggle,
    show: function() { if (!panel) buildPanel(); panel.style.display = 'block'; render(); },
    hide: function() { if (panel) panel.style.display = 'none'; },
    render: render,
  };
})();
