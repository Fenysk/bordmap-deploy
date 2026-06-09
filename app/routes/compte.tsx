/**
 * L6 — Account management page (RGPD: right to erasure).
 * Protected route; redirects unauthenticated users to /login.
 */
import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from 'convex/react'
import { anyApi } from 'convex/server'
import { authClient } from '#/lib/auth-client'
import { getSession } from '#/lib/session'
import { deleteAuthAccount } from '#/lib/delete-account'

export const Route = createFileRoute('/compte')({
  beforeLoad: async ({ location }) => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login', search: { redirect: location.pathname } as Record<string, string> })
    }
    return { session }
  },
  component: ComptePage,
})

function ComptePage() {
  const { session } = Route.useRouteContext()
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteMyData = useMutation(anyApi.users.deleteMyData)

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      // 1. Delete Convex data while JWT is still valid
      await deleteMyData({})
      // 2. Delete Better Auth records server-side
      await deleteAuthAccount()
      // 3. Clear client session
      await authClient.signOut()
      void router.navigate({ to: '/' })
    } catch {
      setError('Une erreur est survenue. Veuillez réessayer.')
      setDeleting(false)
      setConfirming(false)
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-bold">Mon compte</h1>

      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-gray-500">Email</dt>
            <dd className="font-medium">{session.email}</dd>
          </div>
          {session.displayName && (
            <div>
              <dt className="text-gray-500">Pseudo</dt>
              <dd className="font-medium">{session.displayName}</dd>
            </div>
          )}
        </dl>
      </div>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-red-700">Supprimer mon compte</h2>
        <p className="mb-4 text-sm text-gray-600">
          La suppression est définitive et irréversible. Toutes vos routes et données personnelles
          seront effacées conformément au RGPD.
        </p>

        {error && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition"
          >
            Supprimer mon compte
          </button>
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="mb-3 text-sm font-semibold text-red-800">
              Êtes-vous sûr(e) ? Cette action est irréversible.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition"
              >
                {deleting ? 'Suppression…' : 'Oui, supprimer définitivement'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition"
              >
                Annuler
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="mt-10 text-sm text-gray-500">
        <Link to="/tos" className="hover:underline">
          Conditions générales d&apos;utilisation
        </Link>
      </div>
    </main>
  )
}
