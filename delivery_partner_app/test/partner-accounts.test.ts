/// <reference types="jest" />
import AsyncStorage from "@react-native-async-storage/async-storage";
import { activateDemoAccount, clearDemoAccount, useDemo } from "../src/store";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

beforeEach(async () => {
  await AsyncStorage.clear();
  await clearDemoAccount();
});

test("demo activity and working preferences are isolated and restored for each account", async () => {
  await activateDemoAccount("partner-a");
  useDemo
    .getState()
    .record({ id: "a-event", kind: "arrived", stopId: "stop-1" });
  useDemo.getState().updatePreferences({ start: "08:00", areas: ["North"] });
  await activateDemoAccount("partner-b");
  expect(
    useDemo.getState().events.some((event) => event.id === "a-event"),
  ).toBe(false);
  expect(useDemo.getState().preferences.start).toBe("09:00");
  useDemo
    .getState()
    .record({ id: "b-event", kind: "arrived", stopId: "stop-2" });
  await activateDemoAccount("partner-a");
  expect(
    useDemo.getState().events.some((event) => event.id === "a-event"),
  ).toBe(true);
  expect(
    useDemo.getState().events.some((event) => event.id === "b-event"),
  ).toBe(false);
  expect(useDemo.getState().preferences).toMatchObject({
    start: "08:00",
    areas: ["North"],
  });
  await clearDemoAccount();
  expect(useDemo.getState().events).toEqual([]);
});

test("anonymous legacy data is left untouched when a real account signs in", async () => {
  const legacy = JSON.stringify({
    state: { events: [{ id: "legacy", kind: "arrived", at: 1 }], drafts: {} },
    version: 3,
  });
  await AsyncStorage.setItem("@dairydirect/partner-demo", legacy);
  await activateDemoAccount("partner-new");
  expect(useDemo.getState().events.some((event) => event.id === "legacy")).toBe(
    false,
  );
  expect(await AsyncStorage.getItem("@dairydirect/partner-demo")).toBe(legacy);
});

test("invalid saved working preferences fall back safely", async () => {
  await AsyncStorage.setItem(
    "@dairydirect/partner-demo/account/broken",
    JSON.stringify({
      version: 3,
      state: {
        events: [],
        drafts: {},
        preferences: {
          mode: "unknown",
          start: "25:00",
          end: "00:00",
          days: null,
          areas: ["invalid"],
          maxDeliveries: -1,
        },
      },
    }),
  );
  await activateDemoAccount("broken");
  expect(useDemo.getState().preferences).toEqual({
    mode: "flexible",
    start: "09:00",
    end: "18:00",
    days: [1, 2, 3, 4, 5],
    areas: ["Central", "East"],
    maxDeliveries: 25,
  });
});

test("unreadable saved data remains intact and the demo stays usable", async () => {
  const key = "@dairydirect/partner-demo/account/damaged";
  await AsyncStorage.setItem(key, "{broken json");
  await activateDemoAccount("damaged");
  expect(useDemo.getState().hydrated).toBe(true);
  expect(useDemo.getState().notice).toMatch(
    /could not be restored|Storage unavailable/,
  );
  useDemo
    .getState()
    .record({ id: "temporary", kind: "arrived", stopId: "stop-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await AsyncStorage.getItem(key)).toBe("{broken json");
});
