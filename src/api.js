async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  session: () => request('/api/session'),
  setupAdmin: (payload) => request('/api/session/setup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => request('/api/session/login', { method: 'POST', body: JSON.stringify(payload) }),
  verifyTwoFactor: (payload) => request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/api/session/logout', { method: 'POST' }),
  security: () => request('/api/security'),
  updateSecurityProfile: (payload) => request('/api/security/profile', { method: 'PATCH', body: JSON.stringify(payload) }),
  setupTwoFactor: () => request('/api/security/2fa/setup', { method: 'POST' }),
  enableTwoFactor: (code) => request('/api/security/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  regenerateRecoveryCodes: (payload) => request('/api/security/2fa/recovery-codes', { method: 'POST', body: JSON.stringify(payload) }),
  disableTwoFactor: (payload) => request('/api/security/2fa', { method: 'DELETE', body: JSON.stringify(payload) }),
  dashboard: () => request('/api/dashboard'),
  createUpstream: (payload) => request('/api/upstreams', { method: 'POST', body: JSON.stringify(payload) }),
  updateUpstream: (id, payload) => request(`/api/upstreams/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteUpstream: (id) => request(`/api/upstreams/${id}`, { method: 'DELETE' }),
  reassignUpstreamProxy: (id) => request(`/api/upstreams/${id}/proxy/reassign`, { method: 'POST' }),
  proxyPool: () => request('/api/proxy-pool'),
  importProxySubscription: (url) => request('/api/proxy-pool/subscription', { method: 'PUT', body: JSON.stringify({ url }) }),
  refreshProxySubscription: () => request('/api/proxy-pool/refresh', { method: 'POST' }),
  checkProxyPool: () => request('/api/proxy-pool/check', { method: 'POST' }),
  startUpstreamLogin: (payload) => request('/api/upstream-logins', { method: 'POST', body: JSON.stringify(payload) }),
  upstreamLogin: (id) => request(`/api/upstream-logins/${id}`),
  cancelUpstreamLogin: (id) => request(`/api/upstream-logins/${id}`, { method: 'DELETE' }),
  createAccount: (payload) => request('/api/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  updateAccount: (id, payload) => request(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  moveAccount: (id, upstreamId) => request(`/api/accounts/${id}/upstream`, { method: 'PATCH', body: JSON.stringify({ upstreamId }) }),
  deleteAccount: (id) => request(`/api/accounts/${id}`, { method: 'DELETE' }),
  testAccount: (payload) => request('/api/accounts/test', { method: 'POST', body: JSON.stringify(payload) }),
  refreshAccount: (id) => request(`/api/accounts/${id}/refresh`, { method: 'POST' }),
  accountKeyDetails: (id) => request(`/api/accounts/${id}/api-keys`),
  openAccountUpstream: (id) => request(`/api/accounts/${id}/open-upstream`, { method: 'POST' }),
  simulateRecharge: (id) => request(`/api/accounts/${id}/simulate-recharge`, { method: 'POST' }),
  testFormula: (rawValue, formula) => request('/api/formulas/test', { method: 'POST', body: JSON.stringify({ rawValue, formula }) }),
  acknowledge: (id) => request(`/api/incidents/${id}/acknowledge`, { method: 'POST' }),
  saveSettings: (payload) => request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  testNotification: (channel, settings) => request('/api/settings/test-notification', { method: 'POST', body: JSON.stringify({ channel, settings }) }),
};
