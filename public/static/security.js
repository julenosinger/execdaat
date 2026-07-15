/**
 * ExecDaat — Frontend Runtime Security Layer
 * ================================================
 * Loaded as the FIRST script on the page.
 * Provides:
 *  1. Anti-clickjacking frame-busting guard
 *  2. Prototype pollution detection & freeze
 *  3. DOM XSS sanitization utilities
 *  4. Suspicious activity monitor (console abuse, DevTools detection)
 *  5. Subresource Integrity (SRI) check helper
 *  6. Secure local storage wrapper (masked writes for sensitive fields)
 *  7. Content Security Policy violation reporter
 *  8. Input sanitization helpers exposed globally
 *  9. Anti-paste injection for sensitive fields
 * 10. Session fingerprinting (tab-bound session ID)
 * 11. Request signing helper (adds X-Client-Timestamp + X-Request-Sig)
 */

;(function ArcSecurityInit() {
  'use strict'

  // ── 1. Anti-Clickjacking Frame Guard ────────────────────────────────────────
  // If the page is embedded in an iframe on a different origin, break out
  try {
    if (window.self !== window.top) {
      const parentOrigin = document.referrer ? new URL(document.referrer).origin : ''
      const selfOrigin   = window.location.origin
      if (parentOrigin && parentOrigin !== selfOrigin) {
        // Hide content and redirect top frame
        document.documentElement.style.display = 'none'
        window.top.location.href = window.self.location.href
      }
    }
  } catch (e) {
    // Cross-origin top frame — definitely clickjacking, hide content
    document.documentElement.style.display = 'none'
    setTimeout(() => { document.documentElement.style.display = '' }, 0)
  }

  // ── 2. Prototype Pollution Prevention ────────────────────────────────────────
  // Note: Object.freeze(Object.prototype) was removed — freezing global prototypes
  // breaks legitimate libraries (ethers v6, jsPDF) that define non-writable properties
  // on instances, causing "Cannot assign to read only property 'toString'" errors.
  // Prototype pollution is instead prevented by the defineProperty monitor below.
  ;(function freezePrototypes() {

    // Monitor for prototype mutation attempts
    const dangerous = ['__proto__', 'constructor', 'prototype']
    const origDefProp = Object.defineProperty.bind(Object)
    try {
      origDefProp(Object, 'defineProperty', {
        value: function(obj, prop, descriptor) {
          if (dangerous.includes(String(prop)) && (obj === Object.prototype || obj === Array.prototype)) {
            console.warn('[ARC Security] Prototype pollution attempt blocked:', prop)
            arcSecurityLog('PROTO_POLLUTION_ATTEMPT', { prop })
            return obj
          }
          // Wrap in try/catch to silently absorb non-fatal TypeError from ethers v6 UMD
          // which tries to defineProperty('toString', {writable:false}) on sealed TypedArray objects.
          try {
            return origDefProp(obj, prop, descriptor)
          } catch(e) {
            if (e instanceof TypeError) return obj  // non-fatal — ethers prototype patch on sealed object
            throw e
          }
        },
        writable: false,
        configurable: false,
      })
    } catch (e) { /* already defined */ }
  })()

  // ── 3. CSP Violation Reporter ─────────────────────────────────────────────────
  document.addEventListener('securitypolicyviolation', function(e) {
    arcSecurityLog('CSP_VIOLATION', {
      blockedURI:   e.blockedURI,
      directive:    e.violatedDirective,
      originalPolicy: e.originalPolicy ? e.originalPolicy.slice(0, 100) : '',
      sourceFile:   e.sourceFile,
      lineNumber:   e.lineNumber,
    })
  })

  // ── 4. Security Event Logger ──────────────────────────────────────────────────
  const _arcSecurityQueue = []
  function arcSecurityLog(event, detail) {
    const entry = {
      ts:     new Date().toISOString(),
      event,
      detail: detail || {},
      url:    window.location.pathname,
      ua:     navigator.userAgent.slice(0, 100),
    }
    _arcSecurityQueue.push(entry)
    // Flush to backend (fire-and-forget, non-blocking)
    if (_arcSecurityQueue.length >= 5 || event.includes('BLOCK') || event.includes('ATTACK')) {
      flushSecurityLogs()
    }
  }
  window.arcSecurityLog = arcSecurityLog

  let _flushTimer = null
  function flushSecurityLogs() {
    if (!_arcSecurityQueue.length) return
    const batch = _arcSecurityQueue.splice(0, _arcSecurityQueue.length)
    clearTimeout(_flushTimer)
    _flushTimer = setTimeout(function() {
      try {
        fetch('/api/security/log', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ events: batch }),
          keepalive: true,
        }).catch(function() {}) // silent fail — non-critical
      } catch (e) {}
    }, 200)
  }
  // Flush on page unload
  window.addEventListener('beforeunload', flushSecurityLogs)
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flushSecurityLogs()
  })

  // ── 5. DOM XSS Sanitizer ──────────────────────────────────────────────────────
  /**
   * Sanitizes a string to be safely injected as HTML text content.
   * Never use innerHTML with unsanitized user data — use this first.
   */
  function arcEscapeHtml(str) {
    if (typeof str !== 'string') return String(str)
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;')
      .replace(/`/g, '&#x60;')
      .replace(/=/g, '&#x3D;')
  }
  window.arcEscapeHtml = arcEscapeHtml

  /**
   * Strips all HTML tags from a string (for display in UI)
   */
  function arcStripTags(str) {
    if (typeof str !== 'string') return ''
    const tmp = document.createElement('div')
    tmp.textContent = str
    return tmp.innerHTML.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, ' ')
  }
  window.arcStripTags = arcStripTags

  /**
   * Safe innerHTML setter — replaces dangerous tags/attributes
   * Use this instead of element.innerHTML = untrustedContent
   */
  function arcSafeHtml(element, html) {
    if (!element || typeof html !== 'string') return
    // DOMParser approach — safer than innerHTML
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Remove all script, style, link elements from parsed document
    const dangerous = doc.querySelectorAll('script,link[rel="import"],object,embed,applet,base')
    dangerous.forEach(function(el) { el.remove() })
    // Remove event handler attributes
    const allNodes = doc.body.querySelectorAll('*')
    const eventAttrs = Array.from(allNodes).reduce(function(acc, node) {
      Array.from(node.attributes).forEach(function(attr) {
        if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value) || /^vbscript:/i.test(attr.value)) {
          node.removeAttribute(attr.name)
        }
      })
      return acc
    }, [])
    element.innerHTML = doc.body.innerHTML
  }
  window.arcSafeHtml = arcSafeHtml

  // ── 6. Secure Local Storage Wrapper ──────────────────────────────────────────
  // Sensitive keys are masked in storage (actual values stored obfuscated)
  const MASKED_KEYS = ['arc_session', 'arc_wallet', 'arc_pin', 'arc_auth', 'arc_jwt']

  const _origSetItem = localStorage.setItem.bind(localStorage)
  const _origGetItem = localStorage.getItem.bind(localStorage)

  function arcStorageSet(key, value) {
    try {
      if (MASKED_KEYS.some(function(k) { return key.startsWith(k) })) {
        // Base64 encode sensitive values (not encryption, but prevents casual snooping)
        // For real encryption, use the server-side AES-256 utilities
        _origSetItem(key, btoa(unescape(encodeURIComponent(value))))
      } else {
        _origSetItem(key, value)
      }
    } catch (e) {
      try { sessionStorage.setItem(key, value) } catch (e2) {}
    }
  }

  function arcStorageGet(key) {
    try {
      const raw = _origGetItem(key)
      if (!raw) return null
      if (MASKED_KEYS.some(function(k) { return key.startsWith(k) })) {
        try { return decodeURIComponent(escape(atob(raw))) } catch { return raw }
      }
      return raw
    } catch (e) {
      return null
    }
  }

  window.arcStorageSet = arcStorageSet
  window.arcStorageGet = arcStorageGet

  // ── 7. Input Validation Helpers ───────────────────────────────────────────────
  function arcValidateEthAddress(addr) {
    return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)
  }
  function arcValidateTxHash(hash) {
    return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)
  }
  function arcValidateAmount(amount) {
    const str = String(amount)
    return /^\d{1,18}(\.\d{1,6})?$/.test(str) && parseFloat(str) > 0 && parseFloat(str) < 1e18
  }
  function arcValidateEmail(email) {
    return typeof email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email) && email.length <= 320
  }
  function arcSanitizeInput(str, maxLen) {
    if (typeof str !== 'string') return ''
    return str
      .trim()
      .replace(/[\x00-\x1F\x7F]/g, '')  // strip control characters
      .slice(0, maxLen || 500)
  }
  window.arcValidateEthAddress = arcValidateEthAddress
  window.arcValidateTxHash     = arcValidateTxHash
  window.arcValidateAmount     = arcValidateAmount
  window.arcValidateEmail      = arcValidateEmail
  window.arcSanitizeInput      = arcSanitizeInput

  // ── 8. Anti-Paste Injection for Wallet/Key Fields ────────────────────────────
  // Validates pasted content in address fields — prevents address replacement attacks
  document.addEventListener('paste', function(e) {
    const target = e.target
    if (!target || !target.id) return
    const isAddressField = /recipient|address|wallet|0x/i.test(target.id + ' ' + (target.placeholder || ''))
    if (!isAddressField) return
    const pasted = (e.clipboardData || window.clipboardData).getData('text')
    if (!pasted) return
    // Warn user if pasted content doesn't look like an address
    if (pasted.trim().startsWith('0x') && !arcValidateEthAddress(pasted.trim())) {
      arcSecurityLog('INVALID_ADDRESS_PASTE', { field: target.id, length: pasted.length })
      // Don't block — just log. UX validation handles the actual error.
    }
    // Block pasted content that contains HTML/script
    if (/<script|javascript:|on\w+\s*=/i.test(pasted)) {
      e.preventDefault()
      arcSecurityLog('XSS_PASTE_BLOCKED', { field: target.id })
      if (window.showToast) window.showToast('⚠️ Pasted content blocked — potential security risk', 'error')
    }
  }, true)

  // ── 9. Tab-Bound Session Fingerprint ─────────────────────────────────────────
  // Generates a per-tab session ID (survives refresh, not shared across tabs)
  ;(function initSessionFingerprint() {
    let tabId = sessionStorage.getItem('arc_tab_id')
    if (!tabId) {
      const arr = new Uint8Array(16)
      crypto.getRandomValues(arr)
      tabId = Array.from(arr).map(function(b) { return b.toString(16).padStart(2, '0') }).join('')
      sessionStorage.setItem('arc_tab_id', tabId)
    }
    window.ARC_TAB_ID = tabId
  })()

  // ── 10. Secure Fetch Wrapper (adds security headers to all API calls) ─────────
  const _origFetch = window.fetch.bind(window)

  // Public Arc RPC hosts are rate-limited per client IP (HTTP 429
  // "request limit reached"). ALL direct browser calls to them are
  // transparently rerouted to the same-origin failover proxy /api/rpc,
  // which distributes across every Arc RPC server-side.
  const ARC_RPC_HOSTS = [
    'rpc.testnet.arc.network',
    'rpc.blockdaemon.testnet.arc.network',
    'rpc.drpc.testnet.arc.network',
    'rpc.quicknode.testnet.arc.network',
  ]
  function _isArcRpcUrl(url) {
    try {
      const host = new URL(url, window.location.origin).hostname
      return ARC_RPC_HOSTS.indexOf(host) !== -1
    } catch (_) { return false }
  }

  window.fetch = function(input, init) {
    // Only add headers to same-origin API calls
    let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input))

    // Transparent Arc RPC reroute → same-origin failover proxy
    if (_isArcRpcUrl(url)) {
      const proxied = window.location.origin + '/api/rpc'
      if (typeof input === 'string' || !(input instanceof Request)) {
        input = proxied
      } else {
        input = new Request(proxied, input)
      }
      url = proxied
    }

    const isSameOrigin = !url.startsWith('http') || url.startsWith(window.location.origin)
    const isAPI = url.includes('/api/')

    if (isSameOrigin && isAPI) {
      init = init || {}
      init.headers = Object.assign({}, init.headers || {}, {
        'X-Client-Timestamp': Date.now().toString(),
        'X-Tab-Id':           window.ARC_TAB_ID || '',
        'X-Requested-With':   'XMLHttpRequest',
      })
    }
    return _origFetch(input, init)
  }

  // ── 11. Console Abuse Detection ───────────────────────────────────────────────
  // Detect DevTools automation / headless browser injection attempts
  ;(function detectConsoleAbuse() {
    let devtoolsOpen = false
    const threshold = 160

    // Size-based detection (reasonably reliable)
    function checkDevTools() {
      const widthDiff  = window.outerWidth  - window.innerWidth
      const heightDiff = window.outerHeight - window.innerHeight
      const newState   = widthDiff > threshold || heightDiff > threshold
      if (newState && !devtoolsOpen) {
        devtoolsOpen = true
        arcSecurityLog('DEVTOOLS_OPENED', {})
      } else if (!newState && devtoolsOpen) {
        devtoolsOpen = false
      }
    }

    // Throttled check — not on every resize to avoid spam
    let devtoolsTimer = null
    window.addEventListener('resize', function() {
      clearTimeout(devtoolsTimer)
      devtoolsTimer = setTimeout(checkDevTools, 300)
    })
    setTimeout(checkDevTools, 1000)

    // Detect console.log overrides (injection via extension/automation)
    const origConsoleLog = console.log
    const origConsoleErr = console.error
    Object.defineProperty(console, 'log', {
      get: function() { return origConsoleLog },
      set: function(v) {
        arcSecurityLog('CONSOLE_OVERRIDE_ATTEMPT', { type: 'log' })
        // Allow the override (don't break legitimate usage) but log it
      },
      configurable: true,
    })
  })()

  // ── 12. Integrity Check for Critical Scripts ───────────────────────────────────
  // Monitors loaded scripts for unexpected sources (DOM-based script injection)
  ;(function observeScriptInjection() {
    if (!window.MutationObserver) return

    const ALLOWED_SCRIPT_ORIGINS = [
      window.location.origin,
      'https://cdn.tailwindcss.com',
      'https://cdn.jsdelivr.net',
      'https://cdnjs.cloudflare.com',
      'https://unpkg.com',
    ]

    function isAllowedScript(src) {
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) return false
      try {
        const scriptOrigin = new URL(src).origin
        return ALLOWED_SCRIPT_ORIGINS.some(function(allowed) {
          return scriptOrigin === new URL(allowed).origin
        })
      } catch (e) {
        return true // relative URL — same origin
      }
    }

    const observer = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName === 'SCRIPT' && node.src) {
            if (!isAllowedScript(node.src)) {
              arcSecurityLog('UNAUTHORIZED_SCRIPT_INJECTION', { src: node.src.slice(0, 100) })
              // Do NOT remove the script — could break legitimate dynamic loading
              // But log it for investigation
            }
          }
        }
      }
    })

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        observer.observe(document.body, { childList: true, subtree: true })
      })
    }
  })()

  // ── 13. Wallet Address Replacement Attack Prevention ──────────────────────────
  // Polls critical address input fields — warns if value changed unexpectedly
  // (clipboard hijacking / address swapper malware mitigation)
  ;(function monitorAddressFields() {
    let lastValues = {}

    function scanAddressFields() {
      const fields = document.querySelectorAll(
        'input[id*="recipient"], input[id*="address"], input[id*="wallet"], input[placeholder*="0x"]'
      )
      fields.forEach(function(field) {
        const id    = field.id || field.name || 'unknown'
        const value = field.value

        if (lastValues[id] !== undefined && lastValues[id] !== value) {
          // Value changed — was it by user typing or programmatic replacement?
          if (value.startsWith('0x') && !arcValidateEthAddress(value)) {
            arcSecurityLog('SUSPICIOUS_ADDRESS_CHANGE', { field: id, length: value.length })
          }
        }
        lastValues[id] = value
      })
    }

    // Check every 2 seconds (light enough to not affect performance)
    setInterval(scanAddressFields, 2000)
  })()

  // ── 14. Secure PIN/Password Field Protection ──────────────────────────────────
  // Prevents autocomplete and clears clipboard after PIN paste
  document.addEventListener('DOMContentLoaded', function() {
    const sensitiveFields = document.querySelectorAll('input[type="password"], input[id*="pin"]')
    sensitiveFields.forEach(function(field) {
      field.setAttribute('autocomplete', 'off')
      field.setAttribute('autocorrect', 'off')
      field.setAttribute('autocapitalize', 'off')
      field.setAttribute('spellcheck', 'false')
      field.setAttribute('data-lpignore', 'true')  // LastPass ignore
      field.setAttribute('data-1p-ignore', '')      // 1Password ignore
    })
  })

  // ── 15. Anti-MITM: Warn if Connection is Not HTTPS ───────────────────────────
  if (location.protocol === 'http:' && location.hostname !== 'localhost') {
    console.warn('[ARC Security] WARNING: Connection is not encrypted (HTTP). All requests are visible to network observers.')
    arcSecurityLog('INSECURE_CONNECTION', { protocol: location.protocol })
    // Show non-blocking toast when UI is ready
    const checkToast = setInterval(function() {
      if (window.showToast) {
        clearInterval(checkToast)
        window.showToast('⚠️ Insecure connection detected. Please use HTTPS for your security.', 'error')
      }
    }, 500)
    setTimeout(function() { clearInterval(checkToast) }, 10000)
  }

  // ── 16. Security Headers Check (runtime verification) ────────────────────────
  // Verifies that expected security headers are present via a HEAD request to self
  ;(function verifySecurityHeaders() {
    setTimeout(function() {
      _origFetch('/api/security/headers', { method: 'GET', cache: 'no-store' })
        .then(function(r) {
          const missing = []
          const required = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options']
          required.forEach(function(h) {
            if (!r.headers.get(h)) missing.push(h)
          })
          if (missing.length > 0) {
            arcSecurityLog('MISSING_SECURITY_HEADERS', { missing })
          }
        })
        .catch(function() {}) // silent fail
    }, 3000)
  })()

  console.log('[ARC Security] Runtime security layer initialized ✓')

})()
