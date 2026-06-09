/**
 * L6 — Safety & legal warning banner.
 * Displayed on route detail cards and on the registration form.
 * Wording is informative, non-prescriptive (see FEN-351 note board).
 */
export interface SafetyBannerProps {
  variant?: 'compact' | 'full'
}

export function SafetyBanner({ variant = 'compact' }: SafetyBannerProps) {
  if (variant === 'full') {
    return (
      <div
        role="note"
        className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
      >
        <p className="font-semibold">⚠️ Sécurité des riders</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>Portez toujours un casque et des protections adaptées.</li>
          <li>
            Les routes listées peuvent être ouvertes à la circulation routière — vérifiez vous-même
            la légalité et la sécurité avant de rider.
          </li>
          <li>Ne ridez pas seul(e) dans des zones isolées.</li>
          <li>Ne bloquez pas la circulation. Respectez le code de la route et les autres usagers.</li>
        </ul>
      </div>
    )
  }

  return (
    <div
      role="note"
      className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
    >
      ⚠️{' '}
      <strong>Sécurité :</strong> portez votre casque · routes potentiellement ouvertes au trafic
      (vérifiez légalité/sécurité) · ne ridez pas seul(e).
    </div>
  )
}

export default SafetyBanner
