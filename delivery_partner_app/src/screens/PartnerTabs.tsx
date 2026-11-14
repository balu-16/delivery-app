import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import Svg, { Circle, Path, Text as SvgText } from "react-native-svg";
import {
  acceptDemoAssignment,
  demoTasks,
  rejectDemoAssignment,
  type TaskStatus,
} from "../assignments";
import {
  Button,
  Card,
  Chip,
  IconBox,
  PageTitle,
  Text,
  type IconName,
} from "../components/Ui";
import { isResolved, lastActiveOffer, nextRouteStop } from "../domain";
import type { Navigation } from "../navigation";
import {
  cashBalance,
  earnings,
  money,
  stops,
  useDemo,
  type Event,
} from "../store";
import { colors, fonts } from "../theme";
import type { PartnerIdentity } from "../auth/session";

function message(title: string, body: string) {
  if (Platform.OS === "web") globalThis.alert(`${title}\n\n${body}`);
  else Alert.alert(title, body);
}
export async function acceptTask(id: string) {
  try {
    await acceptDemoAssignment(id);
    return true;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    message(
      "Unable to accept assignment",
      code === "ACTIVE_ASSIGNMENT"
        ? "Finish the active sample job before accepting another."
        : "Go online and make sure the sample route and cash limit allow this assignment.",
    );
    return false;
  }
}
function dayKey(time: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
}
function todayEvents(events: Event[], now: number) {
  return events.filter((event) => dayKey(event.at) === dayKey(now));
}
function countCompleted(events: Event[]) {
  return events.filter(
    (event) => event.kind === "delivered" || event.kind === "offer-completed",
  ).length;
}
function useNow(offset: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);
  return now + offset;
}

export function HomeTab({
  navigation,
  identity,
  online,
  setOnline,
}: {
  navigation: Navigation;
  identity: PartnerIdentity;
  online: boolean;
  setOnline: (value: boolean) => void;
}) {
  const state = useDemo();
  const now = useNow(state.clockOffset);
  const today = todayEvents(state.events, now);
  const tasks = demoTasks(state.events);
  const completed = countCompleted(today);
  const remaining = stops.filter(
    (stop) => !isResolved(state.events, stop.id),
  ).length;
  const next = nextRouteStop(state.events, stops);
  const first =
    identity.name === "Partner" ? "Partner" : identity.name.split(" ")[0];
  const currentOffer = lastActiveOffer(state.events);
  const newTask = tasks.find((task) => task.status === "new");
  return (
    <>
      <View style={s.welcome}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{first.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.greeting}>Good morning, {first} 👋</Text>
          <Text style={s.muted}>Ready for today’s deliveries?</Text>
        </View>
      </View>
      <Card style={s.availability}>
        <IconBox name="bicycle-outline" />
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
      <View style={s.statRow}>
        <Stat
          title="Today’s earnings"
          value={money(earnings(today))}
          icon="wallet-outline"
          onPress={() => navigation.setTab("earnings")}
        />
        <Stat
          title="Today’s deliveries"
          value={String(completed + remaining)}
          icon="cube-outline"
          onPress={() => navigation.setTab("tasks")}
        />
      </View>
      <View style={s.statRow}>
        <Stat
          title="Completed"
          value={String(completed)}
          icon="checkmark-circle-outline"
          small
          onPress={() => navigation.setTab("tasks")}
        />
        <Stat
          title="Pending"
          value={String(remaining)}
          icon="time-outline"
          small
          onPress={() => navigation.setTab("route")}
        />
        <Stat
          title="COD to submit"
          value={money(cashBalance(state.events))}
          icon="cash-outline"
          small
          onPress={() => navigation.openWorkspace({ tab: "earnings" })}
        />
      </View>
      <Card>
        <View style={s.cardTitleRow}>
          <View style={s.row}>
            <Ionicons
              name="git-network-outline"
              size={21}
              color={colors.green}
            />
            <Text style={s.cardTitle}>Next delivery</Text>
          </View>
          <Text style={s.badge}>DEMO</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            currentOffer
              ? navigation.openWorkspace({ tab: "today" })
              : navigation.setTab("route")
          }
          style={s.nextRow}
        >
          <IconBox name="bag-outline" />
          <View style={{ flex: 1 }}>
            <Text style={s.bold}>
              {currentOffer
                ? "Active sample assignment"
                : (next?.name ?? "Route complete")}
            </Text>
            <Text numberOfLines={1} style={s.muted}>
              {currentOffer
                ? "Finish this job to resume your route"
                : (next?.address ?? "All sample stops are complete")}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
      </Card>
      {newTask && (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            navigation.openPage({ kind: "assignment", id: newTask.id })
          }
        >
          <Card style={s.assignmentBanner}>
            <IconBox name="cube-outline" />
            <View style={{ flex: 1 }}>
              <Text style={s.bold}>New delivery assignment</Text>
              <Text style={s.muted}>Explore a sample delivery request</Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color={colors.green} />
          </Card>
        </Pressable>
      )}
      <Pressable
        onPress={() => navigation.setTab("route")}
        accessibilityRole="button"
        style={s.farmBanner}
      >
        <Image
          source={require("../../assets/images/farm-scene-hd.png")}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={["rgba(250,246,227,0.98)", "rgba(250,246,227,0.05)"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <Text style={s.farmTitle}>Fresh from{"\n"}our farms</Text>
        <Text style={s.farmCaption}>Every delivery makes a difference</Text>
      </Pressable>
    </>
  );
}
function Stat({
  title,
  value,
  icon,
  small,
  onPress,
}: {
  title: string;
  value: string;
  icon: IconName;
  small?: boolean;
  onPress?: () => void;
}) {
  const content = (
    <Card style={[s.stat, small && s.smallStat]}>
      <View style={s.statTop}>
        <Text style={s.statLabel}>{title}</Text>
        {!small && <IconBox name={icon} size={19} />}
      </View>
      {small && <Ionicons name={icon} color={colors.green} size={19} />}
      <Text
        adjustsFontSizeToFit
        numberOfLines={1}
        style={[s.statValue, small && { fontSize: 17 }]}
      >
        {value}
      </Text>
    </Card>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ flex: 1 }}>
      {content}
    </Pressable>
  ) : (
    <View style={{ flex: 1 }}>{content}</View>
  );
}

export function TasksTab({ navigation }: { navigation: Navigation }) {
  const events = useDemo((state) => state.events);
  const [filter, setFilter] = useState<TaskStatus>("new");
  const [busy, setBusy] = useState<string | null>(null);
  const tasks = demoTasks(events);
  const labels: [TaskStatus, string][] = [
    ["new", "New"],
    ["accepted", "Accepted"],
    ["in-progress", "In progress"],
    ["completed", "Completed"],
  ];
  async function accept(id: string) {
    setBusy(id);
    await acceptTask(id);
    setBusy(null);
  }
  return (
    <>
      <PageTitle
        title="My tasks"
        subtitle="Manage and complete your sample deliveries."
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.horizontalFilters}
      >
        {labels.map(([value, label]) => (
          <Chip
            key={value}
            label={`${label} (${tasks.filter((task) => task.status === value).length})`}
            active={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </ScrollView>
      {tasks
        .filter((task) => task.status === filter)
        .map((task) => (
          <Card key={task.id}>
            <Pressable
              onPress={() =>
                navigation.openPage({
                  kind: task.status === "new" ? "assignment" : "order",
                  id: task.id,
                })
              }
              accessibilityRole="button"
              style={s.taskHeader}
            >
              <IconBox name="bag-outline" />
              <View style={{ flex: 1 }}>
                <Text style={s.bold}>Order #{task.order}</Text>
                <Text style={s.bold}>{task.name}</Text>
                <Text style={s.muted}>⌖ {task.address}</Text>
                <Text style={s.small}>{task.items}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 7 }}>
                <Text style={s.badge}>
                  {task.status === "new"
                    ? "New"
                    : task.status === "completed"
                      ? "Done"
                      : "Demo"}
                </Text>
                <Text style={s.small}>{task.distance}</Text>
                <Text style={s.small}>{task.time}</Text>
              </View>
            </Pressable>
            {task.status === "new" && (
              <View style={[s.row, { marginTop: 12 }]}>
                <Button
                  compact
                  icon="checkmark"
                  label="Accept"
                  disabled={busy !== null}
                  onPress={() => void accept(task.id)}
                  style={{ flex: 1 }}
                />
                <Button
                  compact
                  icon="close"
                  label="Reject"
                  secondary
                  disabled={busy !== null}
                  onPress={() => rejectDemoAssignment(task.id)}
                  style={{ flex: 1 }}
                />
              </View>
            )}
          </Card>
        ))}
      {!tasks.some((task) => task.status === filter) && (
        <Card>
          <Text style={s.muted}>No tasks in this category.</Text>
        </Card>
      )}
    </>
  );
}

export function RouteMap() {
  return (
    <View style={s.map}>
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 360 200"
        preserveAspectRatio="none"
      >
        <Path
          d="M 0 50 L 360 110 M 10 145 L 340 20 M 80 0 L 180 200 M 235 0 L 330 200 M 0 180 L 360 45"
          stroke="#FDF9ED"
          strokeWidth="6"
          fill="none"
        />
        <Path
          d="M 25 142 C 70 145 62 65 116 82 S 168 47 200 48 S 234 127 270 122 S 306 102 337 114"
          stroke="#5C8B26"
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        {[
          { x: 25, y: 142, n: "H" },
          { x: 116, y: 82, n: "1" },
          { x: 200, y: 48, n: "2" },
          { x: 270, y: 122, n: "3" },
          { x: 337, y: 114, n: "✓" },
        ].map((point) => (
          <Circle
            key={point.n}
            cx={point.x}
            cy={point.y}
            r="12"
            fill={colors.green}
            stroke={colors.raised}
            strokeWidth="3"
          />
        ))}
        {[
          { x: 25, y: 142, n: "H" },
          { x: 116, y: 82, n: "1" },
          { x: 200, y: 48, n: "2" },
          { x: 270, y: 122, n: "3" },
          { x: 337, y: 114, n: "✓" },
        ].map((point) => (
          <SvgText
            key={point.n}
            x={point.x}
            y={point.y + 4}
            fill="#FFFDF8"
            fontSize="11"
            textAnchor="middle"
            fontWeight="bold"
          >
            {point.n}
          </SvgText>
        ))}
      </Svg>
      <View style={s.mapLabel}>
        <Ionicons
          name="information-circle-outline"
          size={15}
          color={colors.secondary}
        />
        <Text style={s.small}>Illustrated demo map</Text>
      </View>
    </View>
  );
}

export function RoutesTab({ navigation }: { navigation: Navigation }) {
  const state = useDemo();
  const current = lastActiveOffer(state.events);
  const selected = nextRouteStop(state.events, stops);
  const ordered = [...stops].sort((a, b) =>
    a.id === selected?.id ? -1 : b.id === selected?.id ? 1 : 0,
  );
  return (
    <>
      <PageTitle
        title="Routes"
        subtitle="Follow your sample route for today’s deliveries."
      />
      <RouteMap />
      <View style={s.routeSummary}>
        <View style={s.summaryMetric}>
          <Ionicons name="bicycle-outline" size={22} color={colors.green} />
          <View>
            <Text style={s.small}>Total distance</Text>
            <Text style={s.bold}>12.4 km</Text>
          </View>
        </View>
        <View style={s.summaryMetric}>
          <Ionicons name="time-outline" size={22} color={colors.green} />
          <View>
            <Text style={s.small}>Est. duration</Text>
            <Text style={s.bold}>42 min</Text>
          </View>
        </View>
      </View>
      {current && (
        <Card style={s.activeRoute}>
          <Text style={s.greenTitle}>Active sample assignment</Text>
          <Text style={s.muted}>Finish this job to resume your route</Text>
          <Button
            label="Go to active job"
            onPress={() => navigation.openWorkspace({ tab: "today" })}
            compact
          />
        </Card>
      )}
      <View style={s.sectionRow}>
        <View style={s.row}>
          <Ionicons name="git-network-outline" size={21} color={colors.green} />
          <Text style={s.cardTitle}>Delivery stops</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            const next = [
              stops[3],
              stops[1],
              stops[4],
              stops[0],
              stops[2],
            ].find((stop) => !isResolved(state.events, stop.id));
            if (next)
              state.record({
                id: `next:${Date.now()}`,
                kind: "next",
                stopId: next.id,
              });
          }}
        >
          <Text style={s.link}>Optimize route ⇄</Text>
        </Pressable>
      </View>
      <Card>
        {ordered.map((stop, index) => (
          <Pressable
            key={stop.id}
            onPress={() =>
              navigation.openWorkspace({ tab: "route", stop: stop.id })
            }
            style={s.stopRow}
            accessibilityRole="button"
          >
            <View style={s.stopNumber}>
              <Text style={s.stopNumberText}>{index + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.bold}>{stop.name}</Text>
              <Text style={s.muted}>⌖ {stop.address}</Text>
            </View>
            <Text style={s.badge}>
              {isResolved(state.events, stop.id)
                ? "Done"
                : `${9 + Math.floor(index / 2)}:${index % 2 ? "30" : "00"}`}
            </Text>
            <Ionicons name="chevron-forward" size={19} color={colors.text} />
          </Pressable>
        ))}
      </Card>
      <View style={s.row}>
        <Button
          label="Start demo route"
          icon="navigate"
          onPress={() =>
            navigation.openWorkspace({ tab: current ? "today" : "route" })
          }
          style={{ flex: 1 }}
        />
        <Button
          label="View map"
          secondary
          icon="map-outline"
          onPress={() => navigation.openPage({ kind: "map" })}
          style={{ flex: 1 }}
        />
      </View>
    </>
  );
}

export function EarningsTab({ navigation }: { navigation: Navigation }) {
  const state = useDemo();
  const [period, setPeriod] = useState<"Today" | "This week" | "This month">(
    "Today",
  );
  const now = useNow(state.clockOffset);
  const days = period === "Today" ? 1 : period === "This week" ? 7 : 30;
  const events = state.events.filter((event) =>
    period === "Today"
      ? dayKey(event.at) === dayKey(now)
      : event.at <= now && event.at >= now - days * 86400000,
  );
  const total = earnings(events),
    completed = countCompleted(events);
  const cod = events
    .filter((event) => event.kind === "cash-collected")
    .reduce((sum, event) => sum + (event.amount ?? 0), 0);
  const chart = Array.from({ length: 7 }, (_, index) => {
    const day = now - (6 - index) * 86400000;
    return {
      day,
      amount: earnings(
        state.events.filter((event) => dayKey(event.at) === dayKey(day)),
      ),
    };
  });
  const high = Math.max(1, ...chart.map((item) => item.amount));
  return (
    <>
      <PageTitle
        title="Earnings"
        subtitle="Track your sample income and settlements."
      />
      <View style={s.filterRow}>
        {(["Today", "This week", "This month"] as const).map((item) => (
          <Chip
            key={item}
            label={item}
            active={period === item}
            onPress={() => setPeriod(item)}
          />
        ))}
      </View>
      <LinearGradient colors={["#396D17", "#244D0E"]} style={s.earnHero}>
        <View>
          <Text style={s.earnLabel}>
            {period === "Today"
              ? "Today’s earnings"
              : period === "This week"
                ? "This week"
                : "This month"}
          </Text>
          <Text style={s.earnAmount}>{money(total)}</Text>
          <Text style={s.earnSub}>Based on demo delivery activity</Text>
        </View>
        <Image
          source={require("../../assets/images/milk-hd.png")}
          style={{ width: 85, height: 100 }}
          contentFit="contain"
        />
      </LinearGradient>
      <View style={s.statRow}>
        <Stat
          title="Deliveries"
          value={String(completed)}
          icon="bicycle-outline"
        />
        <Stat
          title="Incentives"
          value={money(
            earnings(
              events.filter(
                (event) =>
                  event.kind === "failed" || event.kind === "offer-failed",
              ),
            ),
          )}
          icon="trophy-outline"
        />
      </View>
      <View style={s.statRow}>
        <Stat
          title="COD collected"
          value={money(cod)}
          icon="cash-outline"
          onPress={() => navigation.openWorkspace({ tab: "earnings" })}
        />
        <Stat
          title="Pending settlement"
          value={money(total)}
          icon="wallet-outline"
          onPress={() => navigation.openPage({ kind: "payouts" })}
        />
      </View>
      <Card>
        <View style={s.sectionRow}>
          <Text style={s.cardTitle}>Earnings trend</Text>
          <Text style={s.muted}>Last 7 days</Text>
        </View>
        <View style={s.chart}>
          {chart.map((item) => (
            <View key={item.day} style={s.barColumn}>
              <Text style={s.barValue}>
                {money(item.amount).replace(".00", "")}
              </Text>
              <View
                style={[
                  s.bar,
                  {
                    height: Math.max(5, (item.amount / high) * 70),
                    backgroundColor:
                      dayKey(item.day) === dayKey(now)
                        ? colors.green
                        : "#B9D78B",
                  },
                ]}
              />
              <Text style={s.small}>
                {new Intl.DateTimeFormat("en-IN", {
                  weekday: "short",
                  timeZone: "Asia/Kolkata",
                }).format(item.day)}
              </Text>
            </View>
          ))}
        </View>
      </Card>
      <Pressable
        onPress={() => navigation.openPage({ kind: "payouts" })}
        accessibilityRole="button"
      >
        <Card style={s.listRow}>
          <IconBox name="business-outline" />
          <Text style={[s.bold, { flex: 1 }]}>Withdrawals & payouts</Text>
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Card>
      </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  welcome: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    marginTop: 4,
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.raised,
  },
  avatarText: { color: colors.green, fontFamily: fonts.bold, fontSize: 22 },
  greeting: { fontFamily: fonts.bold, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.secondary, fontSize: 11, lineHeight: 17 },
  small: { color: colors.secondary, fontSize: 10, lineHeight: 16 },
  bold: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 19 },
  availability: { flexDirection: "row", alignItems: "center", gap: 11 },
  greenTitle: { color: colors.greenDark, fontFamily: fonts.bold, fontSize: 14 },
  statRow: { flexDirection: "row", gap: 9 },
  stat: { minHeight: 104, padding: 13 },
  smallStat: { minHeight: 100, padding: 11 },
  statTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  statLabel: { fontFamily: fonts.medium, fontSize: 10, flexShrink: 1 },
  statValue: {
    fontFamily: fonts.bold,
    fontSize: 22,
    lineHeight: 28,
    marginTop: 3,
  },
  cardTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontFamily: fonts.bold, fontSize: 14 },
  badge: {
    color: colors.greenDark,
    backgroundColor: colors.greenSoft,
    fontFamily: fonts.semibold,
    fontSize: 10,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  nextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginTop: 12,
  },
  assignmentBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: "#F4F8E9",
  },
  farmBanner: {
    height: 95,
    borderRadius: 17,
    overflow: "hidden",
    padding: 14,
    justifyContent: "center",
    marginBottom: 10,
  },
  farmTitle: {
    color: colors.greenDeep,
    fontFamily: fonts.bold,
    fontSize: 18,
    lineHeight: 21,
  },
  farmCaption: { color: colors.greenDark, fontSize: 10, marginTop: 4 },
  filterRow: {
    flexDirection: "row",
    gap: 7,
    flexWrap: "wrap",
    marginBottom: 14,
  },
  horizontalFilters: { flexDirection: "row", gap: 7, paddingBottom: 14 },
  taskHeader: { flexDirection: "row", gap: 11, alignItems: "flex-start" },
  map: {
    height: 215,
    backgroundColor: "#E7ECD8",
    borderRadius: 19,
    overflow: "hidden",
    marginBottom: 10,
  },
  mapLabel: {
    position: "absolute",
    bottom: 9,
    right: 9,
    backgroundColor: colors.raised,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 9,
  },
  routeSummary: { flexDirection: "row", marginBottom: 15, gap: 10 },
  summaryMetric: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.raised,
    borderRadius: 13,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.line,
  },
  activeRoute: { backgroundColor: colors.greenSoft, gap: 8 },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  link: { color: colors.green, fontFamily: fonts.semibold, fontSize: 11 },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  stopNumber: {
    width: 29,
    height: 29,
    borderRadius: 15,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  stopNumberText: {
    color: colors.inverse,
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  earnHero: {
    borderRadius: 19,
    minHeight: 135,
    padding: 17,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 11,
  },
  earnLabel: {
    color: colors.inverse,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  earnAmount: {
    color: colors.inverse,
    fontFamily: fonts.bold,
    fontSize: 31,
    lineHeight: 39,
  },
  earnSub: { color: "#E6F1D5", fontSize: 10 },
  chart: {
    height: 125,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 3,
  },
  barColumn: { flex: 1, alignItems: "center", gap: 4 },
  bar: { width: "75%", borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  barValue: { fontSize: 8, fontFamily: fonts.semibold },
  listRow: { flexDirection: "row", alignItems: "center", gap: 11 },
});
