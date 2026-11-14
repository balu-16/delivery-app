import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import type { PartnerIdentity } from "../auth/session";
import {
  Button,
  Card,
  Chip,
  IconBox,
  PageTitle,
  Text,
  type IconName,
} from "../components/Ui";
import type { Navigation } from "../navigation";
import { useDemo, type WorkPreferences } from "../store";
import { colors, fonts } from "../theme";

export function ProfileTab({
  identity,
  navigation,
  onSignOut,
}: {
  identity: PartnerIdentity;
  navigation: Navigation;
  onSignOut: () => void;
}) {
  const state = useDemo();
  const delivered = state.events.filter(
    (event) => event.kind === "delivered" || event.kind === "offer-completed",
  ).length;
  const language =
    (
      { en: "English", te: "తెలుగు", hi: "हिन्दी", kn: "ಕನ್ನಡ" } as Record<
        string,
        string
      >
    )[state.language] ?? "English";
  return (
    <>
      <PageTitle title="Profile" subtitle="Your account and demo preferences" />
      <Card>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            navigation.openPage({ kind: "info", topic: "personal" })
          }
          style={s.profileTop}
        >
          <View style={s.avatar}>
            <Text style={s.avatarText}>
              {identity.name.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{identity.name}</Text>
            <Text style={s.muted}>{identity.email}</Text>
            <Text style={s.demoBadge}>Email account · Demo partner</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
        <View style={s.profileStats}>
          <View style={s.profileStat}>
            <Ionicons name="bicycle-outline" color={colors.green} size={20} />
            <Text style={s.bold}>{delivered}</Text>
            <Text style={s.small}>Demo deliveries</Text>
          </View>
          <View style={s.profileStat}>
            <Ionicons name="star-outline" color={colors.green} size={20} />
            <Text style={s.bold}>4.8</Text>
            <Text style={s.small}>Sample rating</Text>
          </View>
          <View style={s.profileStat}>
            <Ionicons name="calendar-outline" color={colors.green} size={20} />
            <Text style={s.bold}>Demo</Text>
            <Text style={s.small}>Partner profile</Text>
          </View>
        </View>
      </Card>
      <Card style={s.menuCard}>
        <Menu
          icon="person-outline"
          label="Personal information"
          onPress={() =>
            navigation.openPage({ kind: "info", topic: "personal" })
          }
        />
        <Menu
          icon="bicycle-outline"
          label="Vehicle information"
          detail="Sample scooter"
          onPress={() =>
            navigation.openPage({ kind: "info", topic: "vehicle" })
          }
        />
        <Menu
          icon="document-text-outline"
          label="Documents & verification"
          detail="Demo"
          onPress={() =>
            navigation.openPage({ kind: "info", topic: "documents" })
          }
        />
        <Menu
          icon="location-outline"
          label="Delivery areas"
          onPress={() => navigation.openPage({ kind: "info", topic: "areas" })}
        />
        <Menu
          icon="business-outline"
          label="Payout & bank details"
          detail="Demo"
          onPress={() => navigation.openPage({ kind: "payouts" })}
        />
        <Menu
          icon="calendar-outline"
          label="Availability & working hours"
          onPress={() => navigation.openPage({ kind: "working" })}
          last
        />
      </Card>
      <Card style={s.menuCard}>
        <Menu
          icon="globe-outline"
          label="Language"
          detail={language}
          onPress={() => navigation.openPage({ kind: "language" })}
        />
        <Menu
          icon="headset-outline"
          label="Help & support"
          onPress={() =>
            navigation.openWorkspace({ tab: "profile", panel: "support" })
          }
        />
        <Menu
          icon="call-outline"
          label="Emergency contact"
          onPress={() =>
            navigation.openPage({ kind: "info", topic: "emergency" })
          }
        />
        <Menu
          icon="options-outline"
          label="Demo settings"
          onPress={() => navigation.openWorkspace({ tab: "profile" })}
          last
        />
      </Card>
      <Button
        label="Sign out"
        icon="log-out-outline"
        secondary
        onPress={onSignOut}
      />
      <Text style={[s.small, { textAlign: "center", marginVertical: 13 }]}>
        Deliveries and payments in this app are simulated.
      </Text>
    </>
  );
}
function Menu({
  icon,
  label,
  detail,
  onPress,
  last,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[s.menu, last && { borderBottomWidth: 0 }]}
    >
      <Ionicons name={icon} size={22} color={colors.green} />
      <View style={{ flex: 1 }}>
        <Text style={s.menuLabel}>{label}</Text>
      </View>
      {detail && <Text style={s.muted}>{detail}</Text>}
      <Ionicons name="chevron-forward" size={19} color={colors.text} />
    </Pressable>
  );
}

const modes: [WorkPreferences["mode"], string, string][] = [
  ["flexible", "Flexible", "Anytime"],
  ["fixed", "Fixed shift", "Set hours"],
  ["part-time", "Part-time", "Limited hours"],
];
const weekdays = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;
const areas = ["Central", "East", "North"];
function formatTime(time: string) {
  const hour = Number(time.slice(0, 2));
  return `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;
}
export function WorkingPage({
  online,
  setOnline,
}: {
  online: boolean;
  setOnline: (value: boolean) => void;
}) {
  const preferences = useDemo((state) => state.preferences),
    update = useDemo((state) => state.updatePreferences);
  function changeTime(key: "start" | "end") {
    const current = Number(preferences[key].slice(0, 2));
    let hour = current + 1;
    if (key === "start") {
      if (hour >= Number(preferences.end.slice(0, 2)) || hour > 20) hour = 6;
    } else {
      if (hour > 22)
        hour = Math.max(7, Number(preferences.start.slice(0, 2)) + 1);
    }
    update({ [key]: `${String(hour).padStart(2, "0")}:00` });
  }
  const total =
    Number(preferences.end.slice(0, 2)) - Number(preferences.start.slice(0, 2));
  return (
    <>
      <PageTitle
        title="Availability & working hours"
        subtitle="Manage your sample schedule and preferences."
      />
      <Card style={s.online}>
        <View style={s.statusDot} />
        <View style={{ flex: 1 }}>
          <Text style={s.greenTitle}>
            {online ? "You are online" : "You are offline"}
          </Text>
          <Text style={s.small}>
            {online
              ? "Available for demo assignments"
              : "Go online to try assignments"}
          </Text>
        </View>
        <Switch
          accessibilityLabel="Demo online status"
          value={online}
          onValueChange={setOnline}
          trackColor={{ false: "#D5C8B6", true: "#8AB159" }}
          thumbColor={online ? colors.greenDark : colors.raised}
        />
      </Card>
      <View style={s.headingRow}>
        <Ionicons name="calendar-outline" color={colors.green} size={22} />
        <Text style={s.sectionTitle}>Working preference</Text>
      </View>
      <View style={s.modeRow}>
        {modes.map(([value, label, detail]) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: preferences.mode === value }}
            key={value}
            onPress={() => update({ mode: value })}
            style={[s.mode, preferences.mode === value && s.modeActive]}
          >
            <Text
              style={[
                s.modeLabel,
                preferences.mode === value && s.modeLabelActive,
              ]}
            >
              {label}
            </Text>
            <Text
              style={[s.small, preferences.mode === value && s.modeLabelActive]}
            >
              {detail}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.headingRow}>
        <Ionicons name="time-outline" color={colors.green} size={22} />
        <Text style={s.sectionTitle}>Today’s availability</Text>
      </View>
      <View style={s.modeRow}>
        {(["start", "end"] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => changeTime(key)}
            style={s.timeBox}
            accessibilityRole="button"
          >
            <Text style={s.small}>
              {key === "start" ? "Start time" : "End time"}
            </Text>
            <View style={s.timeInner}>
              <Ionicons name="time-outline" color={colors.green} size={19} />
              <Text style={[s.bold, { flex: 1 }]}>
                {formatTime(preferences[key])}
              </Text>
              <Ionicons name="chevron-down" size={17} color={colors.text} />
            </View>
          </Pressable>
        ))}
      </View>
      <View style={s.total}>
        <Ionicons name="calendar-outline" size={17} color={colors.green} />
        <Text style={s.greenTitle}>Total: {total} hours</Text>
      </View>
      <Text style={[s.small, { marginTop: 4 }]}>
        Tap a time to change it. Settings are saved on this device.
      </Text>
      <View style={s.headingRow}>
        <Ionicons
          name="calendar-number-outline"
          color={colors.green}
          size={22}
        />
        <Text style={s.sectionTitle}>Preferred working days</Text>
      </View>
      <View style={s.days}>
        {weekdays.map(([day, label]) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: preferences.days.includes(day) }}
            key={day}
            onPress={() =>
              update({
                days: preferences.days.includes(day)
                  ? preferences.days.filter((item) => item !== day)
                  : [...preferences.days, day],
              })
            }
            style={[s.day, preferences.days.includes(day) && s.dayActive]}
          >
            <Text
              style={[
                s.dayLabel,
                preferences.days.includes(day) && s.modeLabelActive,
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.headingRow}>
        <Ionicons name="layers-outline" color={colors.green} size={22} />
        <Text style={s.sectionTitle}>Delivery preferences</Text>
      </View>
      <Card>
        <Text style={s.bold}>Preferred areas</Text>
        <View
          style={[s.days, { justifyContent: "flex-start", marginVertical: 10 }]}
        >
          {areas.map((area) => (
            <Chip
              key={area}
              label={area}
              active={preferences.areas.includes(area)}
              onPress={() =>
                update({
                  areas: preferences.areas.includes(area)
                    ? preferences.areas.filter((item) => item !== area)
                    : [...preferences.areas, area],
                })
              }
            />
          ))}
        </View>
        <Pressable
          onPress={() =>
            update({
              maxDeliveries:
                preferences.maxDeliveries === 10
                  ? 25
                  : preferences.maxDeliveries === 25
                    ? 40
                    : 10,
            })
          }
          style={s.settingRow}
        >
          <Text style={s.bold}>Max deliveries per shift</Text>
          <Text style={s.greenTitle}>{preferences.maxDeliveries} ›</Text>
        </Pressable>
      </Card>
    </>
  );
}

export function LanguagePage() {
  const language = useDemo((state) => state.language),
    setLanguage = useDemo((state) => state.setLanguage);
  return (
    <>
      <PageTitle title="Language" subtitle="Choose your preferred language" />
      <Card style={s.menuCard}>
        {[
          ["en", "English"],
          ["te", "తెలుగు"],
          ["hi", "हिन्दी"],
          ["kn", "ಕನ್ನಡ"],
        ].map(([id, label], index) => (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ checked: language === id }}
            onPress={() => setLanguage(id)}
            style={[s.menu, index === 3 && { borderBottomWidth: 0 }]}
          >
            <Text style={[s.bold, { flex: 1 }]}>{label}</Text>
            <Ionicons
              name={language === id ? "radio-button-on" : "radio-button-off"}
              size={21}
              color={colors.green}
            />
          </Pressable>
        ))}
      </Card>
    </>
  );
}
export function InfoPage({
  topic,
  identity,
  navigation,
}: {
  topic: "personal" | "vehicle" | "documents" | "areas" | "emergency";
  identity: PartnerIdentity;
  navigation: Navigation;
}) {
  const preferences = useDemo((state) => state.preferences);
  const content = {
    personal: {
      title: "Personal information",
      lines: [
        identity.name,
        identity.email,
        "This email is your sign-in account.",
      ],
    },
    vehicle: {
      title: "Vehicle information",
      lines: ["Sample scooter", "Vehicle details shown here are fictional."],
    },
    documents: {
      title: "Documents & verification",
      lines: [
        "Demo profile",
        "No documents are uploaded or verified in this demo.",
      ],
    },
    areas: {
      title: "Delivery areas",
      lines: [
        preferences.areas.join(", ") || "No areas selected",
        "Preferences are saved on this device only.",
      ],
    },
    emergency: {
      title: "Emergency contact",
      lines: [
        "Demo only",
        "This app does not call or notify emergency contacts.",
      ],
    },
  }[topic];
  return (
    <>
      <PageTitle title={content.title} />
      <Card>
        {content.lines.map((line) => (
          <Text key={line} style={[s.muted, { marginBottom: 9, fontSize: 13 }]}>
            {line}
          </Text>
        ))}
      </Card>
      {topic === "areas" && (
        <Button
          label="Edit preferences"
          onPress={() => navigation.openPage({ kind: "working" })}
        />
      )}
    </>
  );
}
export function PayoutPage({ navigation }: { navigation: Navigation }) {
  return (
    <>
      <PageTitle
        title="Withdrawals & payouts"
        subtitle="Sample settlement details"
      />
      <Card>
        <IconBox name="business-outline" />
        <Text style={[s.bold, { marginTop: 12 }]}>Payouts are simulated</Text>
        <Text style={[s.muted, { marginTop: 5 }]}>
          No bank details are collected and no money is transferred.
        </Text>
      </Card>
      <Button
        label="View demo cash handover"
        secondary
        onPress={() => navigation.openWorkspace({ tab: "earnings" })}
      />
    </>
  );
}

const s = StyleSheet.create({
  profileTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: {
    width: 67,
    height: 67,
    borderRadius: 34,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.bold, color: colors.green, fontSize: 28 },
  name: { fontFamily: fonts.bold, fontSize: 16 },
  bold: { fontFamily: fonts.semibold, fontSize: 13 },
  muted: { fontSize: 11, color: colors.secondary, lineHeight: 18 },
  small: { fontSize: 10, color: colors.secondary, lineHeight: 16 },
  demoBadge: { color: colors.greenDark, fontSize: 10, marginTop: 3 },
  profileStats: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderColor: colors.line,
    marginTop: 15,
    paddingTop: 14,
  },
  profileStat: {
    flex: 1,
    alignItems: "center",
    gap: 3,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
  },
  menuCard: { paddingVertical: 1 },
  menu: {
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  menuLabel: { fontFamily: fonts.semibold, fontSize: 12 },
  online: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.greenSoft,
    gap: 10,
  },
  statusDot: {
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: colors.green,
  },
  greenTitle: {
    color: colors.greenDark,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 17,
    marginBottom: 10,
  },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 14 },
  modeRow: { flexDirection: "row", gap: 8 },
  mode: {
    flex: 1,
    minHeight: 59,
    borderRadius: 13,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    padding: 5,
  },
  modeActive: { backgroundColor: colors.green, borderColor: colors.green },
  modeLabel: { fontFamily: fonts.semibold, fontSize: 11, textAlign: "center" },
  modeLabelActive: { color: colors.inverse },
  timeBox: {
    flex: 1,
    backgroundColor: colors.raised,
    borderRadius: 13,
    padding: 9,
    borderWidth: 1,
    borderColor: colors.line,
  },
  timeInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  total: {
    marginTop: 10,
    backgroundColor: colors.greenSoft,
    borderRadius: 11,
    padding: 9,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
  },
  days: { flexDirection: "row", gap: 5, justifyContent: "space-between" },
  day: {
    flex: 1,
    minHeight: 47,
    borderRadius: 10,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  dayActive: { backgroundColor: colors.green, borderColor: colors.green },
  dayLabel: { fontFamily: fonts.semibold, fontSize: 10 },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingTop: 12,
  },
});
