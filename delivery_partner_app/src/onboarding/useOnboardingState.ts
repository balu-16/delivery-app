import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  riderApi,
  type Application,
} from "../api";
import {
  UNKNOWN_SAVE_MESSAGE,
  asExtendedApplication,
  decodeSaveSnapshot,
  initialDocumentRowState,
  isUnknownWriteError,
  resolveHomeStore,
  storeErrorMessage,
  vehicleErrorMessage,
  type DocumentRowState,
  type ExtendedApplication,
  type HomeStore,
} from "./onboardingTypes";

export type SectionStatus = "idle" | "saving" | "saved" | "error" | "unknown";

export type VehicleDraft = {
  vehicleType: string;
  vehicleNo: string;
  /** Suffixed when the rider edited that field; refresh only fills pristine fields. */
  dirtyType: boolean;
  dirtyNo: boolean;
};

export type StoreSectionState = {
  /** Optimistically highlighted store (before ack). */
  optimistic: HomeStore | null;
  status: SectionStatus;
  error: string | null;
  reference?: string;
};

export type VehicleSectionState = {
  draft: VehicleDraft;
  status: SectionStatus;
  error: string | null;
  reference?: string;
};

export type OnboardingSnapshot = {
  confirmed: ExtendedApplication;
  store: StoreSectionState;
  vehicle: VehicleSectionState;
  documents: Record<string, DocumentRowState>;
};

function draftFromConfirmed(confirmed: ExtendedApplication): VehicleDraft {
  return {
    vehicleType: confirmed.vehicleType ?? "",
    vehicleNo: confirmed.vehicleNo ?? "",
    dirtyType: false,
    dirtyNo: false,
  };
}

function draftMatchesConfirmed(draft: VehicleDraft, confirmed: ExtendedApplication): boolean {
  return draft.vehicleType.trim() === (confirmed.vehicleType ?? "").trim()
    && draft.vehicleNo.trim().toUpperCase() === (confirmed.vehicleNo ?? "").trim().toUpperCase();
}

export function isVehicleDraftValid(draft: VehicleDraft): boolean {
  const type = draft.vehicleType.trim();
  const no = draft.vehicleNo.trim();
  if (!type || !no) return false;
  if (type.length > 40 || no.length > 40) return false;
  return true;
}

async function scopedRead(signal?: AbortSignal): Promise<ExtendedApplication> {
  const fresh = await riderApi.application({ signal });
  return asExtendedApplication(fresh as Application);
}

/**
 * One account-scoped onboarding state: confirmed snapshot, per-section drafts
 * and statuses, and one queue for application writes. File picking, file
 * transfer, and reads stay outside the queue. A request generation discards
 * responses from an earlier account, an older write, or a superseded read.
 */
export function useOnboardingState(
  accountId: string,
  initial: Application,
  onApplicationChange?: (application: ExtendedApplication) => void,
) {
  const accountRef = useRef(accountId);
  const generationRef = useRef(0);
  const readGenerationRef = useRef(0);
  const writeVersionRef = useRef(0);
  const sessionController = useRef<AbortController | null>(null);
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastVehicleAttempt = useRef<VehicleDraft | null>(null);
  const confirmedRef = useRef<ExtendedApplication>(asExtendedApplication(initial));
  const [confirmed, setConfirmedState] = useState<ExtendedApplication>(() => asExtendedApplication(initial));
  const [store, setStoreState] = useState<StoreSectionState>(() => ({
    optimistic: null,
    status: "idle",
    error: null,
  }));
  const [vehicle, setVehicleState] = useState<VehicleSectionState>(() => ({
    draft: draftFromConfirmed(asExtendedApplication(initial)),
    status: "idle",
    error: null,
  }));
  const [documents, setDocumentsState] = useState<Record<string, DocumentRowState>>({});

  useEffect(() => {
    const controller = new AbortController();
    sessionController.current = controller;
    return () => {
      controller.abort();
      generationRef.current += 1;
      readGenerationRef.current += 1;
    };
  }, [accountId]);

  // Account switch: bump generation, reset to the new account's snapshot.
  useEffect(() => {
    if (accountRef.current === accountId) return;
    accountRef.current = accountId;
    generationRef.current += 1;
    readGenerationRef.current += 1;
    writeQueueRef.current = Promise.resolve();
    lastVehicleAttempt.current = null;
    const ext = asExtendedApplication(initial);
    confirmedRef.current = ext;
    setConfirmedState(ext);
    setStoreState({ optimistic: null, status: "idle", error: null });
    setVehicleState({ draft: draftFromConfirmed(ext), status: "idle", error: null });
    setDocumentsState({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Keep confirmed in sync when the parent hands a newer snapshot (e.g. polling)
  // without clobbering drafts: pristine vehicle fields follow, dirty ones stay.
  useEffect(() => {
    const ext = asExtendedApplication(initial);
    confirmedRef.current = ext;
    setConfirmedState(ext);
    setVehicleState((previous) => ({
      ...previous,
      draft: {
        vehicleType: previous.draft.dirtyType ? previous.draft.vehicleType : (ext.vehicleType ?? ""),
        vehicleNo: previous.draft.dirtyNo ? previous.draft.vehicleNo : (ext.vehicleNo ?? ""),
        dirtyType: previous.draft.dirtyType,
        dirtyNo: previous.draft.dirtyNo,
      },
    }));
  }, [initial]);

  const applySnapshot = useCallback((snapshot: ExtendedApplication, forGeneration: number) => {
    if (forGeneration !== generationRef.current) return false;
    if (accountRef.current !== accountId) return false;
    confirmedRef.current = snapshot;
    setConfirmedState(snapshot);
    onApplicationChange?.(snapshot);
    return true;
  }, [accountId, onApplicationChange]);

  /**
   * Scoped application read that keeps the current form visible. A superseded
   * read (or one from another account) is discarded.
   */
  const fillPristineVehicleDraft = useCallback((fresh: ExtendedApplication) => {
    setVehicleState((previous) => ({
      ...previous,
      draft: {
        vehicleType: previous.draft.dirtyType ? previous.draft.vehicleType : (fresh.vehicleType ?? ""),
        vehicleNo: previous.draft.dirtyNo ? previous.draft.vehicleNo : (fresh.vehicleNo ?? ""),
        dirtyType: previous.draft.dirtyType,
        dirtyNo: previous.draft.dirtyNo,
      },
    }));
  }, []);

  const refreshApplication = useCallback(async (): Promise<boolean> => {
    const readGeneration = ++readGenerationRef.current;
    const writeVersion = writeVersionRef.current;
    const generation = generationRef.current;
    try {
      const fresh = await scopedRead(sessionController.current?.signal);
      if (readGeneration !== readGenerationRef.current || writeVersion !== writeVersionRef.current) return false;
      if (accountRef.current !== accountId) return false;
      if (!applySnapshot(fresh, generation)) return false;
      // A refresh fills pristine vehicle fields and preserves dirty drafts.
      fillPristineVehicleDraft(fresh);
      return true;
    } catch (failure) {
      if (readGeneration !== readGenerationRef.current || writeVersion !== writeVersionRef.current) return false;
      throw failure;
    }
  }, [accountId, applySnapshot, fillPristineVehicleDraft]);

  const enqueueWrite = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const previous = writeQueueRef.current;
    const generation = generationRef.current;
    writeVersionRef.current += 1;
    const run = async () => {
      try { return await work(); }
      finally {
        if (generation === generationRef.current) writeVersionRef.current += 1;
      }
    };
    const next = previous.then(run, run);
    writeQueueRef.current = next;
    return next;
  }, []);

  const saveStore = useCallback((next: HomeStore): void => {
    const writeGeneration = generationRef.current;
    const attemptedId = next.id;
    const attempted = { ...next };
    // One tap highlights immediately, before any network response.
    setStoreState({ optimistic: attempted, status: "saving", error: null });
    void enqueueWrite(async () => {
      // Only a session change supersedes a queued write.
      if (writeGeneration !== generationRef.current || accountRef.current !== accountId) {
        return;
      }
      try {
        const raw = await riderApi.selectOnboardingStore(attemptedId, { signal: sessionController.current?.signal });
        if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
        const snapshot = decodeSaveSnapshot(raw, confirmedRef.current.maxDocumentBytes);
        if (snapshot) {
          // New contract: use the returned snapshot with zero follow-up GETs.
          if (!applySnapshot(snapshot, writeGeneration)) return;
          setStoreState((previous) => {
            if (previous.optimistic?.id !== attemptedId) return previous;
            return {
              ...previous,
              optimistic: null,
              status: "saved",
              error: null,
            };
          });
          return;
        }
        // Mixed-version tolerance: previous void response — reconcile via one scoped read.
        const fresh = await scopedRead(sessionController.current?.signal);
        if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
        if (!applySnapshot(fresh, writeGeneration)) return;
        setStoreState((previous) => {
          if (previous.optimistic?.id !== attemptedId) return previous;
          return { ...previous, optimistic: null, status: "saved", error: null };
        });
      } catch (failure) {
        if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
        const reference = failure instanceof ApiError ? failure.traceId ?? failure.requestId : undefined;
        if (isUnknownWriteError(failure)) {
          // Timeout / lost response: compare a fresh read with the attempted write.
          try {
            const fresh = await scopedRead(sessionController.current?.signal);
            if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
            const reconciledId = fresh.homeStoreId ?? fresh.homeStore?.id ?? null;
            if (reconciledId === attemptedId) {
              if (!applySnapshot(fresh, writeGeneration)) return;
              setStoreState((previous) => {
                if (previous.optimistic?.id !== attemptedId) return previous;
                return { ...previous, optimistic: null, status: "saved", error: null };
              });
              return;
            }
          } catch {
            // Fresh read itself failed; the outcome stays unknown.
          }
          if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
          setStoreState((previous) => ({
            ...previous,
            status: "unknown",
            error: UNKNOWN_SAVE_MESSAGE,
            reference,
          }));
          return;
        }
        // Definitive rejection: restore confirmed value, retain retry target.
        setStoreState((previous) => ({
          ...previous,
          optimistic: null,
          status: "error",
          error: storeErrorMessage(failure),
          reference,
        }));
      }
    });
  }, [accountId, applySnapshot, enqueueWrite]);

  const setVehicleDraft = useCallback((patch: Partial<VehicleDraft>) => {
    setVehicleState((previous) => ({
      ...previous,
      draft: { ...previous.draft, ...patch },
    }));
  }, []);

  const markVehicleDirty = useCallback((field: "vehicleType" | "vehicleNo") => {
    setVehicleState((previous) => ({
      ...previous,
      draft: previous.draft[field === "vehicleType" ? "dirtyType" : "dirtyNo"]
        ? previous.draft
        : { ...previous.draft, [field === "vehicleType" ? "dirtyType" : "dirtyNo"]: true },
    }));
  }, []);

  const saveVehicleDraft = useCallback((attemptedDraft: VehicleDraft): void => {
    // Snapshot the draft now; letters typed during flight are preserved.
    // Registration letters are normalized to uppercase for the wire.
    const attempted = {
      vehicleType: attemptedDraft.vehicleType.trim(),
      vehicleNo: attemptedDraft.vehicleNo.trim().toUpperCase(),
    };
    if (!isVehicleDraftValid(attemptedDraft)) return;
    lastVehicleAttempt.current = attemptedDraft;
    const writeGeneration = generationRef.current;
    const accept = (snapshot: ExtendedApplication) => {
      if (!applySnapshot(snapshot, writeGeneration)) return;
      setVehicleState(previous => {
        const sameDraft = previous.draft.vehicleType === attemptedDraft.vehicleType
          && previous.draft.vehicleNo === attemptedDraft.vehicleNo;
        return {
          draft: sameDraft ? draftFromConfirmed(snapshot) : previous.draft,
          status: "saved",
          error: null,
        };
      });
    };
    setVehicleState((previous) => ({ draft: previous.draft, status: "saving", error: null }));
    void enqueueWrite(async () => {
      if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
      try {
        const raw = await riderApi.profile(attempted.vehicleType, attempted.vehicleNo, { signal: sessionController.current?.signal });
        if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
        const snapshot = decodeSaveSnapshot(raw, confirmedRef.current.maxDocumentBytes)
          ?? await scopedRead(sessionController.current?.signal);
        accept(snapshot);
      } catch (failure) {
        if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
        const reference = failure instanceof ApiError ? failure.traceId ?? failure.requestId : undefined;
        if (isUnknownWriteError(failure)) {
          try {
            const fresh = await scopedRead(sessionController.current?.signal);
            if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
            if (draftMatchesConfirmed(attemptedDraft, fresh)) {
              accept(fresh);
              return;
            }
          } catch {
            // Fresh read failed; outcome stays unknown.
          }
          if (writeGeneration !== generationRef.current || accountRef.current !== accountId) return;
          setVehicleState((previous) => ({ ...previous, status: "unknown", error: UNKNOWN_SAVE_MESSAGE, reference }));
          return;
        }
        setVehicleState((previous) => ({
          ...previous,
          status: "error",
          error: vehicleErrorMessage(failure),
          reference,
        }));
      }
    });
  }, [accountId, applySnapshot, enqueueWrite]);

  const saveVehicle = useCallback(() => {
    saveVehicleDraft(vehicle.draft);
  }, [saveVehicleDraft, vehicle.draft]);

  const retryVehicle = useCallback(() => {
    if (lastVehicleAttempt.current) saveVehicleDraft(lastVehicleAttempt.current);
  }, [saveVehicleDraft]);

  // Document attachment commits enter the same write queue; picking/transfer
  // stay outside. The transfer worker reports scoped phases via setRow.
  const setDocumentRow = useCallback((type: string, patch: Partial<DocumentRowState>) => {
    setDocumentsState((previous) => ({
      ...previous,
      [type]: { ...(previous[type] ?? initialDocumentRowState()), ...patch },
    }));
  }, []);

  const commitDocument = useCallback((type: string, mediaId: string, signal: AbortSignal): Promise<void> => {
    const generation = generationRef.current;
    const assertCurrent = () => {
      if (signal.aborted || generation !== generationRef.current || accountRef.current !== accountId)
        throw new ApiError('NETWORK_ERROR', 0);
    };
    return enqueueWrite(async () => {
      assertCurrent();
      const raw = await riderApi.document(type, mediaId, signal);
      assertCurrent();
      const snapshot = decodeSaveSnapshot(raw, confirmedRef.current.maxDocumentBytes)
        ?? await scopedRead(signal);
      assertCurrent();
      if (!applySnapshot(snapshot, generation)) throw new ApiError('NETWORK_ERROR', 0);
      fillPristineVehicleDraft(snapshot);
    });
  }, [accountId, applySnapshot, enqueueWrite, fillPristineVehicleDraft]);

  const isSavingStore = store.status === "saving";
  const isSavingVehicle = vehicle.status === "saving";
  const confirmedStore = resolveHomeStore(confirmed, null);
  const displayedStore: HomeStore | null = store.optimistic ?? confirmedStore;
  const lastAttempt = lastVehicleAttempt.current;
  const vehicleEditedAfterFailure = lastAttempt !== null &&
    (vehicle.draft.vehicleType.trim() !== lastAttempt.vehicleType.trim() ||
      vehicle.draft.vehicleNo.trim().toUpperCase() !== lastAttempt.vehicleNo.trim().toUpperCase());

  return {
    confirmed,
    store,
    vehicle,
    documents,
    refreshApplication,
    saveStore,
    setVehicleDraft,
    markVehicleDirty,
    saveVehicle,
    retryVehicle,
    setDocumentRow,
    commitDocument,
    isSavingStore,
    isSavingVehicle,
    confirmedStore,
    displayedStore,
    isVehicleDraftValid,
    isVehicleDirty: !draftMatchesConfirmed(vehicle.draft, confirmed),
    vehicleEditedAfterFailure,
  };
}
