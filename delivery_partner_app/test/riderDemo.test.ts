/// <reference types="jest" />
import { riderDemo } from "../src/riderDemo";
import { useDemo } from "../src/store";
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
beforeEach(() => {
  useDemo.getState().reset();
  useDemo.getState().hydrateDone();
  useDemo
    .getState()
    .record({ id: "online", kind: "availability", data: "online" });
});
test("mock rider offer follows generated task statuses and replays actions safely", async () => {
  useDemo.getState().offer(Date.now() + 25000);
  const offer = (await riderDemo.offers()).items[0];
  expect(offer.offerId).toMatch(/^[0-9a-f-]{36}$/);
  const accepted = await riderDemo.accept(offer.offerId, "accept-1");
  expect(accepted.status).toBe("ASSIGNED");
  expect(accepted.codAmountPaise).toBeNull();
  expect((await riderDemo.accept(offer.offerId, "accept-1")).status).toBe(
    "ASSIGNED",
  );
  expect(
    (await riderDemo.advance(offer.taskId, "AT_STORE", "arrive-hub")).status,
  ).toBe("AT_STORE");
  expect(
    (await riderDemo.advance(offer.taskId, "AT_STORE", "arrive-hub")).status,
  ).toBe("AT_STORE");
  await riderDemo.advance(offer.taskId, "PICKED_UP", "pickup");
  await riderDemo.advance(offer.taskId, "ARRIVED", "arrive");
  await expect(
    riderDemo.advance(offer.taskId, "DELIVERED", "bad", {
      deliveryCode: "0000",
    }),
  ).rejects.toThrow("DELIVERY_PROOF_REQUIRED");
  expect(
    (
      await riderDemo.advance(offer.taskId, "DELIVERED", "deliver", {
        deliveryCode: "1234",
      })
    ).status,
  ).toBe("DELIVERED");
  expect(
    (
      await riderDemo.advance(offer.taskId, "DELIVERED", "deliver", {
        deliveryCode: "1234",
      })
    ).status,
  ).toBe("DELIVERED");
  expect(
    useDemo.getState().events.filter((e) => e.kind === "offer-completed"),
  ).toHaveLength(1);
});

test("simultaneous accepts of the same offer create only one assignment", async () => {
  useDemo.getState().offer(Date.now() + 25_000);
  const offer = (await riderDemo.offers()).items[0];
  const results = await Promise.allSettled([
    riderDemo.accept(offer.offerId, "first"),
    riderDemo.accept(offer.offerId, "second"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    useDemo
      .getState()
      .events.filter((event) => event.kind === "offer-accepted"),
  ).toHaveLength(1);
});

test("an offer cannot be accepted after the rider goes offline", async () => {
  useDemo.getState().offer(Date.now() + 25_000);
  const offer = (await riderDemo.offers()).items[0];
  useDemo
    .getState()
    .record({ id: "offline", kind: "availability", data: "offline" });
  await expect(
    riderDemo.accept(offer.offerId, "accept-offline"),
  ).rejects.toThrow("OFFER_UNAVAILABLE");
});
