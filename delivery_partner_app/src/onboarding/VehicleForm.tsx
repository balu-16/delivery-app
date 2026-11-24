import { StyleSheet, TextInput, View } from "react-native";
import { Button, Card, Text } from "../components/Ui";
import { colors, fonts } from "../theme";

type VehicleFormProps = {
  vehicleType: string;
  vehicleNo: string;
  saving: boolean;
  saved: boolean;
  error: string | null;
  canSave: boolean;
  onTypeChange: (value: string) => void;
  onNumberChange: (value: string) => void;
  onSave: () => void;
  onRetry: () => void;
};

/**
 * Vehicle draft form. Confirmed values live in the parent snapshot; this
 * renders the rider's draft. Save is enabled only when the valid draft
 * differs from confirmed data. "Saving…" appears only on this action —
 * store saves and document uploads never touch this button.
 */
export function VehicleForm({
  vehicleType,
  vehicleNo,
  saving,
  saved,
  error,
  canSave,
  onTypeChange,
  onNumberChange,
  onSave,
  onRetry,
}: VehicleFormProps) {
  return (
    <Card>
      <Text style={styles.strong}>Vehicle details</Text>
      <Text style={styles.label}>Vehicle type</Text>
      <TextInput
        accessibilityLabel="Vehicle type"
        value={vehicleType}
        onChangeText={onTypeChange}
        placeholder="Bike or scooter"
        placeholderTextColor={colors.muted}
        style={styles.input}
        maxLength={40}
        testID="vehicle-type-input"
      />
      <Text style={styles.label}>Registration number</Text>
      <TextInput
        accessibilityLabel="Registration number"
        value={vehicleNo}
        onChangeText={onNumberChange}
        autoCapitalize="characters"
        placeholder="Vehicle number"
        placeholderTextColor={colors.muted}
        style={styles.input}
        maxLength={40}
        testID="vehicle-number-input"
      />
      {error ? <Text accessibilityRole="alert" style={styles.danger}>{error}</Text> : null}
      {saved && !saving && !error ? (
        <Text testID="vehicle-saved" style={styles.success}>Vehicle details saved</Text>
      ) : null}
      <View style={styles.actionRow}>
        {saving ? (
          <Button label="Saving…" disabled onPress={() => undefined} />
        ) : error ? (
          <>
            <Button label="Retry" secondary={canSave} onPress={onRetry} />
            {canSave ? <Button label="Save vehicle" onPress={onSave} /> : null}
          </>
        ) : (
          <Button label="Save vehicle" disabled={!canSave} onPress={onSave} />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  label: { fontSize: 11, color: colors.secondary, marginTop: 12 },
  input: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.backgroundTop, color: colors.text, paddingHorizontal: 12, minHeight: 48, borderRadius: 12, marginVertical: 7, fontFamily: fonts.regular },
  danger: { color: colors.danger, marginVertical: 8, fontSize: 12 },
  success: { color: colors.greenDark, marginVertical: 8, fontSize: 12, fontFamily: fonts.semibold },
  actionRow: { marginTop: 4, gap: 8 },
});
