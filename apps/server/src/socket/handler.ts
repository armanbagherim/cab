import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import prisma from '../utils/prisma';
import { verifyToken } from '../utils/helpers';
import { JwtPayload } from '../types';
import { handleTripResponse, wakeDriverLocationRefresh } from '../routes/trip';
import { config } from '../config';

let io: Server;

/** Driver reachability registry (per process). Candidate selection promises
 * offers only to connected drivers. Disconnected drivers' existing offers
 * keep their natural timers, so a brief reconnect can still act on them
 * (recovery via `/drivers/pending-offers` + dispatcher re-offer policy). */
const driverSocketCount = new Map<string, number>();
const connectedDriverIds = new Set<string>();

export function isDriverConnected(driverId: string): boolean {
  return connectedDriverIds.has(driverId);
}

function onDriverSocketOpened(driverId: string): void {
  driverSocketCount.set(driverId, (driverSocketCount.get(driverId) ?? 0) + 1);
  connectedDriverIds.add(driverId);
}

function onDriverSocketClosed(driverId: string): void {
  const count = (driverSocketCount.get(driverId) ?? 1) - 1;
  if (count > 0) {
    driverSocketCount.set(driverId, count);
    return; // multi-device / fast-flap: still reachable
  }
  driverSocketCount.delete(driverId);
  connectedDriverIds.delete(driverId);
  void prisma.driverStatus.updateMany({
    where: { userId: driverId },
    data: { isOnline: false, isAccepting: false, selectedActive: false, selectedLat: null, selectedLng: null, updatedAt: new Date() },
  }).catch((err) => console.error('[WS][DRIVER_OFFLINE_PERSIST]', err));
  io?.emit('drivers:status', { id: driverId, isOnline: false, isAccepting: false });
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware for sockets
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }
    try {
      const user = verifyToken(token as string);
      (socket as any).user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user as JwtPayload;
    console.log(`[WS] User ${user.userId} (${user.role}) connected`);

    // Join personal rooms
    socket.join(`user:${user.userId}`);
    if (user.role === 'DRIVER') {
      socket.join(`driver:${user.userId}`);
      onDriverSocketOpened(user.userId);
    }
    socket.join(`trip:${user.userId}`); // for active trip events

    socket.on('disconnect', () => {
      console.log(`[WS] User ${user.userId} disconnected`);
      if (user.role === 'DRIVER') onDriverSocketClosed(user.userId);
    });

    // Update driver status
    socket.on('driver:status', async (data: { isOnline?: boolean; isAccepting?: boolean }) => {
      if (user.role !== 'DRIVER') return;
      try {
        // Mirror the HTTP guard: a driver with an active ride cannot become
        // unavailable — the server is the source of truth.
        if (data.isOnline === false || data.isAccepting === false) {
          const activeTrip = await prisma.trip.findFirst({
            where: {
              driverId: user.userId,
              status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
            },
            select: { id: true },
          });
          if (activeTrip) {
            console.log('[WS][DRIVER_STATUS_REJECTED]', { userId: user.userId, reason: 'active_trip', requested: data });
            return;
          }
        }
        const status = await prisma.driverStatus.update({
          where: { userId: user.userId },
          data: (data.isOnline === false || data.isAccepting === false)
            ? { ...data, selectedActive: false, selectedLat: null, selectedLng: null, updatedAt: new Date() }
            : { ...data, updatedAt: new Date() },
        });
        console.log('[WS][DRIVER_STATUS]', { userId: user.userId, ...data, isOnline: status.isOnline, isAccepting: status.isAccepting });
        io.emit('drivers:status', {
          id: user.userId, isOnline: status.isOnline, isAccepting: status.isAccepting,
          latitude: status.latitude, longitude: status.longitude,
        });
      } catch (err) {
        console.error('[WS] Status update error:', err);
      }
    });

    // Driver location update (every 2-3 seconds)
    socket.on('driver:location', async (data: { latitude: number; longitude: number; heading?: number }) => {
      if (user.role !== 'DRIVER') return;

      const { latitude, longitude, heading } = data ?? {} as typeof data;
      if (
        !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180
        || (heading !== undefined && (!Number.isFinite(heading) || heading < 0 || heading > 360))
      ) {
        console.warn('[WS][DRIVER_LOCATION_REJECTED]', { userId: user.userId });
        return;
      }

      try {
        const status = await prisma.driverStatus.findUnique({
          where: { userId: user.userId },
          select: { isOnline: true, isAccepting: true },
        });
        if (!status?.isOnline || !status.isAccepting) return;
        const wasStale = await isDriverLocationStale(user.userId);
        await persistDriverLocation(user.userId, latitude, longitude, heading);

        io.emit('drivers:location', {
          id: user.userId, latitude, longitude, heading,
          isOnline: true, isAccepting: true,
        });

        // A previously-stale driver just sent a fresh eligible fix — active
        // dispatchers should reconsider that driver promptly (event-driven;
        // no additional dispatcher loops are spawned per location event).
        if (wasStale) wakeDriverLocationRefresh(user.userId);

        // Send location to passenger of active trip
        const activeTrip = await prisma.trip.findFirst({
          where: {
            driverId: user.userId,
            status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
          },
        });

        if (activeTrip) {
          io.to(`user:${activeTrip.passengerId}`).emit('driver:location', {
            tripId: activeTrip.id,
            latitude,
            longitude,
          });
        }
      } catch (err) {
        console.error('[WS] Location update error:', err);
      }
    });

    // Driver accepts/declines trip offer.
    // Race safety: arbitration validates offer identity/expiry server-side
    // and assigns via an atomic conditional DB transition — duplicate, late
    // or lost-race responses are idempotent no-ops for the client.
    socket.on('trip:respond', async (data: { tripId: string; accepted: boolean; offerId?: string }) => {
      if (user.role !== 'DRIVER') return;
      if (!data || typeof data.tripId !== 'string' || typeof data.accepted !== 'boolean') return;

      console.log('[WS][TRIP_RESPONSE]', { driverId: user.userId, tripId: data.tripId, accepted: data.accepted });

      try {
        await handleTripResponse(data.tripId, user.userId, data.accepted, data.offerId);
      } catch (err) {
        console.error('[WS][TRIP_RESPONSE_ERROR]', { driverId: user.userId, tripId: data.tripId, error: (err as Error)?.message });
      }
    });

    // Join trip room (for passenger to listen)
    socket.on('trip:join', (tripId: string) => {
      socket.join(`trip:${tripId}`);
    });
  });

  return io;
}

export { io };

async function isDriverLocationStale(driverId: string): Promise<boolean> {
  const status = await prisma.driverStatus.findUnique({
    where: { userId: driverId },
    select: { updatedAt: true },
  });
  if (!status?.updatedAt) return false;
  return Date.now() - new Date(status.updatedAt).getTime() > config.driverSearch.locationFreshnessMs;
}

/** Throttled persistence: writes at most once per second and skips mirroring
 * fixes that moved <10 m since the last persisted one. Keeps SQLite write
 * volume bounded while staying comfortably inside the 10 s dispatch
 * freshness window. */
const locationWriteState = new Map<string, { lat: number; lng: number; atMs: number }>();

async function persistDriverLocation(
  driverId: string, latitude: number, longitude: number, heading?: number,
): Promise<void> {
  const now = Date.now();
  const prev = locationWriteState.get(driverId);
  if (prev) {
    const dt = now - prev.atMs;
    const movedM = Math.hypot(latitude - prev.lat, longitude - prev.lng) * 111_000;
    if (dt < 1000 && movedM < 10) {
      // Keep the persisted timestamp a heartbeat even when the coordinate did not move.
      await prisma.driverStatus.update({ where: { userId: driverId }, data: { updatedAt: new Date(now) } });
      return;
    }
  }
  locationWriteState.set(driverId, { lat: latitude, lng: longitude, atMs: now });
  await prisma.driverStatus.update({
    where: { userId: driverId },
    data: { latitude, longitude, heading, updatedAt: new Date(now) },
  });
}
