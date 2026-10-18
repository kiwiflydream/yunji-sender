export type Locale = 'zh-CN' | 'en'
export const LOCALE_STORAGE_KEY = 'yunji-sender.locale'

/** Respect a saved choice, then the first supported browser language. */
export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'zh-CN' || saved === 'en') return saved
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}
