// ============================================================
// ExecDaat — SPA Router (Feature 2)
// Hash-based routing: /app#/contracts, /app#/payments, etc.
// Also handles direct URL path routing via Cloudflare Pages
// Build: 20260407a
// ============================================================
'use strict';

/* ─── Route definition ────────────────────────────────────── */
const DAAT_ROUTES = [
  { path: '/dashboard',  tab: 'dashboard',  label: 'Dashboard',  icon: 'fas fa-info-circle',   color: '#6366f1' },
  { path: '/payments',   tab: 'payments',   label: 'Payments',   icon: 'fas fa-dollar-sign',   color: '#22c55e' },
  { path: '/contracts',  tab: 'contracts',  label: 'Contracts',  icon: 'fas fa-file-contract', color: '#3b82f6' },
  { path: '/autonoma',   tab: 'agents',     label: 'AI Agents',  icon: 'fas fa-brain',         color: '#a855f7' },
  { path: '/settings',   tab: 'settings',   label: 'Settings',   icon: 'fas fa-cog',           color: '#f59e0b' },
  { path: '/otc',        tab: 'otc',        label: 'OTC',        icon: 'fas fa-handshake',     color: '#6366f1' },
  { path: '/swap',       tab: 'dex',        label: 'Swap',       icon: 'fas fa-exchange-alt',  color: '#eab308' },
  { path: '/multisend',  tab: 'multisend',  label: 'MultiSend',  icon: 'fas fa-paper-plane',   color: '#06b6d4' },
  { path: '/history',    tab: 'history',    label: 'History',    icon: 'fas fa-history',       color: '#60a5fa' },
];

// tab-name → route path (for reverse lookup)
const TAB_TO_PATH = {};
DAAT_ROUTES.forEach(r => { TAB_TO_PATH[r.tab] = r.path; });

/* ─── State ───────────────────────────────────────────────── */
let _currentRoute  = null;
let _popStateBound = false;

/* ─── Helpers ─────────────────────────────────────────────── */
function _getHashPath() {
  // Support both /#/payments and /payments (direct URL)
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('/')) return hash.split('?')[0];
  // Fall back to pathname
  const path = location.pathname.replace(/\/$/, '');
  return path || '/dashboard';
}

function _routeForPath(path) {
  return DAAT_ROUTES.find(r => r.path === path || r.path === '/' + path.replace(/^\//,''));
}

function _tabForPath(path) {
  const r = _routeForPath(path);
  return r ? r.tab : null;
}

/* ─── Navigation ──────────────────────────────────────────── */
/**
 * Navigate to a named tab — updates the URL hash and switches tabs.
 * Does NOT reload the page; wallet state is preserved.
 * @param {string} tab  - tab name (e.g. 'payments', 'contracts')
 * @param {boolean} [replace] - use replaceState instead of pushState
 */
function daatNavigate(tab, replace = false) {
  const path = TAB_TO_PATH[tab] || '/dashboard';

  // Update URL without reload
  const newHash = '#' + path;
  if (location.hash !== newHash) {
    if (replace) {
      history.replaceState({ tab, path }, '', newHash);
    } else {
      history.pushState({ tab, path }, '', newHash);
    }
  }

  _applyRoute(tab);
}

function _applyRoute(tab) {
  if (_currentRoute === tab) return;
  _currentRoute = tab;

  // Enter app-shell if hidden
  if (typeof window.enterApp === 'function') {
    const shell = document.getElementById('app-shell');
    if (shell && shell.classList.contains('hidden')) {
      window.enterApp();
    }
  }

  // Delegate to existing switchTab
  if (typeof window.switchTab === 'function') {
    window.switchTab(tab);
  }

  // Update router-nav active states
  _updateRouterNavHighlight(tab);

  // Update page title
  const route = DAAT_ROUTES.find(r => r.tab === tab);
  if (route) {
    document.title = route.label + ' — ExecDaat';
  }
}

/* ─── popstate (Back / Forward buttons) ──────────────────── */
function _onPopState(e) {
  const path = _getHashPath();
  const tab  = _tabForPath(path);
  if (tab) _applyRoute(tab);
}

/* ─── Router Nav HTML (sidebar / topnav supplement) ──────── */
function _buildRouterNav() {
  if (document.getElementById('daat-router-nav')) return;

  const nav = document.createElement('nav');
  nav.id        = 'daat-router-nav';
  nav.innerHTML = DAAT_ROUTES.map(r => `
    <a href="#${r.path}"
       data-route-tab="${r.tab}"
       onclick="daatNavigate('${r.tab}');return false;"
       class="daat-rnav-link"
       title="${r.label}">
      <i class="${r.icon}"></i>
      <span>${r.label}</span>
    </a>`).join('');

  // Insert after tab-nav
  const tabNav = document.getElementById('tab-nav');
  if (tabNav && tabNav.parentNode) {
    tabNav.parentNode.insertBefore(nav, tabNav.nextSibling);
  } else {
    // fallback: prepend to app-shell
    const shell = document.getElementById('app-shell');
    if (shell) shell.prepend(nav);
  }

  // Inject styles
  _injectRouterStyles();
}

function _updateRouterNavHighlight(tab) {
  document.querySelectorAll('.daat-rnav-link').forEach(a => {
    const active = a.getAttribute('data-route-tab') === tab;
    a.classList.toggle('active', active);
  });
}

/* ─── CSS ─────────────────────────────────────────────────── */
function _injectRouterStyles() {
  if (document.getElementById('daat-router-styles')) return;
  const s = document.createElement('style');
  s.id = 'daat-router-styles';
  s.textContent = `
    #daat-router-nav {
      display: none;           /* hidden by default — shown via URL routing only */
    }

    /* Route-aware breadcrumb shown in header area */
    #daat-breadcrumb {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #6b7280;
      padding: 4px 10px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 8px;
      font-weight: 600;
    }
    #daat-breadcrumb .sep { color: #374151; }
    #daat-breadcrumb .active-page { color: #a78bfa; }
  `;
  document.head.appendChild(s);
}

/* ─── Breadcrumb helper ───────────────────────────────────── */
function _updateBreadcrumb(tab) {
  const route = DAAT_ROUTES.find(r => r.tab === tab);
  const bc    = document.getElementById('daat-breadcrumb');
  if (!bc || !route) return;
  bc.innerHTML = `
    <i class="fas fa-home" style="color:#4b5563;font-size:10px;"></i>
    <span class="sep">/</span>
    <span class="active-page"><i class="${route.icon}" style="font-size:10px;margin-right:4px;"></i>${route.label}</span>
  `;
}

/* ─── Settings tab support ────────────────────────────────── */
// The Settings tab is opened via openSettingsModal() by default.
// We intercept /settings route to open the modal seamlessly.
function _handleSettingsRoute() {
  if (typeof window.openSettingsModal === 'function') {
    window.openSettingsModal();
  } else {
    // Fallback: switch to dashboard
    daatNavigate('dashboard', true);
  }
}

/* ─── Init ────────────────────────────────────────────────── */
function daatRouterInit() {
  if (_popStateBound) return;
  _popStateBound = true;

  window.addEventListener('popstate', _onPopState);
  window.addEventListener('hashchange', _onPopState);

  // Intercept switchTab calls to keep URL in sync
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function(tab) {
      _origSwitchTab(tab);
      // Update hash without triggering _applyRoute again
      const path = TAB_TO_PATH[tab];
      if (path) {
        const newHash = '#' + path;
        if (location.hash !== newHash) {
          history.replaceState({ tab, path }, '', newHash);
        }
      }
      _updateRouterNavHighlight(tab);
      _updateBreadcrumb(tab);
    };
  }

  // Handle initial URL
  const path = _getHashPath();
  const tab  = _tabForPath(path);

  if (tab) {
    // Wait for DOM / app to be ready
    const _initRoute = () => {
      if (tab === 'settings') {
        _handleSettingsRoute();
        return;
      }
      const shell = document.getElementById('app-shell');
      if (shell && shell.classList.contains('hidden')) {
        // On landing page — navigate to app
        if (typeof window.enterApp === 'function') {
          window.enterApp();
          setTimeout(() => {
            if (typeof window.switchTab === 'function') window.switchTab(tab);
            _updateRouterNavHighlight(tab);
          }, 200);
        }
      } else {
        if (typeof window.switchTab === 'function') window.switchTab(tab);
        _updateRouterNavHighlight(tab);
      }
      _currentRoute = tab;
      const route = DAAT_ROUTES.find(r => r.tab === tab);
      if (route) document.title = route.label + ' — ExecDaat';
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(_initRoute, 400);
    } else {
      document.addEventListener('DOMContentLoaded', () => setTimeout(_initRoute, 400));
    }
  }

  // Build router nav
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    _buildRouterNav();
  } else {
    document.addEventListener('DOMContentLoaded', _buildRouterNav);
  }

  console.log('[ROUTER] daatRouterInit · v20260407a · path=', path, '→ tab=', tab || '(none)');
}

/* ─── Expose globals ──────────────────────────────────────── */
window.daatNavigate   = daatNavigate;
window.daatRouterInit = daatRouterInit;
window.DAAT_ROUTES    = DAAT_ROUTES;

// Auto-init after DOM ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(daatRouterInit, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(daatRouterInit, 100));
}
