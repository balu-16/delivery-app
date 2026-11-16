import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { Badge } from '@/components/ui/Badge';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { images } from '@/constants/assets';
import { colors, fonts, radii } from '@/constants/theme';
import { useUserStore } from '@/store/userStore';
import { useCartStore, getCartTotals } from '@/store/cartStore';
import { formatCurrency } from '@/utils/format';
import { successFeedback } from '@/utils/haptics';

type PaymentKey = 'upi' | 'card' | 'cash';
type SlotKey = 'morning' | 'evening';

const paymentOptions: {
  key: PaymentKey;
  label: string;
  body: string;
  icon: 'phone-portrait-outline' | 'card-outline' | 'cash-outline';
}[] = [
  { key: 'upi', label: 'UPI', body: 'GPay, PhonePe or Paytm', icon: 'phone-portrait-outline' },
  { key: 'card', label: 'Card', body: 'Visa, Mastercard, RuPay', icon: 'card-outline' },
  { key: 'cash', label: 'Cash on delivery', body: 'Pay your delivery partner', icon: 'cash-outline' },
];

const slots: { key: SlotKey; label: string; body: string }[] = [
  { key: 'morning', label: 'Tomorrow morning', body: '6:00 AM – 7:00 AM' },
  { key: 'evening', label: 'Today evening', body: '7:00 PM – 9:00 PM' },
];

export function CheckoutSheet({
  visible,
  onClose,
  onOrderPlaced,
}: {
  visible: boolean;
  onClose: () => void;
  onOrderPlaced: () => void;
}) {
  const items = useCartStore((state) => state.items);
  const clear = useCartStore((state) => state.clear);
  const totals = useMemo(() => getCartTotals(items), [items]);
  const [payment, setPayment] = useState<PaymentKey>('upi');
  const [slot, setSlot] = useState<SlotKey>('morning');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [snapshot, setSnapshot] = useState({ total: totals.total, count: totals.count });

  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => {
        setLoading(false);
        setSuccess(false);
      }, 240);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [visible]);

  const addresses = useUserStore((state) => state.addresses);
  const addressId = useUserStore((state) => state.addressId);
  const addOrder = useUserStore((state) => state.addOrder);
  const address = addresses.find((entry) => entry.id === addressId) ?? addresses[0];

  const placeOrder = () => {
    if (!items.length || loading) return;
    setSnapshot({ total: totals.total, count: totals.count });
    const order = { id: `DEMO-${Date.now()}`, title: 'Demo order', date: 'Demo · scheduled', items: totals.lines.map((line) => `${line.product.name} × ${line.quantity}`).join(', '), amount: totals.total, status: 'Scheduled' as const };
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setSuccess(true);
      successFeedback();
      addOrder(order);
      clear();
    }, 900);
  };

  const closeSuccess = () => {
    setSuccess(false);
    onClose();
    onOrderPlaced();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={loading ? () => {} : success ? closeSuccess : onClose}
      title={success ? undefined : 'Demo checkout'}
      maxHeight="92%"
    >
      {success ? (
        <View style={styles.success}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark" size={34} color={colors.inverse} />
          </View>
          <Image source={images.cowMascot} style={styles.successCow} contentFit="contain" />
          <AppText style={styles.successTitle}>Demo order placed</AppText>
          <AppText style={styles.successBody}>
            {snapshot.count} demo item{snapshot.count === 1 ? '' : 's'} ·{' '}
            {slot === 'morning' ? 'morning slot' : 'evening slot'}. No order or payment was sent.
          </AppText>
          <View style={styles.successCard}>
            <View>
              <AppText style={styles.successLabel}>ORDER TOTAL</AppText>
              <AppText style={styles.successTotal}>{formatCurrency(snapshot.total)}</AppText>
            </View>
            <Badge tone="soft">DEMO · {payment.toUpperCase()}</Badge>
          </View>
          <Button
            label="Back to the farm"
            fullWidth
            onPress={closeSuccess}
            style={{ marginTop: 18 }}
          />
        </View>
      ) : (
        <>
          <View style={styles.addressCard}>
            <View style={styles.addressIcon}>
              <Ionicons name="home" size={18} color={colors.green} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.eyebrow}>DELIVERING TO</AppText>
              <AppText style={styles.addressTitle}>
                {address?.label} · {address?.line1}
              </AppText>
              <AppText style={styles.addressLine}>{address?.line2}</AppText>
            </View>
            <Ionicons name="chevron-forward" size={17} color={colors.muted} />
          </View>

          <AppText style={styles.sectionLabel}>Delivery slot</AppText>
          <View style={styles.optionList}>
            {slots.map((option) => {
              const active = slot === option.key;
              return (
                <PressableScale
                  key={option.key}
                  onPress={() => setSlot(option.key)}
                  haptic="select"
                  style={[styles.option, active ? styles.optionActive : null]}
                >
                  <Ionicons
                    name={active ? 'radio-button-on' : 'radio-button-off'}
                    size={19}
                    color={active ? colors.green : colors.mutedLight}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.optionTitle, active ? { color: colors.greenDark } : null]}>
                      {option.label}
                    </AppText>
                    <AppText style={styles.optionBody}>{option.body}</AppText>
                  </View>
                </PressableScale>
              );
            })}
          </View>

          <AppText style={styles.sectionLabel}>Payment method</AppText>
          <View style={styles.optionList}>
            {paymentOptions.map((option) => {
              const active = payment === option.key;
              return (
                <PressableScale
                  key={option.key}
                  onPress={() => setPayment(option.key)}
                  haptic="select"
                  style={[styles.option, active ? styles.optionActive : null]}
                >
                  <View style={styles.payIcon}>
                    <Ionicons name={option.icon} size={17} color={colors.brown} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.optionTitle, active ? { color: colors.greenDark } : null]}>
                      {option.label}
                    </AppText>
                    <AppText style={styles.optionBody}>{option.body}</AppText>
                  </View>
                  <Ionicons
                    name={active ? 'radio-button-on' : 'radio-button-off'}
                    size={19}
                    color={active ? colors.green : colors.mutedLight}
                  />
                </PressableScale>
              );
            })}
          </View>

          <View style={styles.summary}>
            <View style={styles.summaryRow}>
              <AppText style={styles.summaryLabel}>Items ({totals.count})</AppText>
              <AppText style={styles.summaryValue}>{formatCurrency(totals.subtotal)}</AppText>
            </View>
            <View style={styles.summaryRow}>
              <AppText style={styles.summaryLabel}>Delivery</AppText>
              <AppText style={[styles.summaryValue, styles.free]}>
                {totals.deliveryFee === 0 ? 'FREE' : formatCurrency(totals.deliveryFee)}
              </AppText>
            </View>
            <View style={styles.summaryRow}>
              <AppText style={styles.summaryLabel}>You save</AppText>
              <AppText style={[styles.summaryValue, styles.free]}>
                {formatCurrency(totals.savings)}
              </AppText>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryRow}>
              <AppText style={styles.totalLabel}>Total</AppText>
              <AppText style={styles.totalValue}>{formatCurrency(totals.total)}</AppText>
            </View>
          </View>

          <Button
            label={`Place demo order · ${formatCurrency(totals.total)}`}
            fullWidth
            loading={loading}
            onPress={placeOrder}
            icon="shield-checkmark-outline"
            style={{ marginTop: 16 }}
          />
          <AppText style={styles.secureNote}>
            Demo only · no payment or delivery will be made
          </AppText>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  addressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.greenIce,
    borderWidth: 1,
    borderColor: 'rgba(61,109,21,0.1)',
  },
  addressIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surfaceStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    fontFamily: fonts.medium,
    fontSize: 8.5,
    lineHeight: 12,
    letterSpacing: 0.7,
    color: colors.green,
  },
  addressTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.text,
  },
  addressLine: {
    fontFamily: fonts.regular,
    fontSize: 10.5,
    lineHeight: 14,
    color: colors.textSecondary,
  },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.text,
    marginTop: 20,
    marginBottom: 8,
  },
  optionList: {
    gap: 7,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  optionActive: {
    backgroundColor: colors.greenIce,
    borderColor: colors.greenTint,
  },
  payIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: colors.peachSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.text,
  },
  optionBody: {
    fontFamily: fonts.regular,
    fontSize: 10.5,
    lineHeight: 14,
    color: colors.muted,
  },
  summary: {
    marginTop: 20,
    padding: 13,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 7,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 11.5,
    color: colors.textSecondary,
  },
  summaryValue: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.text,
  },
  free: {
    color: colors.green,
    fontFamily: fonts.semibold,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: colors.lineStrong,
    marginVertical: 2,
  },
  totalLabel: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: colors.text,
  },
  totalValue: {
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
  },
  secureNote: {
    fontFamily: fonts.regular,
    fontSize: 10,
    lineHeight: 15,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 10,
  },
  success: {
    alignItems: 'center',
    paddingTop: 6,
    paddingBottom: 6,
  },
  successIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: -20,
    zIndex: 2,
  },
  successCow: {
    width: 150,
    height: 164,
  },
  successTitle: {
    fontFamily: fonts.semibold,
    fontSize: 21,
    lineHeight: 28,
    color: colors.text,
    textAlign: 'center',
    marginTop: 2,
  },
  successBody: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 290,
    marginTop: 5,
  },
  successCard: {
    marginTop: 16,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  successLabel: {
    fontFamily: fonts.medium,
    fontSize: 8.5,
    letterSpacing: 0.7,
    color: colors.muted,
  },
  successTotal: {
    fontFamily: fonts.bold,
    fontSize: 19,
    color: colors.text,
  },
});
