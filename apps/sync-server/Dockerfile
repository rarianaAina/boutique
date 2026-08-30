# Serveur de synchronisation.
#
# DEUX ÉTAPES, ET LA PREMIÈRE N'EST PAS DÉCORATIVE. Le paquet partagé écrit ses
# imports sans extension — « ./enums » et non « ./enums.js ». Vite et les
# épreuves savent les résoudre ; Node, lancé directement sur les sources, ne le
# fait pas et s'arrête au démarrage. On assemble donc le serveur et tout ce dont
# il dépend en un seul fichier, qui n'a plus rien à résoudre.
#
# L'image finale n'emporte ni sources, ni node_modules, ni outillage : un
# fichier et Node. Elle démarre en une fraction de seconde, ce qui compte quand
# l'hébergeur relance le service.

# ─── Assemblage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS assemblage
RUN corepack enable
WORKDIR /app

# Les manifestes d'abord : tant qu'ils ne changent pas, la couche des
# dépendances est réutilisée et le déploiement prend quelques secondes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/sync-server/package.json apps/sync-server/
RUN pnpm install --frozen-lockfile --filter "@boutique/sync-server..."

COPY packages/shared packages/shared
COPY apps/sync-server apps/sync-server
RUN pnpm --filter @boutique/sync-server bundle

# ─── Exécution ──────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
# Le fichier assemblé ET le schéma, que le journal lit à sa création.
COPY --from=assemblage /app/apps/sync-server/dist/ ./

# Le journal vit sur un disque persistant monté ici. Sans ce disque, il
# disparaîtrait à chaque redémarrage — et avec lui l'ordre des événements.
ENV SYNC_DB=/donnees/sync.db
ENV BACKUP_DIR=/donnees/sauvegardes
ENV PORT=4310
EXPOSE 4310

# `--experimental-sqlite` : le journal s'appuie sur le SQLite intégré à Node.
CMD ["node", "--experimental-sqlite", "serveur.js"]
