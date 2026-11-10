import { en as enPhrases } from "./locales/en";
import { te as tePhrases } from "./locales/te";
import { hi as hiPhrases } from "./locales/hi";
import { kn as knPhrases } from "./locales/kn";

export const en = {
  today: "Today",
  route: "Route",
  earnings: "Earnings",
  profile: "Profile",
  demo: "Demo · No real deliveries",
  next: "Next",
  start: "Get started",
  online: "Online",
  offline: "Offline",
  break: "Break",
};
type Dictionary = { [K in keyof typeof en]: string };
const te: Dictionary = {
  today: "ఈ రోజు",
  route: "మార్గం",
  earnings: "సంపాదన",
  profile: "ప్రొఫైల్",
  demo: "డెమో · నిజమైన డెలివరీలు కావు",
  next: "తరువాత",
  start: "ప్రారంభించండి",
  online: "ఆన్‌లైన్",
  offline: "ఆఫ్‌లైన్",
  break: "విరామం",
};
const hi: Dictionary = {
  today: "आज",
  route: "मार्ग",
  earnings: "कमाई",
  profile: "प्रोफ़ाइल",
  demo: "डेमो · वास्तविक डिलीवरी नहीं",
  next: "आगे",
  start: "शुरू करें",
  online: "ऑनलाइन",
  offline: "ऑफ़लाइन",
  break: "विराम",
};
const kn: Dictionary = {
  today: "ಇಂದು",
  route: "ಮಾರ್ಗ",
  earnings: "ಗಳಿಕೆ",
  profile: "ಪ್ರೊಫೈಲ್",
  demo: "ಡೆಮೊ · ನೈಜ ವಿತರಣೆಗಳಲ್ಲ",
  next: "ಮುಂದೆ",
  start: "ಪ್ರಾರಂಭಿಸಿ",
  online: "ಆನ್‌ಲೈನ್",
  offline: "ಆಫ್‌ಲೈನ್",
  break: "ವಿರಾಮ",
};
export const dictionaries: Record<string, Dictionary> = { en, te, hi, kn };

const translations: Record<string, Record<string, string>> = {
  en: enPhrases,
  te: tePhrases,
  hi: hiPhrases,
  kn: knPhrases,
};
export function translate(text: string, language: string): string {
  return translations[language]?.[text] ?? text;
}
