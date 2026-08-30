import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/* ─── Page de consultation ─────────────────────────────────────────────── */

/** Démarre un serveur sur un port libre et rend de quoi l'appeler puis le fermer. */
async function surUnPort(
  store: SyncStore,
  options: Parameters<typeof createServer>[1] = {},
): Promise<{ adresse: string; fermer: () => Promise<void> }> {
  const serveur = createServer(store, options);
  await new Promise<void>((resoudre) => serveur.listen(0, '127.0.0.1', resoudre));
  const port = (serveur.address() as AddressInfo).port;
  return {
    adresse: `http://127.0.0.1:${port}`,
    fermer: async () => {
      await new Promise<void>((resoudre) => serveur.close(() => resoudre()));
      store.close();
    },
  };
}

const basic = (motDePasse: string) => `Basic ${btoa(`admin:${motDePasse}`)}`;

describe('journal de consultation', () => {
  it("n'existe pas quand aucun mot de passe n'est configuré", async () => {
    // Un journal qui porte le nom des clients ne s'ouvre pas par oubli.
    const { adresse, fermer } = await surUnPort(new SyncStore(':memory:'));
    try {
      expect((await fetch(`${adresse}/admin`)).status).toBe(404);
    } finally {
      await fermer();
    }
  });

  it('demande le mot de passe quand il est configuré', async () => {
    const { adresse, fermer } = await surUnPort(new SyncStore(':memory:'), {
      adminPassword: 'phrase-de-passe',
    });
    try {
      const reponse = await fetch(`${adresse}/admin`);
      expect(reponse.status).toBe(401);
      expect(reponse.headers.get('www-authenticate')).toContain('Basic');
    } finally {
      await fermer();
    }
  });

  it('refuse un mauvais mot de passe', async () => {
    const { adresse, fermer } = await surUnPort(new SyncStore(':memory:'), {
      adminPassword: 'phrase-de-passe',
    });
    try {
      const reponse = await fetch(`${adresse}/admin`, {
        headers: { authorization: basic('autre-chose') },
      });
      expect(reponse.status).toBe(401);
    } finally {
      await fermer();
    }
  });

  it('rend la page avec le bon mot de passe', async () => {
    const store = new SyncStore(':memory:');
    store.registerShop({ id: 'shop-a', code: 'CENT', name: 'Centre', token: 'jeton-a' });
    const { adresse, fermer } = await surUnPort(store, { adminPassword: 'phrase-de-passe' });
    try {
      const reponse = await fetch(`${adresse}/admin`, {
        headers: { authorization: basic('phrase-de-passe') },
      });
      expect(reponse.status).toBe(200);
      const page = await reponse.text();
      expect(page).toContain('Journal de synchronisation');
      expect(page).toContain('Centre');
    } finally {
      await fermer();
    }
  });

  it('échappe ce qui vient des boutiques', async () => {
    // La page affiche des noms de commerces : sans échappement, un nom
    // contenant une balise s'exécuterait dans le navigateur de l'éditeur.
    const store = new SyncStore(':memory:');
    store.registerShop({
      id: 'shop-a',
      code: 'CENT',
      name: '<script>alert(1)</script>',
      token: 'jeton-a',
    });
    const { adresse, fermer } = await surUnPort(store, { adminPassword: 'phrase-de-passe' });
    try {
      const page = await (
        await fetch(`${adresse}/admin`, { headers: { authorization: basic('phrase-de-passe') } })
      ).text();
      expect(page).not.toContain('<script>alert(1)</script>');
      expect(page).toContain('&lt;script&gt;');
    } finally {
      await fermer();
    }
  });
});

describe('sauvegarde du journal', () => {
  it('écrit une base complète, relisible telle quelle', () => {
    // Recopier le fichier pendant qu'une boutique pousse un lot donnerait un
    // fichier tronqué, qu'on ne découvrirait qu'en tentant de le restaurer.
    const dossier = mkdtempSync(join(tmpdir(), 'synchro-'));
    const store = new SyncStore(':memory:');
    store.registerShop({ id: 'shop-a', code: 'CENT', name: 'Centre', token: 'jeton-a' });
    store.push({
      shopId: 'shop-a',
      deviceId: 'p',
      events: [
        {
          id: newId(),
          type: 'PRODUCT_CREATED',
          entity: 'product',
          entityId: newId(),
          shopId: 'shop-a',
          userId: null,
          occurredAt: nowIso(),
          payload: {},
        },
      ],
    });

    const copie = join(dossier, 'journal.db');
    store.backupTo(copie);
    store.close();

    const relue = new SyncStore(copie);
    try {
      expect(relue.eventCount()).toBe(1);
      expect(relue.shops()).toHaveLength(1);
    } finally {
      relue.close();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});
