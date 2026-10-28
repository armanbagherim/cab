import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authMiddleware, requireRole } from '../middleware/auth';
import { offeredTripsByDriver } from './trip';

const router = Router();

const updateStatusSchema = z.object({
  isOnline: z.boolean().optional(),
  isAccepting: z.boolean().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
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
    res.json({ success: true, data: status });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
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