import { tr, useLocale } from '../i18n'
import { Sidebar, Text, useSidebar } from '@cloudflare/kumo'
import { BookOpenIcon, ChartBarIcon, GearSixIcon, HashIcon, KeyIcon, PaperPlaneTiltIcon, PlugsConnectedIcon, TrayIcon, FileTextIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLocation } from 'wouter'
import { api } from '../api'

function SidebarToggle() {
  useLocale()
  const { isMobile, open, openMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  return <Sidebar.Trigger aria-expanded={expanded} aria-label={tr(expanded ? '收起侧栏' : '展开侧栏')} />
}

const NAV = [
  { href: '/', label: '消息', icon: TrayIcon, match: (p: string) => p === '/' || p.startsWith('/messages') },
  { href: '/channels', label: '渠道', icon: PlugsConnectedIcon, match: (p: string) => p.startsWith('/channels') },
  { href: '/templates', label: '模板', icon: FileTextIcon, match: (p: string) => p.startsWith('/templates') },
  { href: '/channel-groups', label: '渠道组', icon: HashIcon, match: (p: string) => p.startsWith('/channel-groups') },
  { href: '/keys', label: 'API Key', icon: KeyIcon, match: (p: string) => p.startsWith('/keys') },
  { href: '/api-docs', label: 'API 文档', icon: BookOpenIcon, match: (p: string) => p === '/api-docs' },
  { href: '/stats', label: '统计', icon: ChartBarIcon, match: (p: string) => p.startsWith('/stats') },
  { href: '/settings', label: '设置', icon: GearSixIcon, match: (p: string) => p.startsWith('/settings') },
]

export function AppShell({ children }: { children: ReactNode }) {
  useLocale()
  const [location] = useLocation()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  return (
    <Sidebar.Provider defaultOpen collapsible="icon" className="h-svh">
      <Sidebar aria-label={tr('主导航')}>
        <Sidebar.Header>
          <div className="flex items-center gap-2 px-2 py-1 group-data-[state=collapsed]/sidebar:w-full group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0">
            <PaperPlaneTiltIcon size={22} weight="duotone" className="shrink-0 text-kumo-brand" />
            <div className="group-data-[state=collapsed]/sidebar:hidden"><Text bold>{tr('云吉 Sender')}</Text></div>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map((item) => (
                <Sidebar.MenuButton
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  tooltip={tr(item.label)}
                  active={item.match(location)}
                >
                  {tr(item.label)}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer className="h-auto min-h-12 py-2">
          <div className="flex min-w-0 w-full items-center justify-between gap-2 px-2 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0">
            {me.data && (
              <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
                <Text size="xs" variant="secondary" truncate>{me.data.user}</Text>
              </div>
            )}
            <SidebarToggle />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-y-auto bg-kumo-canvas">
        <div className="flex items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-4 py-2 md:hidden">
          <SidebarToggle />
          <Text bold>{tr('云吉 Sender')}</Text>
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">{children}</div>
      </main>
    </Sidebar.Provider>
  )
}
