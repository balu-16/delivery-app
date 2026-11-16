import { AppState } from 'react-native';
import { io } from 'socket.io-client';
import { apiBaseUrl } from './api/client';
import { accessToken } from './auth/session';

/** The caller owns this subscription and stops it when the order view blurs. */
export function startOrderRealtime(orderId: string, onChange: () => void, onStatus: () => void) {
  let active = true;
  let refreshing = false;
  let lastForcedRefresh = -Infinity;
  const socket = io(`${apiBaseUrl()}/customer`, {
    auth: (done) => { void accessToken().then((token) => done({ token })).catch(() => done({})); },
    transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelayMax: 10000,
  });
  socket.on('connect', () => {
    if (!active) return;
    socket.emit('subscribe', { room: `order:${orderId}` });
    onChange();
  });
  ['rider.location', 'snapshot', 'eta.updated'].forEach((event) => socket.on(event, () => { if (active) onChange(); }));
  socket.on('order.status', () => { if (active) onStatus(); });
  socket.on('disconnect', (reason) => {
    if (active && reason === 'io server disconnect') socket.connect();
  });
  socket.on('connect_error', (error) => {
    if (!active || error.message !== 'UNAUTHORIZED' || refreshing || Date.now() - lastForcedRefresh < 60000) return;
    lastForcedRefresh = Date.now();
    refreshing = true;
    void accessToken(true).then(() => { if (active && !socket.connected) socket.connect(); })
      .catch(() => undefined).finally(() => { refreshing = false; });
  });
  const retry = setInterval(() => {
    if (active && AppState.currentState === 'active' && !socket.connected && !socket.active && !refreshing) socket.connect();
  }, 30000);
  return () => {
    active = false;
    clearInterval(retry);
    if (socket.connected) socket.emit('unsubscribe', { room: `order:${orderId}` });
    socket.disconnect();
  };
}
