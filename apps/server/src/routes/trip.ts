import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../middleware/auth';
import prisma from '../utils/prisma';
import { validateTehranCoord, calculatePrice, calculateDistance } from '../utils/helpers';
import { getRoute, reverseGeocode, searchAddress, searchAddressPlus, searchPoi } from '../services/neshan';
import { io } from '../socket/handler';
import { config } from '../config';

const router = Router();

const estimateSchema = z.object({
  originLat: z.number(),
  originLng: z.number(),
  destLat: z.number(),
  destLng: z.number(),
});

const createTripSchema = z.object({
  originLat: z.number(),
  originLng: z.number(),
  originAddress: z.string().optional(),
  destLat: z.number(),
  destLng: z.number(),
  destAddress: z.string().optional(),
  paymentMethod: z.enum(['CASH', 'WALLET']).optional().default('CASH'),
});

// Estimate price and route
router.post('/estimate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const body = estimateSchema.parse(req.body);

    if (!validateTehranCoord(body.originLat, body.originLng) ||
        !validateTehranCoord(body.destLat, body.destLng)) {
      res.status(400).json({ success: false, error: 'مختصات خارج از محدوده مجاز تهران است' });
      return;
    }

    const routeResult = await getRoute(body.originLat, body.originLng, body.destLat, body.destLng);

    if (routeResult.status !== 'OK' || routeResult.distance <= 0) {
      res.status(400).json({ success: false, error: 'مسیریابی ناموفق بود' });
      return;
    }

    const distanceKm = routeResult.distance / 1000;
    const durationMin = Math.round(routeResult.duration / 60);
    const price = calculatePrice(distanceKm, durationMin);

    // Get addresses (best-effort)
    let originAddress = '';
    let destAddress = '';
    try { const o = await reverseGeocode(body.originLat, body.originLng); originAddress = o.formatted_address; } catch {}
    try { const d = await reverseGeocode(body.destLat, body.destLng); destAddress = d.formatted_address; } catch {}

    res.json({
      success: true,
      data: {
        distanceKm: Math.round(distanceKm * 10) / 10,
        durationMin,
        estimatedPrice: price,
        originAddress,
        destAddress,
        route: routeResult.routes[0]?.overview_polyline?.points || null,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Create trip request
router.post('/', authMiddleware, requireRole('PASSENGER'), async (req: Request, res: Response) => {
  try {
    const body = createTripSchema.parse(req.body);

    if (!validateTehranCoord(body.originLat, body.originLng) ||
        !validateTehranCoord(body.destLat, body.destLng)) {
      res.status(400).json({ success: false, error: 'مختصات خارج از محدوده مجاز تهران است' });
      return;
    }

    // Check for existing active trip
    const existingTrip = await prisma.trip.findFirst({
      where: {
        passengerId: req.user!.userId,
        status: { in: ['SEARCHING', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
    });

    if (existingTrip) {
      res.status(400).json({ success: false, error: 'شما یک سفر فعال دارید' });
      return;
    }

    // Get route & estimate
    let routeResult;
    try {
      routeResult = await getRoute(body.originLat, body.originLng, body.destLat, body.destLng);
    } catch {
      res.status(502).json({ success: false, error: 'خطا در دریافت مسیر. لطفاً دوباره تلاش کنید' });
      return;
    }

    if (routeResult.status !== 'OK' || routeResult.distance <= 0) {
      res.status(400).json({ success: false, error: 'مسیریابی ناموفق بود' });
      return;
    }

    const distanceKm = routeResult.distance / 1000;
    const durationMin = Math.round(routeResult.duration / 60);
    const price = calculatePrice(distanceKm, durationMin);

    // Get addresses
    let originAddress = body.originAddress || '';
    let destAddress = body.destAddress || '';
    try {
      if (!originAddress) {
        const oRes = await reverseGeocode(body.originLat, body.originLng);
        originAddress = oRes.formatted_address;
      }
      if (!destAddress) {
        const dRes = await reverseGeocode(body.destLat, body.destLng);
        destAddress = dRes.formatted_address;
      }
    } catch {
      // continue with empty addresses
    }

    // Wallet payment: validate authoritative balance before accepting the
    // request. The actual charge happens only at ride completion, atomically.
    if (body.paymentMethod === 'WALLET') {
      const wallet = await prisma.wallet.findUnique({ where: { userId: req.user!.userId } });
      if (!wallet || wallet.balance < price) {
        res.status(400).json({ success: false, error: 'موجودی کیف پول کافی نیست. روش پرداخت نقدی را انتخاب کنید یا موجودی را افزایش دهید' });
        return;
      }
    }

    // Create trip — atomically. The active-ride invariant is re-checked
    // inside the transaction: two concurrent requests can never both pass
    // the earlier (non-authoritative) check and create two live rides.
    const trip = await prisma.$transaction(async (tx) => {
      const active = await tx.trip.findFirst({
        where: {
          passengerId: req.user!.userId,
          status: { in: ['SEARCHING', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        },
      });
      if (active) return null; // race lost — another ride is live

      return tx.trip.create({
        data: {
          passengerId: req.user!.userId,
          originLat: body.originLat,
          originLng: body.originLng,
          originAddress,
          destLat: body.destLat,
          destLng: body.destLng,
          destAddress,
          distanceKm: Math.round(distanceKm * 10) / 10,
          durationMin,
          estimatedPrice: price,
          status: 'SEARCHING',
          routeGeoJson: routeResult.routes[0]?.overview_polyline?.points || null,
          paymentMethod: body.paymentMethod,
        },
      });
    });

    if (!trip) {
      res.status(400).json({ success: false, error: 'شما یک سفر فعال دارید' });
      return;
    }

    // Find & offer to nearest driver (async)
    findAndOfferDriver(trip.id).catch((err) => {
      console.error('Driver search error:', err);
    });

    res.json({ success: true, data: trip });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

async function findAndOfferDriver(tripId: string): Promise<void> {
  // Bounded search window (~150 s): instead of failing fast when no driver is
  // currently in range, we keep the trip in SEARCHING and re-scan the pool
  // every pollIntervalMs until a driver accepts or the window expires.
  // Driver acceptance always takes precedence over any later offer.
  const deadline = Date.now() + config.driverSearch.searchWindowMs;
  const offerHistory = new Set<string>(); // drivers already offered this run

  while (Date.now() < deadline) {
    const trip = await prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== 'SEARCHING') return; // cancelled / accepted / terminal

    // Find eligible drivers
    let eligibleDrivers = await prisma.driverStatus.findMany({
      where: {
        isOnline: true,
        isAccepting: true,
        isOnTrip: false,
        latitude: { not: null },
        longitude: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (eligibleDrivers.length === 0) {
      // Reconcile: check if any online driver has stale isOnTrip without an active ride
      const driversToCheck = await prisma.driverStatus.findMany({
        where: {
          isOnline: true,
          isAccepting: true,
          isOnTrip: true,
          latitude: { not: null },
          longitude: { not: null },
        },
      });
      for (const d of driversToCheck) {
        const liveTrip = await prisma.trip.findFirst({
          where: {
            driverId: d.userId,
            status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
          },
        });
        if (!liveTrip) {
          await prisma.driverStatus.update({
            where: { userId: d.userId },
            data: { isOnTrip: false },
          });
          eligibleDrivers.push({ ...d, isOnTrip: false });
        }
      }
    }

    // Sort by distance to trip origin. Two-stage dispatch: nearby drivers
    // (within maxRadiusKm) are offered first; if no one nearby is available,
    // fall back to ALL free drivers regardless of distance — a trip should
    // reach any available driver rather than expire silently.
    const nearby = eligibleDrivers
      .map((d) => ({
        ...d,
        distance: calculateDistance(
          trip.originLat, trip.originLng,
          d.latitude!, d.longitude!
        ),
      }))
      .sort((a, b) => a.distance - b.distance)
      .filter((d) => d.distance <= config.driverSearch.maxRadiusKm);

    const candidates = nearby.length > 0
      ? nearby
      : eligibleDrivers
          .map((d) => ({
            ...d,
            distance: calculateDistance(
              trip.originLat, trip.originLng,
              d.latitude!, d.longitude!
            ),
          }))
          .sort((a, b) => a.distance - b.distance);

    const pool = candidates
      .filter((d) => !offerHistory.has(d.userId));

    for (const driver of pool) {
      const tripCheck = await prisma.trip.findUnique({ where: { id: tripId } });
      if (!tripCheck || !['SEARCHING', 'OFFERED'].includes(tripCheck.status)) return;

      offerHistory.add(driver.userId);
      trackOffer(driver.userId, tripId);

      // Mark as OFFERED
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'OFFERED' },
      });

      io.to(`driver:${driver.userId}`).emit('trip:offer', {
        tripId,
        originLat: trip.originLat,
        originLng: trip.originLng,
        originAddress: trip.originAddress,
        destLat: trip.destLat,
        destLng: trip.destLng,
        destAddress: trip.destAddress,
        distanceKm: trip.distanceKm,
        durationMin: trip.durationMin,
        estimatedPrice: trip.estimatedPrice,
        driverDistanceKm: Math.round(driver.distance * 10) / 10,
      });

      // Wait for acceptance with timeout
      const accepted = await waitForDriverResponse(tripId, driver.userId, config.driverSearch.timeoutMs);

      if (accepted) {
        // Double check trip is still eligible before assigning
        const liveTrip = await prisma.trip.findUnique({ where: { id: tripId } });
        if (!liveTrip || liveTrip.status !== 'OFFERED') return;

        // Assign trip to this driver
        await prisma.trip.update({
          where: { id: tripId },
          data: {
            driverId: driver.userId,
            status: 'ACCEPTED',
            acceptedAt: new Date(),
          },
        });
        await prisma.driverStatus.update({
          where: { userId: driver.userId },
          data: { isOnTrip: true },
        });

        io.to(`trip:${tripId}`).emit('trip:accepted', {
          tripId,
          driverId: driver.userId,
          status: 'ACCEPTED',
        });
        io.to(`driver:${driver.userId}`).emit('trip:accepted', { tripId, status: 'ACCEPTED' });
        // Driver is now busy: all other pending offers to them expire at once.
        expireOtherOffers(driver.userId, tripId);
        return;
      }

      // Driver declined or timed out, notify and try next
      untrackOffer(driver.userId, tripId);
      io.to(`driver:${driver.userId}`).emit('trip:offer_expired', { tripId });

      // If the trip was cancelled while waiting, stop
      const checkAfterWait = await prisma.trip.findUnique({ where: { id: tripId } });
      if (!checkAfterWait || checkAfterWait.status !== 'OFFERED') return;

      // Revert status to SEARCHING so passenger sees search continues and next driver can be offered
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'SEARCHING' },
      });
      io.to(`trip:${tripId}`).emit('trip:status', { tripId, status: 'SEARCHING' });

      if (Date.now() >= deadline) break;
    }

    if (Date.now() >= deadline) break;

    // Reset offerHistory if all available drivers were offered once, so they can be re-contacted
    if (pool.length === 0 && candidates.length > 0) {
      offerHistory.clear();
    }

    // Nothing actionable this pass — return to SEARCHING so the passenger and
    // driver pool see an honest pending state, then re-scan for new drivers.
    const tripCheck = await prisma.trip.findUnique({ where: { id: tripId } });
    if (!tripCheck) return;
    if (!['SEARCHING', 'OFFERED'].includes(tripCheck.status)) return;
    if (tripCheck.status === 'OFFERED') {
      await prisma.trip.update({
        where: { id: tripId },
        data: { status: 'SEARCHING' },
      });
      io.to(`trip:${tripId}`).emit('trip:status', { tripId, status: 'SEARCHING' });
    }

    await new Promise((r) => setTimeout(r, config.driverSearch.pollIntervalMs));
  }

  // Window expired with no acceptance — honest terminal state.
  const tripCheck = await prisma.trip.findUnique({ where: { id: tripId } });
  if (tripCheck && ['SEARCHING', 'OFFERED'].includes(tripCheck.status)) {
    await prisma.trip.update({
      where: { id: tripId },
      data: { status: 'NO_DRIVER_AVAILABLE' },
    });
    io.to(`trip:${tripId}`).emit('trip:status', { tripId, status: 'NO_DRIVER_AVAILABLE' });
  }
}

const pendingResponses = new Map<string, (accepted: boolean) => void>();

/** Live offers per driver, so accepting one ride invalidates the others
 * instead of leaving the driver with stale, acceptable requests. */
export const offeredTripsByDriver = new Map<string, Set<string>>();

export function trackOffer(driverId: string, tripId: string): void {
  if (!offeredTripsByDriver.has(driverId)) offeredTripsByDriver.set(driverId, new Set());
  offeredTripsByDriver.get(driverId)!.add(tripId);
}

export function untrackOffer(driverId: string, tripId: string): void {
  offeredTripsByDriver.get(driverId)?.delete(tripId);
}

/** On acceptance, every other pending offer for this driver expires. */
export function expireOtherOffers(driverId: string, keepTripId: string): void {
  const set = offeredTripsByDriver.get(driverId);
  if (!set) return;
  set.forEach((tripId) => {
    if (tripId !== keepTripId) {
      io.to(`driver:${driverId}`).emit('trip:offer_expired', { tripId });
    }
  });
  offeredTripsByDriver.set(driverId, new Set([keepTripId]));
}

export function handleDriverResponse(tripId: string, driverId: string, accepted: boolean): void {
  const key = `${tripId}:${driverId}`;
  const resolve = pendingResponses.get(key);
  if (resolve) {
    resolve(accepted);
    pendingResponses.delete(key);
  }
}

function waitForDriverResponse(tripId: string, driverId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const key = `${tripId}:${driverId}`;
    pendingResponses.set(key, resolve);
    setTimeout(() => {
      const r = pendingResponses.get(key);
      if (r) {
        pendingResponses.delete(key);
        resolve(false);
      }
    }, timeoutMs);
  });
}

// Cancel trip
router.put('/:id/cancel', authMiddleware, async (req: Request, res: Response) => {
  try {
  const tripId = req.params.id as string;
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) {
    res.status(404).json({ success: false, error: 'Trip not found' });
    return;
  }

  if (trip.passengerId !== req.user!.userId && trip.driverId !== req.user!.userId) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  if (['COMPLETED', 'CANCELLED'].includes(trip.status)) {
    res.status(400).json({ success: false, error: 'این سفر قابل لغو نیست' });
    return;
  }

  // Cancelled rides must not become permanently active, and a wallet charge
  // made before cancellation is refunded atomically with the status flip.
  const cancelData: Record<string, unknown> = { status: 'CANCELLED', cancelledAt: new Date() };
  let refundAmount = 0;
  if (trip.paymentStatus === 'PAID' && trip.paymentMethod === 'WALLET' && trip.finalFare) {
    refundAmount = Math.round(trip.finalFare);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.trip.update({
      where: { id: tripId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: cancelData,
    });
    if (refundAmount > 0) {
      const wallet = await tx.wallet.update({
        where: { userId: trip.passengerId },
        data: { balance: { increment: refundAmount } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          amount: refundAmount,
          type: 'CREDIT',
          source: 'REFUND',
          description: `بازگشت کرایه سفر لغوشده ${trip.id.slice(0, 8)}`,
          tripId: trip.id,
          balanceAfter: wallet.balance,
        },
      });
      await tx.trip.update({
        where: { id: trip.id },
        data: { paymentStatus: 'REFUNDED' },
      });
    }
    return cancelled;
  });

  if (trip.driverId) {
    await prisma.driverStatus.update({
      where: { userId: trip.driverId },
      data: { isOnTrip: false },
    });
  }

  io.to(`trip:${trip.id}`).emit('trip:cancelled', { tripId: trip.id, status: 'CANCELLED' });
  if (trip.driverId) {
    io.to(`driver:${trip.driverId}`).emit('trip:cancelled', { tripId: trip.id, status: 'CANCELLED' });
  }

  res.json({ success: true, data: updated });
  } catch (err) {
    // Concurrent transition (e.g. already completed/cancelled) → P2025 inside
    // the transaction. Return the authoritative state instead of crashing.
    console.error('[trip:cancel] error:', err);
    const current = await prisma.trip.findUnique({ where: { id: req.params.id as string } }).catch(() => null);
    res.status(409).json({ success: false, error: 'وضعیت سفر تغییر کرده است', data: current });
  }
});

// Update trip status (driver actions)
router.put('/:id/status', authMiddleware, requireRole('DRIVER'), async (req: Request, res: Response) => {
  try {
  const { status } = req.body;
  const validStatuses = ['DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({ success: false, error: 'Status non valide' });
    return;
  }

  const tripId2 = req.params.id as string;
  const trip = await prisma.trip.findUnique({ where: { id: tripId2 } });
  if (!trip || trip.driverId !== req.user!.userId) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  const transitionMap: Record<string, string[]> = {
    ACCEPTED: ['DRIVER_ARRIVING'],
    DRIVER_ARRIVING: ['DRIVER_ARRIVED'],
    DRIVER_ARRIVED: ['IN_PROGRESS'],
    IN_PROGRESS: ['COMPLETED'],
  };

  const allowedNext = transitionMap[trip.status];
  if (!allowedNext || !allowedNext.includes(status)) {
    res.status(400).json({ success: false, error: 'تغییر وضعیت مجاز نیست' });
    return;
  }

  const updateData: Record<string, unknown> = { status };
  if (status === 'IN_PROGRESS') updateData.startedAt = new Date();
  if (status === 'COMPLETED') {
    updateData.completedAt = new Date();

    if (trip.paymentMethod === 'WALLET') {
      // Charge the passenger's wallet atomically with the status flip:
      // balance check + decrement + ledger entry + payment flag happen in
      // one transaction, so concurrent completions can't double-charge and
      // an insufficient balance blocks the completion entirely.
      const fare = Math.round(trip.estimatedPrice);
      try {
        const [, updatedPaidTrip] = await prisma.$transaction([
          prisma.wallet.update({
            where: {
              userId: trip.passengerId,
              // Guard prevents negative balances under concurrency.
              balance: { gte: fare },
            },
            data: { balance: { decrement: fare } },
          }),
          prisma.trip.update({
            where: { id: tripId2, status: 'IN_PROGRESS' },
            data: { ...updateData, paymentStatus: 'PAID', finalFare: fare },
          }),
          ...(trip.driverId
            ? [
                prisma.driverStatus.update({
                  where: { userId: trip.driverId },
                  data: { isOnTrip: false },
                }),
              ]
            : []),
        ]);
        const wallet = await prisma.wallet.findUnique({ where: { userId: trip.passengerId } });
        if (wallet) {
          await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              amount: fare,
              type: 'DEBIT',
              source: 'RIDE_PAYMENT',
              description: `پرداخت کرایه سفر ${trip.id.slice(0, 8)}`,
              tripId: trip.id,
              balanceAfter: wallet.balance,
            },
          });
        }
        io.to(`trip:${trip.id}`).emit('trip:status', { tripId: trip.id, status: 'COMPLETED' });
        io.to(`trip:${trip.id}`).emit('trip:payment', { tripId: trip.id, paymentStatus: 'PAID', finalFare: fare, method: 'WALLET' });
        res.json({ success: true, data: updatedPaidTrip });
      } catch {
        res.status(409).json({ success: false, error: 'موجودی کیف پول کافی نیست؛ پرداخت نقدی انجام دهید' });
      }
      return;
    }

    // Cash: fare is settled on board; record it without touching the wallet.
    updateData.paymentStatus = 'PAID';
    updateData.finalFare = Math.round(trip.estimatedPrice);
  }

  let updated;
  try {
    // Optimistic concurrency: lock on the status we READ. The transitionMap
    // maps current → allowed targets; using it as the where-filter instead
    // made every transition fail with P2025 (e.g. ACCEPTED row guarded by
    // `in: ['DRIVER_ARRIVING']` never matches).
    const results = await prisma.$transaction([
      prisma.trip.update({
        where: { id: tripId2, status: trip.status },
        data: updateData,
      }),
      ...(status === 'COMPLETED' && trip.driverId
        ? [
            prisma.driverStatus.update({
              where: { userId: trip.driverId },
              data: { isOnTrip: false },
            }),
          ]
        : []),
    ]);
    updated = results[0];
  } catch {
    // P2025: the trip's authoritative status changed concurrently (cancelled,
    // completed by a duplicate tap, …). Never crash — return 409 with the
    // current state so the driver's UI re-syncs.
    const current = await prisma.trip.findUnique({ where: { id: tripId2 } });
    res.status(409).json({
      success: false,
      error: 'وضعیت سفر تغییر کرده است',
      data: current,
    });
    return;
  }

  io.to(`trip:${trip.id}`).emit('trip:status', { tripId: trip.id, status });
  res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[trip:status] error:', err);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Re-dispatch an unassigned request to drivers.
//
// A search that ends with NO_DRIVER_AVAILABLE is not a client permission to
// create a brand-new ride (that would duplicate the request after e.g. a slow
// network). Instead the passenger re-arms dispatch on the SAME trip id:
// - NO_DRIVER_AVAILABLE → flips back to SEARCHING and re-runs the driver loop.
// - Already active (SEARCHING/OFFERED/…) → no-op, returns the current trip.
// - Terminal (COMPLETED/CANCELLED) → rejected.
// Driver acceptance always takes precedence: the loop re-checks the status
// before offering, so a late acceptance is never overwritten.
router.put('/:id/retry-dispatch', authMiddleware, requireRole('PASSENGER'), async (req: Request, res: Response) => {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id as string } });
    if (!trip) {
      res.status(404).json({ success: false, error: 'Trip not found' });
      return;
    }
    if (trip.passengerId !== req.user!.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    if (['COMPLETED', 'CANCELLED'].includes(trip.status)) {
      res.status(400).json({ success: false, error: 'این سفر قابل ارسال مجدد نیست' });
      return;
    }

    if (trip.status !== 'NO_DRIVER_AVAILABLE') {
      // Idempotent no-op for any still-active request.
      res.json({ success: true, data: trip });
      return;
    }

    const updated = await prisma.trip.update({
      where: { id: trip.id },
      data: { status: 'SEARCHING' },
    });
    io.to(`trip:${trip.id}`).emit('trip:status', { tripId: trip.id, status: 'SEARCHING' });

    findAndOfferDriver(trip.id).catch((err) => {
      console.error('Driver re-dispatch error:', err);
    });

    res.json({ success: true, data: updated });
  } catch {
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Passenger trip history (terminal trips only). Fares shown are the charged
// estimates — the model stores no other final-amount field.
router.get('/history', authMiddleware, async (req: Request, res: Response) => {
  const trips = await prisma.trip.findMany({
    where: {
      passengerId: req.user!.userId,
      status: { in: ['COMPLETED', 'CANCELLED', 'NO_DRIVER_AVAILABLE'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      driver: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  });
  res.json({ success: true, data: { trips } });
});

// Get passenger's active trip
router.get('/active', authMiddleware, async (req: Request, res: Response) => {
  const where = req.user!.role === 'PASSENGER'
    ? { passengerId: req.user!.userId }
    : { driverId: req.user!.userId };

  const trip = await prisma.trip.findFirst({
    where: {
      ...where,
      status: { in: ['SEARCHING', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
    },
    include: req.user!.role === 'PASSENGER'
      ? { driver: { select: { id: true, firstName: true, lastName: true, phone: true } } }
      : { passenger: { select: { id: true, firstName: true, lastName: true, phone: true } } },
  });
  res.json({ success: true, data: trip });
});

// Get pricing config
router.get('/pricing', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      baseFare: config.pricing.baseFare,
      perKmRate: config.pricing.perKmRate,
      perMinRate: config.pricing.perMinRate,
    },
  });
});

// Reverse geocode
router.get('/reverse-geocode', authMiddleware, async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ success: false, error: 'Invalid coordinates' });
    return;
  }
  try {
    const result = await reverseGeocode(lat, lng);
    res.json({ success: true, data: { address: result.formatted_address } });
  } catch {
    res.status(502).json({ success: false, error: 'Reverse geocode failed' });
  }
});

// Search address using Neshan Geocoding Plus
router.post('/search-plus', authMiddleware, async (req: Request, res: Response) => {
  const { address, city, province, latitude, longitude } = req.body;
  if (!address) {
    res.status(400).json({ success: false, error: 'Address required' });
    return;
  }
  try {
    const result = await searchAddressPlus(address, city || 'تهران', province || 'تهران', latitude, longitude);
    res.json({ success: true, data: result });
  } catch {
    res.status(502).json({ success: false, error: 'Search failed' });
  }
});

// Real POI search (Neshan Search API v1) — proxied server-side so the
// service key never reaches the client.
router.get('/search', authMiddleware, async (req: Request, res: Response) => {
  const term = (req.query.term as string || '').trim();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!term) {
    res.status(400).json({ success: false, error: 'Term required' });
    return;
  }
  try {
    const result = await searchPoi(
      term,
      Number.isFinite(lat) ? lat : undefined,
      Number.isFinite(lng) ? lng : undefined
    );
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(502).json({ success: false, error: e?.message?.includes('401') || e?.message?.includes('403') ? 'کلید سرویس جست‌وجو دسترسی ندارد' : 'Search failed' });
  }
});

// Search address (simple)
router.get('/search-address', authMiddleware, async (req: Request, res: Response) => {
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ success: false, error: 'Query required' });
    return;
  }
  try {
    const result = await searchAddress(query);
    res.json({ success: true, data: result.items });
  } catch {
    res.status(502).json({ success: false, error: 'Search failed' });
  }
});

// Get trip details — keep last to avoid catching special paths
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  const tripId3 = req.params.id as string;
  const trip = await prisma.trip.findUnique({
    where: { id: tripId3 },
    include: {
      passenger: { select: { id: true, firstName: true, lastName: true, phone: true } },
      driver: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  });
  if (!trip) {
    res.status(404).json({ success: false, error: 'Trip not found' });
    return;
  }
  if (trip.passengerId !== req.user!.userId && trip.driverId !== req.user!.userId) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }
  res.json({ success: true, data: trip });
});

export async function reconcileDriverStates(): Promise<void> {
  try {
    const driversOnTrip = await prisma.driverStatus.findMany({
      where: { isOnTrip: true },
    });
    for (const d of driversOnTrip) {
      const activeTrip = await prisma.trip.findFirst({
        where: {
          driverId: d.userId,
          status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        },
      });
      if (!activeTrip) {
        await prisma.driverStatus.update({
          where: { userId: d.userId },
          data: { isOnTrip: false },
        });
        console.log(`[Reconcile] Fixed stale isOnTrip for driver ${d.userId}`);
      }
    }
  } catch (err) {
    console.error('[Reconcile] Error reconciling driver states:', err);
  }
}

export default router;