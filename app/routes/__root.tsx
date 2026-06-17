import { HeadContent, Outlet, Scripts, createRootRoute, Link } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import ConvexProvider from '../integrations/convex/provider'
import { authClient } from '#/lib/auth-client'

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
  // shellComponent is rendered outside React's hook dispatcher context — keep it
  // hook-free (no useRef, useStore, etc.). Providers and interactive components
  // that use hooks belong in `component` below (FEN-463).
  shellComponent: RootDocument,
  component: RootApp,
  errorComponent: RootErrorBoundary,
})

function Nav() {
  const { data: session } = authClient.useSession()

  return (
    <nav className="border-b border-gray-200 bg-white px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-between">
        <Link to="/" className="text-lg font-bold">
          Bordmap
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {session?.user ? (
            <>
              <Link to="/mes-routes" className="text-gray-700 hover:text-blue-600">
                Mes routes
              </Link>
              <Link
                to="/route/new"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700"
              >
                + Référencer
              </Link>
              <Link to="/compte" className="text-gray-500 hover:text-gray-700">
                Mon compte
              </Link>
              <button
                onClick={() => authClient.signOut()}
                className="text-gray-500 hover:text-gray-700"
              >
                Déconnexion
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-blue-600 hover:underline">
                Connexion
              </Link>
              <Link to="/tos" className="text-xs text-gray-400 hover:underline">
                CGU
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}

// HTML shell — no hooks allowed here (shellComponent runs outside React's
// hook dispatcher). Receives the fully-rendered component tree as children.
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

// Route component — runs inside React's render pipeline where hooks work.
// This is where providers and hook-using components belong.
function RootApp() {
  return (
    <ConvexProvider>
      <Nav />
      <Outlet />
      <TanStackDevtools
        config={{ position: 'bottom-right' }}
        plugins={[{ name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> }]}
      />
    </ConvexProvider>
  )
}
