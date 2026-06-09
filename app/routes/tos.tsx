/**
 * L6 — Conditions générales d'utilisation & disclaimer de sécurité.
 * Wording submitted to CEO/PO for review before launch (FEN-351 note board).
 */
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/tos')({
  component: TosPage,
})

function TosPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 prose prose-sm">
      <h1>Conditions générales d&apos;utilisation</h1>
      <p className="text-gray-500 text-xs">Dernière mise à jour : juin 2026</p>

      <h2>1. Présentation</h2>
      <p>
        Bordmap est une plateforme communautaire informative permettant aux pratiquants de Freebord
        de partager et découvrir des routes de descente. Les informations publiées sont fournies par
        la communauté et ne sont pas vérifiées par Bordmap.
      </p>

      <h2>2. Responsabilité et sécurité</h2>
      <p>
        <strong>Le ride se fait à vos propres risques.</strong> Bordmap ne garantit ni l&apos;état
        des routes, ni leur légalité d&apos;accès, ni leur sécurité. Les routes listées peuvent être
        ouvertes à la circulation routière.
      </p>
      <ul>
        <li>
          Il vous appartient de vérifier la légalité et les conditions de sécurité avant tout ride.
        </li>
        <li>Portez toujours un casque et des protections adaptées à votre pratique.</li>
        <li>Ne ridez pas seul(e) dans des zones isolées.</li>
        <li>
          Respectez le code de la route et les autres usagers. Ne bloquez pas la circulation.
        </li>
      </ul>
      <p>
        Bordmap décline toute responsabilité en cas d&apos;accident, de blessure ou d&apos;infraction
        survenus lors d&apos;un ride, quelle qu&apos;en soit la cause.
      </p>

      <h2>3. Contenu communautaire</h2>
      <p>
        Les routes et descriptions publiées sur Bordmap sont soumises par des utilisateurs. Bordmap
        se réserve le droit de supprimer tout contenu contraire à la loi, dangereux ou trompeur.
        Les informations sont fournies à titre indicatif et ne constituent pas un engagement
        contractuel.
      </p>
      <p>
        En publiant une route, vous certifiez que vous n&apos;incitez pas à bloquer la circulation
        ni à enfreindre le code de la route.
      </p>

      <h2>4. Données personnelles (RGPD)</h2>
      <p>
        Bordmap collecte uniquement les données strictement nécessaires au fonctionnement du service :
        adresse e-mail et pseudo. Aucune donnée de géolocalisation en temps réel n&apos;est collectée.
      </p>
      <p>
        Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez d&apos;un
        droit d&apos;accès, de rectification et de suppression de vos données. Vous pouvez supprimer
        votre compte et l&apos;ensemble de vos données depuis votre{' '}
        <Link to="/compte" className="text-blue-600 hover:underline">
          espace personnel
        </Link>
        .
      </p>

      <h2>5. Contact</h2>
      <p>
        Pour toute question relative aux présentes conditions ou à vos données personnelles,
        contactez-nous à l&apos;adresse indiquée dans les mentions légales.
      </p>

      <div className="mt-8">
        <Link to="/" className="text-sm text-blue-600 hover:underline">
          ← Retour à l&apos;accueil
        </Link>
      </div>
    </main>
  )
}
