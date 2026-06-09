/**
 * L1/L6 — Combined login / registration form.
 * L6 adds: RGPD consent checkbox (required at registration) + safety banner.
 */
import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '#/lib/auth-client'
import { getSession } from '#/lib/session'
import { SafetyBanner } from '#/components/SafetyBanner'

export const Route = createFileRoute('/login')({
  beforeLoad: async ({ location }) => {
    const session = await getSession()
    if (session) {
      throw redirect({ to: (location.search as any).redirect ?? '/' })
    }
  },
  component: LoginPage,
})

type Mode = 'login' | 'register'

function LoginPage() {
  const router = useRouter()
  const search = Route.useSearch() as { redirect?: string }

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [tosAccepted, setTosAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setTosAccepted(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (mode === 'register') {
        const { error: err } = await authClient.signUp.email({
          email,
          password,
          name: displayName || email.split('@')[0],
        })
        if (err) throw new Error(err.message)
      } else {
        const { error: err } = await authClient.signIn.email({
          email,
          password,
        })
        if (err) throw new Error(err.message)
      }
      await router.invalidate()
      router.navigate({ to: search.redirect ?? '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-md">
        <h1 className="mb-1 text-2xl font-bold">Bordmap</h1>
        <p className="mb-6 text-sm text-gray-500">
          {mode === 'login' ? 'Connectez-vous à votre compte' : 'Créer un compte'}
        </p>

        {mode === 'register' && (
          <div className="mb-4">
            <SafetyBanner variant="full" />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Pseudo
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Votre pseudo"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="vous@exemple.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Mot de passe
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder={mode === 'register' ? '8 caractères minimum' : '••••••••'}
              minLength={8}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          {mode === 'register' && (
            <div className="flex items-start gap-2">
              <input
                id="tos"
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                required
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 accent-blue-600"
              />
              <label htmlFor="tos" className="text-xs text-gray-600 leading-snug cursor-pointer">
                J&apos;accepte les{' '}
                <Link to="/tos" target="_blank" className="text-blue-600 hover:underline">
                  conditions générales d&apos;utilisation
                </Link>{' '}
                et je reconnais que le ride se fait à mes propres risques.
              </label>
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || (mode === 'register' && !tosAccepted)}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {loading
              ? 'Chargement…'
              : mode === 'login'
                ? 'Se connecter'
                : 'Créer un compte'}
          </button>
        </form>

        <div className="mt-4 text-center text-sm text-gray-500">
          {mode === 'login' ? (
            <>
              Pas encore de compte ?{' '}
              <button
                type="button"
                onClick={() => switchMode('register')}
                className="text-blue-600 hover:underline"
              >
                S&apos;inscrire
              </button>
            </>
          ) : (
            <>
              Déjà un compte ?{' '}
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="text-blue-600 hover:underline"
              >
                Se connecter
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
