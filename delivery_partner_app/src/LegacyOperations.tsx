import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Children, useEffect, useRef, useState } from "react";
import {
  Alert as NativeAlert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  View,
  useWindowDimensions,
  type AlertButton,
  type TextProps,
  type TextInputProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg";
import { TabView } from "react-native-tab-view";
import {
  attemptCount,
  canAcceptCash,
  canOfferDuringRoute,
  distancePassed,
  DEMO_CASH_LIMIT,
  hasOpenIssue,
  hubReturnUnits,
  isResolved,
  isValidCount,
  lastActiveOffer,
  MIN_CONTACT_ATTEMPTS,
  OFFER_DURATION_MS,
  openPickupIssue,
  pendingCash,
  pendingAttemptReviews,
  pickupAffectedStops,
  waitRemaining,
} from "../src/domain";
import {
  cashBalance,
  earnings,
  has,
  money as formatMoney,
  stops,
  useDemo,
  type Stop,
} from "../src/store";
import { dictionaries, translate } from "../src/i18n";
import { riderDemo, type RiderTransport } from "../src/riderDemo";
import { demoTasks } from "./assignments";
import { randomUUID } from "./uuid";

const green = "#3D6D15",
  dark = "#2F2419",
  cream = "#FBF3E7",
  muted = "#73604A";
const images = {
  farm: require("../assets/images/farm-scene-hd.png"),
  calf: require("../assets/images/calf-hd.png"),
  milk: require("../assets/images/milk-hd.png"),
};
function Text({ children, ...props }: TextProps) {
  const language = useDemo((state) => state.language);
  return (
    <NativeText
      {...props}
      style={[{ fontFamily: "Poppins_400Regular" }, props.style]}
    >
      {Children.map(children, (child) => {
        if (typeof child !== "string") return child;
        const trimmed = child.trim();
        return trimmed
          ? child.replace(trimmed, translate(trimmed, language))
          : child;
      })}
    </NativeText>
  );
}
function showAlert(title: string, message?: string, buttons?: AlertButton[]) {
  const language = useDemo.getState().language;
  const translatedTitle = translate(title, language),
    translatedMessage = message ? translate(message, language) : undefined;
  if (Platform.OS === "web") {
    if (buttons?.length) {
      if (
        globalThis.confirm(
          [translatedTitle, translatedMessage].filter(Boolean).join("\n"),
        )
      )
        buttons[buttons.length - 1]?.onPress?.();
    } else
      globalThis.alert(
        [translatedTitle, translatedMessage].filter(Boolean).join("\n"),
      );
    return;
  }
  NativeAlert.alert(
    translatedTitle,
    translatedMessage,
    buttons?.map((button) => ({
      ...button,
      text: button.text ? translate(button.text, language) : undefined,
    })),
  );
}
function TextInput({ placeholder, ...props }: TextInputProps) {
  const language = useDemo((state) => state.language);
  return (
    <NativeTextInput
      {...props}
      placeholder={placeholder ? translate(placeholder, language) : placeholder}
    />
  );
}
const uid = () => randomUUID();
function Button({
  title,
  onPress,
  secondary = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  const last = useRef({ title: "", at: 0 });
  const haptics = useDemo((state) => state.hapticsOn);
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View style={animated}>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPressIn={() => {
          if (!reduced) scale.set(withTiming(0.97, { duration: 90 }));
        }}
        onPressOut={() => {
          if (!reduced)
            scale.set(withSpring(1, { damping: 18, stiffness: 260 }));
        }}
        onPress={() => {
          const now = Date.now();
          if (last.current.title === title && now - last.current.at < 500)
            return;
          last.current = { title, at: now };
          if (haptics && Platform.OS !== "web")
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
              () => {},
            );
          onPress();
        }}
        style={[
          s.button,
          secondary && s.secondary,
          disabled && { opacity: 0.45 },
        ]}
      >
        <Text style={[s.buttonText, secondary && { color: green }]}>
          {title}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
function Progress({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(value);
  useEffect(() => {
    progress.set(reduced ? value : withTiming(value, { duration: 350 }));
  }, [progress, reduced, value]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));
  return (
    <View style={s.progressTrack}>
      <Animated.View style={[s.progressFill, style]} />
    </View>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <LinearGradient
        pointerEvents="none"
        colors={["#FFFCF6", "#FBF4E8"]}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}
function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={s.heading}>
      <Text style={s.headingText}>{title}</Text>
      {sub && <Text style={s.muted}>{sub}</Text>}
    </View>
  );
}
export default function LegacyOperations({
  initialTab = "route",
  initialStopId,
  initialPanel,
  onClose,
}: {
  initialTab?: "today" | "route" | "earnings" | "profile";
  initialStopId?: string;
  initialPanel?: "support" | "notifications";
  onClose: () => void;
}) {
  const state = useDemo();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<"today" | "route" | "earnings" | "profile">(
    initialTab,
  );
  const [selected, setSelected] = useState<string | null>(
    initialStopId ?? null,
  );
  const [now, setNow] = useState(0);
  const [cashInput, setCashInput] = useState("");
  const [reason, setReason] = useState("");
  const [panel, setPanel] = useState<
    "notifications" | "support" | "upi" | "location" | null
  >(initialPanel ?? null);
  const [supportText, setSupportText] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [bottleCount, setBottleCount] = useState("");
  const [returnCount, setReturnCount] = useState("");
  const [crateCount, setCrateCount] = useState("");
  const [choices, setChoices] = useState<{
    title: string;
    items: { label: string; action: () => void }[];
  } | null>(null);
  const needsSecondUpdates =
    state.offerExpiresAt !== null ||
    state.events.some(
      (event) =>
        event.kind === "arrived" &&
        event.stopId &&
        !isResolved(state.events, event.stopId),
    );
  useEffect(() => {
    if (!state.hydrated) return;
    const initial = setTimeout(() => setNow(Date.now() + state.clockOffset), 0);
    const timer = setInterval(
      () => setNow(Date.now() + state.clockOffset),
      needsSecondUpdates ? 1000 : 60000,
    );
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [state.hydrated, state.clockOffset, needsSecondUpdates]);
  if (!state.hydrated)
    return (
      <View style={s.loading}>
        <Text>Loading demo…</Text>
      </View>
    );
  const ev = state.events,
    picked = has(ev, "pickup"),
    atHub = has(ev, "hub"),
    started = has(ev, "route-start"),
    done = (id: string) => isResolved(ev, id),
    remaining = stops.filter((x) => !done(x.id));
  const day = (time: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(time);
  const todayEarnings = earnings(
    ev.filter((event) => day(event.at) === day(now)),
  );
  const latest = ev
    .filter((e) => e.kind === "next" && e.stopId && !done(e.stopId))
    .at(-1)?.stopId;
  const next = remaining.find((x) => x.id === latest) ?? remaining[0];
  const orderedStops = [...stops].sort((a, b) =>
    a.id === latest ? -1 : b.id === latest ? 1 : 0,
  );
  const stop = remaining.find((x) => x.id === selected) ?? next;
  const locale = state.language + "-IN";
  const money = (amount: number) => formatMoney(amount, locale);
  const phrase = (key: string) => translate(key, state.language);
  const resolvedLabel = phrase("{count} of {total} stops resolved")
    .replace("{count}", String(stops.length - remaining.length))
    .replace("{total}", String(stops.length));
  const remainingLabel = phrase("{count} remaining").replace(
    "{count}",
    String(remaining.length),
  );
  const returned = ev
      .filter((e) => ["delivered", "failed"].includes(e.kind))
      .reduce((n, e) => n + Number(e.data || 0), 0),
    failed = ev.filter((e) =>
      ["failed", "transferred"].includes(e.kind),
    ).length,
    failedUnits = hubReturnUnits(ev, stops);
  const balance = cashBalance(ev),
    completed = has(ev, "route-completed"),
    availability =
      ev.filter((e) => e.kind === "availability").at(-1)?.data ?? "offline";
  const activeOffer = lastActiveOffer(ev);
  const detour = !!activeOffer;
  const jobId = activeOffer?.stopId;
  const linkedTask = demoTasks(ev).find((item) => item.offerId === jobId);
  const jobHas = (kind: string) => !!jobId && has(ev, kind, jobId);
  const issueOpen = hasOpenIssue(ev);
  const pickupIssue = openPickupIssue(ev);
  const pickupItems = [
    { id: "hub-milk", label: "Milk bottles · 7" },
    { id: "hub-chilled", label: "Chilled dairy · 2 packs" },
    { id: "hub-crates", label: "Delivery crates · 2" },
  ];
  const itemChecked = (id: string) =>
    ev
      .filter(
        (e) => e.stopId === id && ["hub-check", "hub-uncheck"].includes(e.kind),
      )
      .at(-1)?.kind === "hub-check";
  const offerLive =
    now > 0 && state.offerExpiresAt !== null && state.offerExpiresAt > now;
  const offerFits = canOfferDuringRoute(
    ev,
    stops,
    now,
    state.offersDuringRoute,
  );
  const cashFits = canAcceptCash(
    balance,
    pendingCash(ev, stops),
    state.offerCash,
  );
  const offerVisible = offerFits;
  const offerAllowed =
    state.signal &&
    availability === "online" &&
    !detour &&
    !issueOpen &&
    offerVisible &&
    cashFits;
  const pending = ev.filter((e) => e.pending).length;
  const record = (
    kind: string,
    stopId?: string,
    extra?: { amount?: number; reason?: string; data?: string },
    fixed = false,
  ) =>
    state.record({
      id: fixed ? `${kind}:${stopId ?? "route"}` : `${kind}:${uid()}`,
      kind,
      stopId,
      ...extra,
    });
  const advanceJob = (
    status: Parameters<RiderTransport["advance"]>[1],
    proof?: Parameters<RiderTransport["advance"]>[3],
  ) => {
    if (!jobId) return;
    void riderDemo
      .advance(jobId, status, `job:${status}:${jobId}`, proof)
      .catch(() =>
        showAlert(
          "Unable to update demo job",
          "Please check the job status and try again.",
        ),
      );
  };
  const setAvailability = (v: string) => {
    if (
      v === "offline" &&
      ((picked && !completed && !has(ev, "custody-released")) ||
        (detour && jobHas("offer-pickup")))
    ) {
      showAlert(
        "Milk still in your care",
        "Finish the route, return to the hub, or report an issue before going offline.",
      );
      return;
    }
    record("availability", undefined, { data: v });
  };
  const deliver = (item: Stop) => {
    if (detour || issueOpen || availability !== "online") {
      showAlert(
        "Route paused",
        "Finish the sample job before resuming the route.",
      );
      return;
    }
    if (!picked) {
      showAlert("Pickup required", "Confirm the hub pickup first.");
      return;
    }
    if (!has(ev, "arrived", item.id)) {
      showAlert("Arrival required", "Mark arrival at the stop first.");
      return;
    }
    if (
      item.cash > 0 &&
      (ev.find((e) => e.kind === "cash-collected" && e.stopId === item.id)
        ?.amount ?? 0) < item.cash &&
      !has(ev, "upi", item.id)
    ) {
      showAlert("Payment required", "Record simulated cash or UPI first.");
      return;
    }
    if (
      item.type === "silent" &&
      (!has(ev, "photo", item.id) || !distancePassed(ev, item.id))
    ) {
      showAlert(
        "Demo proof required",
        "Select the sample doorstep photo and run the simulated distance check first.",
      );
      return;
    }
    if (item.type === "standard" && !has(ev, "code", item.id)) {
      showAlert("Demo proof required", "Confirm the demo code first.");
      return;
    }
    if (!isValidCount(state.drafts[item.id]?.bottles ?? "", true)) {
      showAlert("Check bottle count", "Enter a whole number from 0 to 999.");
      return;
    }
    record(
      "delivered",
      item.id,
      { data: state.drafts[item.id]?.bottles || "0" },
      true,
    );
    showAlert("Delivery recorded", "This is a simulated delivery.");
  };
  const fail = (item: Stop) => {
    if (
      detour ||
      issueOpen ||
      availability !== "online" ||
      !has(ev, "arrived", item.id)
    ) {
      showAlert(
        "Arrival required",
        "Finish any detour and mark arrival first.",
      );
      return;
    }
    if (!isValidCount(state.drafts[item.id]?.bottles ?? "", true)) {
      showAlert("Check bottle count", "Enter a whole number from 0 to 999.");
      return;
    }
    const options =
      item.type === "silent"
        ? [
            "Inaccessible doorstep",
            "Wrong address",
            "Damaged item",
            "Partner at fault",
          ]
        : [
            "Customer unavailable",
            "Wrong address",
            "Damaged item",
            "Partner at fault",
          ];
    setChoices({
      title: "Reason for undelivered stop",
      items: options.map((r) => ({
        label: r,
        action: () => {
          if (
            r === "Customer unavailable" &&
            (waitRemaining(ev, item.id, now) > 0 ||
              attemptCount(ev, item.id) < MIN_CONTACT_ATTEMPTS)
          ) {
            showAlert(
              "Wait and contact required",
              "Wait 5 minutes after arrival and record two contact attempts. You can advance demo time in Profile.",
            );
            return;
          }
          if (r === "Wrong address") {
            record("wrong-address", item.id, { reason: r }, true);
            return;
          }
          record(
            "failed",
            item.id,
            { reason: r, data: state.drafts[item.id]?.bottles || "0" },
            true,
          );
        },
      })),
    });
  };

  const tabs = [
    ["today", "sunny-outline"],
    ["route", "map-outline"],
    ["earnings", "wallet-outline"],
    ["profile", "person-outline"],
  ] as const;
  const t = dictionaries[state.language] ?? dictionaries.en;
  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.top}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Ionicons name="arrow-back" size={24} color={dark} />
        </Pressable>
        <View>
          <Text style={s.brand}>
            DairyDirect <Text style={{ color: green }}>Partner</Text>
          </Text>
          <Text style={s.muted}>{t.demo}</Text>
        </View>
        <View style={s.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Simulate SOS"
            hitSlop={10}
            onPress={() =>
              showAlert(
                "Demo only",
                "No emergency call or alert will be sent.",
                [
                  { text: "Cancel" },
                  {
                    text: "Simulate SOS",
                    onPress: () => {
                      record("sos");
                      record("issue", undefined, { reason: "Simulated SOS" });
                      setTab("route");
                    },
                  },
                ],
              )
            }
          >
            <Ionicons name="medkit-outline" size={23} color="#BF4B36" />
            <Text style={{ fontSize: 8, color: "#BF4B36" }}>DEMO SOS</Text>
          </Pressable>
          <Pressable
            onPress={() => setPanel("notifications")}
            accessibilityRole="button"
            accessibilityLabel="Open demo notifications"
            hitSlop={10}
          >
            <Ionicons name="notifications-outline" size={24} color={dark} />
          </Pressable>
        </View>
      </View>
      {state.notice && <Text style={s.notice}>{state.notice}</Text>}
      {pending > 0 && (
        <View style={{ backgroundColor: "#FCE8C2", padding: 8 }}>
          <Text style={s.notice}>
            {pending} pending demo sync · no data is sent
          </Text>
          {state.signal && state.simulateConflict && (
            <Button
              title="Retry demo sync"
              secondary
              onPress={state.retrySync}
            />
          )}
        </View>
      )}
      <TabView
        swipeEnabled={false}
        animationEnabled={!reducedMotion}
        navigationState={{
          index: Math.max(
            0,
            tabs.findIndex(([key]) => key === tab),
          ),
          routes: tabs.map(([key]) => ({ key, title: t[key] })),
        }}
        onIndexChange={(i) => setTab(tabs[i][0])}
        initialLayout={{ width }}
        tabBarPosition="bottom"
        renderScene={({ route }) => (
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: 18,
              paddingBottom: 140,
            }}
            showsVerticalScrollIndicator={false}
          >
            {route.key === "today" && (
              <>
                {!detour && (
                  <>
                    <View style={s.hero}>
                      <Image
                        source={images.farm}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                      />
                      <LinearGradient
                        colors={[
                          "rgba(255,249,239,0.98)",
                          "rgba(255,249,239,0.84)",
                          "rgba(255,249,239,0)",
                        ]}
                        start={{ x: 0, y: 0.5 }}
                        end={{ x: 1, y: 0.5 }}
                        style={StyleSheet.absoluteFill}
                      />
                      <View style={s.heroPanel}>
                        <Text style={s.eyebrow}>VIJAYAWADA · DEMO</Text>
                        <Text style={s.heroText}>Good morning, partner</Text>
                        <Text style={s.body}>
                          Your morning deliveries, all in one place.
                        </Text>
                      </View>
                    </View>
                    <Card>
                      <Text style={s.label}>YOUR STATUS</Text>
                      <Text style={s.title}>
                        {availability === "online"
                          ? t.online
                          : availability === "break"
                            ? t.break
                            : t.offline}
                      </Text>
                      <View style={s.row}>
                        <Button
                          title={t.online}
                          secondary={availability !== "online"}
                          onPress={() => setAvailability("online")}
                        />
                        <Button
                          title={t.break}
                          secondary={availability !== "break"}
                          onPress={() => setAvailability("break")}
                        />
                        <Button
                          title={t.offline}
                          secondary={availability !== "offline"}
                          onPress={() => setAvailability("offline")}
                        />
                      </View>
                      <Pressable onPress={() => setPanel("location")}>
                        <Text style={s.muted}>
                          Demo location · not shared ⓘ
                        </Text>
                      </Pressable>
                    </Card>
                    <Card>
                      <Heading title="Morning route" sub={resolvedLabel} />
                      <Progress
                        value={(stops.length - remaining.length) / stops.length}
                      />
                      <Text style={s.body}>
                        {completed
                          ? failed
                            ? "Completed with issues"
                            : "Route completed"
                          : next
                            ? `${phrase("Next:")} ${next.name} · ${next.address}`
                            : "Return to the hub to close out."}
                      </Text>
                      <Button
                        title="View route"
                        onPress={() => setTab("route")}
                      />
                    </Card>
                  </>
                )}
                <Card>
                  <Heading
                    title={
                      linkedTask
                        ? `Order #${linkedTask.order}`
                        : detour
                          ? "Active sample assignment"
                          : "Delivery offers"
                    }
                    sub={
                      linkedTask
                        ? `${linkedTask.name} · ${linkedTask.address}`
                        : "Simulated individual orders"
                    }
                  />
                  {offerLive && offerVisible ? (
                    <>
                      <Text style={s.body}>
                        Pickup: Demo hub · Drop: Demo Lane 6
                      </Text>
                      <Text style={s.muted}>
                        {state.offerCash
                          ? `${phrase("Cash")} ${money(state.offerCash)}`
                          : "Prepaid"}{" "}
                        · expires in{" "}
                        {Math.ceil((state.offerExpiresAt! - now) / 1000)}
                        {phrase("s")}
                      </Text>
                      {!cashFits && (
                        <Text style={s.notice}>
                          Cash limit would be exceeded by this offer.
                        </Text>
                      )}
                      {!offerFits && (
                        <Text style={s.notice}>
                          This detour would make the next stop late.
                        </Text>
                      )}
                      {picked && !state.offersDuringRoute && (
                        <Text style={s.notice}>
                          Offers are paused during routes.
                        </Text>
                      )}
                      <View style={s.row}>
                        <Button
                          title="Accept"
                          disabled={!offerAllowed}
                          onPress={() => {
                            if (
                              !state.offerId ||
                              !state.offerExpiresAt ||
                              Date.now() + state.clockOffset >=
                                state.offerExpiresAt
                            ) {
                              state.offer(null);
                              showAlert(
                                "Offer expired",
                                "Please request a new demo offer.",
                              );
                              return;
                            }
                            void riderDemo
                              .accept(state.offerId, `accept:${state.offerId}`)
                              .then(() =>
                                showAlert(
                                  "Demo offer accepted",
                                  "Your route is paused. Complete the sample job to resume.",
                                ),
                              )
                              .catch(() =>
                                showAlert(
                                  "Offer expired",
                                  "Please request a new demo offer.",
                                ),
                              );
                          }}
                        />
                        <Button
                          title="Decline"
                          secondary
                          onPress={() => state.offer(null)}
                        />
                      </View>
                    </>
                  ) : offerLive ? (
                    <Text style={s.muted}>
                      Offers are paused during routes.
                    </Text>
                  ) : !detour ? (
                    <Button
                      title="Show sample offer"
                      secondary
                      disabled={detour || availability !== "online"}
                      onPress={() =>
                        state.offer(
                          Date.now() + state.clockOffset + OFFER_DURATION_MS,
                        )
                      }
                    />
                  ) : null}
                  {detour && (availability !== "online" || issueOpen) && (
                    <Text style={s.notice}>
                      Active job paused · resume your shift or resolve the
                      issue.
                    </Text>
                  )}
                  {detour && availability === "online" && !issueOpen && (
                    <>
                      <Text style={s.body}>
                        Route paused · sample one-off job
                      </Text>
                      <Button
                        title="Report breakdown or accident"
                        secondary
                        onPress={() => {
                          record("issue", undefined, {
                            reason: "Breakdown or accident",
                          });
                          setTab("route");
                          showAlert(
                            "Demo issue recorded",
                            "Route paused. No real alert was sent.",
                          );
                        }}
                      />
                      {!jobHas("offer-hub") ? (
                        <Button
                          title="Arrived at pickup"
                          onPress={() => advanceJob("AT_STORE")}
                        />
                      ) : !jobHas("offer-pickup") ? (
                        <Button
                          title="Confirm pickup"
                          onPress={() => advanceJob("PICKED_UP")}
                        />
                      ) : !jobHas("offer-arrived") ? (
                        <Button
                          title="Arrived at customer"
                          onPress={() => advanceJob("ARRIVED")}
                        />
                      ) : !jobHas("offer-code") ? (
                        <>
                          <Text style={s.muted}>Demo delivery code: 1234</Text>
                          <TextInput
                            style={s.input}
                            keyboardType="number-pad"
                            maxLength={4}
                            placeholder="Enter four-digit demo code"
                            value={state.drafts[jobId ?? ""]?.code ?? ""}
                            onChangeText={(v) => {
                              if (jobId) state.draft(jobId, { code: v });
                            }}
                          />
                          <Button
                            title="Verify demo code"
                            onPress={() =>
                              state.drafts[jobId ?? ""]?.code === "1234"
                                ? record("offer-code", jobId, undefined, true)
                                : showAlert("Incorrect demo code", "Try 1234.")
                            }
                          />
                        </>
                      ) : activeOffer?.amount &&
                        !jobHas("cash-collected") &&
                        !jobHas("upi") ? (
                        <Button
                          title={`Collect demo cash ${money(activeOffer.amount)}`}
                          onPress={() =>
                            record(
                              "cash-collected",
                              jobId,
                              { amount: activeOffer.amount },
                              true,
                            )
                          }
                        />
                      ) : (
                        <Button
                          title="Complete job & resume route"
                          onPress={() =>
                            advanceJob("DELIVERED", { deliveryCode: "1234" })
                          }
                        />
                      )}
                      {jobHas("offer-arrived") && (
                        <>
                          <Button
                            title="Record demo contact attempt"
                            secondary
                            onPress={() => record("offer-contact", jobId)}
                          />
                          <Button
                            title="Unable to deliver offer"
                            secondary
                            onPress={() =>
                              setChoices({
                                title: "Reason for undelivered job",
                                items: [
                                  "Customer unavailable",
                                  "Wrong address",
                                  "Damaged item",
                                  "Partner at fault",
                                ].map((r) => ({
                                  label: r,
                                  action: () => {
                                    if (r === "Customer unavailable") {
                                      const arrival = ev.find(
                                        (e) =>
                                          e.kind === "offer-arrived" &&
                                          e.stopId === jobId,
                                      );
                                      const contacts = ev.filter(
                                        (e) =>
                                          e.kind === "offer-contact" &&
                                          e.stopId === jobId,
                                      ).length;
                                      if (
                                        !arrival ||
                                        now - arrival.at < 300000 ||
                                        contacts < 2
                                      ) {
                                        showAlert(
                                          "Wait and contact required",
                                          "Wait 5 minutes and record two contact attempts.",
                                        );
                                        return;
                                      }
                                    }
                                    advanceJob("FAILED", { reason: r });
                                  },
                                })),
                              })
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                </Card>
                <View style={s.stats}>
                  <Card>
                    <Text style={s.muted}>Demo earnings</Text>
                    <Text style={s.title}>{money(todayEarnings)}</Text>
                  </Card>
                  <Card>
                    <Text style={s.muted}>Cash in hand</Text>
                    <Text style={s.title}>{money(balance)}</Text>
                  </Card>
                </View>
              </>
            )}
            {route.key === "route" &&
              (detour || issueOpen || availability === "break") && (
                <Card>
                  <Heading
                    title="Route paused"
                    sub={
                      issueOpen
                        ? "Assistance is simulated. No alert has been sent."
                        : detour
                          ? "Finish the sample offer, then return here."
                          : "Resume your shift to continue."
                    }
                  />
                  {issueOpen ? (
                    <>
                      <Button
                        title="Simulate operations handover"
                        onPress={() => {
                          remaining.forEach((item) =>
                            record(
                              "transferred",
                              item.id,
                              { reason: "Demo operations handover" },
                              true,
                            ),
                          );
                          if (jobId)
                            record(
                              "offer-transferred",
                              jobId,
                              { reason: "Demo operations handover" },
                              true,
                            );
                          record(
                            "custody-released",
                            undefined,
                            undefined,
                            true,
                          );
                          record("issue-resolved");
                        }}
                      />
                      <Button
                        title="Resume after assistance"
                        secondary
                        onPress={() => record("issue-resolved")}
                      />
                    </>
                  ) : detour ? (
                    <Button
                      title="Go to active job"
                      onPress={() => setTab("today")}
                    />
                  ) : (
                    <Button
                      title="Resume shift"
                      onPress={() => setAvailability("online")}
                    />
                  )}
                </Card>
              )}
            {route.key === "route" &&
              !detour &&
              !issueOpen &&
              availability !== "break" && (
                <>
                  <Heading
                    title="Your morning route"
                    sub="Your stops and pickup"
                  />
                  <Card>
                    <View style={s.map}>
                      <Svg width="100%" height="130" viewBox="0 0 340 130">
                        <Path
                          d="M 25 100 C 80 105 60 25 130 43 S 210 110 315 35"
                          stroke="#91ae6f"
                          strokeWidth="5"
                          strokeDasharray="8 5"
                          fill="none"
                        />
                        {stops.map((x, i) => (
                          <Circle
                            key={x.id}
                            cx={30 + i * 70}
                            cy={[98, 65, 46, 77, 42][i]}
                            r="13"
                            fill={x.id === stop?.id ? green : "#9ab579"}
                          />
                        ))}
                        {stops.map((x, i) => (
                          <SvgText
                            key={x.id}
                            x={30 + i * 70}
                            y={[102, 69, 50, 81, 46][i]}
                            fill="white"
                            fontSize="11"
                            textAnchor="middle"
                          >
                            {orderedStops.findIndex(
                              (item) => item.id === x.id,
                            ) + 1}
                          </SvgText>
                        ))}
                      </Svg>
                      {stops.map((x, i) => (
                        <Pressable
                          key={x.id}
                          accessibilityLabel={`Select stop ${orderedStops.findIndex((item) => item.id === x.id) + 1}: ${x.name}`}
                          accessibilityRole="button"
                          onPress={() => setSelected(x.id)}
                          style={{
                            position: "absolute",
                            left: `${((30 + i * 70) / 340) * 100 - 5}%`,
                            top:
                              ([98, 65, 46, 77, 42][i] / 130) * 100 - 13 + "%",
                            width: 38,
                            height: 38,
                          }}
                        />
                      ))}
                    </View>
                    <Text style={s.muted}>
                      Illustrated map · not real navigation
                    </Text>
                  </Card>
                  <Card>
                    <Heading
                      title="Hub pickup"
                      sub="Check your load before leaving"
                    />
                    <Text style={s.body}>
                      Milk bottles · chilled dairy · delivery crates
                    </Text>
                    {!started ? (
                      <Button
                        title="Start route"
                        disabled={availability !== "online"}
                        onPress={() =>
                          record("route-start", undefined, undefined, true)
                        }
                      />
                    ) : !atHub ? (
                      <Button
                        title="Arrived at hub"
                        onPress={() =>
                          record("hub", undefined, undefined, true)
                        }
                      />
                    ) : !picked ? (
                      <>
                        {pickupItems.map((item) => (
                          <Pressable
                            key={item.id}
                            accessibilityRole="checkbox"
                            accessibilityState={{
                              checked: itemChecked(item.id),
                            }}
                            onPress={() =>
                              record(
                                itemChecked(item.id)
                                  ? "hub-uncheck"
                                  : "hub-check",
                                item.id,
                              )
                            }
                            style={s.choice}
                          >
                            <Text style={s.body}>{item.label}</Text>
                            <Ionicons
                              name={
                                itemChecked(item.id)
                                  ? "checkbox"
                                  : "square-outline"
                              }
                              size={23}
                              color={green}
                            />
                          </Pressable>
                        ))}
                        <Button
                          title="Confirm pickup"
                          disabled={
                            pickupItems.some((item) => !itemChecked(item.id)) ||
                            !!pickupIssue
                          }
                          onPress={() =>
                            record("pickup", undefined, undefined, true)
                          }
                        />
                        <Button
                          title="Report pickup discrepancy"
                          secondary
                          onPress={() =>
                            setChoices({
                              title: "Demo pickup issue",
                              items: [
                                "Short quantity",
                                "Damaged item",
                                "Wrong item",
                              ].map((r) => ({
                                label: r,
                                action: () =>
                                  setChoices({
                                    title: "Which item is affected?",
                                    items: [
                                      { label: "Milk bottles", item: "milk" },
                                      { label: "Curd", item: "curd" },
                                      { label: "Paneer", item: "paneer" },
                                      {
                                        label: "Delivery crates",
                                        item: "crates",
                                      },
                                    ].map(({ label, item }) => ({
                                      label,
                                      action: () =>
                                        record("pickup-issue", undefined, {
                                          reason: r,
                                          data: item,
                                        }),
                                    })),
                                  }),
                              })),
                            })
                          }
                        />
                        {pickupIssue && (
                          <>
                            <Text style={s.body}>
                              Affected stops:{" "}
                              {pickupAffectedStops(pickupIssue, remaining)
                                .map((x) => x.name)
                                .join(", ")}
                              . Pickup is paused pending demo operations.
                            </Text>
                            <Button
                              title="Simulate operations resolution"
                              secondary
                              onPress={() =>
                                record("pickup-resolved", undefined, undefined)
                              }
                            />
                          </>
                        )}
                      </>
                    ) : (
                      <Text style={s.success}>✓ Pickup confirmed</Text>
                    )}
                  </Card>
                  <Heading title="Stops" sub={remainingLabel} />
                  {orderedStops.map((item, i) => (
                    <Pressable
                      key={item.id}
                      onPress={() => setSelected(item.id)}
                      style={[s.stop, item.id === stop?.id && s.stopActive]}
                    >
                      <View style={s.number}>
                        <Text style={{ color: green, fontWeight: "700" }}>
                          {i + 1}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.stopName}>
                          {item.name}{" "}
                          {item.type === "silent" ? "· Silent drop" : ""}
                        </Text>
                        <Text style={s.muted}>{item.address}</Text>
                      </View>
                      <Text style={s.muted}>
                        {has(ev, "delivered", item.id)
                          ? "Delivered"
                          : has(ev, "failed", item.id)
                            ? "Issue"
                            : has(ev, "transferred", item.id)
                              ? "Returned"
                              : "›"}
                      </Text>
                    </Pressable>
                  ))}
                  {stop && !done(stop.id) && (
                    <Card>
                      <Heading title={stop.name} sub={stop.address} />
                      <Text style={s.body}>{stop.items}</Text>
                      <Text style={s.muted}>
                        Demo due by:{" "}
                        {new Intl.DateTimeFormat(locale, {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: "Asia/Kolkata",
                        }).format(
                          (ev.find((e) => e.kind === "route-start")?.at ??
                            now) +
                            stop.windowMinutes * 60000,
                        )}
                      </Text>
                      <Text style={s.muted}>
                        {stop.cash
                          ? `Demo cash due: ${money(stop.cash)}`
                          : "Prepaid"}{" "}
                        ·{" "}
                        {stop.type === "silent"
                          ? "Silent doorstep delivery"
                          : "Customer handover"}
                      </Text>
                      <Button
                        title="Make this next stop"
                        secondary
                        disabled={!picked || detour}
                        onPress={() => record("next", stop.id)}
                      />
                      <Button
                        title="Arrived at customer"
                        disabled={
                          !picked || detour || has(ev, "arrived", stop.id)
                        }
                        onPress={() =>
                          record("arrived", stop.id, undefined, true)
                        }
                      />
                      <Button
                        title="Defer stop"
                        secondary
                        disabled={!picked || detour}
                        onPress={() => {
                          const other = remaining.find((x) => x.id !== stop.id);
                          if (other) {
                            record("next", other.id);
                            setSelected(other.id);
                          }
                        }}
                      />
                      {has(ev, "arrived", stop.id) &&
                        stop.type === "standard" && (
                          <Text style={s.muted}>
                            Contact attempts: {attemptCount(ev, stop.id)} /{" "}
                            {MIN_CONTACT_ATTEMPTS} · Wait:{" "}
                            {Math.ceil(waitRemaining(ev, stop.id, now) / 1000)}s
                          </Text>
                        )}
                      {stop.type === "silent" && (
                        <TextInput
                          placeholder="Reason for contacting a silent-drop customer"
                          style={s.input}
                          value={reason}
                          onChangeText={setReason}
                        />
                      )}
                      <Button
                        title="Simulate contact attempt"
                        secondary
                        onPress={() => {
                          if (!has(ev, "arrived", stop.id)) {
                            showAlert(
                              "Arrival required",
                              "Mark arrival before recording a contact attempt.",
                            );
                            return;
                          }
                          if (stop.type === "silent" && !reason.trim()) {
                            showAlert(
                              "Reason required",
                              "Enter a reason before contacting a silent-drop customer.",
                            );
                            return;
                          }
                          const act = () =>
                            record("contact", stop.id, {
                              reason: reason || "Delivery assistance",
                            });
                          if (stop.type === "silent")
                            showAlert(
                              "Silent drop",
                              `Call only if necessary. Reason: ${reason}. No call will be made.`,
                              [
                                { text: "Cancel" },
                                { text: "Confirm", onPress: act },
                              ],
                            );
                          else act();
                        }}
                      />
                      {stop.type === "silent" ? (
                        <>
                          <Button
                            title="Select sample doorstep photo"
                            secondary
                            disabled={!has(ev, "arrived", stop.id)}
                            onPress={() =>
                              record("photo", stop.id, undefined, true)
                            }
                          />
                          {has(ev, "photo", stop.id) && (
                            <View style={s.proof}>
                              <View style={s.doorstep}>
                                <View style={s.door} />
                                <Image
                                  source={images.milk}
                                  style={{
                                    width: 50,
                                    height: 72,
                                    position: "absolute",
                                    bottom: 4,
                                    left: 42,
                                  }}
                                  contentFit="contain"
                                />
                              </View>
                              <Text style={s.muted}>
                                Sample image · no camera used
                              </Text>
                            </View>
                          )}
                          <Button
                            title="Simulate distance check"
                            secondary
                            disabled={!has(ev, "arrived", stop.id)}
                            onPress={() =>
                              setChoices({
                                title: "Demo distance check",
                                items: [
                                  {
                                    label: "At doorstep · 25 m",
                                    action: () =>
                                      record("distance-near", stop.id),
                                  },
                                  {
                                    label: "Too far · 500 m",
                                    action: () => {
                                      record("distance-far", stop.id);
                                      showAlert(
                                        "Outside the demo distance",
                                        "Defer the stop or report an issue.",
                                      );
                                    },
                                  },
                                ],
                              })
                            }
                          />
                          {distancePassed(ev, stop.id) && (
                            <Text style={s.success}>
                              ✓ Simulated distance check passed
                            </Text>
                          )}
                        </>
                      ) : (
                        <>
                          <Text style={s.muted}>Demo delivery code: 1234</Text>
                          <TextInput
                            style={s.input}
                            keyboardType="number-pad"
                            maxLength={4}
                            placeholder="Enter four-digit demo code"
                            value={state.drafts[stop.id]?.code ?? ""}
                            onChangeText={(v) =>
                              state.draft(stop.id, { code: v })
                            }
                          />
                          <Button
                            title="Verify demo code"
                            secondary
                            disabled={!has(ev, "arrived", stop.id)}
                            onPress={() =>
                              state.drafts[stop.id]?.code === "1234"
                                ? record("code", stop.id, undefined, true)
                                : showAlert("Incorrect demo code", "Try 1234.")
                            }
                          />
                        </>
                      )}
                      <Text style={s.label}>EMPTY BOTTLES RETURNED</Text>
                      <TextInput
                        keyboardType="number-pad"
                        placeholder="0"
                        value={state.drafts[stop.id]?.bottles ?? ""}
                        onChangeText={(v) =>
                          state.draft(stop.id, { bottles: v })
                        }
                        style={s.input}
                      />
                      {stop.cash > 0 && (
                        <>
                          <Text style={s.label}>
                            SIMULATED CASH RECEIVED (₹)
                          </Text>
                          <TextInput
                            keyboardType="decimal-pad"
                            placeholder="Amount tendered"
                            value={state.drafts[stop.id]?.cash ?? ""}
                            onChangeText={(v) =>
                              state.draft(stop.id, { cash: v })
                            }
                            style={s.input}
                          />
                          <Text style={s.muted}>
                            Change:{" "}
                            {money(
                              Math.max(
                                0,
                                Math.round(
                                  Number(state.drafts[stop.id]?.cash || 0) *
                                    100,
                                ) - stop.cash,
                              ),
                            )}
                          </Text>
                          {Number(state.drafts[stop.id]?.cash || 0) * 100 <
                            stop.cash && (
                            <TextInput
                              placeholder="Reason if cash is short"
                              style={s.input}
                              value={state.drafts[stop.id]?.shortfall ?? ""}
                              onChangeText={(v) =>
                                state.draft(stop.id, { shortfall: v })
                              }
                            />
                          )}
                          <Button
                            title="Record cash"
                            secondary
                            disabled={
                              has(ev, "cash-collected", stop.id) ||
                              has(ev, "upi", stop.id)
                            }
                            onPress={() => {
                              const tender = Math.round(
                                Number(state.drafts[stop.id]?.cash || 0) * 100,
                              );
                              if (!Number.isFinite(tender) || tender <= 0) {
                                showAlert(
                                  "Check amount",
                                  "Enter the amount received.",
                                );
                                return;
                              }
                              if (
                                tender < stop.cash &&
                                !state.drafts[stop.id]?.shortfall?.trim()
                              ) {
                                showAlert(
                                  "Reason required",
                                  "Explain the cash shortfall.",
                                );
                                return;
                              }
                              const amount = Math.min(tender, stop.cash);
                              record(
                                "cash-collected",
                                stop.id,
                                {
                                  amount,
                                  reason: state.drafts[stop.id]?.shortfall,
                                },
                                true,
                              );
                              if (amount < stop.cash)
                                record(
                                  "cash-issue",
                                  stop.id,
                                  {
                                    amount: stop.cash - amount,
                                    reason: state.drafts[stop.id]?.shortfall,
                                  },
                                  true,
                                );
                            }}
                          />
                          <Button
                            title="Simulate UPI payment"
                            secondary
                            disabled={
                              has(ev, "upi", stop.id) ||
                              (ev.find(
                                (e) =>
                                  e.kind === "cash-collected" &&
                                  e.stopId === stop.id,
                              )?.amount ?? 0) >= stop.cash
                            }
                            onPress={() => setPanel("upi")}
                          />
                        </>
                      )}
                      <Button
                        title="Complete delivery"
                        onPress={() => deliver(stop)}
                      />
                      <Button
                        title="Unable to deliver"
                        secondary
                        onPress={() => fail(stop)}
                      />
                      {has(ev, "wrong-address", stop.id) && (
                        <>
                          <Text style={s.notice}>
                            Wrong address reported · awaiting demo operations
                            review.
                          </Text>
                          <Button
                            title="Simulate address resolution"
                            secondary
                            onPress={() => {
                              if (
                                !isValidCount(
                                  state.drafts[stop.id]?.bottles ?? "",
                                  true,
                                )
                              ) {
                                showAlert(
                                  "Check bottle count",
                                  "Enter a whole number from 0 to 999.",
                                );
                                return;
                              }
                              if (
                                stop.type !== "silent" &&
                                (waitRemaining(ev, stop.id, now) > 0 ||
                                  attemptCount(ev, stop.id) <
                                    MIN_CONTACT_ATTEMPTS)
                              ) {
                                showAlert(
                                  "Wait and contact required",
                                  "Wait 5 minutes and record two contact attempts.",
                                );
                                return;
                              }
                              record(
                                "failed",
                                stop.id,
                                {
                                  reason: "Wrong address",
                                  data: state.drafts[stop.id]?.bottles || "0",
                                },
                                true,
                              );
                            }}
                          />
                        </>
                      )}
                    </Card>
                  )}
                  {remaining.length === 0 && !completed && (
                    <Card>
                      <Heading
                        title="Return to hub"
                        sub="Close out your route"
                      />
                      <Text style={s.body}>
                        Expected bottles: {returned} · Undelivered items:{" "}
                        {failedUnits}
                      </Text>
                      <TextInput
                        style={s.input}
                        keyboardType="number-pad"
                        placeholder="Count crates"
                        value={crateCount}
                        onChangeText={setCrateCount}
                      />
                      {(returned > 0 || failedUnits > 0) &&
                        !has(ev, "reconciled") && (
                          <>
                            <TextInput
                              style={s.input}
                              keyboardType="number-pad"
                              placeholder="Count returned bottles"
                              value={bottleCount}
                              onChangeText={setBottleCount}
                            />
                            <TextInput
                              style={s.input}
                              keyboardType="number-pad"
                              placeholder="Count undelivered items"
                              value={returnCount}
                              onChangeText={setReturnCount}
                            />
                            <Button
                              title="Confirm demo reconciliation"
                              onPress={() => {
                                if (
                                  !isValidCount(bottleCount) ||
                                  !isValidCount(returnCount) ||
                                  !isValidCount(crateCount)
                                ) {
                                  showAlert(
                                    "Counts required",
                                    "Enter whole-number counts from 0 to 999.",
                                  );
                                  return;
                                }
                                if (
                                  Number(bottleCount) !== returned ||
                                  Number(returnCount) !== failedUnits
                                )
                                  record("reconciliation-issue", undefined, {
                                    reason: "Counts differ",
                                  });
                                record(
                                  "reconciled",
                                  undefined,
                                  {
                                    data: JSON.stringify({
                                      bottleCount,
                                      returnCount,
                                      crateCount,
                                    }),
                                  },
                                  true,
                                );
                              }}
                            />
                          </>
                        )}
                      {balance > 0 && !has(ev, "cash-shortfall") && (
                        <>
                          <TextInput
                            placeholder="Reason for outstanding cash"
                            style={s.input}
                            value={reason}
                            onChangeText={setReason}
                          />
                          <Button
                            title="Record outstanding cash"
                            secondary
                            onPress={() => {
                              if (!reason.trim()) {
                                showAlert("Reason required");
                                return;
                              }
                              record(
                                "cash-shortfall",
                                undefined,
                                { amount: balance, reason },
                                true,
                              );
                            }}
                          />
                        </>
                      )}
                      <Button
                        title="Complete route"
                        disabled={
                          !isValidCount(crateCount) ||
                          ((returned > 0 || failedUnits > 0) &&
                            !has(ev, "reconciled")) ||
                          (balance > 0 && !has(ev, "cash-shortfall"))
                        }
                        onPress={() =>
                          record("route-completed", undefined, undefined, true)
                        }
                      />
                    </Card>
                  )}
                  <Card>
                    <Heading title="Need help?" />
                    <Button
                      title="Open demo support"
                      secondary
                      onPress={() => setPanel("support")}
                    />
                    <Button
                      title="Return remaining milk to hub"
                      secondary
                      disabled={!picked || remaining.length === 0}
                      onPress={() =>
                        showAlert(
                          "Return to hub?",
                          "This resolves the remaining stops as a simulated return.",
                          [
                            { text: "Cancel" },
                            {
                              text: "Confirm",
                              onPress: () => {
                                remaining.forEach((item) =>
                                  record(
                                    "transferred",
                                    item.id,
                                    { reason: "Returned to hub" },
                                    true,
                                  ),
                                );
                                record(
                                  "custody-released",
                                  undefined,
                                  undefined,
                                  true,
                                );
                              },
                            },
                          ],
                        )
                      }
                    />
                    <Button
                      title="Report breakdown or accident"
                      secondary
                      onPress={() => {
                        record("issue", undefined, {
                          reason: "Breakdown or accident",
                        });
                        showAlert(
                          "Demo issue recorded",
                          "Route paused. No real alert was sent.",
                        );
                      }}
                    />
                    <Button
                      title="Simulate SOS"
                      secondary
                      onPress={() =>
                        showAlert(
                          "Demo only",
                          "No emergency call or alert will be sent.",
                          [
                            { text: "Cancel" },
                            {
                              text: "Simulate SOS",
                              onPress: () => {
                                record("sos");
                                record("issue", undefined, {
                                  reason: "Simulated SOS",
                                });
                              },
                            },
                          ],
                        )
                      }
                    />
                  </Card>
                </>
              )}
            {route.key === "earnings" && (
              <>
                <Heading
                  title="Earnings"
                  sub="Your work, clearly accounted for"
                />
                <Card>
                  <Text style={s.label}>TODAY · DEMO</Text>
                  <Text style={s.bigMoney}>{money(todayEarnings)}</Text>
                  <Text style={s.muted}>
                    Includes demo delivery and attempt fees
                  </Text>
                  {pendingAttemptReviews(ev) > 0 && (
                    <Text style={s.muted}>
                      Attempt fees pending review: {pendingAttemptReviews(ev)}
                    </Text>
                  )}
                </Card>
                <Card>
                  <Heading title="Cash in hand" sub="Separate from earnings" />
                  <Text style={s.title}>{money(balance)}</Text>
                  <Text style={s.muted}>
                    Demo limit: {money(DEMO_CASH_LIMIT)}
                  </Text>
                  <Text style={s.muted}>
                    Assigned cash still to collect:{" "}
                    {money(pendingCash(ev, stops))}
                  </Text>
                  <TextInput
                    style={s.input}
                    keyboardType="decimal-pad"
                    placeholder="Handover amount in ₹"
                    value={cashInput}
                    onChangeText={setCashInput}
                  />
                  <Button
                    title="Record demo handover"
                    disabled={balance <= 0}
                    onPress={() => {
                      const amount = Math.round(Number(cashInput) * 100);
                      if (
                        !Number.isSafeInteger(amount) ||
                        amount <= 0 ||
                        amount > balance
                      ) {
                        showAlert(
                          "Check amount",
                          "Enter an amount up to the cash held.",
                        );
                        return;
                      }
                      record("cash-handover", undefined, {
                        amount,
                        data: "Demo hub",
                      });
                      setCashInput("");
                    }}
                  />
                  {balance > 0 && (
                    <Text style={s.muted}>
                      Any remaining amount stays as a shortfall.
                    </Text>
                  )}
                </Card>
                <Card>
                  <Heading title="Last 7 days" sub="Demo earnings by day" />
                  <View
                    style={{
                      flexDirection: "row",
                      height: 110,
                      alignItems: "flex-end",
                      justifyContent: "space-around",
                    }}
                  >
                    {Array.from({ length: 7 }, (_, i) => {
                      const day = now - (6 - i) * 86400000;
                      const fmt = new Intl.DateTimeFormat("en-CA", {
                        timeZone: "Asia/Kolkata",
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                      });
                      const total = earnings(
                        ev.filter((e) => fmt.format(e.at) === fmt.format(day)),
                      );
                      return (
                        <View key={i} style={{ alignItems: "center", gap: 5 }}>
                          <View
                            style={{
                              width: 24,
                              height: Math.max(4, Math.min(72, total / 100)),
                              backgroundColor: total ? green : "#E4EEDB",
                              borderRadius: 7,
                            }}
                          />
                          <Text style={s.muted}>
                            {new Intl.DateTimeFormat(locale, {
                              weekday: "narrow",
                              timeZone: "Asia/Kolkata",
                            }).format(day)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </Card>
                <Heading title="Activity" />
                {ev
                  .filter((e) =>
                    [
                      "delivered",
                      "failed",
                      "offer-completed",
                      "offer-failed",
                      "cash-collected",
                      "cash-handover",
                    ].includes(e.kind),
                  )
                  .slice()
                  .reverse()
                  .map((e) => (
                    <View style={s.stop} key={e.id}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.stopName}>
                          {e.kind.replaceAll("-", " ")}
                        </Text>
                        <Text style={s.muted}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone: "Asia/Kolkata",
                          }).format(e.at)}{" "}
                          ·{" "}
                          {e.data === "Demo hub"
                            ? "Demo hub"
                            : (e.stopId ?? "Demo")}
                        </Text>
                      </View>
                      {e.amount !== undefined && (
                        <Text style={s.stopName}>{money(e.amount)}</Text>
                      )}
                    </View>
                  ))}
              </>
            )}
            {route.key === "profile" && (
              <>
                <Heading title="Partner profile" sub="Your demo workspace" />
                <Card>
                  <View style={s.row}>
                    <Image
                      source={images.calf}
                      style={{ width: 82, height: 82 }}
                      contentFit="contain"
                    />
                    <View>
                      <Text style={s.title}>Demo Partner</Text>
                      <Text style={s.muted}>Vijayawada · Bicycle</Text>
                    </View>
                  </View>
                </Card>
                <Card>
                  <Heading
                    title="Language"
                    sub="Choose your preferred language"
                  />
                  <View style={s.row}>
                    {[
                      ["en", "English"],
                      ["te", "తెలుగు"],
                      ["hi", "हिन्दी"],
                      ["kn", "ಕನ್ನಡ"],
                    ].map(([id, label]) => (
                      <Pressable
                        key={id}
                        onPress={() => state.setLanguage(id)}
                        style={[s.chip, state.language === id && s.chipActive]}
                      >
                        <Text>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </Card>
                <Card>
                  <Heading title="Settings" />
                  <Button
                    title={state.hapticsOn ? "Haptics on" : "Haptics off"}
                    secondary
                    onPress={state.setHaptics}
                  />
                  <Text style={s.muted}>
                    Motion follows your device accessibility settings.
                  </Text>
                </Card>
                <Card>
                  <Heading title="Help and notifications" />
                  <Button
                    title="Support tickets"
                    secondary
                    onPress={() => setPanel("support")}
                  />
                  <Button
                    title="Notifications"
                    secondary
                    onPress={() => setPanel("notifications")}
                  />
                </Card>
                <Card>
                  <Heading title="Demo controls" />
                  <Text style={s.body}>
                    Connection: {state.signal ? "Connected" : "Disconnected"}
                  </Text>
                  <Button
                    title={
                      state.signal
                        ? "Simulate signal loss"
                        : "Restore demo signal"
                    }
                    secondary
                    onPress={() => state.setSignal(!state.signal)}
                  />
                  {!state.signal && (
                    <Button
                      title="Simulate a sync conflict"
                      secondary
                      onPress={state.setConflict}
                    />
                  )}
                  <Button
                    title={
                      state.offersDuringRoute
                        ? "Pause offers during route"
                        : "Allow offers during route"
                    }
                    secondary
                    onPress={state.toggleRouteOffers}
                  />
                  <Button
                    title="Advance demo clock 5 minutes"
                    secondary
                    onPress={state.advanceClock}
                  />
                  <TextInput
                    placeholder="Issue reason (optional)"
                    style={s.input}
                    value={reason}
                    onChangeText={setReason}
                  />
                  <Button
                    title="Reset demo"
                    secondary
                    onPress={() =>
                      showAlert(
                        "Reset demo?",
                        "All demo route activity will be cleared.",
                        [
                          { text: "Cancel" },
                          {
                            text: "Reset",
                            style: "destructive",
                            onPress: state.reset,
                          },
                        ],
                      )
                    }
                  />
                </Card>
              </>
            )}
          </ScrollView>
        )}
        renderTabBar={() => null}
      />
      <Modal
        transparent
        visible={!!panel}
        animationType="slide"
        onRequestClose={() => setPanel(null)}
      >
        <View style={panel === "notifications" ? s.clearBackdrop : s.backdrop}>
          {panel === "notifications" && (
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setPanel(null)}
              accessibilityRole="button"
              accessibilityLabel="Close notifications"
            />
          )}
          <View style={s.choiceSheet}>
            <Text style={s.title}>
              {panel === "support"
                ? "Demo support"
                : panel === "upi"
                  ? "Simulated UPI"
                  : panel === "location"
                    ? "Location and privacy"
                    : "Notifications"}
            </Text>
            {panel === "location" ? (
              <>
                <Text style={s.body}>
                  A real delivery app may use location during a shift to support
                  delivery tracking. Background access requires a separate
                  explanation and permission.
                </Text>
                <Text style={s.muted}>
                  This demo does not request, collect, or share your location.
                </Text>
              </>
            ) : panel === "upi" ? (
              <>
                <Text style={s.muted}>
                  Demo only · this image cannot be scanned and no payment will
                  be made.
                </Text>
                <View style={s.qr}>
                  <Svg width={160} height={160} viewBox="0 0 21 21">
                    {Array.from(
                      { length: 441 },
                      (_, i) =>
                        (i * 17 + Math.floor(i / 21) * 11) % 7 < 3 && (
                          <Rect
                            key={i}
                            x={i % 21}
                            y={Math.floor(i / 21)}
                            width={1}
                            height={1}
                            fill="#24450C"
                          />
                        ),
                    )}
                  </Svg>
                </View>
                <Text style={s.body}>
                  {stop
                    ? money(
                        stop.cash -
                          (ev.find(
                            (e) =>
                              e.kind === "cash-collected" &&
                              e.stopId === stop.id,
                          )?.amount ?? 0),
                      )
                    : ""}
                </Text>
                <Button
                  title="Confirm demo payment"
                  onPress={() => {
                    if (stop) record("upi", stop.id, undefined, true);
                    setPanel(null);
                  }}
                />
              </>
            ) : panel === "support" ? (
              <>
                <Text style={s.muted}>
                  Messages stay on this device. No one will receive them.
                </Text>
                {ticketId ? (
                  <>
                    <Button
                      title="All tickets"
                      secondary
                      onPress={() => setTicketId(null)}
                    />
                    <ScrollView style={{ maxHeight: 180 }}>
                      {ev
                        .filter(
                          (e) =>
                            e.id === ticketId ||
                            (e.kind === "support-reply" &&
                              e.stopId === ticketId),
                        )
                        .map((e) => (
                          <View key={e.id} style={s.choice}>
                            <Text style={s.body}>{e.reason}</Text>
                            <Text style={s.muted}>Demo</Text>
                          </View>
                        ))}
                    </ScrollView>
                    <TextInput
                      style={s.input}
                      value={supportText}
                      onChangeText={setSupportText}
                      placeholder="Write a demo reply"
                    />
                    <Button
                      title="Send demo reply"
                      onPress={() => {
                        if (!supportText.trim()) {
                          showAlert("Add a message");
                          return;
                        }
                        record("support-reply", ticketId, {
                          reason: supportText.trim(),
                        });
                        setSupportText("");
                      }}
                    />
                    <Button
                      title={
                        ev
                          .filter(
                            (e) =>
                              e.stopId === ticketId &&
                              ["ticket-closed", "ticket-reopened"].includes(
                                e.kind,
                              ),
                          )
                          .at(-1)?.kind === "ticket-closed"
                          ? "Reopen demo ticket"
                          : "Close demo ticket"
                      }
                      secondary
                      onPress={() =>
                        record(
                          ev
                            .filter(
                              (e) =>
                                e.stopId === ticketId &&
                                ["ticket-closed", "ticket-reopened"].includes(
                                  e.kind,
                                ),
                            )
                            .at(-1)?.kind === "ticket-closed"
                            ? "ticket-reopened"
                            : "ticket-closed",
                          ticketId,
                        )
                      }
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      style={s.input}
                      value={supportText}
                      onChangeText={setSupportText}
                      placeholder="Describe your issue"
                    />
                    <Button
                      title="Create demo ticket"
                      onPress={() => {
                        if (!supportText.trim()) {
                          showAlert("Add a message");
                          return;
                        }
                        record("support-ticket", undefined, {
                          reason: supportText.trim(),
                        });
                        setSupportText("");
                      }}
                    />
                    <ScrollView style={{ maxHeight: 180 }}>
                      {ev
                        .filter((e) => e.kind === "support-ticket")
                        .slice()
                        .reverse()
                        .map((e) => (
                          <Pressable
                            key={e.id}
                            accessibilityRole="button"
                            onPress={() => setTicketId(e.id)}
                            style={s.choice}
                          >
                            <Text style={s.body}>{e.reason}</Text>
                            <Text style={s.muted}>
                              {ev
                                .filter(
                                  (x) =>
                                    x.stopId === e.id &&
                                    [
                                      "ticket-closed",
                                      "ticket-reopened",
                                    ].includes(x.kind),
                                )
                                .at(-1)?.kind === "ticket-closed"
                                ? "Demo · closed"
                                : "Demo · open"}{" "}
                              ›
                            </Text>
                          </Pressable>
                        ))}
                    </ScrollView>
                  </>
                )}
              </>
            ) : (
              <>
                <Text style={s.muted}>
                  These updates are generated on this device.
                </Text>
                {!ev.some((e) =>
                  [
                    "pickup-issue",
                    "issue",
                    "offer-accepted",
                    "reconciliation-issue",
                    "route-completed",
                  ].includes(e.kind),
                ) && <Text style={s.body}>No updates yet.</Text>}
                <Button
                  title="Mark all demo notifications read"
                  secondary
                  disabled={
                    !ev.some(
                      (e) =>
                        [
                          "pickup-issue",
                          "issue",
                          "offer-accepted",
                          "reconciliation-issue",
                          "route-completed",
                        ].includes(e.kind) &&
                        !has(ev, "notification-read", e.id),
                    )
                  }
                  onPress={() =>
                    ev
                      .filter((e) =>
                        [
                          "pickup-issue",
                          "issue",
                          "offer-accepted",
                          "reconciliation-issue",
                          "route-completed",
                        ].includes(e.kind),
                      )
                      .forEach((e) =>
                        record("notification-read", e.id, undefined, true),
                      )
                  }
                />
                <ScrollView style={{ maxHeight: 260 }}>
                  {ev
                    .filter((e) =>
                      [
                        "pickup-issue",
                        "issue",
                        "offer-accepted",
                        "reconciliation-issue",
                        "route-completed",
                      ].includes(e.kind),
                    )
                    .slice()
                    .reverse()
                    .map((e) => (
                      <Pressable
                        key={e.id}
                        accessibilityRole="button"
                        onPress={() =>
                          record("notification-read", e.id, undefined, true)
                        }
                        style={s.choice}
                      >
                        <Text style={s.body}>
                          {e.kind.replaceAll("-", " ")}
                        </Text>
                        <Text style={s.muted}>
                          {has(ev, "notification-read", e.id) ? "Read" : "New"}{" "}
                          · Demo
                        </Text>
                      </Pressable>
                    ))}
                </ScrollView>
              </>
            )}
            <Button title="Close" secondary onPress={() => setPanel(null)} />
          </View>
        </View>
      </Modal>
      <Modal
        transparent
        visible={!!choices}
        animationType="fade"
        onRequestClose={() => setChoices(null)}
      >
        <View style={s.backdrop}>
          <View style={s.choiceSheet}>
            <Text style={s.title}>{choices?.title}</Text>
            {choices?.items.map((item) => (
              <Pressable
                accessibilityRole="button"
                key={item.label}
                style={s.choice}
                onPress={() => {
                  setChoices(null);
                  item.action();
                }}
              >
                <Text style={s.body}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={green} />
              </Pressable>
            ))}
            <Button title="Cancel" secondary onPress={() => setChoices(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: cream },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: cream,
  },
  top: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  brand: {
    fontFamily: "Poppins_700Bold",
    fontSize: 21,
    fontWeight: "700",
    color: dark,
  },
  muted: { fontSize: 12, color: muted, lineHeight: 19 },
  notice: {
    backgroundColor: "#FCE8C2",
    color: dark,
    padding: 8,
    textAlign: "center",
  },
  hero: { height: 190, borderRadius: 24, overflow: "hidden", marginBottom: 14 },
  heroPanel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "64%",
    padding: 18,
    justifyContent: "center",
  },
  heroText: {
    fontFamily: "Poppins_700Bold",
    fontSize: 25,
    fontWeight: "800",
    color: dark,
    lineHeight: 30,
    marginVertical: 8,
  },
  heroTitle: {
    fontSize: 30,
    fontWeight: "800",
    color: dark,
    marginTop: 25,
    marginBottom: 12,
  },
  eyebrow: { fontSize: 10, fontWeight: "700", color: green, letterSpacing: 1 },
  card: {
    backgroundColor: "#FFFCF6",
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: "#EFE1CD",
    overflow: "hidden",
  },
  heading: { marginTop: 10, marginBottom: 4 },
  headingText: {
    fontFamily: "Poppins_700Bold",
    fontSize: 20,
    fontWeight: "700",
    color: dark,
  },
  title: {
    fontFamily: "Poppins_600SemiBold",
    fontSize: 20,
    fontWeight: "600",
    color: dark,
  },
  body: { fontSize: 14, color: dark, lineHeight: 21 },
  label: { fontSize: 10, color: muted, fontWeight: "700", letterSpacing: 0.8 },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: green,
  },
  secondary: { backgroundColor: "#EAF2DD" },
  buttonText: {
    fontFamily: "Poppins_600SemiBold",
    fontSize: 13,
    fontWeight: "600",
    color: "white",
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  stats: { flexDirection: "row", gap: 10 },
  map: { backgroundColor: "#EEF4E5", borderRadius: 16, overflow: "hidden" },
  stop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFCF6",
    padding: 14,
    borderRadius: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#EFE1CD",
  },
  stopActive: { borderColor: "#8BAF62", backgroundColor: "#F3F8E9" },
  number: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#EAF2DD",
    alignItems: "center",
    justifyContent: "center",
  },
  stopName: { fontSize: 14, fontWeight: "700", color: dark },
  success: { color: green, fontWeight: "700" },
  progressTrack: {
    height: 7,
    backgroundColor: "#E4EEDB",
    borderRadius: 5,
    overflow: "hidden",
  },
  progressFill: {
    height: 7,
    width: "100%",
    backgroundColor: green,
    transformOrigin: "left",
  },
  qr: {
    alignSelf: "center",
    padding: 10,
    backgroundColor: "white",
    borderRadius: 14,
  },
  doorstep: {
    width: 115,
    height: 90,
    borderRadius: 10,
    backgroundColor: "#E8D4B6",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    borderBottomWidth: 8,
    borderBottomColor: "#BCA582",
  },
  door: {
    width: 53,
    height: 80,
    backgroundColor: "#A87950",
    borderWidth: 4,
    borderColor: "#F4E7D0",
    borderRadius: 3,
  },
  proof: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#F2F6E8",
    borderRadius: 14,
    padding: 8,
  },
  input: {
    backgroundColor: "#F8F1E6",
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 45,
    color: dark,
    borderWidth: 1,
    borderColor: "#E4D3BC",
  },
  bigMoney: { fontSize: 36, fontWeight: "800", color: green },
  chip: { padding: 10, borderRadius: 12, backgroundColor: "#F8F1E6" },
  chipActive: { backgroundColor: "#DDEBC8" },
  nav: {
    position: "absolute",
    left: 14,
    right: 14,
    height: 66,
    borderRadius: 24,
    backgroundColor: "#FFFCF6",
    flexDirection: "row",
    elevation: 8,
    borderColor: "#EFE1CD",
    borderWidth: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(34,25,13,0.45)",
    justifyContent: "flex-end",
  },
  clearBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "transparent",
  },
  choiceSheet: {
    backgroundColor: "#FFFCF6",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 22,
    gap: 12,
    paddingBottom: 35,
    borderWidth: 1,
    borderColor: "#EFE1CD",
    elevation: 8,
    maxHeight: "90%",
  },
  choice: {
    minHeight: 50,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderColor: "#EFE1CD",
  },
  navIndicator: {
    position: "absolute",
    width: 60,
    height: 52,
    bottom: 6,
    borderRadius: 20,
    backgroundColor: "#EAF2DD",
  },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  navText: { fontSize: 10, fontWeight: "700" },
});
