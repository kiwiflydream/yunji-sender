import { expect, test } from '@playwright/test'
import { call, providerURL, seed } from './helpers'
import type { Channel, RuntimeSettings } from '../src/shared/types'

test('cost protection settings persist and pause sending', async ({ page }, testInfo) => {
  const english = testInfo.project.use.locale === 'en'
  await page.addInitScript((locale) => localStorage.setItem('yunji-sender.locale', locale), english ? 'en' : 'zh-CN')
  const { settings } = await call<{ settings: RuntimeSettings }>('/admin/api/settings/runtime')
  const { channel } = await call<{ channel: Channel }>('/admin/api/channels', {
    method: 'POST', status: 201, data: { name: 'Pause fixture', type: 'webhook', config: { url: `${providerURL}/ok` } },
  })
  try {
    await page.goto('/admin/settings')
    const pause = page.getByRole('switch', { name: english ? 'Pause all sending' : '暂停所有发送' })
    await pause.click()
    await page.getByLabel(english ? 'Daily work budget' : '每日执行预算', { exact: true }).fill('1234')
    await page.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click()
    await expect.poll(async () => (await call<{ settings: RuntimeSettings }>('/admin/api/settings/runtime')).settings.sendingPaused).toBe(true)
    await page.reload()
    await expect(pause).toBeChecked()
    await expect(page.getByLabel(english ? 'Daily work budget' : '每日执行预算', { exact: true })).toHaveValue('1234')
    expect(await call('/admin/api/send', { method: 'POST', status: 503, data: { channels: [channel.id], body: 'must not send' } }))
      .toEqual({ error: 'safety_limit', reason: 'paused' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await pause.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('cost-protection.png'), fullPage: true })
  } finally {
    await call('/admin/api/settings/runtime', { method: 'PUT', data: settings })
  }
})

test('optional credentials can be cleared, undone and persisted', async ({ page }, testInfo) => {
  const english = testInfo.project.use.locale === 'en'
  await page.addInitScript((locale) => localStorage.setItem('yunji-sender.locale', locale), english ? 'en' : 'zh-CN')
  const { channel } = await call<{ channel: Channel }>('/admin/api/channels', {
    method: 'POST', status: 201, data: {
      name: 'Clear credential fixture', type: 'webhook',
      config: { url: `${providerURL}/ok`, headers: '{"Authorization":"Bearer dummy-token"}', signingSecret: 'dummy-signature' },
    },
  })
  await page.goto(`/admin/channels/${channel.id}`)
  // Accessible names identify the field, while visible labels stay short.
  const buttons = page.getByRole('button').filter({ hasText: english ? /^Clear saved value$/ : /^清除已保存的值$/ })
  await expect(buttons).toHaveCount(2)
  await buttons.first().click()
  const undo = page.getByRole('button').filter({ hasText: english ? /^Undo clearing$/ : /^撤销清除$/ })
  await expect(undo).toHaveCount(1)
  await undo.click()
  await expect(buttons).toHaveCount(2)
  await buttons.first().click()
  await buttons.first().click()
  await expect(undo).toHaveCount(2)
  const beforeSave = await call<{ channel: Channel }>(`/admin/api/channels/${channel.id}`)
  expect(beforeSave.channel.secretsSet.sort()).toEqual(['headers', 'signingSecret', 'url'])
  await page.screenshot({ path: testInfo.outputPath('clear-secrets-pending.png'), fullPage: true })
  await page.getByRole('button', { name: english ? 'Save' : '保存', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/channels$/)
  const saved = await call<{ channel: Channel }>(`/admin/api/channels/${channel.id}`)
  expect(saved.channel.secretsSet).toEqual(['url'])
  await page.goto(`/admin/channels/${channel.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Clear credential fixture')
  await expect(buttons).toHaveCount(0)
  await expect(undo).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('clear-secrets-saved.png'), fullPage: true })
})

test('admin pages, template byte preview, favicon, locale and sidebar', async ({ page }, testInfo) => {
  const fixture = await seed()
  const locale = testInfo.project.use.locale!
  const english = locale === 'en'
  const mobile = testInfo.project.name.startsWith('mobile')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.addInitScript((value) => {
    if (!localStorage.getItem('yunji-sender.locale')) localStorage.setItem('yunji-sender.locale', value)
  }, locale)
  const paths = ['/', '/channels', '/channels/new', `/channels/${fixture.channel.id}`, '/channel-groups',
    '/templates', '/templates/new', `/templates/${fixture.template.id}`, '/keys', '/api-docs', '/stats', '/settings', `/messages/${fixture.messageId}`]
  for (const path of paths) {
    const response = await page.goto(`/admin${path}`)
    expect(response?.status(), path).toBe(200)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expect(page.locator('[role="alert"]')).toHaveCount(0)
    if (path === '/settings') {
      await expect(page.getByRole('button', { name: english ? 'Save' : '保存', exact: true })).toBeVisible()
      await expect(page.getByLabel(english ? 'Maximum attempts' : '最多尝试次数', { exact: true })).toHaveValue('5')
    }
    await expect(page.getByRole('button', { name: /^(Switch to English|切换为中文)$/ })).toHaveCount(0)
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    expect(await page.title()).toContain(english ? 'Yunji Sender' : '云吉 Sender')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), path).toBe(false)
  }
  const icon = await page.locator('link[rel="icon"]').getAttribute('href')
  expect(icon).toBeTruthy()
  const favicon = await page.request.get(icon!)
  expect(favicon.ok()).toBe(true)
  expect(favicon.headers()['content-type']).toContain('image/svg+xml')

  await page.goto(`/admin/templates/${fixture.template.id}`)
  // 6,000 Chinese characters fit the old character guard but exceed 16 KiB.
  await page.getByLabel('orderId', { exact: true }).fill('中'.repeat(6000))
  const preview = page.getByLabel(english ? 'Message preview' : '消息预览', { exact: true })
  await expect(preview).toContainText(english ? 'Content is too long' : '内容超过长度限制')
  await preview.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('template-limit.png'), animations: 'disabled' })
  await page.getByLabel('orderId', { exact: true }).fill('TEST-002')
  await expect(preview).toContainText('Order TEST-002')

  const collapse = english ? 'Collapse sidebar' : '收起侧栏'
  const expand = english ? 'Expand sidebar' : '展开侧栏'
  if (mobile) {
    await page.getByRole('button', { name: expand, exact: true }).last().click()
    await expect(page.getByRole('link', { name: english ? 'Channels' : '渠道', exact: true })).toBeVisible()
    await page.getByRole('button', { name: collapse, exact: true }).first().click()
    await expect(page.getByRole('button', { name: expand, exact: true }).last()).toBeVisible()
  } else {
    const sidebar = page.locator('aside[data-sidebar="sidebar"]')
    await page.getByRole('button', { name: collapse, exact: true }).click()
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80)
    await page.getByRole('button', { name: expand, exact: true }).click()
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(200)
  }
  await page.screenshot({ path: testInfo.outputPath('admin.png'), animations: 'disabled' })
  await page.goto('/admin/settings')
  await page.getByLabel(english ? 'Maximum attempts' : '最多尝试次数', { exact: true }).fill('6')
  await page.getByRole('radio', { name: english ? '简体中文' : 'English', exact: true }).click()
  const switchedLocale = english ? 'zh-CN' : 'en'
  await expect(page.locator('html')).toHaveAttribute('lang', switchedLocale)
  await expect(page.getByLabel(english ? '最多尝试次数' : 'Maximum attempts', { exact: true })).toHaveValue('6')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', switchedLocale)
  await expect(page.getByLabel(english ? '最多尝试次数' : 'Maximum attempts', { exact: true })).toHaveValue('5')
  await expect(page.locator('[role="alert"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('settings-locale.png'), animations: 'disabled' })
  expect(errors).toEqual([])
})
