/// <reference types="jest" />
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AuthGate } from '../components/connected/AuthGate';
import { AuthError } from '../src/auth/cognito';
import { completePasswordChange, confirmSignUp, login, signUp } from '../src/auth/session';

const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockLoad = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/store/customer', () => ({ useCustomer: () => ({ status:'signedOut', initialize:mockInitialize, load:mockLoad, logout:jest.fn(), error:null }) }));
jest.mock('../src/auth/session', () => ({
  cancelPasswordChange:jest.fn(), completePasswordChange:jest.fn(), confirmPasswordReset:jest.fn(),
  confirmSignUp:jest.fn(), login:jest.fn(), requestPasswordReset:jest.fn(), resendSignUpCode:jest.fn(), signUp:jest.fn(),
  PasswordChangedError: class PasswordChangedError extends Error { original: unknown; constructor(original:unknown) { super(); this.original=original; } },
  PasswordChangeUncertainError: class PasswordChangeUncertainError extends Error {},
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top:0, bottom:0 }) }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('../components/ui/Button', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { Button: ({label,onPress,disabled}: {label:string;onPress:()=>void;disabled?:boolean}) => React.createElement(Pressable, {onPress,disabled,accessibilityRole:'button'}, React.createElement(Text, null, label)) };
});
jest.mock('../components/ui/Screen', () => {
  const React = require('react'); const { View } = require('react-native');
  return { Screen: ({children}: {children:React.ReactNode}) => React.createElement(View,null,children) };
});

beforeEach(() => { jest.clearAllMocks(); });

test('shows an actionable credential error on the sign-in screen', async () => {
  jest.mocked(login).mockRejectedValue(new AuthError('INVALID_CREDENTIALS'));
  await render(<AuthGate><></></AuthGate>);
  await fireEvent.changeText(screen.getByLabelText('Email address'), 'person@example.com');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'incorrect');
  await fireEvent.press(screen.getByText('Sign in'));
  expect(screen.getByText(/email or password is incorrect/i)).toBeTruthy();
});

test('keeps email verification completed when the subsequent server bootstrap fails', async () => {
  jest.mocked(signUp).mockResolvedValue({confirmed:false});
  jest.mocked(confirmSignUp).mockResolvedValue();
  jest.mocked(login).mockRejectedValue(new AuthError('BACKEND_UNREACHABLE'));
  await render(<AuthGate><></></AuthGate>);
  await fireEvent.press(screen.getByText('Create account'));
  await fireEvent.changeText(screen.getByLabelText('Your name'), 'Person');
  await fireEvent.changeText(screen.getByLabelText('Email address'), 'person@example.com');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'Temporary-123!');
  await fireEvent.press(screen.getByText('Create account'));
  await fireEvent.changeText(screen.getByLabelText('Verification code'), '123456');
  await fireEvent.press(screen.getByText('Verify email'));
  expect(confirmSignUp).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Email verified.*customer server could not be reached/i)).toBeTruthy();
  expect(screen.getByText('Sign in')).toBeTruthy();
});

test('offers a new-password form after accepting a temporary password', async () => {
  jest.mocked(login).mockResolvedValue({kind:'newPasswordRequired', requiredAttributes:['name']});
  jest.mocked(completePasswordChange).mockResolvedValue();
  await render(<AuthGate><></></AuthGate>);
  await fireEvent.changeText(screen.getByLabelText('Email address'), 'person@example.com');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'temporary');
  await fireEvent.press(screen.getByText('Sign in'));
  await fireEvent.changeText(screen.getByLabelText('Your name'), 'Person');
  await fireEvent.changeText(screen.getByLabelText('New password'), 'New-password-123!');
  await fireEvent.press(screen.getByText('Update password'));
  expect(completePasswordChange).toHaveBeenCalledWith('New-password-123!', expect.objectContaining({name:'Person'}));
  expect(mockLoad).toHaveBeenCalled();
});
