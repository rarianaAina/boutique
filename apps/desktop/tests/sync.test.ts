import { SyncTransportError } from '@boutique/shared';
import { describe, expect, it } from 'vitest';
import { StockService } from '@/core/services/stock.service';
import { TransferService } from '@/core/services/transfer.service';
import { ProductService } from '@/core/services/catalog.service';
import { SaleService } from '@/core/services/sale.service';
import { SyncEngine } from '@/core/sync/engine';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { imeiSeries } from './helpers/fixtures';
import { createNetwork, type Network, type ShopNode } from './helpers/network';

/**
 * Synchronisation entre deux boutiques — priorité n°8 des tests (§30).
 *
 * Chaque boutique a sa PROPRE base ; le serveur est le vrai, en mémoire. Ce qui
 * n'a pas été synchronisé n'existe donc réellement pas chez le voisin, et
 * l'idempotence est vérifiée contre le mécanisme qui tournera en production.
 */

const sync = (node: ShopNode) => new SyncEngine(node.context, node.transport, node.deviceId).run();

/** Produit identique dans les deux bases, comme après un partage de catalogue. */
async function seedCatalog(network: Network): Promise<string> {
  const productId = await new ProductService(network.a.context).create({
    sku: 'IPH15-128',
    name: 'iPhone 15 128 Go',
    brand: 'Apple',
    tracking: 'IMEI',
    purchasePrice: 2_400_000,
    salePrice: 2_950_000,
  });
  await sync(network.a);
  await sync(network.b);
  return productId;
}

describe('synchronisation', () => {
  it('partage le catalogue entre les deux boutiques', async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      const chezB = await new ProductRepository(network.b.db).byId(productId);
      expect(chezB?.name).toBe('iPhone 15 128 Go');
      expect(chezB?.salePrice).toBe(2_950_000);
    } finally {
      network.close();
    }
  });

  it('propage une modification de prix', async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      await new ProductService(network.a.context).update(productId, {
        sku: 'IPH15-128',
        name: 'iPhone 15 128 Go',
        brand: 'Apple',
        tracking: 'IMEI',
        purchasePrice: 2_400_000,
        salePrice: 2_750_000,
      });
      await sync(network.a);
      await sync(network.b);

      expect((await new ProductRepository(network.b.db).byId(productId))?.salePrice).toBe(
        2_750_000,
      );
    } finally {
      network.close();
    }
  });

  it('ne montre PAS à une boutique les appareils d’une autre', async () => {
    // Cloisonnement voulu : une boutique ne connaît que ses appareils et ceux
    // qu'on lui expédie. Elle les découvrira à l'expédition, qui porte la
    // fiche complète de chaque appareil du colis.
    //
    // Ce qui n'en dépend PAS : l'unicité de l'IMEI. C'est le serveur qui tient
    // le registre de détention, et l'épreuve suivante le vérifie.
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      const imei = imeiSeries(2);
      await new StockService(network.a.context).receiveUnits({
        productId,
        units: imei.map((value) => ({ imei1: value })),
      });
      await sync(network.a);
      const resultat = await sync(network.b);

      expect(await new UnitRepository(network.b.db).byIdentifier(imei[0]!)).toBeNull();
      // Écartés, et non « en échec » : rien n'est à corriger.
      expect(resultat.applied.ignored).toBeGreaterThan(0);
      expect(resultat.applied.failed).toBe(0);
    } finally {
      network.close();
    }
  });

  it('réplique le catalogue, sans lequel un transfert arriverait vide', async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      await new StockService(network.a.context).receiveUnits({
        productId,
        units: imeiSeries(1).map((value) => ({ imei1: value })),
      });
      await sync(network.a);
      await sync(network.b);

      const produit = await new ProductRepository(network.b.db).byId(productId);
      expect(produit).not.toBeNull();
    } finally {
      network.close();
    }
  });

  it('refuse le même IMEI déclaré par deux boutiques', async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      const [value] = imeiSeries(1);

      await new StockService(network.a.context).receiveUnits({
        productId,
        units: [{ imei1: value }],
      });
      await sync(network.a);

      // B saisit le même IMEI hors ligne : localement rien ne l'en empêche,
      // c'est le serveur qui tranche à la synchronisation.
      await new StockService(network.b.context).receiveUnits({
        productId,
        units: [{ imei1: value }],
      });
      const outcome = await sync(network.b);

      expect(outcome.rejected).toBe(1);
      const conflicts = await network.b.db.select<{ last_error: string }>(
        "SELECT last_error FROM sync_outbox WHERE status = 'CONFLICT'",
      );
      expect(conflicts[0]?.last_error).toContain('déjà détenu');
    } finally {
      network.close();
    }
  });

  it("n'applique jamais deux fois le même événement", async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      await new StockService(network.a.context).receiveUnits({
        productId,
        units: imeiSeries(3).map((value) => ({ imei1: value })),
      });
      await sync(network.a);

      const first = await sync(network.b);
      const second = await sync(network.b);
      const third = await sync(network.b);

      // Les trois appareils de A sont écartés une fois, et une seule : le
      // curseur avance sur eux, sinon on les réexaminerait à chaque
      // synchronisation, indéfiniment.
      expect(first.applied.ignored).toBe(3);
      expect(second.applied.ignored).toBe(0);
      expect(third.applied.ignored).toBe(0);
      expect(second.pulled).toBe(0);
      expect(third.pulled).toBe(0);

      // Aucun appareil de A chez B, et surtout aucun doublon : le curseur a
      // bien avancé sur les événements écartés.
      const units = await network.b.db.select<{ total: number }>(
        'SELECT COUNT(*) AS total FROM product_unit',
      );
      expect(units[0]?.total).toBe(0);
    } finally {
      network.close();
    }
  });

  it('reconnaît un renvoi comme un doublon plutôt que comme une erreur', async () => {
    const network = await createNetwork();
    try {
      await seedCatalog(network);
      // On remet la file en attente : c'est ce qui se passe quand la réponse du
      // serveur se perd après qu'il a appliqué l'envoi.
      await network.a.db.execute("UPDATE sync_outbox SET status = 'PENDING', sent_at = NULL");
      const outcome = await sync(network.a);

      expect(outcome.duplicates).toBeGreaterThan(0);
      expect(outcome.rejected).toBe(0);
    } finally {
      network.close();
    }
  });

  describe('transfert de bout en bout', () => {
    it("porte l'appareil d'une boutique à l'autre", async () => {
      const network = await createNetwork();
      try {
        const productId = await seedCatalog(network);
        const imei = imeiSeries(1);
        const [unitId] = await new StockService(network.a.context).receiveUnits({
          productId,
          units: [{ imei1: imei[0] }],
        });

        const outbound = new TransferService(network.a.context);
        const { transferId } = await outbound.request({
          toShopId: network.b.shopId,
          lines: [{ productId, unitId, label: '', quantity: 1 }],
        });
        await outbound.approve(transferId);
        await outbound.ship(transferId);

        // Avant synchronisation, B ne sait rien du colis.
        expect(await new TransferRepository(network.b.db).byId(transferId)).toBeNull();

        await sync(network.a);
        await sync(network.b);

        const chezB = await new TransferRepository(network.b.db).byId(transferId);
        expect(chezB?.status).toBe('SHIPPED');
        const unitChezB = await new UnitRepository(network.b.db).byIdentifier(imei[0]!);
        expect(unitChezB?.status).toBe('IN_TRANSFER');
        // Le colis roule : l'appareil reste rattaché à l'expéditeur.
        expect(unitChezB?.shopId).toBe(network.a.shopId);

        // B ouvre le colis.
        await new TransferService(network.b.context).receive(transferId);
        const recu = await new UnitRepository(network.b.db).byIdentifier(imei[0]!);
        expect(recu?.status).toBe('IN_STOCK');
        expect(recu?.shopId).toBe(network.b.shopId);

        // A l'apprend à sa prochaine synchronisation.
        await sync(network.b);
        await sync(network.a);

        const chezA = await new UnitRepository(network.a.db).byId(unitId!);
        expect(chezA?.shopId).toBe(network.b.shopId);
        expect(chezA?.status).toBe('IN_STOCK');
        expect((await new TransferRepository(network.a.db).byId(transferId))?.status).toBe(
          'RECEIVED',
        );

        // L'historique de l'appareil est complet depuis les DEUX bases.
        const historiqueA = await new StockRepository(network.a.db).unitHistory(unitId!);
        expect(historiqueA.map((movement) => movement.type)).toEqual([
          'PURCHASE_RECEIPT',
          'TRANSFER_OUT',
          'TRANSFER_IN',
        ]);
      } finally {
        network.close();
      }
    });

    it("permet à la destination de vendre ce qu'elle a reçu", async () => {
      const network = await createNetwork();
      try {
        const productId = await seedCatalog(network);
        const imei = imeiSeries(1);
        const [unitId] = await new StockService(network.a.context).receiveUnits({
          productId,
          units: [{ imei1: imei[0] }],
        });

        const outbound = new TransferService(network.a.context);
        const { transferId } = await outbound.request({
          toShopId: network.b.shopId,
          lines: [{ productId, unitId, label: '', quantity: 1 }],
        });
        await outbound.approve(transferId);
        await outbound.ship(transferId);
        await sync(network.a);
        await sync(network.b);
        await new TransferService(network.b.context).receive(transferId);

        const vente = await new SaleService(network.b.context).checkout({
          lines: [{ productId, unitId, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 3_000_000 }],
        });
        expect(vente.total).toBe(2_950_000);

        // Et A ne peut plus la vendre, une fois informée.
        await sync(network.b);
        await sync(network.a);
        await expect(
          new SaleService(network.a.context).checkout({
            lines: [{ productId, unitId, quantity: 1 }],
            payments: [{ method: 'CASH', amount: 3_000_000 }],
          }),
        ).rejects.toThrow(/autre boutique|pas disponible/i);
      } finally {
        network.close();
      }
    });

    it('rend la marchandise quand la destination refuse', async () => {
      const network = await createNetwork();
      try {
        const productId = await seedCatalog(network);
        const imei = imeiSeries(1);
        const [unitId] = await new StockService(network.a.context).receiveUnits({
          productId,
          units: [{ imei1: imei[0] }],
        });
        const outbound = new TransferService(network.a.context);
        const { transferId } = await outbound.request({
          toShopId: network.b.shopId,
          lines: [{ productId, unitId, label: '', quantity: 1 }],
        });
        await outbound.approve(transferId);
        await outbound.ship(transferId);
        await sync(network.a);
        await sync(network.b);

        await new TransferService(network.b.context).reject(transferId, 'écran fissuré');
        await sync(network.b);
        await sync(network.a);

        const chezA = await new UnitRepository(network.a.db).byId(unitId!);
        expect(chezA?.status).toBe('IN_STOCK');
        expect(chezA?.shopId).toBe(network.a.shopId);
        expect((await new TransferRepository(network.a.db).byId(transferId))?.status).toBe(
          'REJECTED',
        );
      } finally {
        network.close();
      }
    });
  });

  it('laisse la boutique travailler quand le serveur est injoignable', async () => {
    const network = await createNetwork();
    try {
      const productId = await seedCatalog(network);
      const panne = {
        push: () => Promise.reject(new SyncTransportError('coupure')),
        pull: () => Promise.reject(new Error('inutilisé')),
        claim: () => Promise.reject(new Error('inutilisé')),
      };
      const engine = new SyncEngine(network.a.context, panne as never, network.a.deviceId);

      await new StockService(network.a.context).receiveUnits({
        productId,
        units: imeiSeries(1).map((value) => ({ imei1: value })),
      });

      const outcome = await engine.run();
      expect(outcome.transportError).toContain('coupure');

      // Rien n'est perdu : la file reste en attente pour le prochain essai.
      const snapshot = await engine.snapshot();
      expect(snapshot.pending.PENDING).toBeGreaterThan(0);
    } finally {
      network.close();
    }
  });
});
