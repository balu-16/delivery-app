/// <reference types="jest" />
import {
  acceptDemoAssignment,
  demoTasks,
  rejectDemoAssignment,
} from "../src/assignments";
import { lastActiveOffer } from "../src/domain";
import { riderDemo } from "../src/riderDemo";
import { useDemo } from "../src/store";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
beforeEach(() => {
  useDemo.getState().reset();
  useDemo.getState().hydrateDone();
});

test("acceptance follows the existing offer rules and updates assignment status through completion", async () => {
  expect(
    demoTasks(useDemo.getState().events).filter(
      (task) => task.status === "new",
    ),
  ).toHaveLength(3);
  await expect(acceptDemoAssignment("sample-1")).rejects.toThrow();
  useDemo
    .getState()
    .record({ id: "online", kind: "availability", data: "online" });
  await acceptDemoAssignment("sample-1");
  const task = demoTasks(useDemo.getState().events).find(
    (item) => item.id === "sample-1",
  )!;
  expect(task.status).toBe("accepted");
  expect(lastActiveOffer(useDemo.getState().events)?.stopId).toBe(task.offerId);
  await expect(acceptDemoAssignment("sample-2")).rejects.toThrow(
    "ACTIVE_ASSIGNMENT",
  );
  await riderDemo.advance(task.offerId!, "AT_STORE", "hub");
  expect(
    demoTasks(useDemo.getState().events).find((item) => item.id === "sample-1")
      ?.status,
  ).toBe("in-progress");
  await riderDemo.advance(task.offerId!, "PICKED_UP", "picked");
  await riderDemo.advance(task.offerId!, "ARRIVED", "arrived");
  await riderDemo.advance(task.offerId!, "DELIVERED", "delivered", {
    deliveryCode: "1234",
  });
  expect(
    demoTasks(useDemo.getState().events).find((item) => item.id === "sample-1")
      ?.status,
  ).toBe("completed");
});

test("rejecting a sample offer removes only that offer", () => {
  rejectDemoAssignment("sample-2");
  expect(
    demoTasks(useDemo.getState().events).some((task) => task.id === "sample-2"),
  ).toBe(false);
  expect(
    demoTasks(useDemo.getState().events).filter(
      (task) => task.kind === "route",
    ),
  ).toHaveLength(5);
});
