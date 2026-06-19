# POC R-1 — GraphHopper flexible (`ch.disable`) + custom-model area-avoidance, SANS LM / RAM inchangée

> FEN-807 (stream 3a DevOps) / FEN-800 AC-G1 + R-1. Prouve que l'itinéraire
> alternatif « à la demande » est **faisable sans LM et sans hausse RAM**, en
> mode flexible avec un `custom_model` d'évitement de zone passé à la requête.

## Ce qui est livré dans ce ticket (IaC, durable)

- `infra/coolify/graphhopper/config.yml` : ajout de **`routing.ch.disabling_allowed: true`**.
  - **Flag de config pur → coût RAM nul.** Aucune préparation, aucun graphe, aucun
    import. `mem_limit` reste **3g** (`docker-compose.graphhopper.yml`, inchangé).
  - **Requis** : GraphHopper rejette toute requête portant `ch.disable=true`
    (« Disabling CH not allowed on the server-side ») tant que ce flag est faux —
    et ce contrôle se déclenche sur le **paramètre de requête**, indépendamment du
    fait que CH soit préparé ou non. Le profil `bordmap_road` est déjà flexible
    (`profiles_ch: []`, `profiles_lm: []`), donc le `custom_model` à la requête est
    **déjà accepté** : il n'existe **pas** de clé `custom_models.enabled` GraphHopper
    à activer ; « custom_models enabled » du plan = « profil flexible accepté »,
    déjà satisfait ici.
- `NE PAS` ajouter `profiles_lm`. `NE PAS` toucher `mem_limit`. → respecté.

## Comment exécuter le POC sur la live (heartbeat avec accès VPS/Coolify)

GraphHopper n'a **aucun domaine public** (interne au réseau `coolify`). Trois voies
pour l'atteindre depuis le VPS :

```bash
# IP du conteneur sur le bridge coolify
GH_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' bordmap-graphhopper)
```

### Étape A — baseline RAM AVANT (preuve mem_limit + RSS)

```bash
# mem_limit configuré (doit valoir 3g = 3221225472, INCHANGÉ vs baseline)
docker inspect -f '{{.HostConfig.Memory}}' bordmap-graphhopper
# RSS courant (cgroup v2) + stat live
cat /sys/fs/cgroup/system.slice/docker-*bordmap-graphhopper*/memory.current 2>/dev/null \
  || docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}' bordmap-graphhopper
```

### Étape B — requête flexible distincte (harness)

```bash
GH_URL=http://$GH_IP:8989 node scripts/graphhopper-flex-poc.mjs
# imprime : route PRIMAIRE, le CORPS de la requête flexible, la route FLEXIBLE,
# les métriques de distinctness, et POC PASS/FAIL.
```

Le harness : (1) calcule la route primaire `bordmap_road`, (2) construit un polygone
d'évitement (~250 m) autour de son milieu, (3) renvoie une requête flexible
`POST /route` avec `ch.disable=true` + `custom_model.areas` + `priority in_avoid_0
multiply_by 0.05`, (4) mesure l'overlap / la présence dans la zone évitée / le delta
de distance, (5) conclut **PASS** si le tracé est nettement distinct (D-PO-2).

### Étape C — RAM APRÈS (même commande qu'en A)

Rejouer l'Étape A juste après la requête flexible. **Attendu : RSS ≤ baseline + bruit,
`mem_limit` identique (3g).** Le mode flexible exécute Dijkstra/A* sur le graphe de
base **déjà chargé/MMAP'd** : pas de nouvel import, pas de préprocessing → pas de
hausse de la RAM d'import (c'est exactement ce que le LM aurait coûté, ≥4 Go, FEN-599/FEN-603).

## Preuves à joindre au ticket (Étape de clôture)

1. Sortie complète du harness (requête + réponse + distinctness, **POC PASS**).
2. `mem_limit` avant/après (identique, 3g) + RSS avant/après (≤ baseline).
3. GraphHopper `running:healthy` sur la live (le healthcheck EST l'AC, voir compose).

## Gate AC-G2 (sortie explicite — pas d'échec silencieux)

Si, sur la live, **aucun** tracé distinct ne sort sans LM / sans hausse RAM
(harness en **FAIL** de façon répétée, y compris en élargissant le buffer / baissant
`multiply_by`) → **NE PAS livrer avec LM.** Passer FEN-807 **blocked**, escalader au
board via FEN-803 + commentaire CEO (rouvre la décision RAM). Historique : FEN-739, FEN-603.
