import { expect, test } from '@playwright/test'
import { seed } from './helpers'

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
  await page.getByRole('button', { name: english ? '切换为中文' : 'Switch to English', exact: true }).last().click()
  const switchedLocale = english ? 'zh-CN' : 'en'
  await expect(page.locator('html')).toHaveAttribute('lang', switchedLocale)
  await expect(page.getByLabel(english ? '消息预览' : 'Message preview', { exact: true })).toContainText('Order TEST-002')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', switchedLocale)
  expect(errors).toEqual([])
})
