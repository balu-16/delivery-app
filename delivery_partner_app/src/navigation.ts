export type Tab = "home" | "tasks" | "route" | "earnings" | "profile";
export type Page =
  | { kind: "assignment"; id: string }
  | { kind: "order"; id: string }
  | { kind: "working" | "language" | "notifications" | "map" | "payouts" }
  | {
      kind: "info";
      topic: "personal" | "vehicle" | "documents" | "areas" | "emergency";
    };
export type Workspace = {
  tab: "today" | "route" | "earnings" | "profile";
  stop?: string;
  panel?: "support" | "notifications";
};
export type Navigation = {
  setTab: (tab: Tab) => void;
  openPage: (page: Page) => void;
  openWorkspace: (workspace: Workspace) => void;
};
