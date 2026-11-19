import { screen } from '@testing-library/react-native';

/** Pull-to-refresh props from the screen ScrollView's RefreshControl. */
export function refreshControlProp(): { refreshing: boolean; onRefresh?: () => void } {
  const scroll = screen.getByTestId('rider-scroll');
  const control = scroll.props.refreshControl;
  return { refreshing: control.props.refreshing, onRefresh: control.props.onRefresh };
}
