import { SyncStore } from './store.ts';
import { createServer } from './http.ts';

/**
 * Point d'entrée du serveur.
 *
 * Les boutiques sont enrôlées par variable d'environnement plutôt que par une
 * interface d'administration : le parc compte quelques boutiques, pas quelques
 * milliers, et un fichier de configuration se sauvegarde et se relit — ce qui
 * vaut mieux qu'une table qu'on découvrirait vide un lundi matin.
 *
 *   BOUTIQUES="id:code:nom:jeton,id2:code2:nom2:jeton2"
 */
const path = process.env['SYNC_DB'] ?? 'sync.db';
const port = Number(process.env['PORT'] ?? 4310);
const store = new SyncStore(path);

for (const entry of (process.env['BOUTIQUES'] ?? '').split(',')) {
  const parts = entry.split(':');
  if (parts.length !== 4) continue;
  const [id, code, name, token] = parts as [string, string, string, string];
  store.registerShop({ id, code, name, token });
}

const registered = store.shops();
if (registered.length === 0) {
  console.warn(
    'Aucune boutique enrôlée : renseignez BOUTIQUES="id:code:nom:jeton" avant de démarrer.',
  );
}

createServer(store).listen(port, () => {
  console.log(`Serveur de synchronisation sur le port ${port} — base ${path}`);
  for (const shop of registered) console.log(`  • ${shop.code} — ${shop.name}`);
});
