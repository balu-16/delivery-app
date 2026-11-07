import { Server, type Socket, type Namespace } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Json } from '../database/database.js';

export interface RealtimeIdentity {
  userId: string;
  pool: 'CUSTOMER' | 'WORKFORCE';
  roles: string[];
}

/**
 * A namespace owned by exactly one audience (D06): the customer and rider
 * namespaces appear only on roles that serve that audience. Handlers are
 * fan-out only; clients never push business commands.
 */
export interface NamespaceSpec {
  readonly name: string;
  /** Verify the handshake bearer token; null rejects the connection. */
  readonly authenticate: (token: string | undefined) => Promise<RealtimeIdentity | null>;
  /** Room authorization is re-checked on every join attempt. */
  readonly authorizeRoom: (identity: RealtimeIdentity, room: string) => Promise<boolean>;
  /** Snapshot sent to the client on connect and on reconnect. */
  readonly snapshot: (identity: RealtimeIdentity) => Promise<Json>;
  /** Rooms are free-form names scoped by the owning audience. */
  readonly maxRoomsPerSocket?: number;
}

export interface RealtimeNamespace {
  readonly name: string;
  /** Emit to an authorized room; no-op when the room has no local sockets. */
  emitToRoom(room: string, event: string, payload: Json): void;
  /** Number of sockets currently in the room on this instance. */
  socketsIn(room: string): number;
}

const MAX_AUTH_PAYLOAD = 2048;

/**
 * Socket.IO gateway with the Redis adapter for multi-instance fan-out.
 * Handshake identity is verified per connection; room joins are re-authorized;
 * clients are receive-only, so no client event is ever registered.
 */
export class RealtimeGateway {
  private readonly specs = new Map<string, NamespaceSpec>();
  private closed = false;

  constructor(
    readonly io: Server,
    private readonly drainMs: number,
    private readonly onError: (error: Error) => void,
  ) {
    io.engine.on('connection_error', (error: { message: string }) => {
      this.onError(new Error(error.message || 'realtime connection error'));
    });
  }

  register(spec: NamespaceSpec): RealtimeNamespace {
    if (this.closed) throw new Error('REALTIME_CLOSED');
    if (!/^\/[a-z][a-z0-9-]{0,31}$/.test(spec.name)) throw new Error('INVALID_REALTIME_NAMESPACE');
    if (this.specs.has(spec.name)) throw new Error('INVALID_OR_DUPLICATE_REALTIME_NAMESPACE');
    this.specs.set(spec.name, spec);
    const namespace: Namespace = this.io.of(spec.name);
    namespace.use(async (socket, next) => {
      try {
        const header = socket.handshake.auth?.token ?? socket.handshake.headers?.authorization;
        const token = typeof header === 'string' ? header : undefined;
        if (token && token.length > MAX_AUTH_PAYLOAD) return next(new Error('UNAUTHORIZED'));
        const bearer = token?.startsWith('Bearer ') ? token.slice(7) : token;
        const identity = await spec.authenticate(bearer);
        if (!identity || this.closed) return next(new Error('UNAUTHORIZED'));
        socket.data.identity = identity;
        next();
      } catch {
        next(new Error('UNAUTHORIZED'));
      }
    });
    // Receive-only: reject every client-initiated event so business commands
    // stay on the authorized HTTP surface.
    namespace.on('connection', (socket: Socket) => {
      const identity = socket.data.identity as RealtimeIdentity;
      void (async () => {
        // Snapshot after the connection is fully established so the client
        // listener exists; reconnects resume from the same snapshot.
        await socket.join(`user:${identity.userId}`);
        socket.emit('snapshot', await spec.snapshot(identity));
      })().catch(() => socket.disconnect(true));
      socket.onAny((event) => {
        if (event === 'subscribe' || event === 'unsubscribe') return;
        socket.emit('rejected', { code: 'REALTIME_RECEIVE_ONLY' });
      });
      const limit = spec.maxRoomsPerSocket ?? 20;
      socket.on('subscribe', (payload: unknown) => {
        void (async () => {
          if (this.closed) return;
          const room =
            typeof payload === 'object' && payload !== null && 'room' in payload
              ? String((payload as { room: unknown }).room)
              : String(payload ?? '');
          if (!room || room.length > 128 || !/^[\w:-]+$/.test(room)) {
            socket.emit('rejected', { code: 'INVALID_ROOM' });
            return;
          }
          const identity = socket.data.identity as RealtimeIdentity;
          const current = [...socket.rooms].filter((entry) => entry !== socket.id).length;
          if (current >= limit) {
            socket.emit('rejected', { code: 'ROOM_LIMIT_REACHED' });
            return;
          }
          if (!(await spec.authorizeRoom(identity, room))) {
            socket.emit('rejected', { code: 'ROOM_UNAUTHORIZED' });
            return;
          }
          await socket.join(room);
        })().catch(() => socket.emit('rejected', { code: 'REALTIME_ERROR' }));
      });
      socket.on('unsubscribe', (payload: unknown) => {
        const room =
          typeof payload === 'object' && payload !== null && 'room' in payload
            ? String((payload as { room: unknown }).room)
            : String(payload ?? '');
        if (/^[\w:-]+$/.test(room) && room.length <= 128) void socket.leave(room);
      });
    });
    return {
      name: spec.name,
      emitToRoom: (room, event, payload) => {
        if (this.closed) return;
        namespace.to(room).emit(event, payload);
      },
      socketsIn: (room) => namespace.adapter.rooms.get(room)?.size ?? 0,
    };
  }

  /** Stop accepting connections, drain briefly, then close without closing the HTTP server. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const name of this.specs.keys()) this.io.of(name).disconnectSockets(true);
    if (this.drainMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.drainMs);
        timer.unref();
      });
    }
    // Disconnect adapters and engines but keep the shared HTTP server serving
    // until the application's own shutdown closes it.
    await this.io.engine.close();
    this.io.removeAllListeners();
  }
}

/** Attach the gateway to the application's HTTP server; Redis fan-out degrades to single-instance. */
export function createRealtimeGateway(input: {
  httpServer: import('node:http').Server | undefined;
  redisUrl?: string;
  prefix?: string;
  drainMs?: number;
  path?: string;
  corsOrigins?: string[];
  onError?: (error: Error) => void;
}): RealtimeGateway | null {
  const onError = input.onError ?? (() => undefined);
  if (!input.httpServer) {
    onError(new Error('Realtime attach failed: HTTP server not initialized'));
    return null;
  }
  const io = new Server(input.httpServer, {
    path: input.path ?? '/socket.io',
    cors: { origin: input.corsOrigins ?? [], credentials: false },
    transports: ['websocket', 'polling'],
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
  });
  io.on('error', onError);
  if (input.redisUrl) {
    const options = { maxRetriesPerRequest: null, connectTimeout: 5000, commandTimeout: 5000 };
    const prefix = input.prefix ?? 'delivery';
    try {
      const pub = new Redis(input.redisUrl, { ...options, connectionName: `${prefix}:rt-pub` });
      const sub = pub.duplicate();
      (sub as { options?: { connectionName?: string } }).options = {
        ...pub.options,
        connectionName: `${prefix}:rt-sub`,
      };
      pub.on('error', onError);
      sub.on('error', onError);
      io.adapter(createAdapter(pub, sub, { key: `${prefix}:realtime` }));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      // Single-instance fallback: sockets still work without the adapter.
    }
  }
  return new RealtimeGateway(io, input.drainMs ?? 2000, onError);
}
