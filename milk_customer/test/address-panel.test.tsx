/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AddressPanel } from '../components/connected/AddressPanel';

const mockAddAddress = jest.fn();
jest.mock('../src/store/customer', () => ({ useCustomer: () => ({ addresses: [], selectedAddress: null, chooseAddress: jest.fn(), addAddress: mockAddAddress, busy: false }) }));
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
  mockAddAddress.mockReset().mockResolvedValue({ needsConfirmation:false, degraded:false, temporarilyUnavailable:false });
});

test('accepts a local phone number and reports only the missing location', async () => {
  await render(<AddressPanel visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Add address'));
  await fireEvent.changeText(screen.getByLabelText('House and street'), '12 Main Street');
  await fireEvent.changeText(screen.getByLabelText('PIN code'), '520001');
  await fireEvent.changeText(screen.getByLabelText('Contact name'), 'A Customer');
  await fireEvent.changeText(screen.getByLabelText('Contact phone'), '9876543210');
  await fireEvent.press(screen.getByText('Save address'));
  expect(screen.getByText('Select your current location at the delivery address.')).toBeTruthy();
  expect(screen.queryByText('Enter a valid 10-digit Indian phone number.')).toBeNull();
  expect(mockAddAddress).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Use current location'));
  await fireEvent.press(screen.getByText('Save address'));
  expect(mockAddAddress).toHaveBeenCalledWith(expect.objectContaining({contactPhone:'+919876543210',pincode:'520001'}));
});
