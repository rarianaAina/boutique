import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { SyncStore } from './store.ts';
import type { ClaimRequest, PullRequest, PushRequest } from '@boutique/shared';

/**
 * Couche HTTP du serveur de synchronisation.
 *
 * Volontairement minimale : trois routes de synchronisation, une
 * authentification par jeton de boutique, aucun état. Toute la logique est dans
 * `SyncStore` — ce qui permet de la tester sans ouvrir de port, et de la
 * remplacer par un autre transport (un partage de fichiers, une clé USB) sans
 * rien réécrire du métier.
 *
 * S'y ajoutent deux routes de service, qui n'existent que parce que ce serveur
 * vit désormais sur Internet : `/sante`, que l'hébergeur interroge pour savoir
 * s'il faut relancer le service, et `/admin`, qui montre le journal à l'éditeur.
 */

const MAX_BODY = 8 * 1024 * 1024;

export interface ServerOptions {
  /**
   * Mot de passe de la page de consultation.
   *
   * Absent, la page n'existe pas — et c'est le bon comportement par défaut :
   * un journal qui porte le nom des clients ne s'ouvre pas parce qu'on a oublié
   * de le fermer.
   */
  adminPassword?: string;
}

export function createServer(store: SyncStore, options: ServerOptions = {}) {
  return createHttpServer(async (request, response) => {
    try {
      await route(store, options, request, response);
    } catch (cause) {
      send(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}

async function route(
  store: SyncStore,
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = request.url ?? '/';
  const chemin = url.split('?')[0] ?? '/';

  if (request.method === 'GET' && chemin === '/sante') {
    send(response, 200, { ok: true, evenements: store.eventCount(), seq: store.serverSeq() });
    return;
  }

  if (request.method === 'GET' && chemin === '/admin') {
    servirAdmin(store, options, request, response, url);
    return;
  }

  if (request.method !== 'POST') {
    send(response, 405, { error: 'Méthode non autorisée.' });
    return;
  }

  const body = await readBody(request);
  const shopId = String((body as { shopId?: unknown }).shopId ?? '');
  const token = (request.headers['authorization'] ?? '').toString().replace(/^Bearer\s+/i, '');

  if (!shopId || !store.authenticate(shopId, token)) {
    // Le même message pour une boutique inconnue et pour un mauvais jeton :
    // distinguer les deux renseignerait sur les boutiques enrôlées.
    send(response, 401, { error: 'Boutique ou jeton invalide.' });
    return;
  }

  switch (url) {
    case '/sync/push':
      send(response, 200, store.push(body as unknown as PushRequest));
      return;
    case '/sync/pull':
      send(response, 200, store.pull(body as unknown as PullRequest));
      return;
    case '/sync/claim':
      send(response, 200, store.claim(body as unknown as ClaimRequest));
      return;
    default:
      send(response, 404, { error: 'Route inconnue.' });
  }
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Une requête démesurée est refusée AVANT d'être mise en mémoire : un
      // serveur de synchronisation tourne souvent sur une machine modeste.
      if (size > MAX_BODY) {
        reject(new Error('Charge utile trop volumineuse.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('Corps de requête illisible.'));
      }
    });
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/* ─── Page de consultation ─────────────────────────────────────────────── */

/**
 * Journal du serveur, en lecture seule.
 *
 * Authentification HTTP simple : c'est une page que l'éditeur ouvre trois fois
 * par an, depuis un navigateur, souvent en urgence. Lui imposer un formulaire
 * et une session serait du travail pour rien — et le navigateur retient le mot
 * de passe.
 */
function servirAdmin(
  store: SyncStore,
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: string,
): void {
  const attendu = options.adminPassword ?? '';
  if (attendu === '') {
    // Pas de mot de passe configuré : la page n'existe pas. Un journal qui
    // porte le nom des clients ne s'ouvre pas par oubli.
    send(response, 404, { error: 'Route inconnue.' });
    return;
  }

  const entete = (request.headers['authorization'] ?? '').toString();
  const fourni = entete.startsWith('Basic ')
    ? Buffer.from(entete.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':')
    : '';

  if (!timingSafeEqual(fourni, attendu)) {
    response.writeHead(401, {
      'www-authenticate': 'Basic realm="Journal de synchronisation", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end('Mot de passe requis.');
    return;
  }

  const parametres = new URLSearchParams(url.split('?')[1] ?? '');
  const shopId = parametres.get('boutique') ?? undefined;
  const page = pageAdmin(store, shopId);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(page),
  });
  response.end(page);
}

function pageAdmin(store: SyncStore, shopId?: string): string {
  const boutiques = store.shops();
  const curseurs = store.cursors();
  const evenements = store.journal({ shopId, limit: 200 });

  const lignes = evenements
    .map(
      (entree) => `<tr>
        <td class="num">${entree.seq}</td>
        <td>${echapper(entree.receivedAt)}</td>
        <td>${echapper(entree.shopLabel)}</td>
        <td><code>${echapper(entree.type)}</code></td>
        <td>${echapper(entree.entity)}</td>
        <td class="mono">${echapper(entree.entityId)}</td>
      </tr>`,
    )
    .join('');

  const postes = curseurs
    .map(
      (curseur) => `<tr>
        <td>${echapper(curseur.shopLabel)}</td>
        <td class="mono">${echapper(curseur.deviceId.slice(0, 8))}</td>
        <td class="num">${curseur.lastSeq}</td>
        <td>${echapper(curseur.updatedAt)}</td>
      </tr>`,
    )
    .join('');

  const filtres = [
    `<a href="/admin"${shopId ? '' : ' class="actif"'}>Toutes</a>`,
    ...boutiques.map(
      (boutique) =>
        `<a href="/admin?boutique=${encodeURIComponent(boutique.id)}"${
          shopId === boutique.id ? ' class="actif"' : ''
        }>${echapper(boutique.name)}</a>`,
    ),
  ].join(' · ');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Journal de synchronisation</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 24px; color: #1c1f24; background: #f6f7f9; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.resume { color: #667; margin: 0 0 20px; }
  nav { margin-bottom: 16px; }
  nav a { margin-right: 4px; color: #2c5cc5; text-decoration: none; }
  nav a.actif { font-weight: 600; color: #1c1f24; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin-bottom: 24px;
          box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e6e8eb; }
  th { background: #fafbfc; font-weight: 600; font-size: 12px; text-transform: uppercase;
       letter-spacing: .04em; color: #667; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono, code { font-family: ui-monospace, monospace; font-size: 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; }
</style></head><body>
<h1>Journal de synchronisation</h1>
<p class="resume">${store.eventCount()} événements · dernier rang ${store.serverSeq()} · ${
    boutiques.length
  } boutique(s) enrôlée(s)</p>

<h2>Postes</h2>
<table><thead><tr><th>Boutique</th><th>Poste</th><th class="num">Lu jusqu’à</th><th>Dernière visite</th></tr></thead>
<tbody>${postes || '<tr><td colspan="4">Aucun poste ne s’est encore synchronisé.</td></tr>'}</tbody></table>

<h2>Événements</h2>
<nav>${filtres}</nav>
<table><thead><tr><th class="num">Rang</th><th>Reçu le</th><th>Boutique</th><th>Type</th><th>Entité</th><th>Identifiant</th></tr></thead>
<tbody>${lignes || '<tr><td colspan="6">Le journal est vide.</td></tr>'}</tbody></table>
</body></html>`;
}

/**
 * Échappement HTML.
 *
 * La page affiche des noms de commerces et des identifiants venus des
 * boutiques : sans échappement, un nom contenant une balise s'exécuterait dans
 * le navigateur de l'éditeur.
 */
function echapper(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Comparaison en temps constant, comme pour les jetons de boutique. */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
