import { useState } from 'react';
import { images, type AssetSource } from '@/constants/assets';
import { apiBaseUrl } from '@/src/api/client';

function remoteSource(path: string | null | undefined): { uri: string } | null {
  try {
    if (!path) return null;
    const url = new URL(path, `${apiBaseUrl()}/`);
    return url.protocol === 'https:' || (__DEV__ && url.protocol === 'http:')
      ? { uri: url.toString() }
      : null;
  } catch {
    return null;
  }
}

/** These generic pictures are illustrative; they are not the catalog's product photography. */
function illustrationFor(name: string): AssetSource | null {
  if (/\bbutter[\s-]*milk\b/i.test(name)) return images.categoryButtermilk;
  if (/\bbutter\b/i.test(name)) return images.categoryButter;
  if (/\bpaneer\b/i.test(name)) return images.categoryPaneer;
  if (/\bghee\b/i.test(name)) return images.categoryGhee;
  if (/\b(curd|yogurt|yoghurt)\b/i.test(name)) return images.categoryCurd;
  if (/\blassi\b/i.test(name)) return images.categoryLassi;
  if (/\bmilk\b/i.test(name)) return images.categoryMilk;
  return null;
}

export function useProductPhoto(path: string | null | undefined, name: string) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const remote = remoteSource(path);
  const useIllustration = !remote || failedUri === remote.uri;
  const source = useIllustration ? illustrationFor(name) : remote;
  return {
    source,
    illustrative: useIllustration && !!source,
    onError: () => { if (remote) setFailedUri(remote.uri); },
  };
}
