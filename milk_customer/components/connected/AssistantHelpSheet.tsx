import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { sendSupportMessage, supportSendError } from '@/src/support/send-message';
import { shared } from './Shared';

export function AssistantHelpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [body, setBody] = useState(''), [sending, setSending] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  const userId = useCustomer(state => state.profile?.userId);
  const [pendingRequest, setPendingRequest] = useState(false);
  const sendingRef = useRef(false);
  const send = async () => {
    const message = body.trim();
    if (!message || message.length > 2000 || sendingRef.current) return;
    if (!userId) {setError('Sign in again to contact support.');return;}
    sendingRef.current = true; setSending(true); setError('');
    try {
      await sendSupportMessage(userId, await accessToken(), message, null);
      setPendingRequest(false); setSent(true);
    } catch (failure) {
      setPendingRequest(true); setError(supportSendError(failure));
    } finally { sendingRef.current = false; setSending(false); }
  };
  const close = () => { if (sending) return; if (sent) { setBody(''); setSent(false); } setError(''); onClose(); };
  return <BottomSheet visible={visible} onClose={close} title="Ask our support team" keyboardAware>
    <View style={{ gap: 12 }}>
      {sent ? <>
        <AppText style={shared.body}>Your request has been sent to our support team. You can follow it in Help and support.</AppText>
        <Button label="View support requests" fullWidth onPress={() => { close(); router.push({ pathname: '/profile', params: { open: 'support' } }); }} />
        <Button label="Back to chat" variant="soft" fullWidth onPress={close} />
      </> : <>
        <AppText style={shared.body}>Tell us what you need help with. A support team member can review your request.</AppText>
        <TextInput style={[shared.input, { minHeight: 110, textAlignVertical: 'top', paddingTop: 12 }]} multiline maxLength={2000} placeholder="How can we help?" accessibilityLabel="Support request" value={body} editable={!sending} onChangeText={setBody} />
        {!!error && <AppText style={{ color: '#a2382e' }} accessibilityLiveRegion="polite">{error}</AppText>}
        <Button label={pendingRequest ? 'Retry request' : 'Send request'} fullWidth loading={sending} disabled={!body.trim()} onPress={() => void send()} />
      </>}
    </View>
  </BottomSheet>;
}
