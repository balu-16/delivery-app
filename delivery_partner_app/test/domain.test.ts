/// <reference types="jest" />
import {
  attemptCount,
  canAcceptCash,
  hasOpenIssue,
  isResolved,
  lastActiveOffer,
  pendingCash,
  waitRemaining,
} from "../src/domain";
import { stops, type Event } from "../src/store";
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
const event = (id: string, kind: string, stopId?: string, at = 0): Event => ({
  id,
  kind,
  stopId,
  at,
});
test("cash offer limits include assigned unpaid stops", () => {
  const pending = pendingCash([], stops);
  expect(pending).toBe(18500);
  expect(canAcceptCash(10000, pending, 25000, 50000)).toBe(false);
  expect(canAcceptCash(10000, pending, 0, 50000)).toBe(true);
});
test("stop wait counts only contacts after arrival and handles deferral", () => {
  const events = [
    event("old", "contact", "stop-2", 1),
    event("arr", "arrived", "stop-2", 100),
    event("c1", "contact", "stop-2", 200),
    event("defer", "next", "stop-3", 300),
  ];
  expect(attemptCount(events, "stop-2")).toBe(1);
  expect(waitRemaining(events, "stop-2", 100100)).toBe(200000);
  expect(isResolved(events, "stop-2")).toBe(false);
});
test("detours and safety issues retain their own event lifecycles", () => {
  const events = [
    event("a", "offer-accepted", "offer-1"),
    event("b", "offer-completed", "offer-1"),
    event("c", "offer-accepted", "offer-2"),
    event("d", "issue"),
  ];
  expect(lastActiveOffer(events)?.stopId).toBe("offer-2");
  expect(hasOpenIssue(events)).toBe(true);
  events.push(event("e", "issue-resolved"));
  expect(hasOpenIssue(events)).toBe(false);
});

test("a later failed distance check overrides an earlier passing check", () => {
  const events = [
    event("near", "distance-near", "stop-1"),
    event("far", "distance-far", "stop-1"),
  ];
  expect(require("../src/domain").distancePassed(events, "stop-1")).toBe(false);
  events.push(event("near-2", "distance-near", "stop-1"));
  expect(require("../src/domain").distancePassed(events, "stop-1")).toBe(true);
});
