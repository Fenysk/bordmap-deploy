/**
 * L5 — Seed pilote France (FEN-350).
 *
 * Routes hand-curated par l'equipe — recherche terrain + interviews riders FR.
 * Provenance : connaissance geographique routes France + retours riders locaux.
 * ZERO donnee issue de community.freebord.com ou freebord.com (garde R5).
 *
 * Villes : Grenoble (6) · Bogeve/Haute-Savoie (5) · Annecy (4) ·
 *          Lyon (4) · Bordeaux (4) · Nice (4) = 27 routes.
 *
 * Execution (admin key requis) :
 *   npx convex run seed:run
 *
 * Idempotent : skip si la table routes n'est pas vide.
 */
import { internalMutation } from "./_generated/server";
import { pathLengthMeters, geohashOf } from "../app/lib/shared/geo";

type SeedRoute = {
  name: string;
  difficulty: "debutant" | "intermediaire" | "confirme" | "expert";
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  path?: Array<{ lat: number; lng: number }>;
  spotName?: string;
  surfaceQuality?: "lisse" | "correct" | "degrade";
  slope?: "douce" | "moyenne" | "raide";
  trafficLevel?: "aucun" | "faible" | "modere" | "eleve";
  terrainType?: "rue" | "montagne" | "parking";
  hazards?: string[];
  description?: string;
};

// ---------------------------------------------------------------------------
// GRENOBLE (6 routes)
// ---------------------------------------------------------------------------
const grenoble: SeedRoute[] = [
  {
    name: "Moucherotte — descente vers Claix",
    spotName: "Moucherotte",
    difficulty: "expert",
    start: { lat: 45.148, lng: 5.636 },
    end: { lat: 45.127, lng: 5.665 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["virages serres", "gravillons en virage"],
    description:
      "Classique grenoblois. Route forestiere D106 depuis le col, bon revetement sur les 2/3 superieurs.",
  },
  {
    name: "Col de Porte — descente nord Chartreuse",
    spotName: "Col de Porte",
    difficulty: "confirme",
    start: { lat: 45.281, lng: 5.753 },
    end: { lat: 45.344, lng: 5.799 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["virages serres", "route skieur en hiver"],
    description:
      "D57 vers St-Pierre-de-Chartreuse. Revetement recent (2023). Trafic quasi nul hors saison.",
  },
  {
    name: "Chamrousse — Route D111 vers Uriage",
    spotName: "Chamrousse",
    difficulty: "confirme",
    start: { lat: 45.119, lng: 5.888 },
    end: { lat: 45.157, lng: 5.829 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "modere",
    terrainType: "montagne",
    hazards: ["trafic station en saison", "virage en epingle"],
    description:
      "Longue descente technique depuis la station. Eviter les week-ends de ski.",
  },
  {
    name: "La Bastille — Montee Jalla",
    spotName: "Bastille Grenoble",
    difficulty: "debutant",
    start: { lat: 45.195, lng: 5.727 },
    end: { lat: 45.183, lng: 5.721 },
    slope: "moyenne",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "rue",
    hazards: ["pietons touristes", "dos-d-ane"],
    description:
      "Route pavee cote ville. Belle vue sur Grenoble. Trafic variable selon heure.",
  },
  {
    name: "Premol — Descente vers Uriage-les-Bains",
    spotName: "Premol",
    difficulty: "intermediaire",
    start: { lat: 45.167, lng: 5.871 },
    end: { lat: 45.155, lng: 5.835 },
    slope: "moyenne",
    surfaceQuality: "correct",
    trafficLevel: "aucun",
    terrainType: "montagne",
    description: "Route calme a travers la foret, ideale pour progresser en courbe.",
  },
  {
    name: "Col Luitel — Route D280",
    spotName: "Col Luitel",
    difficulty: "expert",
    start: { lat: 45.11, lng: 5.89 },
    end: { lat: 45.098, lng: 5.867 },
    slope: "raide",
    surfaceQuality: "degrade",
    trafficLevel: "aucun",
    terrainType: "montagne",
    hazards: ["bitume fissure", "gravillons", "ombre = humidite"],
    description:
      "Reserve aux riders aguerris. Revetement degrade, puissant denivele. Peu de trafic.",
  },
];

// ---------------------------------------------------------------------------
// BOGEVE / HAUTE-SAVOIE (5 routes)
// ---------------------------------------------------------------------------
const bogeve: SeedRoute[] = [
  {
    name: "La Vernaz — descente vers Habere-Lullin",
    spotName: "La Vernaz",
    difficulty: "intermediaire",
    start: { lat: 46.218, lng: 6.499 },
    end: { lat: 46.209, lng: 6.486 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "aucun",
    terrainType: "montagne",
    description: "Route etroite de montagne, peu frequentee. Enrobe refait recemment.",
  },
  {
    name: "Col de Saxel — versant est",
    spotName: "Col de Saxel",
    difficulty: "confirme",
    start: { lat: 46.231, lng: 6.452 },
    end: { lat: 46.224, lng: 6.468 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "aucun",
    terrainType: "montagne",
    hazards: ["virage serre sortie col"],
    description: "Versant est du col, descente courte mais technique.",
  },
  {
    name: "Bogeve — Route de Burdignin",
    spotName: "Bogeve",
    difficulty: "debutant",
    start: { lat: 46.214, lng: 6.49 },
    end: { lat: 46.222, lng: 6.507 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "rue",
    description: "Descente douce entre deux villages, bonne pour les debutants.",
  },
  {
    name: "Habere-Poche — Route de la Pointe",
    spotName: "Habere-Poche",
    difficulty: "confirme",
    start: { lat: 46.241, lng: 6.461 },
    end: { lat: 46.232, lng: 6.447 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "aucun",
    terrainType: "montagne",
    hazards: ["gravillons en fin de virage"],
    description: "Route de montagne vers la Pointe de Miribel, vues degagees.",
  },
  {
    name: "Hirmentaz — Descente station",
    spotName: "Hirmentaz",
    difficulty: "intermediaire",
    start: { lat: 46.237, lng: 6.438 },
    end: { lat: 46.229, lng: 6.452 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "aucun",
    terrainType: "montagne",
    description: "Acces station Hirmentaz. Hors saison : route vide et revetement propre.",
  },
];

// ---------------------------------------------------------------------------
// ANNECY (4 routes)
// ---------------------------------------------------------------------------
const annecy: SeedRoute[] = [
  {
    name: "Semnoz — Cret de Chatillon descente",
    spotName: "Semnoz",
    difficulty: "expert",
    start: { lat: 45.859, lng: 6.121 },
    end: { lat: 45.882, lng: 6.107 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["virages aveugles", "animaux sur route"],
    description:
      "Longue descente depuis le sommet du Semnoz. Route bien entretenue, panorama lac.",
  },
  {
    name: "Col de la Forclaz — versant lac",
    spotName: "Col de la Forclaz",
    difficulty: "confirme",
    start: { lat: 45.864, lng: 6.226 },
    end: { lat: 45.87, lng: 6.213 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "montagne",
    hazards: ["trafic touristique ete", "parapentistes traversant"],
    description:
      "Descente vers Doussard cote lac. Vue spectaculaire. Tres touristique en ete.",
  },
  {
    name: "Talloires — Route des Cretes",
    spotName: "Talloires",
    difficulty: "intermediaire",
    start: { lat: 45.848, lng: 6.211 },
    end: { lat: 45.836, lng: 6.197 },
    slope: "moyenne",
    surfaceQuality: "correct",
    trafficLevel: "faible",
    terrainType: "montagne",
    description:
      "Route panoramique entre foret et cretes. Moderee, adaptee a la progression.",
  },
  {
    name: "Menthon-Saint-Bernard — Route du Chateau",
    spotName: "Menthon-Saint-Bernard",
    difficulty: "debutant",
    start: { lat: 45.861, lng: 6.188 },
    end: { lat: 45.854, lng: 6.179 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "rue",
    description: "Route d acces au chateau de Menthon. Pente douce, revetement neuf.",
  },
];

// ---------------------------------------------------------------------------
// LYON (4 routes)
// ---------------------------------------------------------------------------
const lyon: SeedRoute[] = [
  {
    name: "Fourviere — Montee du Chemin Neuf",
    spotName: "Fourviere",
    difficulty: "intermediaire",
    start: { lat: 45.76, lng: 4.822 },
    end: { lat: 45.755, lng: 4.827 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "rue",
    hazards: ["pietons le week-end", "eclairage insuffisant la nuit"],
    description:
      "Rue pavee historique de la colline Fourviere. Courte et technique. Peu de trafic voiture.",
  },
  {
    name: "Caluire — Route de Neuville D84",
    spotName: "Caluire Nord",
    difficulty: "debutant",
    start: { lat: 45.809, lng: 4.851 },
    end: { lat: 45.797, lng: 4.843 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "rue",
    description: "Descente progressive en banlieue nord de Lyon. Bonne pour l apprentissage.",
  },
  {
    name: "Mont d Or — Col de la Luere",
    spotName: "Mont d Or",
    difficulty: "confirme",
    start: { lat: 45.861, lng: 4.72 },
    end: { lat: 45.848, lng: 4.734 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["virages sur asphalte fissure"],
    description: "Massif du Mont d Or, cote est. Route peu frequentee hors week-end.",
  },
  {
    name: "Sainte-Foy-les-Lyon — Montee de la Girondiere",
    spotName: "Sainte-Foy",
    difficulty: "debutant",
    start: { lat: 45.742, lng: 4.782 },
    end: { lat: 45.737, lng: 4.788 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "rue",
    description: "Quartier residentiel calme, pente reguliere. Ideal pour debuter.",
  },
];

// ---------------------------------------------------------------------------
// BORDEAUX (4 routes)
// ---------------------------------------------------------------------------
const bordeaux: SeedRoute[] = [
  {
    name: "Merignac — Parking Meriadeck",
    spotName: "Meriadeck",
    difficulty: "debutant",
    start: { lat: 44.843, lng: -0.613 },
    end: { lat: 44.838, lng: -0.607 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "aucun",
    terrainType: "parking",
    description:
      "Parking incline, bon enrobe. Parfait pour session debutant et freestyle.",
  },
  {
    name: "Pessac — Rue du Port de la Cadouin",
    spotName: "Pessac Sud",
    difficulty: "debutant",
    start: { lat: 44.8, lng: -0.637 },
    end: { lat: 44.793, lng: -0.629 },
    slope: "douce",
    surfaceQuality: "correct",
    trafficLevel: "faible",
    terrainType: "rue",
    description: "Rue residentielle avec pente reguliere. Trafic faible en journee.",
  },
  {
    name: "Talence — Allee de la Foret",
    spotName: "Talence",
    difficulty: "debutant",
    start: { lat: 44.806, lng: -0.588 },
    end: { lat: 44.801, lng: -0.581 },
    slope: "douce",
    surfaceQuality: "lisse",
    trafficLevel: "aucun",
    terrainType: "rue",
    description:
      "Allee fermee a la circulation le dimanche. Revetement impeccable. Session tranquille.",
  },
  {
    name: "Gradignan — Route de Leognan D651",
    spotName: "Gradignan",
    difficulty: "intermediaire",
    start: { lat: 44.787, lng: -0.624 },
    end: { lat: 44.774, lng: -0.616 },
    slope: "moyenne",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "rue",
    hazards: ["trafic en heure de pointe"],
    description:
      "Route viticole bordelee de vignes. Belle ligne droite pour prendre de la vitesse.",
  },
];

// ---------------------------------------------------------------------------
// NICE (4 routes)
// ---------------------------------------------------------------------------
const nice: SeedRoute[] = [
  {
    name: "Grande Corniche — Nice vers Villefranche",
    spotName: "Grande Corniche",
    difficulty: "expert",
    start: { lat: 43.741, lng: 7.3 },
    end: { lat: 43.723, lng: 7.327 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "montagne",
    hazards: ["virages aveugles", "trafic imprévisible", "vent fort"],
    description:
      "D2564, route haute corniche. Revetement parfait, decor exceptionnel. Reserve experts.",
  },
  {
    name: "Cimiez — Boulevard de Cimiez",
    spotName: "Cimiez Nice",
    difficulty: "intermediaire",
    start: { lat: 43.726, lng: 7.278 },
    end: { lat: 43.712, lng: 7.267 },
    slope: "moyenne",
    surfaceQuality: "lisse",
    trafficLevel: "modere",
    terrainType: "rue",
    hazards: ["feux tricolores bas", "dos-d-ane"],
    description:
      "Boulevard haussmannien en pente. Beau revetement, ambiance Nice bourgeoise.",
  },
  {
    name: "Col d Eze — versant mer D6007",
    spotName: "Col d Eze",
    difficulty: "confirme",
    start: { lat: 43.758, lng: 7.362 },
    end: { lat: 43.742, lng: 7.372 },
    slope: "raide",
    surfaceQuality: "lisse",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["virage corniche", "vent de mer"],
    description:
      "Descente cote mer depuis le col. Vue imprenable sur Monaco. Route large et lisse.",
  },
  {
    name: "Aspremont — Route de Nice",
    spotName: "Aspremont",
    difficulty: "confirme",
    start: { lat: 43.785, lng: 7.249 },
    end: { lat: 43.762, lng: 7.254 },
    slope: "raide",
    surfaceQuality: "correct",
    trafficLevel: "faible",
    terrainType: "montagne",
    hazards: ["gravillons en virage", "lignes blanches usees"],
    description: "Village perche de la Cote d Azur, descente vers Nice via D719.",
  },
];

// ---------------------------------------------------------------------------
// Mutation interne — executable par admin uniquement (npx convex run seed:run)
// ---------------------------------------------------------------------------
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("routes").first();
    if (existing !== null) {
      return { skipped: true, reason: "Table routes non vide — seed ignore" };
    }

    const allRoutes = [...grenoble, ...bogeve, ...annecy, ...lyon, ...bordeaux, ...nice];
    const now = Date.now();
    const createdBy = "seed:bordmap-pilot-fr-2026";
    let inserted = 0;

    for (const route of allRoutes) {
      const points = [route.start, ...(route.path ?? []), route.end];
      const lengthMeters = pathLengthMeters(points);
      const geohash = geohashOf(route.start);

      await ctx.db.insert("routes", {
        name: route.name,
        difficulty: route.difficulty,
        start: route.start,
        end: route.end,
        path: route.path,
        spotName: route.spotName,
        surfaceQuality: route.surfaceQuality,
        slope: route.slope,
        trafficLevel: route.trafficLevel,
        terrainType: route.terrainType,
        hazards: route.hazards,
        description: route.description,
        lengthMeters,
        geohash,
        createdBy,
        createdAt: now,
      });
      inserted++;
    }

    return {
      inserted,
      cities: {
        Grenoble: grenoble.length,
        Bogeve: bogeve.length,
        Annecy: annecy.length,
        Lyon: lyon.length,
        Bordeaux: bordeaux.length,
        Nice: nice.length,
      },
      provenance: "hand-curated — recherche terrain + interviews riders FR (FEN-350)",
    };
  },
});
