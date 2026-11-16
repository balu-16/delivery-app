/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_USE_SUPABASE?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_RAZORPAY_KEY_ID?: string
  readonly VITE_TWILIO_ACCOUNT_SID?: string
  readonly VITE_TWILIO_AUTH_TOKEN?: string
  readonly VITE_TWILIO_FROM_NUMBER?: string
  readonly VITE_MOCK_LATENCY?: string
}
