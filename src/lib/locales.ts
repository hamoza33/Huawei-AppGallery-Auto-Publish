// The 10 target languages requested by the user, mapped to Huawei AppGallery's
// internal language codes. Huawei uses some non-standard codes (e.g. "zh-CN" is
// "zh-Hans", "zh-TW" is "zh-Hant").
//
// See: https://developer.huawei.com/consumer/en/doc/AppGallery-connect-Guides/agcapi-publish-language-0000001158245301
export const TARGET_LOCALES = [
  { bcp47: "en-US", huawei: "en-US", label: "English", rtl: false },
  { bcp47: "ar-EG", huawei: "ar", label: "العربية", rtl: true },
  { bcp47: "zh-CN", huawei: "zh-CN", label: "中文 (简体)", rtl: false },
  { bcp47: "zh-TW", huawei: "zh-TW", label: "中文 (繁體)", rtl: false },
  { bcp47: "ru-RU", huawei: "ru-RU", label: "Русский", rtl: false },
  { bcp47: "es-ES", huawei: "es-ES", label: "Español", rtl: false },
  { bcp47: "fr-FR", huawei: "fr-FR", label: "Français", rtl: false },
  { bcp47: "de-DE", huawei: "de-DE", label: "Deutsch", rtl: false },
  { bcp47: "ja-JP", huawei: "ja-JP", label: "日本語", rtl: false },
  { bcp47: "ko-KR", huawei: "ko-KR", label: "한국어", rtl: false },
] as const;

export type TargetLocale = (typeof TARGET_LOCALES)[number];

export const DEFAULT_LOCALE = "en-US";

export function normalizeTargetLocales(values: unknown): string[] {
  const allowed = new Set<string>(TARGET_LOCALES.map((locale) => locale.bcp47));
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(",")
      : [];
  const selected = raw
    .map((value) => String(value).trim())
    .filter((value) => allowed.has(value));
  return Array.from(new Set([DEFAULT_LOCALE, ...selected]));
}

export function toHuaweiLocale(bcp47: string): string {
  const found = TARGET_LOCALES.find((l) => l.bcp47 === bcp47);
  return found?.huawei ?? bcp47;
}

// UI languages (only en and ar — for the dashboard itself)
export const UI_LOCALES = ["en", "ar"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
