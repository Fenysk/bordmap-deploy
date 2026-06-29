import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import ConvexProvider from '../integrations/convex/provider'
import appCss from '../styles.css?url'

function RootErrorBoundary({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-xl font-bold text-red-700">Une erreur est survenue</h1>
        <p className="mb-6 text-sm text-gray-500">
          {error?.message ?? 'Erreur inattendue. Veuillez actualiser la page.'}
        </p>
        <a
          href="/"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Retour à l'accueil
        </a>
      </div>
    </div>
  )
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Bordmap' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootApp,
  errorComponent: RootErrorBoundary,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootApp() {
  return (
    <ConvexProvider>
      <Outlet />
    </ConvexProvider>
  )
}
