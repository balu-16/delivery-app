/// <reference types="jest" />
import { cashBalance, earnings, migrateDemo, useDemo } from "../src/store";
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
beforeEach(() => useDemo.getState().reset());
test("replayed action IDs do not duplicate cash or earnings", () => {
  const store = useDemo.getState();
  store.record({
    id: "collect:1",
    kind: "cash-collected",
    stopId: "stop-2",
    amount: 11000,
  });
  store.record({
    id: "collect:1",
    kind: "cash-collected",
    stopId: "stop-2",
    amount: 11000,
  });
  store.record({ id: "delivery:1", kind: "delivered", stopId: "stop-2" });
  store.record({ id: "delivery:1", kind: "delivered", stopId: "stop-2" });
  expect(cashBalance(useDemo.getState().events)).toBe(11000);
  expect(earnings(useDemo.getState().events)).toBe(1800);
});
test("drafts are independent and a terminal action clears only its stop", () => {
  useDemo.getState().draft("stop-1", { bottles: "2" });
  useDemo.getState().draft("stop-2", { cash: "110" });
  useDemo
    .getState()
    .record({ id: "complete", kind: "delivered", stopId: "stop-1" });
  expect(useDemo.getState().drafts["stop-1"]).toBeUndefined();
  expect(useDemo.getState().drafts["stop-2"].cash).toBe("110");
});
test("old saved state migrates without losing events", () => {
  const old = { events: [{ id: "one", kind: "hub", at: 1 }], language: "en" };
  expect(migrateDemo(old, 0)).toMatchObject({ ...old, drafts: {} });
  expect(() => migrateDemo(null, 0)).toThrow();
});

test("cash handovers cannot overdraw and duplicate collections do not add cash", () => {
  const store = useDemo.getState();
  store.record({
    id: "cash-1",
    kind: "cash-collected",
    stopId: "stop-2",
    amount: 11000,
  });
  store.record({
    id: "cash-2",
    kind: "cash-collected",
    stopId: "stop-2",
    amount: 11000,
  });
  store.record({ id: "overdraft", kind: "cash-handover", amount: 12000 });
  store.record({ id: "receipt-1", kind: "cash-handover", amount: 4000 });
  store.record({ id: "receipt-1", kind: "cash-handover", amount: 4000 });
  expect(cashBalance(useDemo.getState().events)).toBe(7000);
});
test("demo sync retains pending events across a simulated conflict until retried", () => {
  useDemo.getState().setSignal(false);
  useDemo
    .getState()
    .record({ id: "arrival", kind: "arrived", stopId: "stop-1" });
  useDemo.getState().setConflict();
  useDemo.getState().setSignal(true);
  expect(useDemo.getState().events[0].pending).toBe(true);
  useDemo.getState().retrySync();
  expect(useDemo.getState().events[0].pending).toBe(false);
});

test("a stored version 1 snapshot migrates and restores stop drafts", async () => {
  const storage = require("@react-native-async-storage/async-storage");
  const old = {
    events: [{ id: "old-arrival", kind: "arrived", stopId: "stop-2", at: 100 }],
    drafts: { "stop-2": { bottles: "1", cash: "50" } },
    language: "en",
    onboarded: true,
    signal: true,
    offerExpiresAt: null,
  };
  await storage.setItem(
    "@dairydirect/partner-demo",
    JSON.stringify({ state: old, version: 1 }),
  );
  await useDemo.persist.rehydrate();
  expect(useDemo.getState().events[0].id).toBe("old-arrival");
  expect(useDemo.getState().drafts["stop-2"].cash).toBe("50");
  expect(useDemo.getState().offerCounter).toBe(0);
});
