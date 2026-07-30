import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { verifySessionToken } from './security.js';

const TICKET_TTL_MS = 60_000;
const MAX_PENDING_TICKETS = 1024;
const sockets = new Set();
const pendingTickets = new Map();

function appOrigin() {
  return new URL(config.appOrigin).origin;
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(body) {
  return crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
}

function sameText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pruneTickets(now = Date.now()) {
  for (const [key, value] of pendingTickets) if (value.exp <= now) pendingTickets.delete(key);
}

function ticketKey(jti) {
  return crypto.createHash('sha256').update(jti).digest('base64url');
}

export function issueBrowserTicket(auth, origin = appOrigin()) {
  pruneTickets();
  const normalizedOrigin = new URL(origin).origin;
  const jti = crypto.randomBytes(32).toString('base64url');
  const payload = {
    jti,
    username: auth.usernameCanonical || auth.username,
    version: Number(auth.sessionVersion || 1),
    origin: normalizedOrigin,
    exp: Date.now() + TICKET_TTL_MS,
  };
  const body = encode(JSON.stringify(payload));
  pendingTickets.set(ticketKey(jti), payload);
  while (pendingTickets.size > MAX_PENDING_TICKETS) {
    const oldest = pendingTickets.keys().next().value;
    if (!oldest) break;
    pendingTickets.delete(oldest);
  }
  return `${body}.${signature(body)}`;
}

function consumeBrowserTicket(token, auth, origin) {
  const [body, provided] = String(token || '').split('.');
  if (!body || !provided || !sameText(signature(body), provided)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  pruneTickets();
  const pending = pendingTickets.get(ticketKey(payload.jti));
  if (!pending || Number(payload.exp) <= Date.now()) return false;
  if (payload.origin !== origin || pending.origin !== origin) return false;
  if (payload.username !== (auth.usernameCanonical || auth.username)) return false;
  if (Number(payload.version) !== Number(auth.sessionVersion || 1)) return false;
  pendingTickets.delete(ticketKey(payload.jti));
  return true;
}

function cookies(request) {
  const header = String(request.headers.cookie || '');
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=')));
}

function reject(socket, status = 403, message = 'Forbidden') {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function closeBrowserConnections(username = '') {
  for (const connection of sockets) {
    if (!username || connection.username === username) {
      clearTimeout(connection.timer);
      connection.client.terminate();
      connection.upstream.terminate();
      sockets.delete(connection);
    }
  }
}

export function attachBrowserGateway(server, store) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, config.appOrigin);
    } catch {
      reject(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/browser/websockify') {
      reject(socket, 404, 'Not Found');
      return;
    }
    const origin = String(request.headers.origin || '');
    const trustedOrigin = appOrigin();
    if (!origin || !sameText(origin, trustedOrigin)) {
      reject(socket, 403);
      return;
    }
    const auth = store.snapshot().auth;
    const token = cookies(request).frosted_session;
    const authenticated = config.authDisabled || verifySessionToken(token, auth);
    if (!authenticated) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    if (sockets.size >= config.browserGatewayMaxConnections) {
      reject(socket, 429, 'Too Many Requests');
      return;
    }
    if (!consumeBrowserTicket(url.searchParams.get('ticket'), auth, trustedOrigin)) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket('ws://127.0.0.1:6080/websockify', request.headers['sec-websocket-protocol'] || undefined);
      const pendingMessages = [];
      let pendingBytes = 0;
      const connection = {
        client,
        upstream,
        username: auth.usernameCanonical || auth.username,
        timer: setTimeout(() => {
          client.close(1000, 'desktop session expired');
          upstream.close(1000, 'desktop session expired');
        }, 15 * 60_000),
        idleTimer: null,
      };
      connection.timer.unref?.();
      const refreshIdleTimer = () => {
        clearTimeout(connection.idleTimer);
        connection.idleTimer = setTimeout(() => {
          client.close(1000, 'desktop session idle');
          upstream.close(1000, 'desktop session idle');
        }, config.browserGatewayIdleTtlMs);
        connection.idleTimer.unref?.();
      };
      refreshIdleTimer();
      sockets.add(connection);
      const close = () => {
        clearTimeout(connection.timer);
        clearTimeout(connection.idleTimer);
        sockets.delete(connection);
        pendingMessages.length = 0;
        pendingBytes = 0;
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
        if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      };
      client.on('message', (data, isBinary) => {
        refreshIdleTimer();
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
          return;
        }
        pendingBytes += data.length;
        if (pendingBytes > 2 * 1024 * 1024) {
          close();
          return;
        }
        pendingMessages.push({ data, isBinary });
      });
      upstream.on('open', () => {
        for (const message of pendingMessages) upstream.send(message.data, { binary: message.isBinary });
        pendingMessages.length = 0;
        pendingBytes = 0;
      });
      upstream.on('message', (data, isBinary) => {
        refreshIdleTimer();
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on('close', close);
      upstream.on('close', close);
      client.on('error', close);
      upstream.on('error', close);
    });
  });
  return { close: () => closeBrowserConnections() };
}

export function browserWorkspaceTicketUrl(ticket) {
  const workspace = new URL(config.browserWorkspaceUrl || '/browser/vnc.html', config.appOrigin);
  const pathValue = workspace.searchParams.get('path') || 'browser/websockify';
  workspace.searchParams.set('path', `${pathValue.split('?')[0]}?ticket=${encodeURIComponent(ticket)}`);
  return workspace.toString();
}
