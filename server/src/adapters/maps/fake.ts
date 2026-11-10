import type {
  MapsPort,
  Place,
  Point,
  RouteEstimate,
  Suggestion,
} from '../../modules/serviceability/contracts/maps.js';

export function haversineMetres(a: Point, b: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat = radians(b.lat - a.lat);
  const lng = radians(b.lng - a.lng);
  const value =
    Math.sin(lat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}
function coordinatePlace(text: string): Place | undefined {
  const match = /^(?:coordinates:)?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return undefined;
  return {
    id: `coordinates:${lat},${lng}`,
    description: `${lat},${lng}`,
    location: { lat, lng },
    degraded: true,
  };
}
export class FakeMaps implements MapsPort {
  constructor(
    private readonly places: readonly Place[],
    private readonly speedKph: number,
  ) {
    if (!Number.isFinite(speedKph) || speedKph <= 0) throw new Error('INVALID_FALLBACK_SPEED');
  }
  async autocomplete(input: string): Promise<Suggestion[]> {
    const coordinate = coordinatePlace(input);
    return [
      ...(coordinate ? [coordinate] : []),
      ...this.places.filter((p) =>
        p.description.toLocaleLowerCase('en-IN').includes(input.trim().toLocaleLowerCase('en-IN')),
      ),
    ].map(({ id, description }) => ({ id, description }));
  }
  async placeDetails(id: string): Promise<Place> {
    const place = coordinatePlace(id) ?? this.places.find((p) => p.id === id);
    if (!place) throw new Error('PLACE_NOT_FOUND');
    return place;
  }
  async geocode(address: string): Promise<Place[]> {
    const text = address.trim().toLocaleLowerCase('en-IN');
    const coordinate = coordinatePlace(text);
    return [
      ...(coordinate ? [coordinate] : []),
      ...this.places.filter((p) => p.description.toLocaleLowerCase('en-IN').includes(text)),
    ];
  }
  async reverseGeocode(point: Point): Promise<Place[]> {
    const place = coordinatePlace(`${point.lat},${point.lng}`);
    if (!place) throw new Error('INVALID_COORDINATES');
    return [place];
  }
  async directions(origin: Point, destination: Point): Promise<RouteEstimate> {
    const distanceMetres = Math.round(haversineMetres(origin, destination));
    return {
      distanceMetres,
      durationSeconds: Math.ceil(distanceMetres / (this.speedKph / 3.6)),
      degraded: true,
    };
  }
  async distanceMatrix(origins: Point[], destinations: Point[]): Promise<RouteEstimate[][]> {
    return Promise.all(
      origins.map((origin) =>
        Promise.all(destinations.map((destination) => this.directions(origin, destination))),
      ),
    );
  }
}
