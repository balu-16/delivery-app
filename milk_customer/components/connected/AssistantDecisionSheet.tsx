import { useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors } from '@/constants/theme';
import type { AgentCard } from '@/src/agent/types';
import { Card, formatPaise, shared } from './Shared';

type Props = {
  card: AgentCard | null;
  onClose: () => void;
  onAddresses: () => void;
  onCart: () => void;
  onProducts: () => void;
  onSupport: () => void;
};
const amount = (value: unknown): string | null => typeof value === 'string' && /^\d+$/.test(value) ? value : null;
const positive = (value: string | null) => value !== null && /[1-9]/.test(value);

/** A decision sheet presents only choices supported by the actual tool result. */
export function AssistantDecisionSheet({ card, onClose, onAddresses, onCart, onProducts, onSupport }: Props) {
  const [onlineInfo, setOnlineInfo] = useState(false);
  const payload = card?.payload ?? {};
  const title = typeof payload.title === 'string' ? payload.title : 'Your options';
  const description = typeof payload.description === 'string' ? payload.description : '';
  const payment = card?.type === 'order_confirm';
  const cash = amount(payload.walletCashPaise), promo = amount(payload.walletPromoPaise), due = amount(payload.amountDuePaise), total = amount(payload.totalPaise);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return <BottomSheet visible={!!card} onClose={onClose} title={payment ? 'Payment details' : title}>
    <View style={{ gap: 12 }}>
      {payment ? <>
        <AppText style={shared.body}>Your eligible wallet balance is applied automatically. The remaining amount is paid on delivery.</AppText>
        <Card>
          <View style={shared.row}><AppText style={[shared.body, { flex: 1 }]}>Order total</AppText><AppText style={shared.label}>{total === null ? 'Unavailable' : formatPaise(total)}</AppText></View>
          {cash !== null && positive(cash) && <View style={shared.row}><AppText style={[shared.body, { flex: 1 }]}>Wallet balance applied</AppText><AppText style={shared.label}>−{formatPaise(cash)}</AppText></View>}
          {promo !== null && positive(promo) && <View style={shared.row}><AppText style={[shared.body, { flex: 1 }]}>Promotional balance applied</AppText><AppText style={shared.label}>−{formatPaise(promo)}</AppText></View>}
          <View style={shared.row}><AppText style={[shared.label, { flex: 1 }]}>Due on delivery</AppText><AppText style={shared.label}>{due === null ? 'Unavailable' : formatPaise(due)}</AppText></View>
        </Card>
        {due !== null && <Card><View style={shared.row}><Ionicons name={positive(due) ? 'cash-outline' : 'wallet-outline'} size={22} color={colors.green} /><View style={{ flex: 1 }}><AppText style={shared.label}>{positive(due) ? 'Cash on delivery' : 'No cash due on delivery'}</AppText><AppText style={shared.muted}>Included in your order summary</AppText></View><Ionicons name="checkmark-circle" size={22} color={colors.green} /></View></Card>}
        <Button label="Online payment · Coming soon" variant="outline" fullWidth onPress={() => setOnlineInfo(true)} />
        {onlineInfo && <AppText style={shared.body}>We’re working on online payments. Cash on delivery remains available when eligible.</AppText>}
        <Button label="Back to order" fullWidth onPress={onClose} />
      </> : <>
        {!!description && <AppText style={shared.body}>{description}</AppText>}
        {card?.type === 'out_of_stock' && items.map((raw, index) => {
          if (!raw || typeof raw !== 'object') return null;
          const item = raw as Record<string, unknown>, name = typeof item.name === 'string' ? item.name : '';
          if (!name) return null;
          return <Card key={`${name}-${index}`}><AppText style={shared.label}>{name}</AppText>{typeof item.variantName === 'string' && !!item.variantName && <AppText style={shared.muted}>{item.variantName}</AppText>}<AppText style={shared.muted}>Currently unavailable</AppText></Card>;
        })}
        {card?.type === 'delivery_unavailable' && <Button label="Choose another address" fullWidth onPress={onAddresses} />}
        {card?.type === 'out_of_stock' && <Button label="Browse available products" fullWidth onPress={onProducts} />}
        {(card?.type === 'out_of_stock' || card?.type === 'cart_attention' || card?.type === 'payment_unavailable') && <Button label="Review cart" variant="outline" fullWidth onPress={onCart} />}
        <Button label="Ask our support team" variant="soft" fullWidth onPress={onSupport} />
      </>}
    </View>
  </BottomSheet>;
}
