export interface Point {
  lat: number;
  lng: number;
}
export interface Place {
  id: string;
  description: string;
  location: Point;
  degraded?: boolean;
}
export interface Suggestion {
  id: string;
  description: string;
}
export interface RouteEstimate {
  distanceMetres: number;
  durationSeconds: number;
  degraded: boolean;
}
export interface MapsPort {
  autocomplete(input: string): Promise<Suggestion[]>;
  placeDetails(id: string): Promise<Place>;
  geocode(address: string): Promise<Place[]>;
  reverseGeocode(point: Point): Promise<Place[]>;
  directions(origin: Point, destination: Point): Promise<RouteEstimate>;
  distanceMatrix(origins: Point[], destinations: Point[]): Promise<RouteEstimate[][]>;
}
export interface MapsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
