import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { ApiError, riderApi } from "./api";
import { getSessionIdentity } from './auth/session';

const LOCATION_TASK = "dairydirect-partner-location";
const ACTIVE_KEY = "dairydirect.partner.location-active.v1";

function point(location: Location.LocationObject) {
  return { ts: new Date(location.timestamp).toISOString(), lat: location.coords.latitude, lng: location.coords.longitude,
    ...(location.coords.accuracy !== null ? { accuracyM: location.coords.accuracy } : {}),
    ...(location.coords.speed !== null && location.coords.speed >= 0 ? { speedMps: location.coords.speed } : {}),
    ...(location.mocked !== undefined ? { isMock: location.mocked } : {}) };
}

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    try {
      const owner = await AsyncStorage.getItem(ACTIVE_KEY);
      if (!owner) return;
      if ((await getSessionIdentity()).subject !== owner) { await stopTracking(); return; }
      await riderApi.location(data.locations.slice(-50).map(point));
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403 || failure.code === 'RIDER_OFFLINE'))
        await stopTracking();
    }
  });
}

export async function stopTracking() {
  await AsyncStorage.removeItem(ACTIVE_KEY);
  if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

export async function startShift(subject: string) {
  if (Platform.OS === 'web' || !(await TaskManager.isAvailableAsync()))
    throw new Error('Going online requires an Android or iOS development build with background location.');
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Allow location access to go online.');
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) throw new Error('Allow background location in device settings to go online.');
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  if (position.mocked || (position.coords.accuracy !== null && position.coords.accuracy > 100))
    throw new Error('A reliable device location is required. Move to an open area and try again.');
  await riderApi.online();
  try {
    await AsyncStorage.setItem(ACTIVE_KEY, subject);
    const outcome = await riderApi.location([point(position)]);
    if (!outcome.accepted) throw new Error('Could not verify a fresh location. Please try again.');
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.High, timeInterval: 15000, distanceInterval: 0,
      pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true,
      foregroundService: { notificationTitle: 'DairyDirect shift is online',
        notificationBody: 'Your location is shared while you are online.', notificationColor: '#3D6D15', killServiceOnDestroy: false },
    });
  } catch (error) {
    await riderApi.offline().catch(() => undefined);
    await stopTracking().catch(() => undefined);
    throw error;
  }
}

export async function endShift() {
  await riderApi.offline();
  await stopTracking();
}

export async function reconcileTracking(subject: string, online: boolean) {
  if (!online) { await stopTracking(); return false; }
  const owner = await AsyncStorage.getItem(ACTIVE_KEY);
  if (owner !== subject) {
    // Never resume a different account's tracking session.
    await stopTracking();
    return false;
  }
  if (Platform.OS === 'web') return false;
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}
