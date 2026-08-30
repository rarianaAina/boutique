import { beforeEach, describe, expect, it } from 'vitest';
import { newId, nowIso } from '@boutique/shared';
import type { SyncEvent } from '@boutique/shared';
import { SyncStore } from '../src/store.ts';

/**
 * Cœur du serveur de synchronisation.
 *
 * Les trois règles vérifiées ici portent toute la fiabilité du réseau :
 * idempotence, ordre attribué par le serveur, et arbitrage de la détention des
 * identifiants physiques.
 */
const BOUTIQUE_A = 'shop-a';
const BOUTIQUE_B = 'shop-b';

function evenement(shopId: string, surcharge: Partial<SyncEvent> = {}): SyncEvent {
  return {
    id: newId(),
    type: 'PRODUCT_CREATED',
    entity: 'product',
    entityId: newId(),
    shopId,
    userId: 'u1',
    occurredAt: nowIso(),
    payload: {},
    ...surcharge,
  };
}

function reception(shopId: string, imei: string, unitId = newId()): SyncEvent {
  return evenement(shopId, {
    type: 'STOCK_RECEIVED',
    entity: 'product_unit',
    entityId: unitId,
    payload: { unitId, identifiers: [{ kind: 'IMEI', slot: 1, value: imei }] },
  });
}

describe('serveur de synchronisation', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore(':memory:');
    store.registerShop({ id: BOUTIQUE_A, code: 'CENT', name: 'Centre', token: 'jeton-a' });
    store.registerShop({ id: BOUTIQUE_B, code: 'NORD', name: 'Nord', token: 'jeton-b' });
  });

  describe('authentification', () => {
    it('accepte le bon jeton et refuse les autres', () => {
      expect(store.authenticate(BOUTIQUE_A, 'jeton-a')).toBe(true);
      expect(store.authenticate(BOUTIQUE_A, 'jeton-b')).toBe(false);
      expect(store.authenticate('inconnue', 'jeton-a')).toBe(false);
    });
  });

  describe('idempotence', () => {
    it("n'applique un événement qu'une seule fois", () => {
      const un = evenement(BOUTIQUE_A);
      const premier = store.push({ shopId: BOUTIQUE_A, deviceId: 'd1', events: [un] });
      const second = store.push({ shopId: BOUTIQUE_A, deviceId: 'd1', events: [un] });

      expect(premier.results[0]?.outcome).toBe('APPLIED');
      expect(second.results[0]?.outcome).toBe('DUPLICATE');
      expect(second.results[0]?.seq).toBe(premier.results[0]?.seq);
      expect(store.eventCount()).toBe(1);
    });

    it('traite chaque événement du lot séparément', () => {
      const un = evenement(BOUTIQUE_A);
      store.push({ shopId: BOUTIQUE_A, deviceId: 'd1', events: [un] });

      const reponse = store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [un, evenement(BOUTIQUE_A)],
      });
      expect(reponse.results.map((resultat) => resultat.outcome)).toEqual(['DUPLICATE', 'APPLIED']);
    });
  });

  describe('ordre et distribution', () => {
    it("attribue un rang croissant, dans l'ordre d'arrivée", () => {
      const reponse = store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [evenement(BOUTIQUE_A), evenement(BOUTIQUE_A), evenement(BOUTIQUE_A)],
      });
      const rangs = reponse.results.map((resultat) => resultat.seq);
      expect(rangs).toEqual([1, 2, 3]);
    });

    it('ne renvoie pas à une boutique ses propres événements', () => {
      store.push({ shopId: BOUTIQUE_A, deviceId: 'd1', events: [evenement(BOUTIQUE_A)] });
      store.push({ shopId: BOUTIQUE_B, deviceId: 'd2', events: [evenement(BOUTIQUE_B)] });

      const pourA = store.pull({ shopId: BOUTIQUE_A, deviceId: 'd1', since: 0 });
      expect(pourA.events).toHaveLength(1);
      expect(pourA.events[0]?.shopId).toBe(BOUTIQUE_B);
    });

    it('reprend le flux au rang demandé', () => {
      store.push({
        shopId: BOUTIQUE_B,
        deviceId: 'd2',
        events: [evenement(BOUTIQUE_B), evenement(BOUTIQUE_B), evenement(BOUTIQUE_B)],
      });

      const premier = store.pull({ shopId: BOUTIQUE_A, deviceId: 'd1', since: 0, limit: 2 });
      expect(premier.events).toHaveLength(2);
      expect(premier.hasMore).toBe(true);

      const suite = store.pull({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        since: premier.events.at(-1)?.seq ?? 0,
      });
      expect(suite.events).toHaveLength(1);
      expect(suite.hasMore).toBe(false);
    });

    it("refuse un événement qui prétend venir d'une autre boutique", () => {
      const reponse = store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [evenement(BOUTIQUE_B)],
      });
      expect(reponse.results[0]?.outcome).toBe('REJECTED');
      expect(reponse.results[0]?.reason).toContain('authentifiée');
    });
  });

  describe('arbitrage des identifiants', () => {
    const IMEI = '356920051000007';

    it('refuse le même IMEI déclaré par une seconde boutique', () => {
      store.push({ shopId: BOUTIQUE_A, deviceId: 'd1', events: [reception(BOUTIQUE_A, IMEI)] });
      const reponse = store.push({
        shopId: BOUTIQUE_B,
        deviceId: 'd2',
        events: [reception(BOUTIQUE_B, IMEI)],
      });

      expect(reponse.results[0]?.outcome).toBe('REJECTED');
      expect(reponse.results[0]?.reason).toContain('déjà détenu');
      expect(store.holderOf('IMEI', IMEI)?.shop_id).toBe(BOUTIQUE_A);
    });

    it('accepte que la boutique détentrice le redéclare', () => {
      const unitId = newId();
      store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [reception(BOUTIQUE_A, IMEI, unitId)],
      });
      const reponse = store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [reception(BOUTIQUE_A, IMEI, unitId)],
      });
      expect(reponse.results[0]?.outcome).toBe('APPLIED');
    });

    it('transfère la détention à la réception du transfert', () => {
      const unitId = newId();
      store.push({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        events: [reception(BOUTIQUE_A, IMEI, unitId)],
      });
      expect(store.holderOf('IMEI', IMEI)?.shop_id).toBe(BOUTIQUE_A);

      store.push({
        shopId: BOUTIQUE_B,
        deviceId: 'd2',
        events: [
          evenement(BOUTIQUE_B, {
            type: 'STOCK_TRANSFER_RECEIVED',
            entity: 'transfer',
            payload: { transferId: 't1', toShopId: BOUTIQUE_B, lines: [{ unitId }] },
          }),
        ],
      });
      expect(store.holderOf('IMEI', IMEI)?.shop_id).toBe(BOUTIQUE_B);
    });

    it('accorde une revendication libre et refuse une revendication détenue', () => {
      const unitId = newId();
      const premier = store.claim({
        shopId: BOUTIQUE_A,
        deviceId: 'd1',
        identifiers: [{ kind: 'IMEI', value: IMEI, unitId }],
      });
      expect(premier.results[0]?.granted).toBe(true);

      const second = store.claim({
        shopId: BOUTIQUE_B,
        deviceId: 'd2',
        identifiers: [{ kind: 'IMEI', value: IMEI, unitId: newId() }],
      });
      expect(second.results[0]?.granted).toBe(false);
      expect(second.results[0]?.heldByShopId).toBe(BOUTIQUE_A);
    });
  });
});

/* ─── Cloisonnement, journal et sauvegarde ─────────────────────────────── */

const BOUTIQUE_C = 'shop-c';

function transfert(
  shopId: string,
  type: string,
  transferId: string,
  parties?: { fromShopId?: string; toShopId?: string },
): SyncEvent {
  return evenement(shopId, {
    type: type as SyncEvent['type'],
    entity: 'transfer',
    entityId: transferId,
    payload: { transferId, ...parties },
  });
}

describe('cloisonnement entre boutiques', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore(':memory:');
    for (const [id, code, nom] of [
      [BOUTIQUE_A, 'CENT', 'Centre'],
      [BOUTIQUE_B, 'NORD', 'Nord'],
      [BOUTIQUE_C, 'TMV', 'Tamatave'],
    ] as const) {
      store.registerShop({ id, code, name: nom, token: `jeton-${code}` });
    }
  });

  const lire = (shopId: string, since = 0) =>
    store.pull({ shopId, deviceId: `poste-${shopId}`, since });

  it('distribue le catalogue à tout le monde', () => {
    // Sans lui, un colis arriverait avec des articles inconnus et un prix vide.
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: [evenement(BOUTIQUE_A)] });
    expect(lire(BOUTIQUE_B).events).toHaveLength(1);
    expect(lire(BOUTIQUE_C).events).toHaveLength(1);
  });

  it("ne distribue à personne les entrées de stock d'une boutique", () => {
    store.push({
      shopId: BOUTIQUE_A,
      deviceId: 'p',
      events: [reception(BOUTIQUE_A, '353879100000018')],
    });
    expect(lire(BOUTIQUE_B).events).toHaveLength(0);
    expect(lire(BOUTIQUE_C).events).toHaveLength(0);
  });

  it("ne distribue un colis qu'à ses deux boutiques", () => {
    const colis = newId();
    store.push({
      shopId: BOUTIQUE_A,
      deviceId: 'p',
      events: [
        transfert(BOUTIQUE_A, 'STOCK_TRANSFER_REQUESTED', colis, {
          fromShopId: BOUTIQUE_A,
          toShopId: BOUTIQUE_B,
        }),
      ],
    });

    expect(lire(BOUTIQUE_B).events).toHaveLength(1);
    // Tamatave n'a rien à savoir d'un colis qui ne la regarde pas.
    expect(lire(BOUTIQUE_C).events).toHaveLength(0);
  });

  it("distribue l'accusé de réception à l'expéditeur, qui n'est pas nommé dedans", () => {
    // Les événements de fin de course ne répètent pas les deux boutiques : sans
    // la trace des parties, l'expéditeur manquerait l'accusé de réception de sa
    // propre marchandise.
    const colis = newId();
    store.push({
      shopId: BOUTIQUE_A,
      deviceId: 'p',
      events: [
        transfert(BOUTIQUE_A, 'STOCK_TRANSFER_SHIPPED', colis, {
          fromShopId: BOUTIQUE_A,
          toShopId: BOUTIQUE_B,
        }),
      ],
    });
    const apres = lire(BOUTIQUE_A).serverSeq;

    store.push({
      shopId: BOUTIQUE_B,
      deviceId: 'p',
      events: [transfert(BOUTIQUE_B, 'STOCK_TRANSFER_RECEIVED', colis)],
    });

    expect(lire(BOUTIQUE_A, apres).events).toHaveLength(1);
    expect(lire(BOUTIQUE_C, apres).events).toHaveLength(0);
  });

  it('renvoie jusqu’où il a regardé, même sans rien à distribuer', () => {
    /*
     * Sans ce repère, une boutique redemanderait éternellement la même portion
     * du journal : elle ne peut plus déduire sa position du dernier événement
     * reçu, puisqu'on lui en cache.
     */
    store.push({
      shopId: BOUTIQUE_A,
      deviceId: 'p',
      events: [reception(BOUTIQUE_A, '353879100000018'), reception(BOUTIQUE_A, '353879100000026')],
    });

    const lot = lire(BOUTIQUE_C);
    expect(lot.events).toHaveLength(0);
    expect(lot.nextSince).toBe(lot.serverSeq);
    expect(lot.nextSince).toBeGreaterThan(0);
  });

  it('ne dépasse jamais le rang qu’il a annoncé', () => {
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: [evenement(BOUTIQUE_A)] });
    const lot = store.pull({ shopId: BOUTIQUE_B, deviceId: 'p', since: 0, limit: 1 });
    expect(lot.nextSince).toBeLessThanOrEqual(lot.serverSeq);
    for (const event of lot.events) expect(event.seq).toBeLessThanOrEqual(lot.nextSince ?? 0);
  });
});

describe('journal de consultation', () => {
  let store: SyncStore;

  beforeEach(() => {
    store = new SyncStore(':memory:');
    store.registerShop({ id: BOUTIQUE_A, code: 'CENT', name: 'Centre', token: 'jeton-a' });
    store.registerShop({ id: BOUTIQUE_B, code: 'NORD', name: 'Nord', token: 'jeton-b' });
  });

  it('rend les derniers événements, du plus récent au plus ancien', () => {
    store.push({
      shopId: BOUTIQUE_A,
      deviceId: 'p',
      events: [evenement(BOUTIQUE_A), evenement(BOUTIQUE_A)],
    });
    const journal = store.journal();
    expect(journal).toHaveLength(2);
    expect(journal[0]!.seq).toBeGreaterThan(journal[1]!.seq);
  });

  it('nomme la boutique plutôt que son identifiant', () => {
    // C'est une page qu'on ouvre en urgence : un UUID n'aide personne.
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: [evenement(BOUTIQUE_A)] });
    expect(store.journal()[0]!.shopLabel).toBe('Centre (CENT)');
  });

  it('se filtre par boutique', () => {
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: [evenement(BOUTIQUE_A)] });
    store.push({ shopId: BOUTIQUE_B, deviceId: 'p', events: [evenement(BOUTIQUE_B)] });
    expect(store.journal({ shopId: BOUTIQUE_B })).toHaveLength(1);
  });

  it('montre où chaque poste en est de sa lecture', () => {
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: [evenement(BOUTIQUE_A)] });
    store.pull({ shopId: BOUTIQUE_B, deviceId: 'poste-nord-1', since: 0 });

    const postes = store.cursors();
    const nord = postes.find((poste) => poste.deviceId === 'poste-nord-1');
    expect(nord?.shopLabel).toBe('Nord (NORD)');
    expect(nord?.lastSeq).toBeGreaterThan(0);
  });

  it('borne ce qu’il rend, pour ne pas charger un journal entier', () => {
    const evenements = Array.from({ length: 20 }, () => evenement(BOUTIQUE_A));
    store.push({ shopId: BOUTIQUE_A, deviceId: 'p', events: evenements });
    expect(store.journal({ limit: 5 })).toHaveLength(5);
    expect(store.journal({ limit: 10_000 }).length).toBeLessThanOrEqual(500);
  });
});
