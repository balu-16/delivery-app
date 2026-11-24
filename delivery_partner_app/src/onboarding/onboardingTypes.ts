import { ApiError, UploadError, type Application, type OnboardingStore } from "../api";

/**
 * Frozen onboarding contracts (plan.md §3) as seen by the onboarding UI.
 *
 * GET /v1/rider/onboarding adds `homeStore {id,name,city}|null` and
 * `maxDocumentBytes`. POST store/profile/documents return
 * `{ updated: true, application: RiderApplicationDto }` (201); the previous
 * empty/void response is still accepted and reconciled via one scoped read.
 * The upload-url response adds `expiresAt` ISO; the UI only displays the
 * effective expiry message and never parses signing details.
 *
 * The generated rider client is owned by the lead and is not regenerated
 * here. These local types decode both the new snapshot shape and the legacy
 * shape so a mixed-version rollout keeps working.
 */

export type HomeStore = { id: string; name: string; city: string };

export interface ExtendedApplication extends Application {
  maxDocumentBytes?: number;
}

export type SaveSnapshot = { updated: boolean; application: ExtendedApplication };

const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export function asExtendedApplication(input: Application, maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES): ExtendedApplication {
  const raw = input as ExtendedApplication;
  return {
    ...raw,
    homeStore: raw.homeStore ?? null,
    maxDocumentBytes:
      typeof raw.maxDocumentBytes === "number" && raw.maxDocumentBytes > 0
        ? raw.maxDocumentBytes
        : maxDocumentBytes,
  };
}

/** Returns the snapshot application when the POST carried one; null means reconcile via one read. */
export function decodeSaveSnapshot(raw: unknown, maxDocumentBytes?: number): ExtendedApplication | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = (raw as { application?: unknown }).application;
  if (!candidate || typeof candidate !== "object") return null;
  const maybe = candidate as Application;
  if (!("userId" in maybe) || !("status" in maybe)) return null;
  return asExtendedApplication(maybe, maxDocumentBytes);
}

export function resolveHomeStore(
  application: ExtendedApplication,
  stores: OnboardingStore[] | null,
): HomeStore | null {
  if (application.homeStore) return application.homeStore;
  const id = application.homeStoreId;
  if (!id) return null;
  const hit = stores?.find((store) => store.id === id);
  return hit ? { id: hit.id, name: hit.name, city: hit.city } : null;
}

export function maxDocumentLabel(maxBytes: number | undefined): string {
  const bytes = maxBytes && maxBytes > 0 ? maxBytes : DEFAULT_MAX_DOCUMENT_BYTES;
  const mb = bytes / (1024 * 1024);
  if (Number.isInteger(mb)) return `${mb} MB`;
  return `${mb.toFixed(1)} MB`;
}

/** Whether the failure left the write outcome unknown (timeout / lost response). */
export function isUnknownWriteError(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE" || error.status === 0 || error.status >= 500;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  return false;
}

export function errorCodeOf(error: unknown): string | null {
  if (error instanceof ApiError) return error.code;
  return null;
}

/** Single short sentence shown beside the affected control (plan.md §3). */
export function storeErrorMessage(error: unknown): string {
  const code = errorCodeOf(error);
  if (code === "STORE_NOT_FOUND") return "That store is no longer available. Choose another store.";
  if (code === "RIDER_STATE_INVALID") return "Your application is already under review. Refresh its status.";
  return "Could not select the store. Please try again.";
}

export function vehicleErrorMessage(error: unknown): string {
  const code = errorCodeOf(error);
  if (code === "INVALID_RIDER_PROFILE") return "Check your vehicle details and try again.";
  if (code === "RIDER_STATE_INVALID") return "Your application is already under review. Refresh its status.";
  return "Could not save the vehicle. Please try again.";
}

export const UNKNOWN_SAVE_MESSAGE = "Couldn’t confirm the save. Tap Retry.";

/**
 * Canonical row messages for document transfer outcomes. The transfer
 * transport in files.ts (media worker) reports UploadError / ApiError;
 * this maps them to the exact strings required by plan.md §4.
 */
export function uploadRowMessage(error: unknown, phase: 'transfer' | 'confirm'): string {
  const code = errorCodeOf(error);
  if (code === 'UPLOAD_EXPIRED' || code === 'MEDIA_NOT_FOUND') return 'The upload expired.';
  if (code === 'UPLOAD_NOT_RECEIVED') return 'The file wasn’t received. Pick it again.';
  if (code === 'INVALID_MEDIA') return 'Choose a valid JPEG, PNG, or PDF.';
  if (code === 'RIDER_STATE_INVALID') return 'Your application is already under review.';
  if (error instanceof UploadError) return error.kind === 'retryable' ? 'Couldn’t upload this file.' : error.message;
  return phase === 'confirm' ? 'Couldn’t confirm the upload.' : 'Couldn’t upload this file.';
}

/** Stable per-row transfer phases, fed by scoped callbacks (media worker owns transport). */
export type DocumentRowPhase =
  | "idle"
  | "preparing"
  | "uploading"
  | "confirming"
  | "uploaded"
  | "error";

export type DocumentRowState = {
  phase: DocumentRowPhase;
  message: string | null;
  progress?: number;
  reference?: string;
};

export function initialDocumentRowState(): DocumentRowState {
  return { phase: "idle", message: null };
}

export function phaseLabel(phase: DocumentRowPhase): string | null {
  switch (phase) {
    case "preparing": return "Preparing upload…";
    case "uploading": return "Uploading…";
    case "confirming": return "Confirming upload…";
    case "uploaded": return "Uploaded · Awaiting review";
    default: return null;
  }
}
