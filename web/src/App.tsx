import { LinkProvider, type LinkComponentProps, Toasty, TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { forwardRef, lazy, Suspense, useEffect } from 'react'
import { Link as RouterLink, Route, Router, Switch as Routes } from 'wouter'
import { AppShell } from './components/AppShell'
import { NotFound, PageLoader } from './components/States'
import { ChannelFormPage } from './pages/ChannelFormPage'
import { ChannelsPage } from './pages/ChannelsPage'
import { KeysPage } from './pages/KeysPage'
import { MessageDetailPage } from './pages/MessageDetailPage'
import { MessagesPage } from './pages/MessagesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ChannelGroupsPage } from './pages/ChannelGroupsPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { TemplateFormPage } from './pages/TemplateFormPage'

// Charts pull in ECharts; keep them out of the main bundle.
const StatsPage = lazy(() => import('./pages/StatsPage'))
const ApiDocsPage = lazy(() => import('./pages/ApiDocsPage'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000 } },
})

/** Route Kumo links through wouter; hrefs are relative to the /admin base. */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href = '', to: _to, ...rest }, ref) =>
  href.startsWith('/') ? <RouterLink ref={ref} href={href} {...rest} /> : <a ref={ref} href={href} {...rest} />,
)

function useSystemColorMode() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (document.documentElement.dataset.mode = media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
}

export function App() {
  useSystemColorMode()
  return (
    <QueryClientProvider client={queryClient}>
      <Router base="/admin">
        <LinkProvider component={AppLink}>
          <TooltipProvider>
            <Toasty>
              <AppShell>
                <Routes>
                  <Route path="/" component={MessagesPage} />
                  <Route path="/messages/:id">{(p) => <MessageDetailPage id={p.id} />}</Route>
                  <Route path="/channels" component={ChannelsPage} />
                  <Route path="/channels/new">{() => <ChannelFormPage />}</Route>
                  <Route path="/channels/:id">{(p) => <ChannelFormPage id={p.id} />}</Route>
                  <Route path="/channel-groups" component={ChannelGroupsPage} />
                  <Route path="/templates" component={TemplatesPage} />
                  <Route path="/templates/new">{() => <TemplateFormPage />}</Route>
                  <Route path="/templates/:id">{(p) => <TemplateFormPage id={p.id} />}</Route>
                  <Route path="/keys" component={KeysPage} />
                  <Route path="/api-docs">
                    {() => (
                      <Suspense fallback={<PageLoader />}>
                        <ApiDocsPage />
                      </Suspense>
                    )}
                  </Route>
                  <Route path="/stats">
                    {() => (
                      <Suspense fallback={<PageLoader />}>
                        <StatsPage />
                      </Suspense>
                    )}
                  </Route>
                  <Route path="/settings" component={SettingsPage} />
                  <Route component={NotFound} />
                </Routes>
              </AppShell>
            </Toasty>
          </TooltipProvider>
        </LinkProvider>
      </Router>
    </QueryClientProvider>
  )
}
