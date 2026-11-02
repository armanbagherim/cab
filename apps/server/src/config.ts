export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'fallback-dev-secret',
  otp: {
    devOtp: '123456',
    isDev: true,
  },
  pricing: {
    baseFare: 25000, // تومان
    perKmRate: 4500, // تومان per km
    perMinRate: 700, // تومان per minute
  },
  driverSearch: {
    searchWindowMs: 150000, // total bounded search window (~2.5 min)
    pollIntervalMs: 8000, // re-scan for newly-available drivers while waiting
    radiusStepsKm: [2, 5, 10, 20],
    radiusExpandMs: 30000, // widen radius one step every 30 s of elapsed time
    maxParallelOffers: 3, // active offers outstanding at any time per trip
    offerTimeoutMs: 10000, // individual driver response deadline
    maxOffersPerDriver: 2, // bounded retry policy within one run
    reofferCooldownMs: 30000, // min gap before the same driver is re-offered
    locationFreshnessMs: 10000, // max age of a driver fix for ordinary eligibility
    locationGraceFactor: 6, // pool fallback age when no fresh drivers exist
  },
  location: {
    tehranBounds: {
      minLat: 35.55,
      maxLat: 35.85,
      minLng: 51.15,
      maxLng: 51.60,
    },
  },
  neshan: {
    tileApiKey: process.env.NESHAN_TILE_API_KEY || '',
    webMapApiKey: process.env.NESHAN_WEB_MAP_API_KEY || '',
    serviceApiKey: process.env.NESHAN_SERVICE_API_KEY || '',
  },
  payments: {
    // Payment gateway (IPG) credentials are not configured in this
    // environment; the wallet refuses top-ups honestly while this is false.
    gatewayConfigured: Boolean(process.env.PAYMENT_GATEWAY_MERCHANT_ID),
  },
};
