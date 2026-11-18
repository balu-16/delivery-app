/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AddressPanel } from '../components/connected/AddressPanel';

const mockAddAddress = jest.fn();
const mockRefreshAddresses = jest.fn(async () => undefined);
const mockRefreshDeliverySettings = jest.fn(async () => true);
let mockLocationRequired = true;
jest.mock('../src/store/customer', () => ({ useCustomer: () => ({ addresses: [], selectedAddress: null, locationRequired:mockLocationRequired, chooseAddress: jest.fn(), addAddress: mockAddAddress, confirmAddressLocation: jest.fn(), refreshAddresses: mockRefreshAddresses, refreshDeliverySettings:mockRefreshDeliverySettings, busy: false }) }));
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({status:'granted'}),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({coords:{latitude:16.50547,longitude:80.64823,accuracy:10}}),
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
