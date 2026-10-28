const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000/api';

class ApiService {
  private token: string | null = null;
  // Optional global handler invoked on HTTP 401 — wires API failures to
  // AuthContext.logout without a circular import.
  private unauthorizedHandler: (() => void | Promise<void>) | null = null;

  setUnauthorizedHandler(h: (() => void | Promise<void>) | null) { this.unauthorizedHandler = h; }

  setToken(t: string | null) { this.token = t; }

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, { ...opts, headers: h });
    } catch (e: any) {
      // Server unreachable / offline / dev-server bundle failed to load.
      console.warn('[API] Network error', path, e?.message || e);
      throw new Error('عدم اتصال به سرور. اتصال اینترنت را بررسی کنید.');
    }
    if (res.status === 401 && this.unauthorizedHandler) {
      this.unauthorizedHandler();
    }

    let d: any;
    try {
      d = await res.json();
    } catch (e) {
      // Non-JSON body (e.g. dev-server error page, gateway HTML).
      console.warn('[API] Invalid response', path, 'status', res.status);
      throw new Error(`پاسخ نامعتبر از سرور (کد ${res.status}).`);
    }
    if (!d.success) throw new Error(d.error || 'Request failed');
    return d.data as T;
  }

  // Auth
  sendOtp = (phone: string, role: string) =>
    this.request<{ phone: string }>('/auth/send-otp', { method: 'POST', body: JSON.stringify({ phone, role }) });

  verifyOtp = (phone: string, otp: string, role: string, firstName?: string, lastName?: string) =>
    this.request<{ token: string; user: any }>('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone, otp, role, firstName, lastName }),
    });

  getProfile = () => this.request<any>('/auth/profile');

  // Trips
  estimateTrip = (oLat: number, oLng: number, dLat: number, dLng: number) =>
    this.request<any>('/trips/estimate', { method: 'POST', body: JSON.stringify({ originLat: oLat, originLng: oLng, destLat: dLat, destLng: dLng }) });

  createTrip = (oLat: number, oLng: number, oAddr: string, dLat: number, dLng: number, dAddr: string, paymentMethod: 'CASH' | 'WALLET' = 'CASH') =>
    this.request<any>('/trips', { method: 'POST', body: JSON.stringify({ originLat: oLat, originLng: oLng, originAddress: oAddr, destLat: dLat, destLng: dLng, destAddress: dAddr, paymentMethod }) });

  getActiveTrip = () => this.request<any>('/trips/active');

  getTrip = (id: string) => this.request<any>(`/trips/${id}`);

  /** Re-dispatch an unassigned request — same trip id, never a duplicate ride. */
  retryTrip = (id: string) => this.request<any>(`/trips/${id}/retry-dispatch`, { method: 'PUT' });

  cancelTrip = (id: string) => this.request<any>(`/trips/${id}/cancel`, { method: 'PUT' });

  updateTripStatus = (id: string, status: string) =>
    this.request<any>(`/trips/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });

  /** Terminal-trip history for the authenticated user (role-scoped server side). */
  getHistory = () => this.request<any>('/trips/history');

  updateProfile = (data: { firstName: string; lastName: string }) =>
    this.request<any>('/auth/profile', { method: 'PUT', body: JSON.stringify(data) });

  getDriverHistory = () => this.request<any>('/drivers/history');

  // Wallet
  getWallet = () => this.request<{ balance: number; transactions: any[] }>('/wallet');

  topupWallet = () =>
    this.request<any>('/wallet/topup', { method: 'POST', body: JSON.stringify({}) });

  getDriverStatus = () => this.request<any>('/drivers/status');

  updateDriverStatus = (data: { isOnline?: boolean; isAccepting?: boolean; latitude?: number; longitude?: number }) =>
    this.request<any>('/drivers/status', { method: 'PUT', body: JSON.stringify(data) });

  getDriverActiveTrip = () => this.request<any>('/drivers/active-trip');

  getPendingOffers = () => this.request<any[]>('/drivers/pending-offers');

  // Geocoding via backend proxy
  reverseGeocode = (lat: number, lng: number) =>
    this.request<{ address: string }>(`/trips/reverse-geocode?lat=${lat}&lng=${lng}`);

  searchAddress = (q: string) =>
    this.request<any[]>(`/trips/search-address?q=${encodeURIComponent(q)}`);

  /** Real place search via the Neshan Search API (server proxy). */
  searchPlaces = (term: string, lat?: number, lng?: number) => {
    const q = new URLSearchParams({ term });
    if (typeof lat === 'number' && typeof lng === 'number') {
      q.set('lat', String(lat));
      q.set('lng', String(lng));
    }
    return this.request<{ count: number; items: Array<{ title: string; address: string; neighbourhood?: string; region?: string; location: { x: number; y: number } }> }>(`/trips/search?${q.toString()}`);
  };

  searchAddressPlus = (address: string, city?: string, province?: string, lat?: number, lng?: number) =>
    this.request<any>('/trips/search-plus', {
      method: 'POST',
      body: JSON.stringify({ address, city: city || 'تهران', province: province || 'تهران', latitude: lat, longitude: lng }),
    });

  getPricing = () => this.request<any>('/trips/pricing');
}

export const api = new ApiService();