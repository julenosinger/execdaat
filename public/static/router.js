// build:v2-20260627-151358
// ============================================================
// ExecDaat — SPA Router
// Clean URL routing: /payments, /contracts, etc.
// Build: 20260626-clean-urls
// ============================================================
'use strict';

/* ─── Route definition ────────────────────────────────────── */
const DAAT_ROUTES = [
  { path: '/dashboard',  tab: 'dashboard',  label: 'Dashboard',  icon: 'fas fa-info-circle',   color: '#6366f1' },
  { path: '/payments',   tab: 'payments',   label: 'Payments',   icon: 'fas fa-dollar-sign',   color: '#22c55e' },
  { path: '/contracts',  tab: 'contracts',  label: 'Contracts',  icon: 'fas fa-file-contract', color: '#3b82f6' },
  { path: '/autonoma',   tab: 'autonoma',   label: 'Autonoma',   icon: 'fas fa-robot',         color: '#22c55e' },
  { path: '/agents',     tab: 'agents',     label: 'AI Agents',  icon: 'fas fa-brain',         color: '#a855f7' },
  { path: '/settings',   tab: 'settings',   label: 'Settings',   icon: 'fas fa-cog',           color: '#f59e0b' },
  { path: '/otc',        tab: 'otc',        label: 'OTC',        icon: 'fas fa-handshake',     color: '#6366f1' },
  { path: '/swap',       tab: 'dex',        label: 'Swap',       icon: 'fas fa-exchange-alt',  color: '#eab308' },
  { path: '/bridge',     tab: 'bridge',     label: 'Bridge',     icon: 'fas fa-right-left',    color: '#06b6d4' },
  { path: '/multisend',  tab: 'multisend',  label: 'MultiSend',  icon: 'fas fa-paper-plane',   color: '#06b6d4' },
  { path: '/history',    tab: 'history',    label: 'History',    icon: 'fas fa-history',       color: '#60a5fa' },
];

const TAB_TO_PATH = {};
DAAT_ROUTES.forEach(r => { TAB_TO_PATH[r.tab] = r.path; });

let _currentRoute  = null;
let _popStateBound = false;

function _getPath() {
  // Support clean URLs (/payments) and legacy hash (#/payments)
  var hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('/')) return hash.split('?')[0];
  var path = location.pathname.replace(/\/$/, '');
  return path || '/payments';
}

function _routeForPath(path) {
  return DAAT_ROUTES.find(function(r) { return r.path === path || r.path === '/' + path.replace(/^\//,''); });
}

function _tabForPath(path) {
  var r = _routeForPath(path);
  return r ? r.tab : null;
}

function daatNavigate(tab, replace) {
  var path = TAB_TO_PATH[tab] || '/payments';
  var state = { tab: tab, path: path };

  if (replace) {
    history.replaceState(state, '', path);
  } else {
    history.pushState(state, '', path);
  }

  _applyRoute(tab);
}

function _applyRoute(tab) {
  if (_currentRoute === tab) return;
  _currentRoute = tab;

  var shell   = document.getElementById('app-shell');
  var landing = document.getElementById('landing-page');
  if (shell && shell.classList.contains('hidden')) {
    if (landing) landing.classList.add('hidden');
    shell.classList.remove('hidden');
    document.body.classList.add('sidebar-active');
    if (typeof applySidebarOffsets === 'function') applySidebarOffsets();
  }

  if (typeof window.switchTab === 'function') {
    window.switchTab(tab);
  }

  _updateRouterNavHighlight(tab);

  var route = DAAT_ROUTES.find(function(r) { return r.tab === tab; });
  if (route) {
    document.title = route.label + ' — ExecDaat';
  }
}

function _onPopState(e) {
  var path = _getPath();
  var tab  = _tabForPath(path);
  if (tab) _applyRoute(tab);
}

function _buildRouterNav() {
  if (document.getElementById('daat-router-nav')) return;
  var nav = document.createElement('nav');
  nav.id = 'daat-router-nav';
  nav.innerHTML = DAAT_ROUTES.map(function(r) {
    return '<a href="' + r.path + '" data-route-tab="' + r.tab + '" onclick="daatNavigate(\'' + r.tab + '\');return false;" class="daat-rnav-link" title="' + r.label + '"><i class="' + r.icon + '"></i><span>' + r.label + '</span></a>';
  }).join('');
  var tabNav = document.getElementById('tab-nav');
  if (tabNav && tabNav.parentNode) {
    tabNav.parentNode.insertBefore(nav, tabNav.nextSibling);
  } else {
    var shell = document.getElementById('app-shell');
    if (shell) shell.prepend(nav);
  }
  _injectRouterStyles();
}

function _updateRouterNavHighlight(tab) {
  document.querySelectorAll('.daat-rnav-link').forEach(function(a) {
    var active = a.getAttribute('data-route-tab') === tab;
    a.classList.toggle('active', active);
  });
}

function _injectRouterStyles() {
  if (document.getElementById('daat-router-styles')) return;
  var s = document.createElement('style');
  s.id = 'daat-router-styles';
  s.textContent = '#daat-router-nav{display:none}#daat-breadcrumb{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#6b7280;padding:4px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px;font-weight:600}#daat-breadcrumb .sep{color:#374151}#daat-breadcrumb .active-page{color:#a78bfa}';
  document.head.appendChild(s);
}

function _updateBreadcrumb(tab) {
  var route = DAAT_ROUTES.find(function(r) { return r.tab === tab; });
  var bc    = document.getElementById('daat-breadcrumb');
  if (!bc || !route) return;
  bc.innerHTML = '<i class="fas fa-home" style="color:#4b5563;font-size:10px;"></i><span class="sep">/</span><span class="active-page"><i class="' + route.icon + '" style="font-size:10px;margin-right:4px;"></i>' + route.label + '</span>';
}

function _handleSettingsRoute() {
  if (typeof window.openSettingsModal === 'function') {
    window.openSettingsModal();
  } else {
    daatNavigate('dashboard', true);
  }
}

function daatRouterInit() {
  if (_popStateBound) return;
  _popStateBound = true;

  window.addEventListener('popstate', _onPopState);

  // Intercept switchTab calls to keep URL in sync with CLEAN URLs
  var _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function(tab) {
      _origSwitchTab(tab);
      var path = TAB_TO_PATH[tab];
      if (path) {
        var currentPath = location.pathname.replace(/\/$/, '') || '/';
        if (currentPath !== path) {
          history.replaceState({ tab: tab, path: path }, '', path);
        }
      }
      _updateRouterNavHighlight(tab);
      _updateBreadcrumb(tab);
    };
  }

  // Handle initial URL
  var path = _getPath();
  var tab  = _tabForPath(path);

  // Auto-redirect legacy hash URLs to clean URLs
  if (location.hash && location.hash.startsWith('#/')) {
    var cleanPath = location.hash.replace(/^#/, '');
    history.replaceState({ tab: tab, path: cleanPath }, '', cleanPath);
  }

  if (tab) {
    var _initRoute = function() {
      if (tab === 'settings') { _handleSettingsRoute(); return; }
      var shell   = document.getElementById('app-shell');
      var landing = document.getElementById('landing-page');
      if (shell && shell.classList.contains('hidden')) {
        if (landing) landing.classList.add('hidden');
        shell.classList.remove('hidden');
        document.body.classList.add('sidebar-active');
        if (typeof applySidebarOffsets === 'function') applySidebarOffsets();
        setTimeout(function() {
          if (typeof window.switchTab === 'function') window.switchTab(tab);
          _updateRouterNavHighlight(tab);
        }, 200);
      } else {
        if (typeof window.switchTab === 'function') window.switchTab(tab);
        _updateRouterNavHighlight(tab);
      }
      _currentRoute = tab;
      var route = DAAT_ROUTES.find(function(r) { return r.tab === tab; });
      if (route) document.title = route.label + ' — ExecDaat';
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(_initRoute, 400);
    } else {
      document.addEventListener('DOMContentLoaded', function() { setTimeout(_initRoute, 400); });
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    _buildRouterNav();
  } else {
    document.addEventListener('DOMContentLoaded', _buildRouterNav);
  }

  console.log('[ROUTER] clean-urls · path=' + path + ' → tab=' + (tab || '(none)'));
}

window.daatNavigate   = daatNavigate;
window.daatRouterInit = daatRouterInit;
window.DAAT_ROUTES    = DAAT_ROUTES;

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(daatRouterInit, 100);
} else {
  document.addEventListener('DOMContentLoaded', function() { setTimeout(daatRouterInit, 100); });
}
