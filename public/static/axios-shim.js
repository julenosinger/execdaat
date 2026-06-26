// ============================================================
// AXIOS-SHIM.JS — Drop-in axios replacement using fetch()
// ExecDaat · Arc Testnet · Build: 20260328a
//
// Replaces ALL axios.get / axios.post / axios.put / axios.delete
// calls project-wide with native fetch().
//
// Mimics the axios response shape:  { data, status, headers }
// Throws on non-2xx just like axios does.
// ============================================================
(function (global) {
  'use strict';

  // Already loaded — bail out to avoid double-definition
  if (global._axiosShimLoaded) return;
  global._axiosShimLoaded = true;

  // ── Core request function ───────────────────────────────────────────────────
  async function _request(method, url, payload, config) {
    config = config || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});

    // Build query string for GET requests with a `params` object
    var finalUrl = url;
    if (config.params && typeof config.params === 'object') {
      var qs = Object.keys(config.params)
        .filter(function (k) { return config.params[k] !== undefined && config.params[k] !== null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(config.params[k]); })
        .join('&');
      if (qs) finalUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    }

    var fetchOptions = {
      method: method,
      headers: headers,
    };

    if (payload !== undefined && method !== 'GET' && method !== 'DELETE') {
      fetchOptions.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }
    // DELETE with body (rare but happens in settings.js)
    if (payload !== undefined && method === 'DELETE') {
      fetchOptions.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }

    var response;
    try {
      response = await fetch(finalUrl, fetchOptions);
    } catch (networkErr) {
      // Network-level failure (offline, CORS block, etc.)
      console.error('[axios-shim] Network error ' + method + ' ' + url + ':', networkErr.message);
      var netError = new Error('Network Error: ' + networkErr.message);
      netError.isAxiosError = true;
      netError.config = { url: finalUrl, method: method };
      throw netError;
    }

    // Parse response body
    var responseData;
    var contentType = response.headers.get('content-type') || '';
    try {
      if (contentType.indexOf('application/json') >= 0) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }
    } catch (parseErr) {
      responseData = null;
    }

    // Build axios-compatible response object
    var axiosResponse = {
      data:       responseData,
      status:     response.status,
      statusText: response.statusText,
      headers:    {},
      config:     { url: finalUrl, method: method },
      request:    response,
    };

    // Copy headers into plain object
    if (response.headers && response.headers.forEach) {
      response.headers.forEach(function (val, key) {
        axiosResponse.headers[key] = val;
      });
    }

    // Axios throws for non-2xx — replicate that behaviour
    if (!response.ok) {
      console.warn('[axios-shim] ' + method + ' ' + url + ' → ' + response.status);
      var httpError = new Error('Request failed with status code ' + response.status);
      httpError.isAxiosError  = true;
      httpError.response      = axiosResponse;
      httpError.config        = axiosResponse.config;
      throw httpError;
    }

    console.debug('[axios-shim] ' + method + ' ' + url + ' → ' + response.status);
    return axiosResponse;
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  var axiosInstance = {
    get:    function (url, config)           { return _request('GET',    url, undefined, config); },
    post:   function (url, data, config)     { return _request('POST',   url, data,      config); },
    put:    function (url, data, config)     { return _request('PUT',    url, data,      config); },
    patch:  function (url, data, config)     { return _request('PATCH',  url, data,      config); },
    delete: function (url, config)           { return _request('DELETE', url, undefined, config); },
    head:   function (url, config)           { return _request('HEAD',   url, undefined, config); },

    // axios(config) call style
    request: function (config) {
      return _request(
        (config.method || 'GET').toUpperCase(),
        config.url,
        config.data,
        config
      );
    },

    // axios.create() — returns same instance (simplified)
    create: function (defaults) {
      defaults = defaults || {};
      var instance = Object.assign({}, axiosInstance);
      // Pre-apply baseURL if provided
      var origRequest = instance.request.bind(instance);
      instance._defaults = defaults;
      ['get','post','put','patch','delete','head'].forEach(function (m) {
        var orig = instance[m].bind(instance);
        instance[m] = function (url) {
          var fullUrl = (defaults.baseURL || '') + url;
          var args = Array.prototype.slice.call(arguments);
          args[0] = fullUrl;
          return orig.apply(null, args);
        };
      });
      return instance;
    },

    // Axios utility helpers used in some files
    isAxiosError: function (err) { return !!(err && err.isAxiosError); },
    all:          function (promises) { return Promise.all(promises); },
    spread:       function (callback) { return function (arr) { return callback.apply(null, arr); }; },

    // Interceptors stub (no-op — avoids crashes in files that set them up)
    interceptors: {
      request:  { use: function () {}, eject: function () {} },
      response: { use: function () {}, eject: function () {} },
    },

    defaults: {
      headers: {
        common: {},
        post:   { 'Content-Type': 'application/json' },
      },
    },
  };

  // Make the instance callable as axios(config)
  // We use a function so typeof axios === 'function' stays true
  var axisFn = function (configOrUrl, config) {
    if (typeof configOrUrl === 'string') {
      return axiosInstance.request(Object.assign({ url: configOrUrl }, config || {}));
    }
    return axiosInstance.request(configOrUrl);
  };
  // Copy all methods onto the function
  Object.assign(axisFn, axiosInstance);

  // ── Inject globally ──────────────────────────────────────────────────────────
  // Only overwrite if axios is NOT already defined (i.e. the CDN didn't load)
  if (typeof global.axios === 'undefined') {
    global.axios = axisFn;
    console.info('[axios-shim] Installed — axios CDN not detected, using fetch() shim');
  } else {
    console.info('[axios-shim] Skipped — real axios already present');
  }

})(window);
