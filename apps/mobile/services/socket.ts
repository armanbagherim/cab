import { io, Socket } from 'socket.io-client';

const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:3000';

/**
 * Socket.IO wrapper.
 *
 * Handlers registered while the socket is offline are buffered and attached
 * as soon as a connection exists, so screens can subscribe in their mount
 * effects without racing the authentication connect.
 */
class SocketService {
  private socket: Socket | null = null;
  private token: string | null = null;
  private handlers = new Map<string, Set<(...args: any[]) => void>>();

  connect(token: string) {
    this.token = token;
    if (this.socket) {
      if (this.socket.connected) return;
      this.socket.auth = { token };
      this.socket.connect();
      this.attachAll();
      return;
    }

    this.socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    this.attachAll();

    this.socket.on('connect', () => {
      if (__DEV__) console.log('[Socket] Connected');
      this.connectHandlers.forEach((h) => {
        try { h(); } catch (_e) { /* handler errors never break the transport */ }
      });
    });
    this.socket.on('disconnect', (reason) => {
      if (__DEV__) console.log('[Socket] Disconnected:', reason);
      else console.warn('[Socket] Disconnected:', reason);
    });
    this.socket.on('connect_error', (err) => {
      // Always log connection problems, not only in dev builds.
      console.warn('[Socket] connect_error:', err.message);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * Subscribe to transport connects (initial + every reconnect). Server-side
   * rooms are lost across reconnects, so callers use this to rejoin trip
   * rooms and reconcile their state with the authoritative API.
   */
  onConnect(handler: () => void): () => void {
    this.socket?.on('connect', handler);
    this.connectHandlers.add(handler);
    return () => {
      this.connectHandlers.delete(handler);
      this.socket?.off('connect', handler);
    };
  }

  private connectHandlers = new Set<() => void>();

  getSocket(): Socket | null {
    return this.socket;
  }

  emit(event: string, data: any) {
    this.socket?.emit(event, data);
  }

  on(event: string, handler: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    this.socket?.on(event, handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
      this.socket?.off(event, handler);
    };
  }

  off(event: string) {
    this.handlers.delete(event);
    this.socket?.off(event);
  }

  joinTrip(tripId: string) {
    this.socket?.emit('trip:join', tripId);
  }

  private attachAll() {
    if (!this.socket) return;
    this.handlers.forEach((set, event) => {
      set.forEach((h) => this.socket!.on(event, h));
    });
  }
}

export const socketService = new SocketService();
