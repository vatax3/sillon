# Sillon

Analyse ta bibliothèque Spotify et génère des playlists par genre, mood, époque, artiste, ou laisse l'app détecter tes ambiances toute seule.

100 % navigateur : pas de serveur, pas de secret (OAuth PKCE). Les données restent dans IndexedDB.

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
| **Analyse** | Familles de genres, genres précis, moods, décennies, artistes les plus présents, profil sonore, likes par année, nouveaux artistes par année, doublons probables. Chaque barre est cliquable et ouvre le Créateur pré-rempli. |
| **Suggestions** | Playlists prêtes à créer : *ambiances* détectées par clustering (k-means sur le son et le genre), moods, genres, décennies, « Pépites oubliées », « Mes nouveautés », « Incontournables », « Essentiel : artiste ». Aperçu, nouveau tirage, création en lot. |
| **Créateur** | Règles combinables : familles et genres, moods, artistes à inclure ou exclure, années, date d'ajout, sources (likés, playlists, tops, récents), énergie, positivité, dansabilité, acoustique, tempo, explicite, durée. Presets (Running, Soirée, Focus, Dîner…). 9 ordres possibles, dont **Mix DJ** (enchaînement par roue de Camelot et tempo) et **Arc d'énergie**. Plafond de titres par artiste, artistes espacés. |
| **Mes playlists** | Chaque playlist créée garde sa recette. « Actualiser » la régénère (nouveaux likes, nouveau tirage) sans changer le lien. |
| **Réglages** | Clé Last.fm, préfixe de nom, public/privé par défaut, export CSV, purge du cache. |

## Contraintes de l'API Spotify (2026) et contournements

Depuis nov. 2024 et fév. 2026, les apps en *Development Mode* n'ont plus accès à :

| Supprimé | Contournement dans Sillon |
|---|---|
| `audio-features`, `recommendations` | [ReccoBeats](https://reccobeats.com) : features au format Spotify, par ID Spotify, sans clé. Tous les titres ne sont pas couverts. |
| Genres d'artistes (`genres: null`) | Tags Last.fm (avec clé) ou MusicBrainz (sans clé, ~1 artiste/s), nettoyés puis regroupés en ~18 familles. |
| Batch `GET /artists?ids=` | Inutile : les genres viennent d'ailleurs. |
| `POST /users/{id}/playlists`, `/playlists/{id}/tracks` | `POST /me/playlists`, `/playlists/{id}/items`. |
| Popularité | Remplacée par un score d'*affinité* personnel : tops, écoutes récentes, présence dans tes playlists. |
| Contenu des playlists des autres | Seules les playlists possédées ou collaboratives sont analysées. |

L'enrichissement est interruptible et reprend où il s'était arrêté. Les artistes les plus présents dans ta bibliothèque passent en premier.

## Développement

```bash
npm test             # tests unitaires (genres, moods, Camelot, générateur, clustering, stats)
npm run typecheck
npm run build
```

Structure :

```
src/lib/        logique pure : auth PKCE, client Spotify, sync, enrichissement,
                genres/moods, indexation, générateur, ordonnancement, suggestions, stats
src/components/ écrans React
src/store.tsx   état global + persistance IndexedDB
```

## Pistes pour la suite

- Déployer sur un domaine HTTPS (Vercel/Netlify) : ajouter la Redirect URI correspondante.
- Actualisation automatique des playlists « vivantes » (nécessiterait un petit backend + refresh token).
- Tags Last.fm au niveau du titre (`track.getTopTags`) pour des moods plus fins quand ReccoBeats ne connaît pas un titre.
