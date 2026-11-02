import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../middleware/auth';
import prisma from '../utils/prisma';
import { validateTehranCoord, calculatePrice, calculateDistance } from '../utils/helpers';
import { getRoute, reverseGeocode, searchAddress, searchAddressPlus, searchPoi } from '../services/neshan';
import { io, isDriverConnected } from '../socket/handler';
import { config } from '../config';

const router = Router();

const reverseGeocodeCache = new Map<string, string>();
const reverseGeocodeKey = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
async function resolveAddress(lat: number, lng: number): Promise<string> {
  const key = reverseGeocodeKey(lat, lng);
  const cached = reverseGeocodeCache.get(key);
  if (cached) return cached;
  const result = await reverseGeocode(lat, lng);
  const address = result.formatted_address || '';
  if (address) reverseGeocodeCache.set(key, address);
  return address;
}

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
  // Diagnostic context reused by every log line below (never contains the
  // bearer token — Authorization headers are not logged anywhere).
  const coords = {
    originLat: req.body?.originLat,
    originLng: req.body?.originLng,
    destLat: req.body?.destLat,
    destLng: req.body?.destLng,
  };
  try {
    const parsed = estimateSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn('[trip:estimate] request validation failed', {
        ...coords,
        userId: req.user?.userId,
        issues: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }
    const body = parsed.data;

    if (!validateTehranCoord(body.originLat, body.originLng) ||
        !validateTehranCoord(body.destLat, body.destLng)) {
      console.warn('[trip:estimate] coordinates outside Tehran bounds', coords);
      res.status(400).json({ success: false, error: 'مختصات خارج از محدوده مجاز تهران است' });
      return;
    }

    // Upstream routing failures must NOT surface as a naked 500 — mirror the
    // create-trip contract (502) so the client can offer a retry. This was
    // the actual root cause of the reported HTTP 500: any Neshan API failure
    // (rate limit 429, invalid/expired service key 401/403, network error)
    // thrown out of getRoute and fell straight into the generic catch.
    let routeResult;
    try {
      routeResult = await getRoute(body.originLat, body.originLng, body.destLat, body.destLng);
    } catch (e: any) {
      console.error('[trip:estimate] routing upstream failed', {
        ...coords,
        userId: req.user?.userId,
        error: e?.message || String(e),
      });
      res.status(502).json({ success: false, error: 'خطا در دریافت مسیر. لطفاً دوباره تلاش کنید' });
      return;
    }

    if (routeResult.status !== 'OK' || routeResult.distance <= 0) {
      console.warn('[trip:estimate] no usable route from upstream', {
        ...coords,
        userId: req.user?.userId,
        upstreamStatus: routeResult.status,
        upstreamDistance: routeResult.distance,
        routesCount: Array.isArray(routeResult.routes) ? routeResult.routes.length : 0,
      });
      res.status(400).json({ success: false, error: 'مسیریابی ناموفق بود' });
      return;
    }

    const distanceKm = routeResult.distance / 1000;
    const durationMin = Math.round(routeResult.duration / 60);
    const price = calculatePrice(distanceKm, durationMin);

    res.json({
      success: true,
      data: {
        distanceKm: Math.round(distanceKm * 10) / 10,
        durationMin,
        estimatedPrice: price,
        originAddress: '',
        destAddress: '',
        route: routeResult.routes[0]?.overview_polyline?.points || null,
      },
    });
  } catch (err) {
    console.error('[trip:estimate] unexpected error', { ...coords, userId: req.user?.userId, error: err });
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

    // Resolve addresses only for the final trip. Selection and estimates stay free.
    let originAddress = body.originAddress || '';
    let destAddress = body.destAddress || '';
    if (!originAddress || !destAddress) {
      const [resolvedOrigin, resolvedDest] = await Promise.all([
        originAddress ? Promise.resolve(originAddress) : resolveAddress(body.originLat, body.originLng).catch(() => ''),
        destAddress ? Promise.resolve(destAddress) : resolveAddress(body.destLat, body.destLng).catch(() => ''),
      ]);
      originAddress ||= resolvedOrigin;
      destAddress ||= resolvedDest;
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
    ensureDispatch(trip.id);

    res.json({ success: true, data: trip });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Dispatch core
//
// Design (single Node process; SQLite datasource):
// - One dispatcher loop per trip (`dispatchers` map guards duplication).
// - Up to `maxParallelOffers` offers can be outstanding at once; each offer
//   has a server-side identity, expiry timestamp and its own timer.
// - Candidates are re-selected from authoritative DB state on each refill;
//   nothing about eligibility is cached across polls.
// - Assignment is an atomic conditional transition (Prisma `updateMany`
//   guarded on `driverId: null` + eligible statuses); concurrent acceptances
//   race on affected-row count, exactly one wins. SQLite serializes writes,
//   so no extra locking layer is needed — and none is assumed beyond that.
// - The loop never blocks the process and never holds a DB transaction open
//   while waiting on sockets; wakeups are event-driven with a poll fallback.
// ---------------------------------------------------------------------------

interface OfferState {
  offerId: string;
  tripId: string;
  driverId: string;
  createdAtMs: number;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

interface DispatcherState {
  tripId: string;
  startedAtMs: number;
  radiusIndex: number;
  cancelled: boolean;
  /** Driver id -> number of offers made during this dispatch run. */
  attempts: Map<string, number>;
  /** Driver id -> last time this driver was offered (any trip run above). */
  lastAttemptMs: Map<string, number>;
  /** Candidate-scan log de-duplication (noisy per-poll logging guard). */
  lastAttemptScanSig?: string;
  /** Set when the loop crashed (transient failure) — blocks auto-re-arm so a
   * persistent DB error cannot spin dispatchers forever. */
  errored?: boolean;
  wakeups: Set<() => void>;
}

const dispatchers = new Map<string, DispatcherState>();
/** Active offers keyed `${tripId}:${driverId}`. */
const offersByKey = new Map<string, OfferState>();
/** Driver id -> trip ids with an active offer to that driver. */
export const offeredTripsByDriver = new Map<string, Set<string>>();

function offerKey(tripId: string, driverId: string): string {
  return `${tripId}:${driverId}`;
}

function offerLog(event: string, fields: Record<string, unknown>): void {
  console.log(`[DISPATCH] ${event}`, fields);
}

function wakeDispatcher(state: DispatcherState): void {
  for (const wake of state.wakeups) wake();
}

/** Promise that resolves after `ms` OR as soon as any wake() fires. */
function waitOrWake(state: DispatcherState, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      state.wakeups.delete(wake);
      resolve();
    }, ms);
    const wake = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        state.wakeups.delete(wake);
        resolve();
      }
    };
    state.wakeups.add(wake);
  });
}

function activeOfferCount(tripId: string): number {
  let n = 0;
  for (const key of offersByKey.keys()) if (key.startsWith(`${tripId}:`)) n++;
  return n;
}

/** Remove one offer (clearing its timer) WITHOUT notifying — notification is
 * the caller's decision so timeouts and wins emit the right events. */
function unregisterOffer(tripId: string, driverId: string): OfferState | null {
  const key = offerKey(tripId, driverId);
  const offer = offersByKey.get(key);
  if (!offer) return null;
  clearTimeout(offer.timer);
  offersByKey.delete(key);
  const trips = offeredTripsByDriver.get(driverId);
  trips?.delete(tripId);
  if (trips && trips.size === 0) offeredTripsByDriver.delete(driverId);
  return offer;
}

/** Expire a single offer: clears state and (unless silent) tells the driver
 * app its offer is gone. `silent` avoids racing `trip:accepted` on the wire
 * for the winning driver, whose client clears offers on that event. */
function expireOffer(tripId: string, driverId: string, reason: string, options?: { silent?: boolean }): void {
  const offer = unregisterOffer(tripId, driverId);
  if (!offer) return;
  if (!options?.silent) {
    io.to(`driver:${driverId}`).emit('trip:offer_expired', { tripId, offerId: offer.offerId });
  }
  offerLog('OFFER_END', {
    tripId, driverId, offerId: offer.offerId, reason,
    elapsedMs: Date.now() - (dispatchers.get(tripId)?.startedAtMs ?? offer.createdAtMs),
  });
  const state = dispatchers.get(tripId);
  if (state) wakeDispatcher(state); // freed slot → refill promptly
}

/** Expire every outstanding offer for a trip. `skipDriver` is the winning
 * driver on assignment (their client clears via `trip:accepted`). */
function expireAllTripOffers(tripId: string, reason: string, skipDriver?: string): void {
  for (const key of [...offersByKey.keys()]) {
    if (!key.startsWith(`${tripId}:`)) continue;
    const driverId = key.slice(tripId.length + 1);
    if (driverId === skipDriver) {
      unregisterOffer(tripId, driverId);
      continue;
    }
    expireOffer(tripId, driverId, reason);
  }
}

/** On assignment, a driver's offers for OTHER trips must die too — they are
 * now busy. Waking those dispatchers lets them refill from other drivers. */
function expireAllDriverOffers(driverId: string, exceptTripId: string, reason: string): void {
  const trips = offeredTripsByDriver.get(driverId);
  if (!trips) return;
  for (const tripId of [...trips]) {
    if (tripId !== exceptTripId) expireOffer(tripId, driverId, reason);
  }
  unregisterOffer(exceptTripId, driverId);
}

/** Called when a driver transitions stale → fresh (sent a location fix after
 * exceeding the freshness window). Wakes every active dispatcher so their
 * next candidate scan re-evaluates this driver immediately. Event-driven:
 * no dispatcher is created and no unbounded state is tracked per location. */
export function wakeDriverLocationRefresh(_driverId: string): void {
  for (const state of dispatchers.values()) {
    wakeDispatcher(state);
  }
}

/** Read-only access to a driver's outstanding offer (for /pending-offers). */
export function getOfferState(tripId: string, driverId: string): OfferState | null {
  return offersByKey.get(offerKey(tripId, driverId)) ?? null;
}

export function ensureDispatch(tripId: string): void {
  const existing = dispatchers.get(tripId);
  if (existing) {
    // Exactly one worker per trip; a second trigger just nudges the existing
    // loop to re-evaluate (cancel/assign/terminal checks are authoritative).
    offerLog('ALREADY_RUNNING', { tripId });
    wakeDispatcher(existing);
    return;
  }
  const state: DispatcherState = {
    tripId,
    startedAtMs: Date.now(),
    radiusIndex: 0,
    cancelled: false,
    attempts: new Map(),
    lastAttemptMs: new Map(),
    wakeups: new Set(),
  };
  dispatchers.set(tripId, state);
  runDispatcher(state)
    .catch((err) => console.error('[DISPATCH][ERROR]', { tripId, error: err?.message || err }))
    .finally(async () => {
      const exitedCancelled = state.cancelled;
      const exitedDeadline = Date.now() >= state.startedAtMs + config.driverSearch.searchWindowMs;
      dispatchers.delete(tripId);
      // Self-heal the small exit/registration race: if the map entry was
      // still present when an external trigger bailed out, the nudge went to
      // a dying loop. If the trip genuinely remains dispatchable (loop ended
      // early without terminal/assign/cancel), re-arm so the search is never
      // orphaned. Bounded by the same window conditions as the loop itself.
      if (!exitedCancelled && !exitedDeadline) {
        const recheck = await prisma.trip.findUnique({ where: { id: tripId }, select: { status: true } }).catch(() => null);
        if (recheck && ['SEARCHING', 'OFFERED'].includes(recheck.status)) {
          offerLog('REARM', { tripId, reason: 'loop_exited_early' });
          ensureDispatch(tripId);
        }
      }
    });
}

/** Immediately stop a trip's dispatcher and drop its offers. Used when the
 * passenger cancels (or on restart recovery); the loop exits without
 * finalizing the trip into NO_DRIVER_AVAILABLE. */
export function cancelDispatchForTrip(tripId: string, reason: string): void {
  const state = dispatchers.get(tripId);
  if (state) {
    state.cancelled = true;
    wakeDispatcher(state);
  }
  expireAllTripOffers(tripId, `dispatch_cancelled:${reason}`);
  offerLog('CANCELLED', { tripId, reason });
}

/** Radius strictly grows with elapsed dispatch time, never resets. */
function currentRadiusIndex(state: DispatcherState): number {
  const steps = config.driverSearch.radiusStepsKm;
  const idx = Math.min(
    steps.length - 1,
    Math.floor((Date.now() - state.startedAtMs) / config.driverSearch.radiusExpandMs),
  );
  if (idx > state.radiusIndex) state.radiusIndex = idx;
  return state.radiusIndex;
}

/**
 * Candidates from authoritative DB state. Eligibility (all confirmed server-side):
 * online + accepting + not on a trip + valid finite coordinates + location
 * fresh enough + reachable (connected socket) + no outstanding offer to this
 * or any other trip + within the bounded per-driver retry policy.
 * Ranking: intentional preferred-region feature first, then geodesic distance
 * to the confirmed pickup point, then fewer prior attempts, then driver id
 * (deterministic tie-break). No ETA/road-distance estimates exist in this
 * codebase, so straight-line distance is used and stated as such.
 */
async function selectCandidates(
  trip: { id: string; originLat: number; originLng: number },
  state: DispatcherState,
): Promise<Array<{
  driverId: string; distance: number; preferred: boolean; attempts: number;
}>> {
  const rows = await prisma.driverStatus.findMany({
    where: {
      isOnline: true,
      isAccepting: true,
      isOnTrip: false,
      latitude: { not: null },
      longitude: { not: null },
    },
    select: {
      userId: true, latitude: true, longitude: true, updatedAt: true,
      selectedActive: true, selectedLat: true, selectedLng: true, selectedRadiusKm: true,
      user: { select: { isActive: true } },
    },
  });
  // `isOnTrip` is a fast eligibility index, not the source of truth. Exclude
  // any driver with an authoritative active assignment as well, covering a
  // brief flag/transaction ordering window.
  const activeAssignments = await prisma.trip.findMany({
    where: {
      driverId: { not: null },
      status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
    },
    select: { driverId: true },
  });
  const busyDriverIds = new Set(activeAssignments.map((trip) => trip.driverId).filter((id): id is string => Boolean(id)));

  const now = Date.now();
  const radiusKm = config.driverSearch.radiusStepsKm[currentRadiusIndex(state)];
  const freshCutoff = now - config.driverSearch.locationFreshnessMs;
  const graceCutoff = now - config.driverSearch.locationFreshnessMs * config.driverSearch.locationGraceFactor;

  type Candidate = { driverId: string; distance: number; preferred: boolean; attempts: number };
  const fresh: Candidate[] = [];
  const staleGrace: Candidate[] = [];
  for (const row of rows) {
    if (busyDriverIds.has(row.userId) || !row.user.isActive) continue;
    const lat = row.latitude!;
    const lng = row.longitude!;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    // Reachability: only promise offers a connected client can actually see.
    if (!isDriverConnected(row.userId)) continue;
    // Never re-offer a driver who already holds an offer for this or any trip.
    if (offeredTripsByDriver.has(row.userId)) continue;
    const attempts = state.attempts.get(row.userId) ?? 0;
    if (attempts >= config.driverSearch.maxOffersPerDriver) continue;
    const last = state.lastAttemptMs.get(row.userId);
    if (last !== undefined && now - last < config.driverSearch.reofferCooldownMs) continue;
    const distance = calculateDistance(trip.originLat, trip.originLng, lat, lng);
    if (distance > radiusKm) continue;
    const updatedAtMs = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    if (updatedAtMs < now - config.driverSearch.staleDriverMs) continue;
    const preferred = Boolean(
      row.selectedActive && row.selectedLat !== null && row.selectedLng !== null
      && calculateDistance(trip.originLat, trip.originLng, row.selectedLat, row.selectedLng) <= row.selectedRadiusKm,
    );
    const candidate = { driverId: row.userId, distance, preferred, attempts };
    if (updatedAtMs >= freshCutoff) fresh.push(candidate);
    else if (updatedAtMs >= graceCutoff) staleGrace.push(candidate);
  }

  // Prefer a slightly stale pool (brief network gaps) over an empty one.
  // The location-age bound only widens here; the search radius never shrinks.
  const pool = fresh.length > 0 ? fresh : staleGrace;
  const candidates = pool.sort((a, b) =>
    Number(b.preferred) - Number(a.preferred)
    || a.distance - b.distance
    || a.attempts - b.attempts
    || a.driverId.localeCompare(b.driverId));
  // Avoid noisy per-poll logging: only log scans that could spawn offers
  // (radius change, new candidates, grace-fallback engaged).
  const scanSig = `${radiusKm}|${candidates.length}|${fresh.length === 0 && staleGrace.length > 0}`;
  if (state.lastAttemptScanSig !== scanSig) {
    state.lastAttemptScanSig = scanSig;
    offerLog('SCAN', {
      tripId: state.tripId,
      radiusKm,
      connected: rows.length,
      candidates: candidates.length,
      usedGracePool: fresh.length === 0 && staleGrace.length > 0,
    });
  }
  return candidates;
}

async function createOffer(
  trip: { id: string; originLat: number; originLng: number; originAddress: string; destLat: number; destLng: number; destAddress: string; distanceKm: number; durationMin: number; estimatedPrice: number },
  state: DispatcherState,
  driverOffer: { driverId: string; distance: number; attempts: number },
): Promise<void> {
  const { tripId, driverId } = { tripId: trip.id, driverId: driverOffer.driverId };
  const key = offerKey(tripId, driverId);
  if (offersByKey.has(key)) return; // idempotent against wake races

  // Re-check the trip is still dispatchable before pinning OFFERED.
  await prisma.trip.updateMany({
    where: { id: tripId, status: 'SEARCHING' },
    data: { status: 'OFFERED' },
  });
  const current = await prisma.trip.findUnique({ where: { id: tripId }, select: { status: true } });
  if (!current || !['SEARCHING', 'OFFERED'].includes(current.status)) return; // cancelled / assigned meanwhile

  const offerId = randomUUID();
  const expiresAtMs = Date.now() + config.driverSearch.offerTimeoutMs;
  const entry: OfferState = {
    offerId,
    tripId,
    driverId,
    createdAtMs: Date.now(),
    expiresAtMs,
    timer: setTimeout(() => {
      // Fires at most once; dispatchers wake so the freed slot refills fast.
      expireOffer(tripId, driverId, 'timeout');
    }, config.driverSearch.offerTimeoutMs),
  };
  offersByKey.set(key, entry);
  if (!offeredTripsByDriver.has(driverId)) offeredTripsByDriver.set(driverId, new Set());
  offeredTripsByDriver.get(driverId)!.add(tripId);
  state.attempts.set(driverId, driverOffer.attempts + 1);
  state.lastAttemptMs.set(driverId, Date.now());

  io.to(`driver:${driverId}`).emit('trip:offer', {
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
    driverDistanceKm: Math.round(driverOffer.distance * 10) / 10,
    // New, additive fields — existing clients ignore unknown keys.
    offerId,
    offerExpiresAt: new Date(expiresAtMs).toISOString(),
  });
  offerLog('OFFER', {
    tripId, driverId, offerId, distanceKm: Math.round(driverOffer.distance * 10) / 10,
    attempt: driverOffer.attempts + 1,
    activeOffers: activeOfferCount(tripId),
    elapsedMs: Date.now() - state.startedAtMs,
  });
}

/** Timeout-expiry pruning shared by the loop and timers themselves. */
async function pruneExpiredOffers(state: DispatcherState): Promise<void> {
  const now = Date.now();
  for (const [key, offer] of [...offersByKey.entries()]) {
    if (!key.startsWith(`${state.tripId}:`)) continue;
    if (now >= offer.expiresAtMs) {
      expireOffer(state.tripId, offer.driverId, 'timeout');
    }
  }
}

/** Terminal transition at deadline — strictly conditional so an accepted,
 * cancelled or completed trip can never be overwritten. */
async function finalizeNoDriverWindow(state: DispatcherState): Promise<void> {
  expireAllTripOffers(state.tripId, 'dispatch_deadline');
  const res = await prisma.trip.updateMany({
    where: { id: state.tripId, driverId: null, status: { in: ['SEARCHING', 'OFFERED'] } },
    data: { status: 'NO_DRIVER_AVAILABLE' },
  });
  if (res.count === 1) {
    io.to(`trip:${state.tripId}`).emit('trip:status', { tripId: state.tripId, status: 'NO_DRIVER_AVAILABLE' });
    offerLog('NO_DRIVER_AVAILABLE', { tripId: state.tripId, elapsedMs: Date.now() - state.startedAtMs });
  } else {
    offerLog('FINALIZE_SKIPPED', { tripId: state.tripId, reason: 'trip_left_dispatchable_state' });
  }
}

async function runDispatcher(state: DispatcherState): Promise<void> {
  const tripId = state.tripId;
  const deadline = state.startedAtMs + config.driverSearch.searchWindowMs;
  offerLog('START', { tripId, windowMs: config.driverSearch.searchWindowMs, maxParallelOffers: config.driverSearch.maxParallelOffers });

  try {
    while (!state.cancelled && Date.now() < deadline) {
      let trip = await prisma.trip.findUnique({ where: { id: tripId } });
      if (!trip || !['SEARCHING', 'OFFERED'].includes(trip.status)) return;

      await pruneExpiredOffers(state);

      const slots = config.driverSearch.maxParallelOffers - activeOfferCount(tripId);
      if (slots > 0) {
        const candidates = await selectCandidates(trip, state);
        for (const candidate of candidates.slice(0, slots)) {
          // Each offer re-verifies the trip; stop the moment state moves on.
          trip = await prisma.trip.findUnique({ where: { id: tripId } });
          if (!trip || !['SEARCHING', 'OFFERED'].includes(trip.status)) return;
          if (activeOfferCount(tripId) >= config.driverSearch.maxParallelOffers) break;
          await createOffer(trip, state, candidate);
        }
      }

      const active = activeOfferCount(tripId);
      if (Date.now() >= deadline) break;
      if (active === 0) {
        // No offer outstanding: keep polling for newly eligible drivers.
        await waitOrWake(state, config.driverSearch.pollIntervalMs);
      } else {
        // Wake early whenever any offer resolves (accept/decline/timeout).
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const [key, offer] of offersByKey.entries()) {
          if (key.startsWith(`${tripId}:`) && offer.expiresAtMs < nextExpiry) {
            nextExpiry = offer.expiresAtMs;
          }
        }
        const msToExpiry = Math.max(0, nextExpiry - Date.now());
        await waitOrWake(state, Math.min(msToExpiry + 50, config.driverSearch.pollIntervalMs));
      }
    }
  } finally {
    if (!state.cancelled && Date.now() >= deadline) {
      await finalizeNoDriverWindow(state);
    } else {
      // Cancelled by assignment / terminal trip / cancel route: drop any
      // leftovers (win path already removed the winner's offer silently).
      expireAllTripOffers(tripId, 'dispatcher_stopped');
    }
  }
}

// ---------------------------------------------------------------------------
// Offer response arbitration (invoked from the Socket.IO handler, which has
// already authenticated the driver and enforced role authorization).
// ---------------------------------------------------------------------------

/**
 * Handles `trip:respond` for one outstanding offer. Idempotent: duplicate,
 * delayed or replayed responses after expiry/no-op against a missing offer;
 * a late acceptance can never revive an expired or terminal trip.
 * Exactly one concurrent acceptance wins via a conditional DB transition;
 * losers keep searching and their offers expire — and NOT the winner's
 * (its client clears state on `trip:accepted`).
 */
export async function handleTripResponse(
  tripId: string,
  driverId: string,
  accepted: boolean,
  responseOfferId?: string,
): Promise<void> {
  const key = offerKey(tripId, driverId);
  const offer = offersByKey.get(key);
  if (!offer) {
    offerLog('RESPONSE_IGNORED', { tripId, driverId, reason: 'no_outstanding_offer' });
    return;
  }
  // New clients echo the server-issued identity. Older clients omit it for
  // compatibility; their response is still constrained by the authenticated
  // driver + exact outstanding trip offer.
  if (responseOfferId && responseOfferId !== offer.offerId) {
    offerLog('RESPONSE_IGNORED', { tripId, driverId, responseOfferId, reason: 'offer_id_mismatch' });
    return;
  }
  if (Date.now() > offer.expiresAtMs) {
    expireOffer(tripId, driverId, 'late_response_after_expiry');
    return;
  }

  if (!accepted) {
    expireOffer(tripId, driverId, 'declined');
    return;
  }

  // Acceptance — atomic claim. The trip claim is guarded on `driverId: null`
  // plus eligible statuses; the driver claim is guarded on `isOnTrip: false`.
  // Both run inside one short transaction (no socket I/O inside), so a
  // concurrent acceptance's affected-row count decides the single winner.
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const claimed = await tx.trip.updateMany({
        where: { id: tripId, driverId: null, status: { in: ['SEARCHING', 'OFFERED'] } },
        data: { driverId, status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (claimed.count !== 1) return 'lost_trip_race';
      const driverClaim = await tx.driverStatus.updateMany({
        where: { userId: driverId, isOnTrip: false },
        data: { isOnTrip: true },
      });
      if (driverClaim.count !== 1) {
        // Driver became busy elsewhere between offer and response: roll the
        // trip claim back inside the same transaction.
        const reverted = await tx.trip.updateMany({
          where: { id: tripId, driverId, status: 'ACCEPTED' },
          data: { driverId: null, status: 'OFFERED' },
        });
        if (reverted.count !== 1) return 'trip_moved_though'; // cancelled meanwhile — leave as-is
        return 'driver_busy';
      }
      return 'assigned';
    });
    if (outcome !== 'assigned') {
      expireOffer(tripId, driverId, outcome === 'driver_busy' ? 'driver_became_busy' : 'lost_assignment_race');
      return;
    }
  } catch (err) {
    // Transient DB failure: do NOT declare no-driver; leave the offer valid
    // to expire naturally and let the dispatcher re-drive.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[DISPATCH][ASSIGN_DB_ERROR]', { tripId, driverId, error: message });
    return;
  }

  // ---- Winner path ----
  const state = dispatchers.get(tripId);
  if (state) {
    state.cancelled = true;
    wakeDispatcher(state);
  }
  offerLog('ASSIGNED', {
    tripId, driverId, offerId: offer.offerId,
    elapsedMs: Date.now() - (state?.startedAtMs ?? offer.createdAtMs),
  });

  // Winner's own offer disappears silently (their trip:accepted arrives).
  unregisterOffer(tripId, driverId);
  // Everyone else's offers for this trip end; they must not stay occupied.
  expireAllTripOffers(tripId, 'assigned_elsewhere', driverId);
  // A busy driver's offers for other trips end too; those dispatchers refill.
  expireAllDriverOffers(driverId, tripId, 'driver_assigned_elsewhere');

  io.to(`trip:${tripId}`).emit('trip:accepted', { tripId, driverId, status: 'ACCEPTED' });
  io.to(`driver:${driverId}`).emit('trip:accepted', { tripId, status: 'ACCEPTED' });
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

  // Stop the dispatcher and invalidate every outstanding offer atomically
  // with the cancellation, so no stale worker keeps emitting offers.
  if (['SEARCHING', 'OFFERED', 'NO_DRIVER_AVAILABLE'].includes(trip.status)) {
    cancelDispatchForTrip(tripId, 'passenger_cancelled');
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

    const updated = await prisma.trip.updateMany({
      where: { id: trip.id, status: 'NO_DRIVER_AVAILABLE' },
      data: { status: 'SEARCHING' },
    });
    if (updated.count !== 1) {
      // Concurrent re-arm already ran; report the reloaded trip.
      const current = await prisma.trip.findUnique({ where: { id: trip.id } });
      res.json({ success: true, data: current });
      return;
    }
    io.to(`trip:${trip.id}`).emit('trip:status', { tripId: trip.id, status: 'SEARCHING' });

    ensureDispatch(trip.id);
    const updatedOne = await prisma.trip.findUnique({ where: { id: trip.id } });

    res.json({ success: true, data: updatedOne });
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
    const address = await resolveAddress(lat, lng);
    res.json({ success: true, data: { address } });
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
        // Conditional update: an acceptance may have committed between our
        // read and this write; only clear when there is really no live
        // assigned trip (relation `driverId = driver` is implied).
        const cleared = await prisma.driverStatus.updateMany({
          where: {
            userId: d.userId,
            isOnTrip: true,
            NOT: {
              user: {
                assignedTrips: {
                  some: { status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] } },
                },
              },
            },
          },
          data: { isOnTrip: false },
        });
        if (cleared.count === 1) {
          console.log(`[Reconcile] Fixed stale isOnTrip for driver ${d.userId}`);
        }
      }
    }

    // Restart recovery: outstanding offers are in-memory only and died with
    // the previous process. Re-arm dispatch on every still-dispatchable trip
    // so passengers are not left stuck in SEARCHING/OFFERED limbo. `OFFERED`
    // offers can no longer be answered (no in-memory identity) — revert them
    // to SEARCHING under an exact-status guard so a real acceptance in flight
    // is never clobbered.
    const orphanSearch = await prisma.trip.findMany({
      where: { status: 'SEARCHING', createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
      select: { id: true },
      take: 100,
    });
    const orphanOffered = await prisma.trip.findMany({
      where: { status: 'OFFERED', createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
      select: { id: true },
      take: 100,
    });
    for (const trip of orphanOffered) {
      const reverted = await prisma.trip.updateMany({
        where: { id: trip.id, driverId: null, status: 'OFFERED' },
        data: { status: 'SEARCHING' },
      });
      if (reverted.count === 1) {
        console.log('[DISPATCH][RESTART_RECOVERY] offer lost to restart, re-searching', { tripId: trip.id });
      }
    }
    for (const trip of [...orphanSearch, ...orphanOffered]) {
      ensureDispatch(trip.id);
    }
  } catch (err) {
    console.error('[Reconcile] Error reconciling driver states:', err);
  }
}

export default router;
