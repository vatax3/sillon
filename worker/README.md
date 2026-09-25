# sillon-history : enregistrement continu des écoutes

L'API Spotify ne renvoie que tes **50 dernières écoutes** (~2-3 h de musique). Ce worker Cloudflare les relève toutes les 30 minutes et les garde dans un stockage KV. Sillon les récupère à chaque ouverture, ton historique reste donc complet même quand l'app est fermée.

Le plan gratuit de Cloudflare suffit largement (~150 écritures KV par jour).

## Installation (une fois, ~10 min)

```bash
cd worker
npm install
npx wrangler login                          # compte Cloudflare gratuit
npx wrangler kv namespace create HISTORY    # copie l'id affiché dans wrangler.toml
npx wrangler secret put API_KEY             # invente une longue clé aléatoire, garde-la
```

1. Dans `wrangler.toml`, renseigne `SPOTIFY_CLIENT_ID` (le même que Sillon) et l'id du namespace KV.
2. Déploie :
   ```bash
   npx wrangler deploy
   ```
   Note l'URL affichée, par ex. `https://sillon-history.ton-compte.workers.dev`.
3. Dans le [dashboard Spotify](https://developer.spotify.com/dashboard), ajoute la Redirect URI `https://sillon-history.ton-compte.workers.dev/callback`.
4. Ouvre `https://sillon-history.ton-compte.workers.dev/login?key=TA_CLE` et autorise l'accès. Seul le scope `user-read-recently-played` est demandé.
5. Dans Sillon, va dans **Réglages › Enregistrement continu**, colle l'URL et la clé.

## Routes

| Route | Rôle |
|---|---|
| `GET /` | État : connecté, total enregistré, dernière relève, dernière erreur |
| `GET /login?key=…` | Connecte le worker à ton compte Spotify (PKCE, sans secret) |
| `GET /plays?since=<ms>` | Écoutes après une date (`Authorization: Bearer <API_KEY>`) |
| `GET /poll?key=…` | Force une relève immédiate |

Chaque écoute est stockée sous la forme `[horodatage ms, uri, titre, artiste, album, durée ms]`, une clé KV par mois (`plays:2026-09`).

## Développement local

```bash
echo "API_KEY=test" > .dev.vars
npm run dev    # puis curl "http://127.0.0.1:8787/__scheduled" pour simuler le cron
```
