import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { newId, nowIso } from '@boutique/shared';
import { SyncStore } from '../src/store.ts';
import { createServer } from '../src/http.ts';

/**
 * Couche HTTP.
 *
 * Le test ouvre un VRAI port : c'est le seul moyen de vérifier ce qui se passe
 * réellement quand une boutique appelle le serveur — codes de retour compris,
 * puisque c'est sur eux que le client distingue une panne réseau d'un refus.
 */
describe('serveur HTTP', () => {
  let store: SyncStore;
  let serveur: Server;
  let base: string;

  beforeEach(async () => {
    store = new SyncStore(':memory:');
    store.registerShop({ id: 'shop-a', code: 'CENT', name: 'Centre', token: 'jeton-a' });
    serveur = createServer(store);
    await new Promise<void>((resoudre) => serveur.listen(0, '127.0.0.1', resoudre));
    const adresse = serveur.address() as AddressInfo;
    base = `http://127.0.0.1:${adresse.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resoudre) => serveur.close(() => resoudre()));
    store.close();
  });

  const appeler = (chemin: string, corps: unknown, jeton = 'jeton-a') =>
    fetch(`${base}${chemin}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
      body: JSON.stringify(corps),
    });

  it('répond à la vérification de santé', async () => {
    const reponse = await fetch(`${base}/sante`);
    expect(reponse.status).toBe(200);
    expect(await reponse.json()).toMatchObject({ ok: true });
  });

  it('refuse un jeton invalide', async () => {
    const reponse = await appeler('/sync/pull', { shopId: 'shop-a', since: 0 }, 'mauvais');
    expect(reponse.status).toBe(401);
  });

  it("refuse une boutique inconnue avec le MÊME message qu'un mauvais jeton", async () => {
    const inconnue = await appeler('/sync/pull', { shopId: 'shop-z', since: 0 });
    const mauvais = await appeler('/sync/pull', { shopId: 'shop-a', since: 0 }, 'mauvais');
    expect(inconnue.status).toBe(401);
    expect(await inconnue.json()).toEqual(await mauvais.json());
  });

  it('accepte un envoi et le restitue au tour suivant', async () => {
    const evenement = {
      id: newId(),
      type: 'PRODUCT_CREATED',
      entity: 'product',
      entityId: newId(),
      shopId: 'shop-a',
      userId: null,
      occurredAt: nowIso(),
      payload: { sku: 'TEST' },
    };

    const envoi = await appeler('/sync/push', {
      shopId: 'shop-a',
      deviceId: 'd1',
      events: [evenement],
    });
    expect(envoi.status).toBe(200);
    const resultat = (await envoi.json()) as { results: { outcome: string }[] };
    expect(resultat.results[0]?.outcome).toBe('APPLIED');

    store.registerShop({ id: 'shop-b', code: 'NORD', name: 'Nord', token: 'jeton-b' });
    const lecture = await appeler(
      '/sync/pull',
      { shopId: 'shop-b', deviceId: 'd2', since: 0 },
      'jeton-b',
    );
    const page = (await lecture.json()) as { events: { payload: { sku: string } }[] };
    expect(page.events[0]?.payload.sku).toBe('TEST');
  });

  it('refuse une route inconnue', async () => {
    const reponse = await appeler('/sync/inconnu', { shopId: 'shop-a' });
    expect(reponse.status).toBe(404);
  });
});
