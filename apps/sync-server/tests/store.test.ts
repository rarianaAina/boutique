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
