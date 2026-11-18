import * as Location from 'expo-location';

/** Used only immediately before a new order when the admin requires GPS. */
export async function requireLocationServices(): Promise<void> {
  if (!(await Location.hasServicesEnabledAsync())) throw new Error('Turn on your phone location to place this order.');
  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== 'granted' && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Allow location access in your phone settings to place this order.');
}
