#!/bin/sh
# Prépare /data puis lance Sillon sans privilèges.
# Un dossier monté depuis l'hôte (./data:/data, NAS…) appartient souvent à root : on corrige ses droits
# au démarrage. PUID / PGID choisissent l'utilisateur d'exécution (défaut 1000:1000).
set -e

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  needs_fix=0
  su-exec "$PUID:$PGID" test -w "$DATA_DIR" || needs_fix=1
  for f in "$DATA_DIR"/sillon.db "$DATA_DIR"/sillon.db-wal "$DATA_DIR"/sillon.db-shm; do
    if [ -e "$f" ] && ! su-exec "$PUID:$PGID" test -w "$f"; then needs_fix=1; fi
  done
  if [ "$needs_fix" = "1" ]; then
    echo "[sillon] Droits de $DATA_DIR corrigés pour l'utilisateur $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR" || echo "[sillon] Impossible de changer le propriétaire de $DATA_DIR (partage réseau ?) : règle PUID/PGID sur son propriétaire."
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Conteneur déjà lancé sans root (option `user:`) : on démarre tel quel.
exec "$@"
