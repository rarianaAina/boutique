import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SyncStore } from './store.ts';
import { createServer } from './http.ts';

/**
 * Point d'entrée du serveur.
 *
 * Tout se règle par variables d'environnement, sans fichier de configuration à
 * déposer : c'est ce que demandent les hébergeurs d'applications, et c'est ce
 * qui rend le déploiement reproductible — la configuration se lit dans leur
 * interface, se sauvegarde avec le compte, et ne se perd pas avec la machine.
 *
 *   SYNC_DB          chemin du journal          (défaut : ./sync.db)
 *   PORT             port d'écoute              (défaut : 4310)
 *   BOUTIQUES        "id:code:nom:jeton,…"      enrôlement
 *   ADMIN_PASSWORD   mot de passe de /admin     (vide : la page n'existe pas)
 *   BACKUP_DIR       dossier des sauvegardes    (vide : pas de sauvegarde)
 *   BACKUP_HOURS     intervalle en heures       (défaut : 6)
 *   BACKUP_KEEP      nombre de copies gardées   (défaut : 14)
 */

const chemin = process.env['SYNC_DB'] ?? 'sync.db';
const port = Number(process.env['PORT'] ?? 4310);
const adminPassword = process.env['ADMIN_PASSWORD'] ?? '';

// Le dossier du journal est créé au besoin : sur un hébergeur, le disque
// persistant est monté vide au premier démarrage.
mkdirSync(dirname(chemin) || '.', { recursive: true });
const store = new SyncStore(chemin);

/* ─── Enrôlement ─────────────────────────────────────────────────────────
   Les boutiques sont déclarées par variable plutôt que par une interface
   d'administration : le parc compte quelques boutiques, pas quelques milliers,
   et une variable se sauvegarde avec le compte de l'hébergeur — ce qui vaut
   mieux qu'une table qu'on découvrirait vide un lundi matin.

   La ligne à coller est PRODUITE PAR L'APPLICATION, dans Paramètres →
   Synchronisation : personne ne recopie un identifiant de trente-six signes à
   la main. */
const enrolees: string[] = [];
const rejetees: string[] = [];
for (const entree of (process.env['BOUTIQUES'] ?? '').split(',')) {
  const propre = entree.trim();
  if (propre === '') continue;
  const parts = propre.split(':');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) {
    // On NOMME ce qui a été refusé plutôt que de l'ignorer : une boutique
    // absente parce qu'une virgule manquait donnerait un « jeton invalide »
    // incompréhensible au moment de la première synchronisation.
    rejetees.push(propre.slice(0, 40));
    continue;
  }
  const [id, code, name, token] = parts as [string, string, string, string];
  store.registerShop({ id: id.trim(), code: code.trim(), name: name.trim(), token: token.trim() });
  enrolees.push(`${code.trim()} — ${name.trim()}`);
}

/* ─── Sauvegarde ─────────────────────────────────────────────────────────
   Le journal ne contient pas les données des boutiques — chacune garde les
   siennes en entier — mais il porte l'ORDRE des événements et le registre des
   IMEI. Le perdre laisserait les postes avec des curseurs pointant dans le
   vide et les colis en cours bloqués. C'est récupérable, mais pas un dimanche
   soir. */
const backupDir = process.env['BACKUP_DIR'] ?? '';
const backupHours = Number(process.env['BACKUP_HOURS'] ?? 6);
const backupKeep = Number(process.env['BACKUP_KEEP'] ?? 14);

function sauvegarder(): void {
  if (backupDir === '') return;
  try {
    mkdirSync(backupDir, { recursive: true });
    const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
    store.backupTo(join(backupDir, `journal-${horodatage}.db`));

    // Rotation : sans elle, le disque se remplit et le serveur s'arrête un
    // jour sans prévenir, ce qui est pire que de n'avoir aucune sauvegarde.
    const copies = readdirSync(backupDir)
      .filter((nom) => nom.startsWith('journal-') && nom.endsWith('.db'))
      .map((nom) => ({ nom, date: statSync(join(backupDir, nom)).mtimeMs }))
      .sort((a, b) => b.date - a.date);
    for (const surplus of copies.slice(Math.max(1, backupKeep))) {
      rmSync(join(backupDir, surplus.nom), { force: true });
    }
  } catch (cause) {
    // Une sauvegarde ratée ne doit PAS arrêter le serveur : les boutiques
    // continuent de se synchroniser, et l'incident se lit dans les traces.
    console.error('Sauvegarde impossible :', cause instanceof Error ? cause.message : cause);
  }
}

if (backupDir !== '' && backupHours > 0) {
  sauvegarder();
  const minuterie = setInterval(sauvegarder, backupHours * 3_600_000);
  // Sans cela, le processus ne se terminerait jamais proprement.
  minuterie.unref();
}

/* ─── Démarrage ─────────────────────────────────────────────────────────── */

createServer(store, { adminPassword }).listen(port, () => {
  console.log(`Serveur de synchronisation — port ${port}, journal ${chemin}`);
  if (enrolees.length === 0) {
    console.warn(
      'AUCUNE BOUTIQUE ENRÔLÉE. Renseignez BOUTIQUES avec les lignes produites par chaque ' +
        'boutique dans Paramètres → Synchronisation.',
    );
  }
  for (const boutique of enrolees) console.log(`  • ${boutique}`);
  for (const refusee of rejetees) {
    console.warn(`  ! ligne d'enrôlement mal formée, ignorée : « ${refusee} »`);
  }
  console.log(
    adminPassword === ''
      ? '  Journal de consultation FERMÉ (ADMIN_PASSWORD non renseigné).'
      : '  Journal de consultation sur /admin',
  );
  if (backupDir === '') console.warn('  Aucune sauvegarde configurée (BACKUP_DIR vide).');
});
