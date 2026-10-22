const SUB2_API_TOKEN_DEFAULTS = {
  profilePath: '/v1/usage',
  balancePath: 'remaining',
  formula: 'x * 7.2',
  rawUnit: 'USD',
};

const SUB2_SESSION_DEFAULTS = {
  profilePath: '/api/v1/auth/me',
  balancePath: 'data.balance',
  formula: 'x',
  rawUnit: 'CNY',
};
const MAX_SESSION_FILE_BYTES = 256 * 1024;

function tokenValue(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  // Access/refresh tokens are opaque strings; bounding them prevents a
  // malformed import from turning into an oversized API request.
  return token.length <= 4096 ? token : '';
}

export function parseSub2ApiSession(raw) {
  if (typeof raw === 'string' && raw.length > MAX_SESSION_FILE_BYTES) {
    throw new Error('登录态文件不能超过 256 KiB');
  }
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('文件不是有效的 JSON');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件内容格式不正确');
  }
  if (data.schema_version !== 1 || data.type !== 'sub2api_session_tokens') {
    throw new Error('不是受支持的 Sub2API 登录态文件');
  }
  if (String(data.platform || '').trim().toLowerCase() !== 'sub2api') {
    throw new Error('文件平台必须是 Sub2API');
  }

  const originValue = typeof data.origin === 'string' ? data.origin.trim() : '';
  let originUrl;
  try {
    originUrl = new URL(originValue);
  } catch {
    throw new Error('文件中的上游地址无效');
  }
  if (
    !['http:', 'https:'].includes(originUrl.protocol)
    || originUrl.username
    || originUrl.password
    || originUrl.pathname !== '/'
    || originUrl.search
    || originUrl.hash
  ) {
    throw new Error('文件中的 origin 必须是完整的 HTTP(S) 站点地址');
  }

  const credentials = data.credentials && typeof data.credentials === 'object' && !Array.isArray(data.credentials)
    ? data.credentials
    : {};
  const accessToken = tokenValue(credentials.access_token);
  const refreshToken = tokenValue(credentials.refresh_token);
  if (!accessToken && !refreshToken) {
    throw new Error('文件中没有 Access Token 或 Refresh Token');
  }

  return {
    schemaVersion: 1,
    type: data.type,
    platform: 'sub2api',
    origin: originUrl.origin,
    accessToken,
    refreshToken,
    observedFrom: {
      source: tokenValue(data.observed_from?.source),
      endpoint: tokenValue(data.observed_from?.endpoint),
    },
  };
}

export function applySub2ApiSession(form, session, fileName) {
  return {
    ...form,
    baseUrl: session.origin,
    token: '',
    sub2AuthMode: 'session',
    browserLogin: null,
    importedSession: { ...session, fileName },
  };
}

export function buildQuickAccountPayload(form) {
  const isSub2 = form.type === 'sub2api';
  const importedSession = isSub2 ? form.importedSession : null;
  const sub2AuthMode = importedSession ? 'session' : form.sub2AuthMode || 'api_token';
  const usesAccountSession = isSub2 && ['session', 'browser'].includes(sub2AuthMode);
  const sub2Defaults = usesAccountSession ? SUB2_SESSION_DEFAULTS : SUB2_API_TOKEN_DEFAULTS;
  let credentials;

  if (isSub2 && importedSession) {
    credentials = {
      ...(importedSession.accessToken ? { accessToken: importedSession.accessToken } : {}),
      ...(importedSession.refreshToken ? { refreshToken: importedSession.refreshToken } : {}),
    };
  } else if (isSub2 && sub2AuthMode === 'browser') {
    credentials = undefined;
  } else if (isSub2) {
    credentials = { apiToken: form.token.trim(), apiTokens: [form.token.trim()] };
  } else {
    credentials = { accessToken: form.token.trim() };
  }

  return {
    upstreamId: form.upstreamId,
    upstreamName: form.upstreamName.trim(),
    name: form.name.trim(),
    type: form.type,
    baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
    region: '默认分组',
    subgroup: isSub2 ? 'Sub2API' : 'New API',
    authMode: isSub2
      ? (usesAccountSession ? 'access_token' : 'api_token')
      : 'access_token',
    tokenStrategy: 'sticky',
    username: '',
    browserLoginId: isSub2 && sub2AuthMode === 'browser' ? form.browserLogin?.id : undefined,
    userId: isSub2 ? '' : form.userId.trim(),
    profilePath: isSub2 ? sub2Defaults.profilePath : '/api/user/self',
    balancePath: isSub2 ? sub2Defaults.balancePath : 'data.quota',
    formula: isSub2 ? sub2Defaults.formula : 'x / 500000 * 1',
    rawUnit: isSub2 ? sub2Defaults.rawUnit : 'quota',
    thresholdLow: 3,
    thresholdRecover: 5,
    pollIntervalMinutes: 5,
    enabled: true,
    notifications: { resend: true, feishu: true, telegram: true, wecom: true },
    credentials,
  };
}
