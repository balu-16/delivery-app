/// <reference types="jest" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AddressPanel } from '../components/connected/AddressPanel';
import { ApiError } from '../src/api/client';

const mockAddAddress = jest.fn();
const mockConfirmAddressLocation = jest.fn(async () => ({ temporarilyUnavailable: false, needsConfirmation: false, degraded: false }));
const mockRefreshAddresses = jest.fn(async () => undefined);
const mockRefreshDeliverySettings = jest.fn(async () => true);
const mockAutocomplete = jest.fn(async (_token: string, _input: string, _signal?: AbortSignal) => [] as { id: string; description: string }[]);
const mockDetails = jest.fn(async (_token: string, _placeId: string, _signal?: AbortSignal): Promise<{ id: string; description: string; location: { lat: number; lng: number }; pincode?: string }> => ({
  id: 'place-1', description: 'Vijayawada Junction, Vijayawada, 520001', location: { lat: 16.50547, lng: 80.64823 }, pincode: '520001',
}));
let mockLocationRequired = true;
let mockUserId = 'user-1';
let mockLocationStatus = 'granted';
jest.mock('../src/store/customer', () => {
  const buildState = () => ({
    addresses: [] as never[],
    selectedAddress: null as string | null,
    profile: { userId: mockUserId, email: 'a@x.in', name: 'A Customer', locale: null },
    locationRequired: mockLocationRequired,
    chooseAddress: jest.fn(),
    addAddress: mockAddAddress,
    confirmAddressLocation: mockConfirmAddressLocation,
    refreshAddresses: mockRefreshAddresses,
    refreshDeliverySettings: mockRefreshDeliverySettings,
    checkoutPhase: 'idle',
    addressBusy: false,
    busy: false,
  });
  const useCustomer = (selector?: (state: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  };
  useCustomer.getState = () => buildState();
  return { useCustomer };
});
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: mockLocationStatus })),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({coords:{latitude:16.50547,longitude:80.64823,accuracy:10}}),
}));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn(async () => 'token-1') }));
jest.mock('../src/api/customer', () => ({
  customerPlacesApi: {
    autocomplete: (...args: unknown[]) => (mockAutocomplete as (...a: unknown[]) => unknown)(...args),
    details: (...args: unknown[]) => (mockDetails as (...a: unknown[]) => unknown)(...args),
  },
}));
jest.mock('../components/ui/BottomSheet', () => {
  const React = require('react'); const { View } = require('react-native');
  return { BottomSheet: ({visible,children}: {visible:boolean;children:React.ReactNode}) => visible ? React.createElement(View,null,children) : null };
});
jest.mock('../components/ui/Button', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { Button: ({label,onPress,disabled}: {label:string;onPress:()=>void;disabled?:boolean}) => React.createElement(Pressable,{onPress,disabled,accessibilityRole:'button'},React.createElement(Text,null,label)) };
});

beforeEach(() => {
  mockLocationRequired = true;
  mockAddAddress.mockReset().mockResolvedValue({ id:'address-1', locationNeeded:true, needsConfirmation:false, degraded:false, temporarilyUnavailable:false });
});

test('does not replace typed address details when the delivery location setting refreshes', async () => {
  const seed = {line1:'Initial address'};
  const onClose = jest.fn();
  const view = await render(<AddressPanel visible seed={seed} onClose={onClose} />);
  await fireEvent.changeText(screen.getByLabelText('House and street'), 'My edited address');
  mockLocationRequired = false;
  await view.rerender(<AddressPanel visible seed={seed} onClose={onClose} />);
  expect(screen.getByLabelText('House and street').props.value).toBe('My edited address');
});

beforeEach(() => {
  mockUserId = 'user-1';
  mockLocationStatus = 'granted';
  mockAutocomplete.mockReset().mockResolvedValue([]);
  mockDetails.mockReset().mockResolvedValue({ id: 'place-1', description: 'Vijayawada Junction, Vijayawada, 520001', location: { lat: 16.50547, lng: 80.64823 }, pincode: '520001' });
  mockConfirmAddressLocation.mockReset().mockResolvedValue({ temporarilyUnavailable: false, needsConfirmation: false, degraded: false });
  mockAddAddress.mockReset().mockResolvedValue({ id:'address-1', locationNeeded:true, needsConfirmation:false, degraded:false, temporarilyUnavailable:false });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function openSearch() {
  await render(<AddressPanel visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Add address'));
  return screen.getByLabelText('Search a place or landmark');
}

test('saves an address without GPS and explains how to confirm location later', async () => {
  await render(<AddressPanel visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Add address'));
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520001');
  await fireEvent.changeText(screen.getByLabelText('Contact name'), 'A Customer');
  await fireEvent.changeText(screen.getByLabelText('Contact phone'), '9876543210');
  await fireEvent.press(screen.getByText('Save address'));
  expect(screen.getByText(/Address saved. When you are at this address/)).toBeTruthy();
  expect(screen.queryByText('Enter a valid 10-digit Indian phone number.')).toBeNull();
  expect(mockAddAddress).toHaveBeenCalledWith({line1:'12 Main Street',contactName:'A Customer',contactPhone:'+919876543210',pincode:'520001'});
});

test('shows Ola attribution and privacy notice before the first search, and replaces the map placeholder', async () => {
  await openSearch();
  expect(screen.queryByText('Search on map')).toBeNull();
  expect(screen.getByLabelText('Search a place or landmark')).toBeTruthy();
  expect(screen.getByText(/Location search by Ola Maps/)).toBeTruthy();
  expect(screen.getByLabelText('Ola privacy notice')).toBeTruthy();
  expect(screen.getByText('Use current location')).toBeTruthy();
});

test('does not search until three trimmed characters', async () => {
  mockAutocomplete.mockResolvedValue([]);
  const input = await openSearch();
  await fireEvent.changeText(input, '  ab');
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(mockAutocomplete).not.toHaveBeenCalled();
  expect(screen.queryByText('Searching…')).toBeNull();
});

test('debounces, shows up to five suggestions, and hides the attribution notice after searching', async () => {
  mockAutocomplete.mockResolvedValue([1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `place-${n}`, description: `Landmark ${n}` })));
  const input = await openSearch();
  await fireEvent.changeText(input, 'Vijayawada');
  expect(await screen.findByText('Landmark 1')).toBeTruthy();
  expect(screen.getByText('Landmark 5')).toBeTruthy();
  expect(screen.queryByText('Landmark 6')).toBeNull();
  expect(mockAutocomplete).toHaveBeenCalledTimes(1);
  expect(mockAutocomplete.mock.calls[0][1]).toBe('Vijayawada');
  expect(screen.queryByLabelText('Ola privacy notice')).toBeNull();
});

test('clearing the query removes suggestions', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  expect(await screen.findByText('Junction')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Search a place or landmark'), '');
  await waitFor(() => expect(screen.queryByText('Junction')).toBeNull());
  expect(mockAutocomplete).toHaveBeenCalledTimes(1);
});

test('a valid empty search shows the empty message', async () => {
  mockAutocomplete.mockResolvedValue([]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Nowhere Road');
  expect(await screen.findByText('No places found. Try a nearby landmark.')).toBeTruthy();
});

test('cancels a superseded autocomplete request and drops its late result', async () => {
  const first = deferred<{ id: string; description: string }[]>();
  mockAutocomplete.mockReturnValueOnce(first.promise).mockResolvedValue([{ id: 'place-2', description: 'Fresh Result' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Vijayawada');
  await screen.findByText('Searching…');
  await fireEvent.changeText(screen.getByLabelText('Search a place or landmark'), 'Vijayawada Junction');
  expect(await screen.findByText('Fresh Result')).toBeTruthy();
  expect(mockAutocomplete.mock.calls[0][2]).toBeTruthy();
  expect((mockAutocomplete.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
  first.resolve([{ id: 'place-1', description: 'Stale Result' }]);
  await waitFor(() => expect(screen.queryByText('Stale Result')).toBeNull());
  expect(screen.getByText('Fresh Result')).toBeTruthy();
});

test('selection fetches details once, shows the place, and prefills empty landmark and PIN', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  mockDetails.mockResolvedValue({ id: 'place-1', description: 'Vijayawada Junction, Vijayawada, 520001', location: { lat: 16.50547, lng: 80.64823 }, pincode: '520001' });
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  await waitFor(() => expect(screen.getByLabelText('Area and landmark').props.value).toBe('Vijayawada Junction, Vijayawada, 520001'));
  expect(mockDetails).toHaveBeenCalledTimes(1);
  expect(mockDetails.mock.calls[0][1]).toBe('place-1');
  expect(screen.getByLabelText('PIN code').props.value).toBe('520001');
  expect(screen.getByText(/Selected: Vijayawada Junction/)).toBeTruthy();
});

test('typed landmark and PIN survive while details are loading', async () => {
  const pending = deferred<{ id: string; description: string; location: { lat: number; lng: number }; pincode: string }>();
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  mockDetails.mockReturnValue(pending.promise);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  expect(await screen.findByText('Loading place…')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Area and landmark'), 'Typed corner');
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520009');
  pending.resolve({ id: 'place-1', description: 'Vijayawada Junction, Vijayawada, 520001', location: { lat: 16.50547, lng: 80.64823 }, pincode: '520001' });
  await waitFor(() => expect(screen.queryByText('Loading place…')).toBeNull());
  expect(screen.getByLabelText('Area and landmark').props.value).toBe('Typed corner');
  expect(screen.getByLabelText('PIN code').props.value).toBe('520009');
  expect(screen.getByText('Check the PIN code for this address.')).toBeTruthy();
});

test('a PIN differing from the selected place asks to check it, and a match clears the message', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  await waitFor(() => expect(screen.getByLabelText('PIN code').props.value).toBe('520001'));
  expect(screen.queryByText('Check the PIN code for this address.')).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520002');
  expect(screen.getByText('Check the PIN code for this address.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520001');
  expect(screen.queryByText('Check the PIN code for this address.')).toBeNull();
});

test('a place without a pincode leaves the PIN empty with no mismatch', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  mockDetails.mockResolvedValue({ id: 'place-1', description: 'Junction, Vijayawada', location: { lat: 16.50547, lng: 80.64823 } });
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  await waitFor(() => expect(screen.getByLabelText('Area and landmark').props.value).toBe('Junction, Vijayawada'));
  expect(screen.getByLabelText('PIN code').props.value).toBe('');
  expect(screen.queryByText('Check the PIN code for this address.')).toBeNull();
});

test('a provider failure shows the unavailable message with retry, keeping typed fields', async () => {
  mockAutocomplete.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ id: 'place-1', description: 'Junction' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  expect(await screen.findByText('Address search unavailable. Enter it manually.')).toBeTruthy();
  expect(screen.getByText('Retry')).toBeTruthy();
  await fireEvent.press(screen.getByText('Retry'));
  expect(await screen.findByText('Junction')).toBeTruthy();
  expect(screen.getByLabelText('House and street').props.value).toBe('12 Main Street');
});

test('an expired session during search asks to sign in again', async () => {
  mockAutocomplete.mockRejectedValue(new ApiError(401, 'REQUEST_FAILED'));
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  expect(await screen.findByText('Sign in again to continue.')).toBeTruthy();
});

test('a missing selection asks to choose another result', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-x', description: 'Gone Place' }]);
  mockDetails.mockRejectedValue(new ApiError(404, 'PLACE_NOT_FOUND'));
  const input = await openSearch();
  await fireEvent.changeText(input, 'Gone');
  await fireEvent.press(await screen.findByLabelText('Select Gone Place'));
  expect(await screen.findByText('That place is unavailable. Choose another result.')).toBeTruthy();
});

test('closing the sheet drops a late search result and aborts the request', async () => {
  const pending = deferred<{ id: string; description: string }[]>();
  mockAutocomplete.mockReturnValue(pending.promise);
  const onClose = jest.fn();
  const view = await render(<AddressPanel visible onClose={onClose} />);
  await fireEvent.press(screen.getByText('Add address'));
  await fireEvent.changeText(screen.getByLabelText('Search a place or landmark'), 'Junction');
  await screen.findByText('Searching…');
  await view.rerender(<AddressPanel visible={false} onClose={onClose} />);
  expect((mockAutocomplete.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
  pending.resolve([{ id: 'place-1', description: 'Late Place' }]);
  await view.rerender(<AddressPanel visible onClose={onClose} />);
  expect(screen.queryByText('Late Place')).toBeNull();
});

test('switching accounts drops a late search result', async () => {
  const pending = deferred<{ id: string; description: string }[]>();
  mockAutocomplete.mockReturnValue(pending.promise);
  const onClose = jest.fn();
  const view = await render(<AddressPanel visible onClose={onClose} />);
  await fireEvent.press(screen.getByText('Add address'));
  await fireEvent.changeText(screen.getByLabelText('Search a place or landmark'), 'Junction');
  await screen.findByText('Searching…');
  mockUserId = 'user-2';
  await view.rerender(<AddressPanel visible onClose={onClose} />);
  pending.resolve([{ id: 'place-1', description: 'Other Account Place' }]);
  await waitFor(() => expect(screen.queryByText('Other Account Place')).toBeNull());
});

test('manual save still works when search is unavailable, without a GPS point', async () => {
  mockAutocomplete.mockRejectedValue(new Error('offline'));
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  expect(await screen.findByText('Address search unavailable. Enter it manually.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520001');
  await fireEvent.changeText(screen.getByLabelText('Contact name'), 'A Customer');
  await fireEvent.changeText(screen.getByLabelText('Contact phone'), '9876543210');
  await fireEvent.press(screen.getByText('Save address'));
  expect(mockAddAddress).toHaveBeenCalledWith({line1:'12 Main Street',contactName:'A Customer',contactPhone:'+919876543210',pincode:'520001'});
});

test('saving a search result without GPS leaves location confirmation pending', async () => {
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  await waitFor(() => expect(screen.getByLabelText('PIN code').props.value).toBe('520001'));
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  await fireEvent.changeText(screen.getByLabelText('Contact name'), 'A Customer');
  await fireEvent.changeText(screen.getByLabelText('Contact phone'), '9876543210');
  await fireEvent.press(screen.getByText('Save address'));
  expect(mockAddAddress).toHaveBeenCalledWith({line1:'12 Main Street',line2:'Vijayawada Junction, Vijayawada, 520001',contactName:'A Customer',contactPhone:'+919876543210',pincode:'520001'});
  expect(screen.getByText('Confirm location')).toBeTruthy();
});

test('clearing the search aborts details and ignores a late place response', async () => {
  const details = deferred<Awaited<ReturnType<typeof mockDetails>>>();
  mockDetails.mockReturnValue(details.promise);
  mockAutocomplete.mockResolvedValue([{ id: 'place-1', description: 'Junction (short)' }]);
  const input = await openSearch();
  await fireEvent.changeText(input, 'Junction');
  await fireEvent.press(await screen.findByLabelText('Select Junction (short)'));
  await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
  await fireEvent.changeText(input, '');
  expect(mockDetails.mock.calls[0]![2]?.aborted).toBe(true);
  details.resolve({ id: 'place-1', description: 'Late Place', location: { lat: 16, lng: 80 }, pincode: '520001' });
  await waitFor(() => expect(screen.getByLabelText('PIN code').props.value).toBe(''));
  expect(screen.queryByText('Selected: Late Place')).toBeNull();
});

test('location permission denied explains how to allow it', async () => {
  mockLocationStatus = 'denied';
  await openSearch();
  await fireEvent.press(screen.getByText('Use current location'));
  expect(await screen.findByText(/Allow location access in your phone settings/)).toBeTruthy();
});

test('a pending address can be confirmed with GPS after the search selection', async () => {
  const onClose = jest.fn();
  await render(<AddressPanel visible onClose={onClose} />);
  await fireEvent.press(screen.getByText('Add address'));
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520001');
  await fireEvent.changeText(screen.getByLabelText('Contact name'), 'A Customer');
  await fireEvent.changeText(screen.getByLabelText('Contact phone'), '9876543210');
  await fireEvent.press(screen.getByText('Save address'));
  expect(await screen.findByText('Confirm location')).toBeTruthy();
  await fireEvent.press(screen.getByText('Use current location'));
  expect(await screen.findByText(/Selected: Current location/)).toBeTruthy();
  await fireEvent.press(screen.getByText('Confirm location'));
  await waitFor(() => expect(mockConfirmAddressLocation).toHaveBeenCalledWith('address-1', { lat: 16.50547, lng: 80.64823 }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
