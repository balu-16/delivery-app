import type { AddressDraft, AddressRepository } from '../contracts/addresses.js';
import { validateAddress } from '../domain/address.js';
import type { MapsPort } from '../../serviceability/contracts/maps.js';
import { distanceMetres } from '../domain/address.js';

export class Addresses {
  constructor(
    private readonly repository: AddressRepository,
    private readonly maxAddresses: () => Promise<number>,
    private readonly maps: MapsPort,
    private readonly mismatchMetres: () => Promise<number>,
  ) {}
  private async confirmation(
    draft: AddressDraft,
  ): Promise<{ needsConfirmation: boolean; degraded: boolean }> {
    const threshold = await this.mismatchMetres();
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('INVALID_MISMATCH_DISTANCE');
    try {
      const [place] = await this.maps.geocode(
        [draft.line1, draft.line2, draft.pincode].filter(Boolean).join(', '),
      );
      if (!place) return { needsConfirmation: false, degraded: true };
      return {
        needsConfirmation: distanceMetres(draft.point, place.location) > threshold,
        degraded: place.degraded === true,
      };
    } catch {
      // Saving the customer's explicit pin must remain possible during a provider outage.
      return { needsConfirmation: false, degraded: true };
    }
  }
  list(userId: string) {
    return this.repository.list(userId);
  }
  async create(userId: string, draft: AddressDraft, makeDefault = false) {
    validateAddress(draft);
    const max = await this.maxAddresses();
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('INVALID_ADDRESS_LIMIT');
    const confirmation = await this.confirmation(draft);
    return {
      address: await this.repository.create(userId, draft, max, makeDefault),
      ...confirmation,
    };
  }
  async update(userId: string, id: string, draft: AddressDraft, expectedVersion: string) {
    validateAddress(draft);
    if (!/^[1-9]\d*$/.test(expectedVersion)) throw new Error('INVALID_VERSION');
    const confirmation = await this.confirmation(draft);
    return {
      address: await this.repository.update(userId, id, draft, expectedVersion),
      ...confirmation,
    };
  }
  setDefault(userId: string, id: string) {
    return this.repository.setDefault(userId, id);
  }
  remove(userId: string, id: string) {
    return this.repository.remove(userId, id);
  }
}
