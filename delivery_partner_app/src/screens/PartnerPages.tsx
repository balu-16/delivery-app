import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { demoTasks, rejectDemoAssignment, type DemoTask } from "../assignments";
import { Button, Card, IconBox, PageTitle, Text } from "../components/Ui";
import type { Navigation } from "../navigation";
import { money, useDemo } from "../store";
import { colors, fonts } from "../theme";
import { acceptTask, RouteMap } from "./PartnerTabs";

function demoCall() {
  if (Platform.OS === "web")
    globalThis.alert("Demo only. No call will be made.");
  else Alert.alert("Demo only", "No call will be made.");
}
export function AssignmentPage({
  id,
  navigation,
  onBack,
}: {
  id: string;
  navigation: Navigation;
  onBack: () => void;
}) {
  const events = useDemo((state) => state.events);
  const task = demoTasks(events).find((item) => item.id === id);
  if (!task)
    return (
      <>
        <PageTitle title="New assignment" />
        <Card>
          <Text>That sample assignment is no longer available.</Text>
        </Card>
        <Button label="Back to tasks" onPress={onBack} />
      </>
    );
  if (task.status !== "new")
    return <OrderPage id={id} navigation={navigation} onBack={onBack} />;
  return (
    <>
      <PageTitle title="New assignment" />
      <Card style={s.listRow}>
        <IconBox name="cube-outline" />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>New delivery assigned</Text>
          <Text style={s.muted}>You have a sample delivery request.</Text>
        </View>
        <Text style={s.small}>Just now</Text>
      </Card>
      <Card>
        <View style={s.orderHeader}>
          <IconBox name="bag-outline" />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Order #{task.order}</Text>
            <Text style={s.muted}>
              1 delivery · {task.distance} · Est. 20 min
            </Text>
          </View>
          <Text style={s.badge}>New</Text>
        </View>
        <View style={s.stop}>
          <View style={s.number}>
            <Text style={s.numberText}>1</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.bold}>{task.name}</Text>
            <Text style={s.muted}>⌖ {task.address}</Text>
          </View>
          <Text style={s.muted}>{task.distance}</Text>
        </View>
        <View style={s.summary}>
          <View>
            <Text style={s.small}>Expected earning</Text>
            <Text style={s.green}>₹35</Text>
          </View>
          <View>
            <Text style={s.small}>Pickup time</Text>
            <Text style={s.bold}>{task.time.split(" – ")[0]}</Text>
          </View>
        </View>
      </Card>
      <Button
        label="View details"
        icon="arrow-forward"
        onPress={() => navigation.openPage({ kind: "order", id })}
      />
      <View style={{ height: 10 }} />
      <Button
        label="Maybe later"
        icon="time-outline"
        secondary
        onPress={onBack}
      />
    </>
  );
}
export function OrderPage({
  id,
  navigation,
  onBack,
}: {
  id: string;
  navigation: Navigation;
  onBack: () => void;
}) {
  const events = useDemo((state) => state.events);
  const task = demoTasks(events).find((item) => item.id === id);
  const [busy, setBusy] = useState(false);
  if (!task)
    return (
      <>
        <PageTitle title="Order details" />
        <Card>
          <Text>That sample assignment is no longer available.</Text>
        </Card>
        <Button label="Back to tasks" onPress={onBack} />
      </>
    );
  async function accept() {
    setBusy(true);
    const ok = await acceptTask(id);
    setBusy(false);
    if (ok) navigation.openWorkspace({ tab: "today" });
  }
  return (
    <>
      <PageTitle title="Order details" />
      <Card style={s.listRow}>
        <IconBox name="bag-outline" />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Order #{task.order}</Text>
          <Text style={s.muted}>
            {task.items} · {task.cash ? `${money(task.cash)} COD` : "Prepaid"}
          </Text>
        </View>
        <Text style={s.badge}>
          {task.status === "new"
            ? "New"
            : task.status === "completed"
              ? "Done"
              : "Demo"}
        </Text>
      </Card>
      <Card>
        <View style={s.heading}>
          <Ionicons name="storefront-outline" color={colors.green} size={22} />
          <Text style={s.title}>Pickup details</Text>
        </View>
        <View style={s.listRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.bold}>DairyDirect Farm Center</Text>
            <Text style={s.muted}>⌖ Demo Farm Road, Vijayawada</Text>
          </View>
          <Button
            compact
            secondary
            icon="call-outline"
            label="Call"
            onPress={demoCall}
          />
        </View>
        <View style={s.summary}>
          <View>
            <Text style={s.small}>Pickup date</Text>
            <Text style={s.bold}>
              {task.completedAt
                ? new Intl.DateTimeFormat("en-IN", {
                    day: "numeric",
                    month: "short",
                    timeZone: "Asia/Kolkata",
                  }).format(task.completedAt)
                : "Today · Demo"}
            </Text>
          </View>
          <View>
            <Text style={s.small}>Pickup time</Text>
            <Text style={s.bold}>{task.time.split(" – ")[0]}</Text>
          </View>
        </View>
      </Card>
      <Card>
        <View style={s.heading}>
          <Ionicons name="cube-outline" color={colors.green} size={22} />
          <Text style={s.title}>Items to pick up</Text>
        </View>
        {task.items.split(" · ").map((item) => (
          <View key={item} style={s.item}>
            <IconBox name="cafe-outline" size={18} />
            <Text style={[s.bold, { flex: 1 }]}>{item}</Text>
            <Text style={s.muted}>× 1</Text>
          </View>
        ))}
      </Card>
      <Card>
        <View style={s.heading}>
          <Ionicons name="bicycle-outline" color={colors.green} size={22} />
          <Text style={s.title}>Delivery summary</Text>
        </View>
        <View style={s.summary}>
          <Metric icon="location-outline" value="1 stop" />
          <Metric icon="git-network-outline" value={task.distance} />
          <Metric icon="time-outline" value="20 min" />
          <Metric
            icon="wallet-outline"
            value={task.kind === "offer" ? "₹35" : "₹18"}
          />
        </View>
        <Text style={s.muted}>
          {task.name} · {task.address}
        </Text>
      </Card>
      {task.status === "new" ? (
        <View style={s.buttons}>
          <Button
            label="Reject"
            icon="close"
            secondary
            disabled={busy}
            onPress={() => {
              rejectDemoAssignment(id);
              onBack();
            }}
            style={{ flex: 1 }}
          />
          <Button
            label="Accept assignment"
            icon="checkmark"
            disabled={busy}
            onPress={() => void accept()}
            style={{ flex: 1.6 }}
          />
        </View>
      ) : task.status === "completed" ? (
        <Button label="Back to tasks" secondary onPress={onBack} />
      ) : (
        <Button
          label="Continue delivery"
          icon="arrow-forward"
          onPress={() =>
            navigation.openWorkspace(
              task.kind === "route"
                ? { tab: "route", stop: task.id }
                : { tab: "today" },
            )
          }
        />
      )}
    </>
  );
}
function Metric({
  icon,
  value,
}: {
  icon:
    | "location-outline"
    | "git-network-outline"
    | "time-outline"
    | "wallet-outline";
  value: string;
}) {
  return (
    <View style={s.metric}>
      <Ionicons name={icon} size={21} color={colors.green} />
      <Text style={s.small}>{value}</Text>
    </View>
  );
}
export function MapPage() {
  return (
    <>
      <PageTitle
        title="Sample route map"
        subtitle="Illustrated map · not real navigation"
      />
      <RouteMap />
      <Card>
        <Text style={s.muted}>
          This map is an illustration. Your location is not collected or shared.
        </Text>
      </Card>
    </>
  );
}
export function NotificationsPage({ navigation }: { navigation: Navigation }) {
  const events = useDemo((state) => state.events);
  const tasks = demoTasks(events).filter((item) => item.status === "new");
  return (
    <>
      <PageTitle
        title="Notifications"
        subtitle="Updates generated on this device"
      />
      {tasks.map((task: DemoTask) => (
        <Pressable
          key={task.id}
          onPress={() =>
            navigation.openPage({ kind: "assignment", id: task.id })
          }
        >
          <Card style={s.listRow}>
            <IconBox name="cube-outline" />
            <View style={{ flex: 1 }}>
              <Text style={s.bold}>New delivery assigned</Text>
              <Text style={s.muted}>
                Order #{task.order} · {task.name}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.text} />
          </Card>
        </Pressable>
      ))}
      {!tasks.length && (
        <Card>
          <Text style={s.muted}>No new demo notifications.</Text>
        </Card>
      )}
    </>
  );
}
const s = StyleSheet.create({
  listRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontFamily: fonts.bold, fontSize: 15 },
  bold: { fontFamily: fonts.semibold, fontSize: 12 },
  muted: { color: colors.secondary, fontSize: 11, lineHeight: 18 },
  small: { color: colors.secondary, fontSize: 10, lineHeight: 16 },
  green: { color: colors.green, fontFamily: fonts.bold, fontSize: 16 },
  badge: {
    color: colors.greenDark,
    backgroundColor: colors.greenSoft,
    overflow: "hidden",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 16,
    fontFamily: fonts.semibold,
    fontSize: 10,
  },
  orderHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.line,
    marginTop: 13,
    paddingVertical: 14,
  },
  number: {
    width: 31,
    height: 31,
    borderRadius: 16,
    backgroundColor: colors.green,
    justifyContent: "center",
    alignItems: "center",
  },
  numberText: { color: colors.inverse, fontFamily: fonts.bold },
  summary: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    marginTop: 5,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginBottom: 12,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 5,
  },
  metric: { flex: 1, gap: 3, alignItems: "center" },
  buttons: { flexDirection: "row", gap: 9 },
});
