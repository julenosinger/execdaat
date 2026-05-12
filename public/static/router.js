// ============================================================
// ExecDaat — SPA Router v20260511a
// Clean URL routing: /payments, /contracts, etc. (sem hash)
// Usa history.pushState — sem # na URL
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
  { path: '/bridge',     tab: 'bridge',     label: 'Bridge',     icon: 'fas fa-right-left',    color: '#06b6d4' },
  { path: '/multisend',  tab: 'multisend',  label: 'MultiSend',  icon: 'fas fa-paper-plane',   color: '#06b6d4' },
  { path: '/history',    tab: 'history',    label: 'History',    icon: 'fas fa-history',       color: '#60a5fa' },
  { path: '/home',       tab: 'home',       label: 'Home',       icon: 'fas fa-home',          color: '#6366f1' },
];

// tab-name → route path (for reverse lookup)
const TAB_TO_PATH = {};
DAAT_ROUTES.forEach(r => { TAB_TO_PATH[r.tab] = r.path; });

/* ─── State ───────────────────────────────────────────────── */
let _currentRoute  = null;
let _popStateBound = false;

/* ─── Helpers ─────────────────────────────────────────────── */
function _getCurrentPath() {
  // Clean URL mode: usa pathname
  // Suporte legado: se ainda há hash #/xxx, migra para clean URL
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('/')) {
    // Migrar hash para clean URL sem reload
    const cleanPath = hash.split('?')[0];
    history.replaceState(null, '', cleanPath);
    return cleanPath;
  }
  const path = location.pathname.replace(/\/$/, '');
  return path || '/payments';
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
 * Navigate to a named tab — atualiza a URL limpa e troca de aba.
 * NÃO recarrega a página; estado da wallet é preservado.
 * @param {string} tab  - tab name (e.g. 'payments', 'contracts')
 * @param {boolean} [replace] - usar replaceState em vez de pushState
 */
function daatNavigate(tab, replace = false) {
  const path = TAB_TO_PATH[tab] || '/payments';

  // Atualizar URL sem reload (clean URL)
  if (location.pathname !== path) {
    if (replace) {
      history.replaceState({ tab, path }, '', path);
    } else {
      history.pushState({ tab, path }, '', path);
    }
  }

  _applyRoute(tab);
}

function _applyRoute(tab) {
  if (_currentRoute === tab) return;
  _currentRoute = tab;

  // Mostrar app-shell se oculto
  const shell   = document.getElementById('app-shell');
  const landing = document.getElementById('landing-page');
  if (shell && shell.classList.contains('hidden')) {
    if (landing) landing.classList.add('hidden');
    shell.classList.remove('hidden');
    // Esconder o header legado (sticky-topbar-anchor) — ele pertence apenas
    // à landing page. O app-shell tem seu próprio app-topbar-wrap inline.
    // Sem isso, o header legado ocupa espaço no topo e cria a área escura vazia.
    const oldTopbar = document.getElementById('sticky-topbar-anchor');
    if (oldTopbar) {
      oldTopbar.style.display = 'none';
      oldTopbar.setAttribute('aria-hidden', 'true');
    }
    // Restaurar estado de colapso da sidebar
    try {
      if (localStorage.getItem('sidebarCollapsed') === '1') {
        shell.classList.add('sidebar-collapsed');
        const icon = document.getElementById('sidebar-collapse-icon');
        if (icon) icon.style.transform = 'rotate(180deg)';
      }
    } catch(e){}
  }

  // Delegar para switchTab existente
  if (typeof window.switchTab === 'function') {
    window.switchTab(tab);
  }

  // Atualizar highlight do nav
  _updateRouterNavHighlight(tab);

  // Atualizar título da página
  const route = DAAT_ROUTES.find(r => r.tab === tab);
  if (route) {
    document.title = route.label + ' — ExecDaat';
  }
}

/* ─── popstate (Botões Voltar / Avançar) ──────────────────── */
function _onPopState(e) {
  const path = _getCurrentPath();
  const tab  = _tabForPath(path);
  if (tab) _applyRoute(tab);
}

/* ─── Router Nav HTML ──────────────────────────────────────── */
function _buildRouterNav() {
  if (document.getElementById('daat-router-nav')) return;

  const nav = document.createElement('nav');
  nav.id        = 'daat-router-nav';
  nav.innerHTML = DAAT_ROUTES.map(r => `
    <a href="${r.path}"
       data-route-tab="${r.tab}"
       onclick="daatNavigate('${r.tab}');return false;"
       class="daat-rnav-link"
       title="${r.label}">
      <i class="${r.icon}"></i>
      <span>${r.label}</span>
    </a>`).join('');

  const tabNav = document.getElementById('tab-nav');
  if (tabNav && tabNav.parentNode) {
    tabNav.parentNode.insertBefore(nav, tabNav.nextSibling);
  } else {
    const shell = document.getElementById('app-shell');
    if (shell) shell.prepend(nav);
  }

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
      display: none;
    }
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
function _handleSettingsRoute() {
  if (typeof window.openSettingsModal === 'function') {
    window.openSettingsModal();
  } else {
    daatNavigate('payments', true);
  }
}

/* ─── Init ────────────────────────────────────────────────── */
function daatRouterInit() {
  if (_popStateBound) return;
  _popStateBound = true;

  window.addEventListener('popstate', _onPopState);

  // Interceptar switchTab para manter URL em sync
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function(tab) {
      _origSwitchTab(tab);
      const path = TAB_TO_PATH[tab];
      if (path && location.pathname !== path) {
        history.replaceState({ tab, path }, '', path);
      }
      _updateRouterNavHighlight(tab);
      _updateBreadcrumb(tab);
    };
  }

  // Lidar com URL inicial
  const path = _getCurrentPath();
  const tab  = _tabForPath(path);

  if (tab) {
    const _initRoute = () => {
      if (tab === 'settings') {
        _handleSettingsRoute();
        return;
      }
      const shell   = document.getElementById('app-shell');
      const landing = document.getElementById('landing-page');
      if (shell && shell.classList.contains('hidden')) {
        if (landing) landing.classList.add('hidden');
        shell.classList.remove('hidden');
        setTimeout(() => {
          if (typeof window.switchTab === 'function') window.switchTab(tab);
          _updateRouterNavHighlight(tab);
        }, 200);
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

  console.log('[ROUTER] v20260511a · clean URLs · path=', path, '→ tab=', tab || '(none)');
}

/* ─── Expose globals ──────────────────────────────────────── */
window.daatNavigate   = daatNavigate;
window.daatRouterInit = daatRouterInit;
window.DAAT_ROUTES    = DAAT_ROUTES;

// Auto-init após DOM ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(daatRouterInit, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(daatRouterInit, 100));
}
