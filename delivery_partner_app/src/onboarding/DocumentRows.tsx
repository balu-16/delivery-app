import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError, type Application } from '../api';
import { Button, Card, IconBox, Text } from '../components/Ui';
import { restoreDocumentUploads, uploadDocument } from '../files';
import { colors, fonts } from '../theme';
import {
  initialDocumentRowState,
  maxDocumentLabel,
  phaseLabel,
  uploadRowMessage,
  type DocumentRowState,
} from './onboardingTypes';

const DOCUMENT_NAMES: Record<string, string> = {
  licence: 'Driving licence',
  vehicle_rc: 'Vehicle registration',
  id_proof: 'Identity proof',
  bank_proof: 'Bank proof',
};

export function DocumentRows({
  application, maxDocumentBytes, editable, rowStates, onRowState, onCommit, accountId, onHelp,
}: {
  application: Application;
  maxDocumentBytes: number;
  editable: boolean;
  rowStates: Record<string, DocumentRowState>;
  onRowState: (type: string, patch: Partial<DocumentRowState>) => void;
  onCommit: (type: string, mediaId: string, signal: AbortSignal) => Promise<void>;
  accountId: string;
  onHelp: (operation: string, reference?: string) => void;
}) {
  const active = useRef(true);
  const running = useRef(new Set<string>());
  useEffect(() => {
    active.current = true;
    if (editable) {
      void restoreDocumentUploads(accountId).then(types => {
        if (!active.current) return;
        for (const type of types) {
          onRowState(type, { phase: 'error', message: 'Couldn’t confirm the upload. Tap Retry.' });
        }
      });
    }
    return () => { active.current = false; };
  }, [accountId, editable, onRowState]);

  async function startUpload(type: string) {
    if (running.current.has(type)) return;
    running.current.add(type);
    let phase: 'transfer' | 'confirm' = 'transfer';
    try {
      const mediaId = await uploadDocument(
        accountId, type, maxDocumentBytes, (id, signal) => onCommit(type, id, signal),
        (next) => {
          phase = next === 'confirming' ? 'confirm' : 'transfer';
          if (active.current) onRowState(type, { phase: next, message: null, progress: undefined, reference: undefined });
        },
        progress => { if (active.current) onRowState(type, { progress }); },
      );
      if (active.current) onRowState(type, { phase: mediaId ? 'uploaded' : 'idle', message: null, progress: undefined });
    } catch (error) {
      if (active.current) onRowState(type, {
        phase: 'error', message: uploadRowMessage(error, phase), progress: undefined,
        reference: error instanceof ApiError ? error.traceId ?? error.requestId : undefined,
      });
    } finally {
      running.current.delete(type);
    }
  }

  return (
    <>
      <Text style={styles.section}>Required documents</Text>
      <Text style={styles.documentHint}>
        Choose a clear JPEG, PNG or PDF file, up to {maxDocumentLabel(maxDocumentBytes)} each.
      </Text>
      {application.status === "REJECTED" && application.documents
        .filter((doc) => doc.status === "REJECTED" && doc.reason && !application.requiredDocuments.includes(doc.type))
        .map((doc) => (
          <Card key={doc.id}>
            <Text style={styles.strong}>{DOCUMENT_NAMES[doc.type] ?? doc.type.replaceAll("_", " ")}</Text>
            <Text style={styles.danger}>{doc.reason}</Text>
          </Card>
        ))}
      {application.requiredDocuments.map((type) => {
        const document = application.documents.find((item) => item.type === type);
        const state = rowStates[type] ?? initialDocumentRowState();
        const busy = state.phase === "preparing" || state.phase === "uploading" || state.phase === "confirming";
        const phaseText = state.phase === 'uploading' && state.progress !== undefined
          ? `Uploading… ${Math.round(state.progress * 100)}%`
          : phaseLabel(state.phase);
        const statusText = state.phase === "uploaded" || state.phase === "confirming" || state.phase === "uploading"
          ? (phaseText ?? "")
          : document?.status === "APPROVED"
            ? "Approved"
            : document?.status === "REJECTED"
              ? "Needs a new document"
              : document
                ? application.status === "UNDER_REVIEW" ? "Submitted · Awaiting review" : "Uploaded"
                : "Not uploaded";
        return (
          <Card key={type}>
            <View style={styles.row}>
              <IconBox name="document-text-outline" />
              <View style={{ flex: 1 }}>
                <Text style={styles.strong}>{DOCUMENT_NAMES[type] ?? type.replaceAll("_", " ")}</Text>
                <Text testID={`document-status-${type}`} style={styles.sub}>{statusText}</Text>
                {document?.reason ? <Text style={styles.danger}>{document.reason}</Text> : null}
              </View>
            </View>
            {editable && document?.status !== "APPROVED" && !busy && state.phase !== "error" ? (
              <Button
                label={document ? "Upload replacement" : "Upload document"}
                secondary
                compact
                disabled={busy}
                onPress={() => void startUpload(type)}
              />
            ) : busy ? (
              <Text style={styles.sub}>{phaseText ?? "Working…"}</Text>
            ) : null}
            {state.phase === "error" && state.message ? (
              <View>
                <Text accessibilityRole="alert" style={styles.danger}>{state.message}</Text>
                {editable ? <Button label="Retry" secondary compact onPress={() => void startUpload(type)} /> : null}
                <Button label="Get help" secondary compact onPress={() => onHelp("upload document", state.reference)} />
              </View>
            ) : null}
          </Card>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 10 },
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  sub: { fontSize: 11, color: colors.secondary, marginTop: 2 },
  danger: { color: colors.danger, marginVertical: 8, fontSize: 12 },
  section: { fontSize: 16, fontFamily: fonts.semibold, marginVertical: 12 },
  documentHint: { fontSize: 11, color: colors.secondary, marginBottom: 12, lineHeight: 18 },
});
