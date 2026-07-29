// ==UserScript==
// @name         Sub2API AT/RT Capture
// @namespace    zzzjiankong.local
// @version      1.1.0
// @description  Capture Sub2API access/refresh tokens locally from login, refresh, and browser storage.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const AUTH_ENDPOINT = /\/api\/v1\/auth\/(login|refresh)(?:[/?#]|$)/i;
  const ACCESS_KEYS = new Set(['accesstoken', 'authtoken', 'access', 'jwt']);
  const REFRESH_KEYS = new Set(['refreshtoken', 'refresh']);
  const capture = {
    accessToken: '',
    refreshToken: '',
    source: '',
    endpoint: '',
    capturedAt: '',
  };

  let ui = null;
  let revealTokens = false;
  let autoExported = false;
  let autoExportTimer = null;
  let lastExportAt = '';
  let refreshAttempted = false;
  let refreshBusy = false;
  let refreshError = '';

  function normalizedKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function normalizedToken(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/^Bearer\s+/i, '');
  }

  function extractTokens(value, options = {}, result = {}, depth = 0, seen = new WeakSet()) {
    if (depth > 10 || value == null) return result;

    if (typeof value === 'string') {
      const text = value.trim();
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2_000_000) {
        try {
          return extractTokens(JSON.parse(text), options, result, depth + 1, seen);
        } catch {
          return result;
        }
      }
      return result;
    }

    if (typeof value !== 'object' || seen.has(value)) return result;
    seen.add(value);

    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (typeof entry === 'string') {
        if (ACCESS_KEYS.has(normalized) || (options.allowGenericToken && normalized === 'token')) {
          result.accessToken = normalizedToken(entry);
        } else if (REFRESH_KEYS.has(normalized)) {
          result.refreshToken = normalizedToken(entry);
        }
      }
      extractTokens(entry, options, result, depth + 1, seen);
    }

    return result;
  }

  function commitTokens(tokens, details = {}) {
    if (!tokens.accessToken && !tokens.refreshToken) return;

    // A fresh login without an RT must not retain an RT from an older login.
    if (details.kind === 'login' && tokens.accessToken && !tokens.refreshToken) {
      capture.refreshToken = '';
    }
    capture.accessToken = tokens.accessToken || capture.accessToken;
    capture.refreshToken = tokens.refreshToken || capture.refreshToken;
    capture.source = details.source || capture.source;
    capture.endpoint = details.endpoint || capture.endpoint;
    capture.capturedAt = new Date().toISOString();

    ensureUi(true);
    renderUi();
    scheduleAutomaticExport();
    scheduleAccessTokenRefresh();
  }

  function inspectAuthPayload(endpoint, payload, source) {
    const match = String(endpoint || '').match(AUTH_ENDPOINT);
    if (!match) return;
    const tokens = extractTokens(payload, { allowGenericToken: true });
    commitTokens(tokens, {
      kind: match[1].toLowerCase(),
      source,
      endpoint: String(endpoint),
    });
  }

  function inspectStoredValue(storeName, key, rawValue) {
    const normalized = normalizedKey(key);
    const tokens = {};
    if (ACCESS_KEYS.has(normalized)) tokens.accessToken = normalizedToken(rawValue);
    if (REFRESH_KEYS.has(normalized)) tokens.refreshToken = normalizedToken(rawValue);
    extractTokens(rawValue, {}, tokens);
    commitTokens(tokens, { source: `${storeName}: ${key}` });
  }

  function scanBrowserStorage() {
    for (const [storeName, store] of [
      ['localStorage', window.localStorage],
      ['sessionStorage', window.sessionStorage],
    ]) {
      try {
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          if (key) inspectStoredValue(storeName, key, store.getItem(key));
        }
      } catch {
        // Some sandboxed pages deny storage access.
      }
    }

    try {
      for (const pair of document.cookie.split(';')) {
        const separator = pair.indexOf('=');
        if (separator < 0) continue;
        const key = decodeURIComponent(pair.slice(0, separator).trim());
        const value = decodeURIComponent(pair.slice(separator + 1).trim());
        inspectStoredValue('cookie', key, value);
      }
    } catch {
      // HttpOnly cookies are intentionally invisible to page scripts.
    }

    renderUi();
    scheduleAccessTokenRefresh();
  }

  async function refreshAccessToken() {
    if (refreshBusy || !capture.refreshToken || capture.accessToken) return false;
    refreshBusy = true;
    refreshAttempted = true;
    refreshError = '';
    renderUi();
    const endpoint = `${location.origin}/api/v1/auth/refresh`;
    try {
      const response = await window.fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: capture.refreshToken }),
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`刷新接口返回非 JSON (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(body.message || body.error || `刷新失败 (${response.status})`);
      }
      const tokens = extractTokens(body, { allowGenericToken: true });
      if (!tokens.accessToken) throw new Error('刷新成功，但响应中没有 Access Token');
      if (tokens.refreshToken && tokens.refreshToken !== capture.refreshToken) {
        try {
          window.localStorage.setItem('refresh_token', tokens.refreshToken);
        } catch {
          // The exported file still preserves the rotated token.
        }
      }
      commitTokens(tokens, { kind: 'refresh', source: 'browser same-origin refresh', endpoint });
      return true;
    } catch (error) {
      refreshError = String(error?.message || error || '刷新失败');
      ensureUi(true);
      renderUi();
      return false;
    } finally {
      refreshBusy = false;
      renderUi();
    }
  }

  function scheduleAccessTokenRefresh() {
    if (refreshAttempted || refreshBusy || capture.accessToken || !capture.refreshToken) return;
    window.setTimeout(refreshAccessToken, 500);
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch;

    window.fetch = async function patchedFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const endpoint = typeof input === 'string' ? input : input && input.url;
        if (AUTH_ENDPOINT.test(String(endpoint || ''))) {
          response
            .clone()
            .text()
            .then((body) => inspectAuthPayload(endpoint, body, 'fetch response'))
            .catch(() => {});
        }
      } catch {
        // Capture must never interfere with the site's request.
      }
      return response;
    };
  }

  function patchXhr() {
    if (typeof window.XMLHttpRequest !== 'function') return;
    const requestDetails = new WeakMap();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, endpoint, ...rest) {
      requestDetails.set(this, { method, endpoint: String(endpoint || '') });
      return nativeOpen.call(this, method, endpoint, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      const details = requestDetails.get(this);
      if (details && AUTH_ENDPOINT.test(details.endpoint)) {
        this.addEventListener(
          'load',
          () => {
            try {
              const payload = this.responseType === 'json' ? this.response : this.responseText;
              inspectAuthPayload(details.endpoint, payload, 'XHR response');
            } catch {
              // Ignore unreadable cross-origin response bodies.
            }
          },
          { once: true },
        );
      }
      return nativeSend.apply(this, args);
    };
  }

  function patchStorageWrites() {
    if (typeof window.Storage !== 'function') return;
    const nativeSetItem = Storage.prototype.setItem;

    Storage.prototype.setItem = function patchedSetItem(key, value) {
      const result = nativeSetItem.call(this, key, value);
      const storeName = this === window.localStorage ? 'localStorage' : 'sessionStorage';
      inspectStoredValue(storeName, key, value);
      return result;
    };
  }

  function masked(value) {
    if (!value) return '未发现';
    if (revealTokens) return value;
    if (value.length <= 12) return `${value.slice(0, 3)}...${value.slice(-2)} (${value.length})`;
    return `${value.slice(0, 7)}...${value.slice(-5)} (${value.length})`;
  }

  function tokenPayload() {
    return JSON.stringify(
      {
        schema_version: 1,
        type: 'sub2api_session_tokens',
        platform: 'sub2api',
        origin: location.origin,
        captured_at: capture.capturedAt || null,
        credentials: {
          access_token: capture.accessToken || null,
          refresh_token: capture.refreshToken || null,
        },
        observed_from: {
          source: capture.source || null,
          endpoint: capture.endpoint || null,
        },
      },
      null,
      2,
    );
  }

  function exportTokenFile(automatic = false) {
    if (!capture.accessToken && !capture.refreshToken) return false;
    const host = (location.hostname || 'sub2api').replace(/[^a-z0-9.-]/gi, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([tokenPayload()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sub2api-session-${host}-${timestamp}.json`;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);

    lastExportAt = new Date().toISOString();
    if (automatic) autoExported = true;
    renderUi();
    return true;
  }

  function scheduleAutomaticExport() {
    if (autoExported || !capture.accessToken || !capture.refreshToken) return;
    window.clearTimeout(autoExportTimer);
    autoExportTimer = window.setTimeout(() => exportTokenFile(true), 700);
  }

  function ensureUi(openPanel = false) {
    if (ui || !document.documentElement) {
      if (openPanel && ui) ui.panel.hidden = false;
      return;
    }

    const host = document.createElement('div');
    host.id = 'sub2api-token-capture-root';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .launcher {
          position: fixed; top: 14px; right: 14px; z-index: 2147483647;
          width: 42px; height: 42px; border: 1px solid #d8dadd; border-radius: 8px;
          color: #191a1c; background: #fff; box-shadow: 0 5px 20px rgba(0,0,0,.13);
          font: 700 13px/1 system-ui, sans-serif; cursor: pointer;
        }
        .launcher.found { color: #087443; border-color: #78d3ad; background: #effbf5; }
        .panel {
          position: fixed; top: 64px; right: 14px; z-index: 2147483647;
          width: min(390px, calc(100vw - 28px)); padding: 16px;
          border: 1px solid #d8dadd; border-radius: 8px; color: #202124; background: #fff;
          box-shadow: 0 14px 42px rgba(0,0,0,.18); font: 13px/1.45 system-ui, sans-serif;
        }
        .panel[hidden] { display: none; }
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .title { font-size: 15px; font-weight: 700; }
        .close { border: 0; padding: 4px 7px; color: #62666c; background: transparent; cursor: pointer; }
        .status { margin-bottom: 12px; color: #62666c; }
        .status.ok { color: #087443; }
        .token { margin: 7px 0; padding: 9px 10px; border: 1px solid #e2e3e5; border-radius: 6px; background: #f7f7f8; }
        .label { display: block; margin-bottom: 3px; color: #72767c; font-size: 11px; }
        .value { display: block; overflow-wrap: anywhere; color: #202124; font: 12px/1.4 ui-monospace, monospace; }
        .meta { margin: 10px 0; color: #72767c; font-size: 11px; overflow-wrap: anywhere; }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
        .action { min-height: 35px; border: 1px solid #d8dadd; border-radius: 6px; color: #292b2e; background: #fff; cursor: pointer; }
        .action.primary { color: #fff; border-color: #202124; background: #202124; }
        .action:disabled { opacity: .45; cursor: default; }
        .hint { margin: 11px 0 0; color: #85898f; font-size: 11px; }
      </style>
      <button class="launcher" type="button" title="Sub2API AT/RT 捕获器">S2</button>
      <section class="panel" hidden>
        <div class="head"><span class="title">Sub2API 登录态</span><button class="close" type="button">关闭</button></div>
        <div class="status">尚未发现 AT/RT</div>
        <div class="token"><span class="label">Access Token</span><span class="value access">未发现</span></div>
        <div class="token"><span class="label">Refresh Token</span><span class="value refresh">未发现</span></div>
        <div class="meta"></div>
        <div class="actions">
          <button class="action scan" type="button">重新扫描</button>
          <button class="action refresh" type="button">用 RT 补全 AT</button>
          <button class="action reveal" type="button">显示原文</button>
          <button class="action primary export" type="button" disabled>导出文件</button>
        </div>
        <p class="hint">AT + RT 齐全后自动下载一次；文件仅保存在浏览器下载目录。</p>
      </section>
    `;

    document.documentElement.appendChild(host);
    ui = {
      host,
      launcher: shadow.querySelector('.launcher'),
      panel: shadow.querySelector('.panel'),
      status: shadow.querySelector('.status'),
      access: shadow.querySelector('.access'),
      refresh: shadow.querySelector('.refresh'),
      meta: shadow.querySelector('.meta'),
      reveal: shadow.querySelector('.reveal'),
      refresh: shadow.querySelector('.refresh'),
      export: shadow.querySelector('.export'),
    };

    ui.launcher.addEventListener('click', () => {
      ui.panel.hidden = !ui.panel.hidden;
      if (!ui.panel.hidden) scanBrowserStorage();
    });
    shadow.querySelector('.close').addEventListener('click', () => {
      ui.panel.hidden = true;
    });
    shadow.querySelector('.scan').addEventListener('click', scanBrowserStorage);
    ui.refresh.addEventListener('click', () => {
      refreshAttempted = false;
      refreshAccessToken();
    });
    ui.reveal.addEventListener('click', () => {
      revealTokens = !revealTokens;
      renderUi();
    });
    ui.export.addEventListener('click', () => {
      const exported = exportTokenFile(false);
      ui.export.textContent = exported ? '已下载' : '导出失败';
      window.setTimeout(() => {
        if (ui) ui.export.textContent = '导出文件';
      }, 1400);
    });

    if (openPanel) ui.panel.hidden = false;
    renderUi();
  }

  function renderUi() {
    if (!ui) return;
    const found = Boolean(capture.accessToken || capture.refreshToken);
    ui.launcher.classList.toggle('found', found);
    ui.status.classList.toggle('ok', found);
    ui.status.textContent = refreshBusy
      ? '正在当前浏览器中用 RT 补全 AT...'
      : refreshError
        ? `补全失败：${refreshError}`
        : found
          ? `已捕获${capture.accessToken ? ' AT' : ''}${capture.refreshToken ? ' + RT' : ''}`
          : '尚未发现 AT/RT';
    ui.access.textContent = masked(capture.accessToken);
    ui.refresh.textContent = masked(capture.refreshToken);
    ui.meta.textContent = capture.source
      ? `${location.origin} · ${capture.source} · ${new Date(capture.capturedAt).toLocaleString()}${lastExportAt ? ' · 已下载' : ''}`
      : location.origin;
    ui.reveal.textContent = revealTokens ? '隐藏原文' : '显示原文';
    ui.refresh.disabled = refreshBusy || !capture.refreshToken || Boolean(capture.accessToken);
    ui.export.disabled = !found;
  }

  patchFetch();
  patchXhr();
  patchStorageWrites();

  const initialize = () => {
    ensureUi(false);
    scanBrowserStorage();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
