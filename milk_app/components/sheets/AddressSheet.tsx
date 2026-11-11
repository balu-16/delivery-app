import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { Badge } from '@/components/ui/Badge';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { colors, fonts, radii } from '@/constants/theme';
import { useUserStore } from '@/store/userStore';
import { selectionFeedback } from '@/utils/haptics';

export function AddressSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const addressId = useUserStore((state) => state.addressId);
  const setAddress = useUserStore((state) => state.setAddress);
  const addresses = useUserStore((state) => state.addresses);
  const addAddress = useUserStore((state) => state.addAddress);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [error, setError] = useState(false);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Delivery address"
      subtitle="Choose where your dairy should arrive each morning."
    >
      {editing ? (
        <View style={{ gap: 10 }}>
          <TextInput accessibilityLabel="Address label" placeholder="Label (e.g. Home)" value={label} onChangeText={setLabel} maxLength={40} style={styles.input} />
          <TextInput accessibilityLabel="Street address" placeholder="Street address" value={line1} onChangeText={setLine1} maxLength={120} style={styles.input} />
          <TextInput accessibilityLabel="Area and city" placeholder="Area and city" value={line2} onChangeText={setLine2} maxLength={120} style={styles.input} />
          {error ? <AppText style={{ color: colors.danger }}>Please complete all address fields.</AppText> : null}
          <Button label="Save address" onPress={() => { if (!label.trim() || !line1.trim() || !line2.trim()) { setError(true); return; } addAddress({ label: label.trim(), line1: line1.trim(), line2: line2.trim() }); setEditing(false); setLabel(''); setLine1(''); setLine2(''); setError(false); onClose(); }} fullWidth />
          <Button label="Cancel" variant="soft" onPress={() => setEditing(false)} fullWidth />
        </View>
      ) : <>
      <View style={styles.list}>
        {addresses.map((address) => {
          const active = address.id === addressId;
          return (
            <PressableScale
              key={address.id}
              onPress={() => {
                selectionFeedback();
                setAddress(address.id);
                onClose();
              }}
              style={[styles.row, active ? styles.rowActive : null]}
              accessibilityLabel={`Deliver to ${address.label}, ${address.line1}`}
            >
              <View style={[styles.icon, active ? styles.iconActive : null]}>
                <Ionicons
                  name={address.label === 'Home' ? 'home' : 'briefcase'}
                  size={19}
                  color={active ? colors.inverse : colors.green}
                />
              </View>
              <View style={styles.rowBody}>
                <View style={styles.rowTitle}>
                  <AppText style={styles.label}>{address.label}</AppText>
                  {address.isDefault ? <Badge tone="soft">DEFAULT</Badge> : null}
                  {active && !address.isDefault ? <Badge tone="soft">SELECTED</Badge> : null}
                </View>
                <AppText style={styles.line}>{address.line1}</AppText>
                <AppText style={styles.line}>{address.line2}</AppText>
              </View>
              <Ionicons
                name={active ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={active ? colors.green : colors.lineStrong}
              />
            </PressableScale>
          );
        })}
      </View>

      <PressableScale
        onPress={() => {
          selectionFeedback();
          setAddress('home');
          onClose();
        }}
        haptic="none"
        style={styles.location}
      >
        <View style={styles.locationIcon}>
          <Ionicons name="navigate" size={17} color={colors.green} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.locationTitle}>Use sample location</AppText>
          <AppText style={styles.locationBody}>HSR Layout, Bengaluru · within 8 km</AppText>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </PressableScale>

      <Button
        label="Add a new address"
        variant="soft"
        icon="add"
        fullWidth
        haptic="select"
        onPress={() => setEditing(true)}
        style={{ marginTop: 14 }}
      />
      </>}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, backgroundColor: colors.surface },
  list: {
    gap: 10,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rowActive: {
    borderColor: colors.greenLight,
    backgroundColor: colors.greenIce,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconActive: {
    backgroundColor: colors.green,
  },
  rowBody: {
    flex: 1,
    gap: 1,
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: 19,
    color: colors.text,
  },
  line: {
    fontFamily: fonts.regular,
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  location: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.lineStrong,
  },
  locationIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationTitle: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
  },
  locationBody: {
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 15,
    color: colors.muted,
  },
});
