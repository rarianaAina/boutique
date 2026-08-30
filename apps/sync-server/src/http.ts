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
 * Volontairement minimale : trois routes, une authentification par jeton de
 * boutique, aucun état. Toute la logique est dans `SyncStore` — ce qui permet
 * de la tester sans ouvrir de port, et de la remplacer par un autre transport
 * (un partage de fichiers, une clé USB) sans rien réécrire du métier.
 */

const MAX_BODY = 8 * 1024 * 1024;

export function createServer(store: SyncStore) {
  return createHttpServer(async (request, response) => {
    try {
      await route(store, request, response);
    } catch (cause) {
      send(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}

async function route(
  store: SyncStore,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/sante') {
    send(response, 200, { ok: true, evenements: store.eventCount(), seq: store.serverSeq() });
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
