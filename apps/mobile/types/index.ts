export interface User {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: 'PASSENGER' | 'DRIVER';
  driverStatus?: DriverStatus;
}

export interface DriverStatus {
  id: string;
  userId: string;
  isOnline: boolean;
  isAccepting: boolean;
  isOnTrip: boolean;
  latitude: number | null;
  longitude: number | null;
}

export interface Trip {
  id: string;
  passengerId: string;
  driverId?: string;
  originLat: number;
  originLng: number;
  originAddress: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  distanceKm: number;
  durationMin: number;
  estimatedPrice: number;
  status: TripStatus;
  routeGeoJson?: string;
  createdAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  driver?: { id: string; firstName: string; lastName: string; phone?: string };
  passenger?: { id: string; firstName: string; lastName: string; phone?: string };
}

export type TripStatus =
  | 'SEARCHING' | 'OFFERED' | 'ACCEPTED'
  | 'DRIVER_ARRIVING' | 'DRIVER_ARRIVED'
  | 'IN_PROGRESS' | 'COMPLETED'
  | 'CANCELLED' | 'NO_DRIVER_AVAILABLE';

export interface TripOffer {
  tripId: string;
  originLat: number;
  originLng: number;
  originAddress: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  distanceKm: number;
  durationMin: number;
  estimatedPrice: number;
  driverDistanceKm: number;
}

export interface EstimateResult {
  distanceKm: number;
  durationMin: number;
  estimatedPrice: number;
  originAddress: string;
  destAddress: string;
  route: string | null;
}