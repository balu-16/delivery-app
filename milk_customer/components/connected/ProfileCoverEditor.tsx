import { Ionicons } from '@expo/vector-icons';
import { Image, type ImageProps } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { images } from '@/constants/assets';
import { colors, fonts } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { ApiError } from '@/src/api/client';
import {
  coverMediaUrl,
  profileCoverApi,
  type CoverSelection,
  type ProfileCover,
} from '@/src/api/profile-cover';
import { accessToken } from '@/src/auth/session';
import {
  CENTERED_CROP,
  COVER_MAX_ZOOM,
  COVER_RATIO,
  coverCropRect,
  panCoverCrop,
  type CoverCrop,
} from '@/src/profile/cover-crop';
import {
  deleteCoverTemp,
  pickCoverPhoto,
  prepareCoverUpload,
  uploadCoverPhoto,
  type CoverPhoto,
} from '@/src/profile/cover-photo';
import { useCustomer } from '@/src/store/customer';

const presets = {
  'calf-at-sunrise': { title: 'Calf at sunrise', image: images.profileBanner },
  'farm-meadow': { title: 'Farm meadow', image: images.homeHero },
};
type PresetId = keyof typeof presets;
type Draft =
  { kind: 'default' } | { kind: 'preset'; presetId: PresetId } | { kind: 'photo'; photo: CoverPhoto };

export function profileCoverSource(cover?: ProfileCover): ImageProps['source'] {
  if (cover?.kind === 'preset' && cover.presetId)
    return presets[cover.presetId]?.image ?? images.profileBanner;
  if (cover?.kind === 'photo' && cover.imageUrl) {
    try {
      return { uri: coverMediaUrl(cover.imageUrl).href };
    } catch {
      return images.profileBanner;
    }
  }
  return images.profileBanner;
}

function CropPreview({
  photo,
  crop,
  disabled,
  onChange,
}: {
  photo: CoverPhoto;
  crop: CoverCrop;
  disabled: boolean;
  onChange: (crop: CoverCrop) => void;
}) {
  const [width, setWidth] = useState(0);
  const start = useRef({ x: 0, y: 0, crop });
  const rect = coverCropRect(photo, crop);
  const scale = width / rect.width;
  const zoom = (step: number) =>
    onChange({ ...crop, zoom: Math.min(COVER_MAX_ZOOM, Math.max(1, crop.zoom + step)) });
  const accessibilityMoves: Record<string, [number, number]> = {
    left: [24, 0],
    right: [-24, 0],
    up: [0, 24],
    down: [0, -24],
  };
  return (
    <>
      <View
        onStartShouldSetResponder={() => !disabled}
        onResponderGrant={({ nativeEvent }) => {
          start.current = { x: nativeEvent.pageX, y: nativeEvent.pageY, crop };
        }}
        onResponderMove={({ nativeEvent }) => {
          if (disabled || width === 0) return;
          const initial = start.current;
          onChange(
            panCoverCrop(
              photo,
              initial.crop,
              nativeEvent.pageX - initial.x,
              nativeEvent.pageY - initial.y,
              width,
            ),
          );
        }}
        accessible
        accessibilityLabel="Cover crop. Drag to reposition the photo."
        accessibilityActions={[
          { name: 'left', label: 'Move crop left' },
          { name: 'right', label: 'Move crop right' },
          { name: 'up', label: 'Move crop up' },
          { name: 'down', label: 'Move crop down' },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          const movement = accessibilityMoves[nativeEvent.actionName];
          if (!disabled && width > 0 && movement)
            onChange(panCoverCrop(photo, crop, ...movement, width));
        }}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        style={styles.frame}
      >
        {width > 0 && (
          <Image
            source={photo.uri}
            cachePolicy="none"
            contentFit="fill"
            style={{
              position: 'absolute',
              width: photo.width * scale,
              height: photo.height * scale,
              left: -rect.originX * scale,
              top: -rect.originY * scale,
            }}
          />
        )}
      </View>
      <AppText allowFontScaling style={styles.cropHint}>
        Drag to reposition your photo.
      </AppText>
      <View style={styles.zoom}>
        <Button
          label="Zoom out"
          icon="remove"
          variant="outline"
          disabled={disabled || crop.zoom <= 1}
          onPress={() => zoom(-0.25)}
        />
        <Button
          label="Zoom in"
          icon="add"
          variant="outline"
          disabled={disabled || crop.zoom >= COVER_MAX_ZOOM}
          onPress={() => zoom(0.25)}
        />
        <Button
          label="Center"
          variant="ghost"
          disabled={disabled}
          onPress={() => onChange(CENTERED_CROP)}
        />
      </View>
    </>
  );
}

export function ProfileCoverEditor({
  userId,
  cover,
  coverFailed,
  onRefresh,
  onSave,
  onClose,
}: {
  userId: string;
  cover?: ProfileCover;
  coverFailed: boolean;
  onRefresh: () => Promise<ProfileCover | null>;
  onSave: (cover: ProfileCover) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const motion = useMotionEnabled();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [crop, setCrop] = useState(CENTERED_CROP);
  const [working, setWorking] = useState<'picking' | 'preparing' | 'uploading' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const draftFile = useRef<string | null>(null);
  const uploaded = useRef<{ key: string; mediaId: string } | null>(null);
  const isCurrent = (request: AbortController) =>
    !request.signal.aborted && useCustomer.getState().profile?.userId === userId;

  useEffect(
    () => () => {
      operation.current?.abort();
      if (draftFile.current) void deleteCoverTemp(draftFile.current);
    },
    [],
  );

  const choose = (next: Draft) => {
    if (draftFile.current) void deleteCoverTemp(draftFile.current);
    draftFile.current = next.kind === 'photo' ? next.photo.uri : null;
    uploaded.current = null;
    setDraft(next);
    setCrop(CENTERED_CROP);
    setError('');
  };

  const pick = async () => {
    if (operation.current) return;
    const request = new AbortController();
    operation.current = request;
    setError('');
    setWorking('picking');
    try {
      const photo = await pickCoverPhoto();
      if (!photo) return;
      if (isCurrent(request)) choose({ kind: 'photo', photo });
      else await deleteCoverTemp(photo.uri);
    } catch {
      if (isCurrent(request))
        setError('Couldn’t open that photo. Check photo access or try another image.');
    } finally {
      operation.current = null;
      if (isCurrent(request)) setWorking(null);
    }
  };

  const save = async () => {
    if (!draft || !cover || operation.current) return;
    const request = new AbortController();
    operation.current = request;
    setWorking(draft.kind === 'photo' ? 'preparing' : 'saving');
    setError('');
    let outputUri: string | undefined;
    try {
      const token = await accessToken();
      if (!isCurrent(request)) return;
      let selection: CoverSelection;
      if (draft.kind === 'photo') {
        const key = JSON.stringify(coverCropRect(draft.photo, crop));
        if (uploaded.current?.key !== key) {
          const prepared = await prepareCoverUpload(draft.photo, crop);
          outputUri = prepared.uri;
          if (!isCurrent(request)) return;
          setWorking('uploading');
          const target = await profileCoverApi.target(token, prepared.data.size, request.signal);
          await uploadCoverPhoto(target, prepared.data, request.signal);
          if (!isCurrent(request)) return;
          uploaded.current = { key, mediaId: target.mediaId };
        }
        selection = { kind: 'photo', mediaId: uploaded.current.mediaId };
      } else {
        selection = draft;
      }
      if (!isCurrent(request)) return;
      setWorking('saving');
      const result = await profileCoverApi.save(token, selection, cover.version, request.signal);
      if (isCurrent(request)) onSave(result);
    } catch (cause) {
      if (!isCurrent(request)) return;
      const code = cause instanceof ApiError ? cause.code : '';
      if (code === 'CONCURRENT_MODIFICATION') {
        const latest = await onRefresh();
        if (isCurrent(request))
          setError(
            latest
              ? 'Your cover changed on another device. Review the preview and save again to use this choice.'
              : 'Your cover changed. Reload it before saving again.',
          );
      } else {
        if (['UPLOAD_EXPIRED', 'MEDIA_NOT_FOUND', 'UPLOAD_NOT_RECEIVED', 'INVALID_MEDIA'].includes(code))
          uploaded.current = null;
        setError('Couldn’t save your cover. Your previous cover is still shown. Try again.');
      }
    } finally {
      if (outputUri) await deleteCoverTemp(outputUri);
      operation.current = null;
      if (isCurrent(request)) setWorking(null);
    }
  };

  const preview =
    draft?.kind === 'preset'
      ? presets[draft.presetId].image
      : draft
        ? images.profileBanner
        : profileCoverSource(cover);
  const selectedPreset =
    draft?.kind === 'preset'
      ? draft.presetId
      : !draft && cover?.kind === 'preset'
        ? cover.presetId
        : null;
  const saveLabel =
    working === 'preparing'
      ? 'Preparing photo…'
      : working === 'uploading'
        ? 'Uploading photo…'
        : working === 'saving'
          ? 'Saving cover…'
          : 'Save cover';

  return (
    <Modal
      visible
      animationType={motion ? 'slide' : 'none'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Screen>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 24 },
          ]}
        >
          <View style={styles.heading}>
            <AppText allowFontScaling accessibilityRole="header" style={styles.title}>
              Change cover
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close cover editor"
              onPress={onClose}
              style={styles.close}
            >
              <Ionicons name="close" size={24} color={colors.brownDark} />
            </Pressable>
          </View>
          {draft?.kind === 'photo' ? (
            <CropPreview photo={draft.photo} crop={crop} disabled={!!working} onChange={setCrop} />
          ) : (
            <View style={styles.frame}>
              <Image
                source={preview}
                cachePolicy="none"
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            </View>
          )}
          <Button
            label="Choose photo"
            icon="images-outline"
            variant="soft"
            fullWidth
            disabled={!!working}
            onPress={() => void pick()}
          />
          <AppText allowFontScaling accessibilityRole="header" style={styles.presetHeading}>
            Farm presets
          </AppText>
          <View style={styles.presets}>
            {(Object.keys(presets) as PresetId[]).map((id) => (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: id === selectedPreset }}
                disabled={!!working}
                onPress={() => choose({ kind: 'preset', presetId: id })}
                style={[styles.preset, id === selectedPreset && styles.selected]}
              >
                <Image source={presets[id].image} style={styles.thumbnail} contentFit="cover" />
                <AppText allowFontScaling style={styles.presetLabel}>
                  {presets[id].title}
                </AppText>
              </Pressable>
            ))}
          </View>
          <Button
            label="Restore default"
            variant="outline"
            fullWidth
            disabled={!!working}
            onPress={() => choose({ kind: 'default' })}
          />
          {coverFailed && (
            <Button
              label="Reload saved cover"
              size="sm"
              variant="outline"
              onPress={() => void onRefresh()}
              disabled={!!working}
            />
          )}
          {error ? (
            <AppText allowFontScaling accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </AppText>
          ) : null}
          <Button
            label={saveLabel}
            fullWidth
            loading={!!working && working !== 'picking'}
            disabled={!cover || !draft || !!working}
            onPress={() => void save()}
          />
        </ScrollView>
      </Screen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, gap: 16, width: '100%', maxWidth: 600, alignSelf: 'center' },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.brownDark },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    aspectRatio: COVER_RATIO,
    backgroundColor: colors.cream,
    borderRadius: 19,
    overflow: 'hidden',
  },
  cropHint: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  zoom: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  presetHeading: { fontFamily: fonts.semibold, fontSize: 16, color: colors.brownDark },
  presets: { flexDirection: 'row', gap: 12 },
  preset: {
    flex: 1,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.line,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  selected: { borderColor: colors.green },
  thumbnail: { width: '100%', aspectRatio: COVER_RATIO },
  presetLabel: { color: colors.brownDark, padding: 8, fontSize: 12, fontFamily: fonts.medium },
  error: { color: colors.danger },
});
