import { Button } from '@cloudflare/kumo'
import { TranslateIcon } from '@phosphor-icons/react'
import { useLocale } from '../i18n'

export function LanguageSwitch() {
  const { locale, setLocale } = useLocale()
  const label = locale === 'en' ? '切换为中文' : 'Switch to English'
  return (
    <Button variant="ghost" shape="square" icon={TranslateIcon} aria-label={label} title={label} lang={locale === 'en' ? 'zh-CN' : 'en'}
      onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')} />
  )
}
