import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { apiBase } from './api';
import { getAccessToken } from './auth/session';

/** Receive updates over a socket, with the HTTP refresh in the screen as fallback. */
export function startRiderRealtime(onConnection: (connected: boolean) => void, onChange: () => void) {
  let alive = true;
  let lastForcedRefresh = -Infinity;
  let refreshing = false;
  const socket = io(`${apiBase()}/rider`, {
    // Socket.IO invokes this on every handshake, including transport reconnection.
    auth: (done) => { void getAccessToken().then((token) => done({ token })).catch(() => done({})); },
    transports: ['websocket'],
    reconnectionDelayMax: 10000,
  });
  socket.on('connect', () => { if (alive) { onConnection(true); onChange(); } });
  socket.on('disconnect', (reason) => {
    if (!alive) return;
    onConnection(false);
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('connect_error', (error) => {
    if (!alive) return;
    onConnection(false);
    // Middleware rejections stop Socket.IO's automatic retry. Refresh once per
    // minute, then let the slower retry below handle persistent rejection.
    if (error.message === 'UNAUTHORIZED' && !refreshing && Date.now() - lastForcedRefresh >= 60000) {
      lastForcedRefresh = Date.now();
      refreshing = true;
      void getAccessToken(true).then(() => {
        if (alive && !socket.connected) socket.connect();
      }).catch(() => undefined).finally(() => { refreshing = false; });
    }
  });
  ['snapshot', 'offer.created', 'offer.revoked', 'task.updated', 'task.cancelled']
    .forEach((event) => socket.on(event, () => { if (alive) onChange(); }));

  const retry = setInterval(() => {
    if (alive && AppState.currentState === 'active' && !socket.connected && !socket.active && !refreshing) socket.connect();
  }, 20000);
  return () => { alive = false; clearInterval(retry); socket.disconnect(); };
}
