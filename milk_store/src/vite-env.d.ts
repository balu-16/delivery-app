/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Dev-only backend target for the /v1 proxy (defaults to http://localhost:13080). */
  readonly VITE_DEV_API_TARGET?: string
}
