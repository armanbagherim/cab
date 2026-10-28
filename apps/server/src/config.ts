export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'fallback-dev-secret',
  otp: {
    devOtp: '123456',
    isDev: true,
  },
  pricing: {
    baseFare: 15000, // تومان
    perKmRate: 3000, // تومان per km
    perMinRate: 500, // تومان per minute
  },
  driverSearch: {
    timeoutMs: 15000, // per-driver offer timeout
    searchWindowMs: 150000, // total bounded search window (~2.5 min)
    pollIntervalMs: 8000, // re-scan for newly-available drivers while waiting
    maxRadiusKm: 5,
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