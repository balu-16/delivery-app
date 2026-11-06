import type { MapsPort, Point } from '../../modules/serviceability/contracts/maps.js';
import { FakeMaps } from './fake.js';
/** Resolve mutable configuration only when a maps operation is invoked. */
export class ConfigurableFakeMaps implements MapsPort {
  constructor(private readonly speed: () => Promise<number>) {}
  private async provider() {
    return new FakeMaps([], await this.speed());
  }
  async autocomplete(input: string) {
    return (await this.provider()).autocomplete(input);
  }
  async placeDetails(id: string) {
    return (await this.provider()).placeDetails(id);
  }
  async geocode(address: string) {
    return (await this.provider()).geocode(address);
  }
  async reverseGeocode(point: Point) {
    return (await this.provider()).reverseGeocode(point);
  }
  async directions(origin: Point, destination: Point) {
    return (await this.provider()).directions(origin, destination);
  }
  async distanceMatrix(origins: Point[], destinations: Point[]) {
    return (await this.provider()).distanceMatrix(origins, destinations);
  }
}
