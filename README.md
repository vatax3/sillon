# Sillon

Analyse ta bibliothèque Spotify et génère des playlists par genre, mood, époque, artiste, ou laisse l'app détecter tes ambiances toute seule.

100 % navigateur : pas de serveur, pas de secret (OAuth PKCE). Les données restent dans IndexedDB.

**Version en ligne** : <https://vatax3.github.io/sillon/>. Il faut ton propre Client ID Spotify, et la Redirect URI `https://vatax3.github.io/sillon/callback` déclarée dans ton app Spotify.

## Démarrage

1. Crée une app sur <https://developer.spotify.com/dashboard> (API : **Web API**). Le compte propriétaire doit être **Premium**.
2. Ajoute la Redirect URI : `http://127.0.0.1:5173/callback`. Spotify refuse `localhost`, il faut l'IP.
3. Dans **User Management**, ajoute l'e-mail des comptes autorisés (5 max en mode dev).
4. Lance l'app :

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Colle le Client ID à l'écran d'accueil, ou mets-le dans `.env` (voir `.env.example`).

5. Optionnel mais conseillé : une [clé API Last.fm](https://www.last.fm/api/account/create) gratuite, à saisir dans Réglages. Elle rend l'enrichissement des genres environ 4× plus rapide.

## Fonctionnalités

| Onglet | Ce qu'il fait |
|---|---|
| **Analyse** | Familles de genres, genres précis, moods, décennies, artistes les plus présents, profil sonore, likes par année, doublons probables. Chaque barre est cliquable et ouvre le Créateur pré-rempli. |
| **Écoutes** | Import de ton historique Spotify (export « streaming étendu »), puis stats sur n'importe quelle période : temps d'écoute réel, carte heure × jour, tops par minutes, séries de jours, taux de skip (y compris « liké mais toujours skippé »), époques mois par mois, obsessions, fidélité, humeur × moment, machine à remonter le temps, playlists de tes moments (matins, soirées, week-ends), comparaison année par année. |
| **Playlists** | *Suggestions* (ambiances détectées par clustering, moods, genres, époques, redécouvertes), *Créateur* à règles (genre, mood, artistes, années, énergie, tempo, et avec l'historique importé : nombre d'écoutes, dernière écoute, taux de skip, date de découverte…, 9 ordres dont **Mix DJ** et **Arc d'énergie**), *Mes playlists* : playlists vivantes actualisables, et **éditeur manuel** pour toutes tes playlists (glisser-déposer, ajout depuis ta bibliothèque ou Spotify, retrait, tri, doublons, nom et description, annulation). Sur une playlist vivante, tes ajouts sont épinglés et tes retraits exclus des actualisations suivantes. |
| **Découvrir** | *Recommandations* à partir de tes écoutes récentes, de tes favoris, d'une playlist à prolonger ou d'artistes précis : artistes similaires (Deezer), extraits 30 s, tout ce que tu connais déjà est écarté. *Radar de sorties* de tes artistes. *À creuser* : artistes très écoutés mais absents de ta bibliothèque, albums à écouter en entier. |
| **Ranger** | Titres de tes playlists non likés (like groupé). Trieur des likés sans playlist, avec suggestions et raccourcis clavier. Doublons dans une playlist, playlists qui se recouvrent, fusion, découpage par genre/décennie/mood, réordonnancement sur place. Artistes à suivre. Sauvegardes, différences et restauration. |
| **Amis** | Carte de goûts exportable (JSON à échanger, image à partager), score de compatibilité détaillé, artistes à se faire découvrir, **Blend** à deux. Tout se passe sans serveur. |
| **Lecteur** | Pilote ton appareil Spotify actif (Premium) : lire une playlist générée sans la créer, file d'attente, suivant/précédent. |

## Auto-hébergement (Docker)

Sillon peut tourner sur ton serveur. L'interface est la même, mais :

| Ce que ça apporte | Détail |
|---|---|
| **Playlists automatiques** | *Découvertes de la semaine* (jamais deux fois le même titre), *Radar de sorties*, *Il y a un an*, *Top du mois*. Chacune garde le même lien Spotify d'une fois sur l'autre. |
| **Playlists vivantes planifiées** | Chaque playlist vivante peut s'actualiser seule (quotidien, hebdo, mensuel), en gardant tes titres épinglés et exclus. |
| **Historique continu** | Tes écoutes sont relevées toutes les 30 min, sans onglet ouvert. Le worker Cloudflare devient inutile. |
| **Synchro et enrichissement de nuit** | La bibliothèque se met à jour seule, et genres et moods se complètent en tâche de fond. |
| **Tous tes appareils** | Données, réglages et playlists vivantes sont sur le serveur, donc les mêmes sur ton téléphone et ton ordinateur. Les modifications concurrentes ne s'écrasent pas. |
| **Notifications** | Nouvelles sorties, playlists générées, échecs de tâche : via [ntfy](https://ntfy.sh) (appli mobile gratuite), Discord ou un webhook. |
| **Sauvegardes** | Instantané quotidien des playlists et export JSON complet dans `/data/exports`, avec rétention. |
| **Plusieurs comptes** | Jusqu'à 5 comptes Spotify (limite du mode dev). Leurs cartes de goûts se comparent directement, sans échange de fichiers. |
| **Journal** | Historique des tâches, prochaines exécutions, bouton « Lancer maintenant ». |

### Installation

1. **App Spotify** : sur le [dashboard](https://developer.spotify.com/dashboard), crée une app (compte propriétaire Premium) et ajoute la Redirect URI `https://TON-DOMAINE/auth/callback`. Dans *User Management*, ajoute chaque compte qui utilisera le serveur.
2. **Configuration** : récupère [`docker-compose.yml`](docker-compose.yml) et renseigne `SPOTIFY_CLIENT_ID` et `BASE_URL`.
3. **Démarrage** :
   ```bash
   docker compose up -d
   docker compose logs -f sillon   # affiche la Redirect URI attendue
   ```
4. Ouvre `BASE_URL`, connecte-toi, puis règle l'onglet **Automatisations**.

L'image `ghcr.io/vatax3/sillon` est publiée pour `amd64` et `arm64` (Raspberry Pi 4/5, serveurs ARM). Pour la mettre à jour : `docker compose pull && docker compose up -d`.

### HTTPS : obligatoire pour Spotify

Spotify n'accepte comme Redirect URI que du **HTTPS**, ou `http://127.0.0.1`. Trois options :

- **Nom de domaine + Caddy** : HTTPS automatique avec Let's Encrypt. Un service Caddy commenté est prêt dans `docker-compose.yml`, avec le [`Caddyfile`](Caddyfile). Traefik ou Nginx Proxy Manager conviennent aussi.
- **Tailscale** : `tailscale serve --bg 8080` donne une URL `https://machine.tailnet.ts.net` accessible depuis tes appareils, sans rien ouvrir sur Internet.
- **Tunnel SSH** : `ssh -L 8080:127.0.0.1:8080 ton-serveur` et `BASE_URL=http://127.0.0.1:8080`. Pratique pour tester, mais l'accès se limite à cette machine.

### Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | oui | Client ID de l'app Spotify |
| `BASE_URL` | oui | URL publique, sans `/` final (sert à la Redirect URI et aux cookies sécurisés) |
| `TZ` | | Fuseau des planifications (défaut `Europe/Paris`) |
| `SPOTIFY_CLIENT_SECRET` | | Secret de l'app. Sans lui, le serveur utilise PKCE. |
| `LASTFM_API_KEY` | | Clé Last.fm pour tous les comptes (genres plus rapides et plus riches) |
| `ALLOWED_SPOTIFY_IDS` | | Liste d'ids Spotify autorisés, séparés par des virgules |
| `PORT`, `DATA_DIR` | | `8080` et `/data` par défaut |

### Données et sécurité

- Tout est dans le volume `/data` : la base `sillon.db` (SQLite) et les exports `exports/<compte>/`. Sauvegarder ce volume suffit.
- Les jetons Spotify ne quittent jamais le serveur, sauf les jetons d'accès courts dont l'interface a besoin. La session est un cookie `HttpOnly`, et les écritures exigent un en-tête anti-CSRF.
- Le conteneur tourne en utilisateur non-root, sans aucune dépendance npm à l'exécution : le serveur est un seul fichier JS.
- Si Spotify révoque l'accès d'un compte, ses tâches s'arrêtent et une notification d'échec est envoyée. Il suffit de se reconnecter.

### Construire l'image soi-même

```bash
docker build -t sillon .
# ou, sans Docker :
npm ci && npm run build && npm run build:server
SPOTIFY_CLIENT_ID=… BASE_URL=http://127.0.0.1:8080 npm start
```

## Enregistrement continu sans serveur (optionnel)

Sans auto-hébergement, l'API ne garde que tes 50 dernières écoutes. Le dossier [`worker/`](worker/) contient un worker Cloudflare gratuit qui les relève toutes les 30 minutes. Sillon les récupère ensuite à chaque ouverture. Voir [worker/README.md](worker/README.md).

## Contraintes de l'API Spotify (2026) et contournements

Depuis nov. 2024 et fév. 2026, les apps en *Development Mode* n'ont plus accès à :

| Supprimé | Contournement dans Sillon |
|---|---|
| `audio-features`, `recommendations` | [ReccoBeats](https://reccobeats.com) : features au format Spotify, par ID Spotify, sans clé. Tous les titres ne sont pas couverts. |
| Genres d'artistes (`genres: null`) | Tags Last.fm (avec clé) ou MusicBrainz (sans clé, ~1 artiste/s), nettoyés puis regroupés en ~18 familles. |
| Batch `GET /artists?ids=` | Inutile : les genres viennent d'ailleurs. |
| `POST /users/{id}/playlists`, `/playlists/{id}/tracks` | `POST /me/playlists`, `/playlists/{id}/items`. |
| Popularité | Remplacée par un score d'*affinité* personnel : tops, écoutes récentes, présence dans tes playlists. |
| `recommendations`, `related-artists`, `browse/new-releases` | Artistes similaires et titres phares via l'API publique **Deezer** (JSONP, sans clé), résolus sur Spotify par recherche. Le radar de sorties interroge chaque artiste. |
| Historique au-delà de 50 écoutes | Import de l'export RGPD de Spotify + worker optionnel. |
| Contenu des playlists des autres | Seules les playlists possédées ou collaboratives sont analysées. |

L'enrichissement est interruptible et reprend où il s'était arrêté. Les artistes les plus présents dans ta bibliothèque passent en premier.

## Développement

```bash
npm test             # tests unitaires + intégration contre une fausse API Spotify
npm run typecheck
npm run build
npm run build:pages  # version GitHub Pages (sous /sillon/)
npm run dev:server   # serveur local (variables dans .env.server)
SILLON_SERVER=http://127.0.0.1:8080 npm run dev   # interface en dev contre ce serveur
```

La CI GitHub vérifie typecheck, tests et build à chaque push, puis publie `main` sur GitHub Pages.

Structure :

```
src/lib/        logique pure : auth PKCE, client Spotify, sync, enrichissement, genres/moods,
                indexation, générateur, ordonnancement, suggestions, stats, historique,
                recommandations (Deezer), radar, outils de rangement, social
server/         serveur auto-hébergé : API, connexion Spotify, SQLite, planificateur, tâches
worker/         worker Cloudflare optionnel d'enregistrement des écoutes (sans serveur)
src/components/ écrans React
src/store.tsx   état global + persistance IndexedDB
```

## Pistes pour la suite

- Déployer sur un domaine HTTPS (Vercel, Netlify) : ajouter la Redirect URI correspondante.
- Concerts de tes artistes : Bandsintown et Songkick exigent une clé partenaire, à brancher si tu en obtiens une.
- Web Playback SDK : faire de Sillon lui-même un appareil de lecture.
