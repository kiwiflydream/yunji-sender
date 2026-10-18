import { initReactI18next, useTranslation } from 'react-i18next'
import { detectLocale, LOCALE_STORAGE_KEY, type Locale } from './locale'
import { createI18n, translate, type Translator } from './i18n-core'

let saved: string | null = null
try {
  saved = localStorage.getItem(LOCALE_STORAGE_KEY)
} catch {
  // Storage may be unavailable in private or embedded browsing contexts.
}
const languages = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]

export const i18n = createI18n(detectLocale(saved, languages), initReactI18next)
export const getLocale = (): Locale => i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en'
export const tr: Translator = (text, values) => translate(i18n, text, values)

function applyLocale() {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = getLocale()
    document.title = tr('云吉 Sender')
  }
}

export function setLocale(locale: Locale) {
  void i18n.changeLanguage(locale)
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Changing language should also work when storage is blocked.
  }
}

/** Subscribe each component without remounting it or losing form state. */
export function useLocale() {
  useTranslation(undefined, { i18n })
  return { locale: getLocale(), setLocale }
}

i18n.on('languageChanged', applyLocale)
applyLocale()
