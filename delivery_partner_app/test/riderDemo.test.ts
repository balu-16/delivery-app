/// <reference types="jest" />
import { riderDemo } from "../src/riderDemo";
import { useDemo } from "../src/store";
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
beforeEach(() => {
  useDemo.getState().reset();
  useDemo.getState().hydrateDone();
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
