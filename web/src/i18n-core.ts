import i18next, { type i18n, type ThirdPartyModule } from 'i18next'
import type { Locale } from './locale'
import { en } from './locales/en'

export type Translator = (text: string, values?: Record<string, unknown>) => string

/** Inline resources also work offline; no translation requests delay the first render. */
export function createI18n(locale: Locale, plugin?: ThirdPartyModule): i18n {
  const instance = i18next.createInstance()
  if (plugin) instance.use(plugin)
  void instance.init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: Object.fromEntries(Object.keys(en).map((key) => [key, key.replace(/_(one|other)$/, '')])) },
    },
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: ['zh-CN', 'en'],
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      escapeValue: false, // React escapes text; interpolation values must stay unchanged.
      prefix: '{%',
      suffix: '%}', // Keep message template syntax {{variableName}} literal.
    },
  })
  return instance
}

/** Only call for UI copy and diagnostics, never for saved names or message content. */
export function translate(instance: i18n, text: string, values: Record<string, unknown> = {}): string {
  const key = text.trim()
  if (!key) return text
  const parameters = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value ?? '']))
  const translated = instance.t(key, { ...parameters, defaultValue: key }) as string
  return text.slice(0, text.length - text.trimStart().length) + translated + text.slice(text.trimEnd().length)
}
