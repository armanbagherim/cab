import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import prisma from '../utils/prisma';
import { verifyToken } from '../utils/helpers';
import { JwtPayload } from '../types';
import { handleDriverResponse } from '../routes/trip';

let io: Server;

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
    }
    socket.join(`trip:${user.userId}`); // for active trip events

    // Update driver status
    socket.on('driver:status', async (data: { isOnline?: boolean; isAccepting?: boolean }) => {
      if (user.role !== 'DRIVER') return;
      try {
        await prisma.driverStatus.update({
          where: { userId: user.userId },
          data: { ...data, updatedAt: new Date() },
        });
        socket.broadcast.emit('driver:status_changed', { userId: user.userId, ...data });
      } catch (err) {
        console.error('[WS] Status update error:', err);
      }
    });

    // Driver location update (every 2-3 seconds)
    socket.on('driver:location', async (data: { latitude: number; longitude: number }) => {
      if (user.role !== 'DRIVER') return;

      try {
        await prisma.driverStatus.update({
          where: { userId: user.userId },
          data: { latitude: data.latitude, longitude: data.longitude, updatedAt: new Date() },
        });

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
            latitude: data.latitude,
            longitude: data.longitude,
          });
        }
      } catch (err) {
        console.error('[WS] Location update error:', err);
      }
    });

    // Driver accepts/declines trip offer.
    // Race safety: a driver already on a trip cannot take another ride, so an
    // incompatible acceptance is ignored and the request is released.
    socket.on('trip:respond', async (data: { tripId: string; accepted: boolean }) => {
      if (user.role !== 'DRIVER') return;

      if (data.accepted) {
        const status = await prisma.driverStatus.findUnique({ where: { userId: user.userId } });
        if (status?.isOnTrip) {
          io.to(`driver:${user.userId}`).emit('trip:offer_expired', { tripId: data.tripId });
          return;
        }
      }

      handleDriverResponse(data.tripId, user.userId, data.accepted);

      if (!data.accepted) {
        io.to(`driver:${user.userId}`).emit('trip:offer_expired', { tripId: data.tripId });
      }
    });

    // Join trip room (for passenger to listen)
    socket.on('trip:join', (tripId: string) => {
      socket.join(`trip:${tripId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] User ${user.userId} disconnected`);
    });
  });

  return io;
}

export { io };