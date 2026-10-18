import { InputGroup, useKumoToastManager } from '@cloudflare/kumo'
import { CopyIcon, EyeIcon, EyeSlashIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { tr, useLocale } from '../i18n'

/** Kumo's SensitiveInput has fixed English labels; compose its localized equivalent. */
export function SecretInput(props: {
  label: string
  value: string
  placeholder?: string
  description?: string
  autoComplete?: string
  error?: string
  onValueChange: (value: string) => void
}) {
  useLocale()
  const [revealed, setRevealed] = useState(false)
  const toasts = useKumoToastManager()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value)
      toasts.add({ title: tr('已复制'), variant: 'success' })
    } catch {
      toasts.add({ title: tr('复制失败，请手动选择代码复制'), variant: 'error' })
    }
  }
  return (
    <InputGroup label={props.label} description={props.description} error={props.error ? { message: props.error, match: true } : undefined}>
      <InputGroup.Input type={revealed ? 'text' : 'password'} value={props.value} aria-label={props.label}
        placeholder={props.placeholder} autoComplete={props.autoComplete} passwordManagerIgnore
        onChange={(event) => props.onValueChange(event.target.value)} />
      <InputGroup.Addon align="end">
        <InputGroup.Button type="button" variant="ghost" shape="square" icon={revealed ? EyeSlashIcon : EyeIcon}
          aria-label={tr(revealed ? '隐藏内容' : '显示内容')} aria-pressed={revealed} onClick={() => setRevealed(!revealed)} />
        <InputGroup.Button type="button" variant="ghost" shape="square" icon={CopyIcon}
          aria-label={tr('复制到剪贴板')} disabled={!props.value} onClick={copy} />
      </InputGroup.Addon>
    </InputGroup>
  )
}
