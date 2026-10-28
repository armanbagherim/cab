export type Role = 'PASSENGER' | 'DRIVER';

export type TripStatus =
  | 'SEARCHING'
  | 'OFFERED'
  | 'ACCEPTED'
  | 'DRIVER_ARRIVING'
  | 'DRIVER_ARRIVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_DRIVER_AVAILABLE';

export interface JwtPayload {
  userId: string;
  phone: string;
  role: Role;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface NeshanRouteResult {
  status: string;
  distance: number; // meters
  duration: number; // seconds
  routes: Array<{
    overview_polyline: { points: string };
    legs: Array<{
      distance: { value: number; text: string };
      duration: { value: number; text: string };
    }>;
  }>;
}

export interface NeshanReverseResult {
  status: string;
  formatted_address: string;
  neighbourhood?: string;
  route_name?: string;
  city?: string;
}

export interface NeshanSearchResult {
  status: string;
  count: number;
  items: Array<{
    title: string;
    address: string;
    location: { x: number; y: number };
    neighbourhood?: string;
  }>;
}