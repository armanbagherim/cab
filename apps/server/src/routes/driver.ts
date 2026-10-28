import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authMiddleware, requireRole } from '../middleware/auth';
import { offeredTripsByDriver, ensureDispatch } from './trip';
import { calculateDistance } from '../utils/helpers';

const router = Router();

async function wakeWaitingTrips(driverId: string, source: string) {
  const waitingTrips = await prisma.trip.findMany({
    where: { status: { in: ['SEARCHING', 'NO_DRIVER_AVAILABLE'] }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    select: { id: true, status: true }, take: 100,
  });
  for (const trip of waitingTrips) {
    if (trip.status === 'NO_DRIVER_AVAILABLE') await prisma.trip.update({ where: { id: trip.id }, data: { status: 'SEARCHING' } });
    ensureDispatch(trip.id);
  }
  console.log('[DISPATCH][DRIVER_AVAILABLE_WAKE]', { driverId, source, waitingTrips });
}

router.get('/nearby', authMiddleware, async (req: Request, res: Response) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).json({ success: false, error: 'موقعیت معتبر نیست' });
    return;
  }
  const drivers = await prisma.driverStatus.findMany({
    where: { isOnline: true, isAccepting: true, latitude: { not: null }, longitude: { not: null } },
    select: { userId: true, latitude: true, longitude: true, heading: true, isAccepting: true, selectedActive: true, selectedLat: true, selectedLng: true },
  });
  const data = drivers
    .map((driver) => ({ ...driver, distanceKm: calculateDistance(latitude, longitude, driver.latitude!, driver.longitude!) }))
    .filter((driver) => driver.distanceKm <= 15)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map(({ userId, latitude: lat, longitude: lng, heading, isAccepting, selectedActive, selectedLat, selectedLng, distanceKm }) => ({
      id: userId, latitude: lat, longitude: lng, heading, isAccepting, selectedActive, selectedLat, selectedLng,
      distanceKm: Math.round(distanceKm * 10) / 10,
    }));
  res.json({ success: true, data });
  console.log('[NEARBY_DRIVERS]', { userId: req.user!.userId, latitude, longitude, count: data.length, drivers: data.map((d) => ({ id: d.id, distanceKm: d.distanceKm, accepting: d.isAccepting })) });
});

const updateStatusSchema = z.object({
  isOnline: z.boolean().optional(),
  isAccepting: z.boolean().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  heading: z.number().min(0).max(360).optional(),
  selectedLat: z.number().min(-90).max(90).nullable().optional(),
  selectedLng: z.number().min(-180).max(180).nullable().optional(),
  selectedRadiusKm: z.number().min(1).max(30).optional(),
  selectedActive: z.boolean().optional(),
});

// Get driver status
router.get('/status', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  const status = await prisma.driverStatus.findUnique({
    where: { userId: req.user!.userId },
  });
  if (!status) {
    res.status(404).json({ success: false, error: 'Driver status not found' });
    return;
  }
  if (status.isOnline && status.isAccepting) await wakeWaitingTrips(req.user!.userId, 'GET_STATUS');
  res.json({ success: true, data: status });
});

// Update driver status.
// A driver with an active assigned ride cannot become unavailable — the
// server is the source of truth, the disabled UI buttons are only a hint.
router.put('/status', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  try {
    const body = updateStatusSchema.parse(req.body);

    if (body.isOnline === false || body.isAccepting === false) {
      const activeTrip = await prisma.trip.findFirst({
        where: {
          driverId: req.user!.userId,
          status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        },
      });
      if (activeTrip) {
        res.status(409).json({ success: false, error: 'سفر فعال دارید؛ امکان غیرفعال کردن وضعیت نیست' });
        return;
      }
    }

    const status = await prisma.driverStatus.update({
      where: { userId: req.user!.userId },
      data: body,
    });
    console.log('[DRIVER_STATUS_HTTP]', { userId: req.user!.userId, body, persisted: { isOnline: status.isOnline, isAccepting: status.isAccepting, latitude: status.latitude, longitude: status.longitude } });
    if (status.isOnline && status.isAccepting) {
      await wakeWaitingTrips(req.user!.userId, 'PUT_STATUS');
    }
    res.json({ success: true, data: status });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.put('/selected-route', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  const parsed = z.object({
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    radiusKm: z.number().min(1).max(30),
    active: z.boolean(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'محدوده مسیر منتخب معتبر نیست' });
    return;
  }
  const status = await prisma.driverStatus.update({
    where: { userId: req.user!.userId },
    data: {
      selectedLat: parsed.data.latitude,
      selectedLng: parsed.data.longitude,
      selectedRadiusKm: parsed.data.radiusKm,
      selectedActive: parsed.data.active && parsed.data.latitude !== null && parsed.data.longitude !== null,
    },
  });
  console.log('[SELECTED_ROUTE]', { userId: req.user!.userId, requested: parsed.data, persisted: { selectedLat: status.selectedLat, selectedLng: status.selectedLng, selectedRadiusKm: status.selectedRadiusKm, selectedActive: status.selectedActive } });
  res.json({ success: true, data: status });
});

// Driver trip history (terminal trips only).
// Financial note: the data model stores no commission/payout — the only
// server-backed amount per trip is `estimatedPrice` (the fare). Totals below
// are therefore sums of fares, labelled as such, never "net earnings".
router.get('/history', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  const trips = await prisma.trip.findMany({
    where: {
      driverId: req.user!.userId,
      status: { in: ['COMPLETED', 'CANCELLED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      passenger: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  });
  const completed = trips.filter((t) => t.status === 'COMPLETED');
  res.json({
    success: true,
    data: {
      trips,
      summary: {
        completedCount: completed.length,
        cancelledCount: trips.length - completed.length,
        totalFare: completed.reduce((s, t) => s + t.estimatedPrice, 0),
      },
    },
  });
});

// Get driver's active trip
router.get('/active-trip', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  const trip = await prisma.trip.findFirst({
    where: {
      driverId: req.user!.userId,
      status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
    },
    include: { passenger: { select: { id: true, firstName: true, lastName: true, phone: true } } },
  });
  res.json({ success: true, data: trip });
});

// Pending offers for a driver (HTTP polling fallback for socket drops)
router.get('/pending-offers', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  const driverId = req.user!.userId;
  const offeredSet = offeredTripsByDriver.get(driverId);
  if (!offeredSet || offeredSet.size === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  const tripIds = Array.from(offeredSet);
  const trips = await prisma.trip.findMany({
    where: {
      id: { in: tripIds },
      status: 'OFFERED',
    },
  });

  const driverStatus = await prisma.driverStatus.findUnique({ where: { userId: driverId } });

  const offers = trips.map((t) => ({
    tripId: t.id,
    originLat: t.originLat,
    originLng: t.originLng,
    originAddress: t.originAddress,
    destLat: t.destLat,
    destLng: t.destLng,
    destAddress: t.destAddress,
    distanceKm: t.distanceKm,
    durationMin: t.durationMin,
    estimatedPrice: t.estimatedPrice,
    driverDistanceKm: driverStatus?.latitude && driverStatus?.longitude
      ? Math.round(
          (Math.hypot(
            (t.originLat - driverStatus.latitude) * 111,
            (t.originLng - driverStatus.longitude) * 88
          )) * 10
        ) / 10
      : null,
  }));

  res.json({ success: true, data: offers });
});

export default router;
