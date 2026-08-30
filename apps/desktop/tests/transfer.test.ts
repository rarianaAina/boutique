import { beforeEach, describe, expect, it } from 'vitest';
import { TransferService } from '@/core/services/transfer.service';
import { StockService } from '@/core/services/stock.service';
import { SaleService } from '@/core/services/sale.service';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Transferts inter-boutiques (§17) — priorité n°7 des tests (§30).
 *
 * Les deux boutiques vivent ici dans la MÊME base : c'est ce que verra la base
 * du destinataire une fois la synchronisation passée. La règle « seule la
 * destination réceptionne » est donc bien vérifiée, avec deux contextes
 * différents.
 */
describe('transferts', () => {
  let fixture: Fixture;
  let source: AppContext;
  let destination: AppContext;
  let unitIds: string[];
  let imei: string[];

  beforeEach(async () => {
    fixture = await seedFixture();
    source = await contextFor(fixture.db, fixture.adminId);

    // Un administrateur rattaché à la boutique Nord : c'est lui qui réceptionne.
    const adminRole = await new RoleRepository(fixture.db).byCode('ADMIN');
    const nordAdmin = await new UserRepository(fixture.db).create(
      {
        shopId: fixture.shopB,
        fullName: 'Fara Nord',
        login: 'fara',
        roleId: adminRole!.id,
      },
      'pbkdf2-sha256$1$c2Vs$ZW1wcmVpbnRl',
    );
    destination = await contextFor(fixture.db, nordAdmin);

    imei = imeiSeries(3);
    const stock = new StockService(source);
    unitIds = await stock.receiveUnits({
      productId: fixture.phone,
      units: imei.map((value) => ({ imei1: value })),
    });
    await stock.receiveQuantity({ productId: fixture.cable, quantity: 40 });
  });

  const requestPhone = async (index = 0) =>
    new TransferService(source).request({
      toShopId: fixture.shopB,
      lines: [{ productId: fixture.phone, unitId: unitIds[index], label: '', quantity: 1 }],
    });

  it("réserve l'appareil dès la demande", async () => {
    const { number } = await requestPhone();
    expect(number).toMatch(/^TR-CENT-\d{4}-0001$/);

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('RESERVED');
    expect(unit?.shopId).toBe(fixture.shopA);
  });

  it("empêche de vendre un appareil déjà promis à l'autre boutique", async () => {
    await requestPhone();
    await expect(
      new SaleService(source).checkout({
        lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
        payments: [{ method: 'CASH', amount: 2_950_000 }],
      }),
    ).rejects.toThrow(/pas disponible/i);
  });

  it("laisse l'appareil chez l'expéditeur pendant le transport", async () => {
    const { transferId } = await requestPhone();
    const service = new TransferService(source);
    await service.approve(transferId);
    await service.ship(transferId);

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('IN_TRANSFER');
    // Tant que le colis roule, l'appareil reste sous la responsabilité de
    // l'expéditeur : un colis égaré ne doit disparaître d'aucun stock.
    expect(unit?.shopId).toBe(fixture.shopA);
  });

  it("change la boutique de l'appareil à la réception", async () => {
    const { transferId } = await requestPhone();
    const outbound = new TransferService(source);
    await outbound.approve(transferId);
    await outbound.ship(transferId);
    await new TransferService(destination).receive(transferId);

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('IN_STOCK');
    expect(unit?.shopId).toBe(fixture.shopB);
    expect(unit?.transferId).toBeNull();

    const transfer = await new TransferRepository(fixture.db).byId(transferId);
    expect(transfer?.status).toBe('RECEIVED');

    const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
    expect(history.map((movement) => movement.type)).toEqual([
      'PURCHASE_RECEIPT',
      'TRANSFER_OUT',
      'TRANSFER_IN',
    ]);
  });

  it("refuse qu'une autre boutique que la destination réceptionne", async () => {
    const { transferId } = await requestPhone();
    const outbound = new TransferService(source);
    await outbound.approve(transferId);
    await outbound.ship(transferId);

    await expect(outbound.receive(transferId)).rejects.toThrow(/destinataire/i);
  });

  it('ne réceptionne pas deux fois le même transfert', async () => {
    const { transferId } = await requestPhone();
    const outbound = new TransferService(source);
    await outbound.approve(transferId);
    await outbound.ship(transferId);

    const inbound = new TransferService(destination);
    await inbound.receive(transferId);
    await expect(inbound.receive(transferId)).rejects.toThrow(/statut/i);

    // Une seule entrée en stock, pas deux.
    const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
    expect(history.filter((movement) => movement.type === 'TRANSFER_IN')).toHaveLength(1);
  });

  it('refuse de transférer un appareil déjà vendu', async () => {
    await new SaleService(source).checkout({
      lines: [{ productId: fixture.phone, unitId: unitIds[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 2_950_000 }],
    });
    await expect(requestPhone(0)).rejects.toThrow(/indisponible/i);
  });

  it('refuse un transfert vers la boutique elle-même', async () => {
    await expect(
      new TransferService(source).request({
        toShopId: fixture.shopA,
        lines: [{ productId: fixture.phone, unitId: unitIds[0], label: '', quantity: 1 }],
      }),
    ).rejects.toThrow(/différente/i);
  });

  it("libère la réservation à l'annulation", async () => {
    const { transferId } = await requestPhone();
    await new TransferService(source).cancel(transferId, 'plus nécessaire');

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('IN_STOCK');
    expect((await new TransferRepository(fixture.db).byId(transferId))?.status).toBe('CANCELLED');
  });

  it("rend la marchandise à l'expéditeur quand la destination refuse", async () => {
    const { transferId } = await requestPhone();
    const outbound = new TransferService(source);
    await outbound.approve(transferId);
    await outbound.ship(transferId);
    await new TransferService(destination).reject(transferId, 'colis endommagé');

    const unit = await new UnitRepository(fixture.db).byId(unitIds[0]!);
    expect(unit?.status).toBe('IN_STOCK');
    expect(unit?.shopId).toBe(fixture.shopA);

    const history = await new StockRepository(fixture.db).unitHistory(unitIds[0]!);
    expect(history.map((movement) => movement.type)).toEqual([
      'PURCHASE_RECEIPT',
      'TRANSFER_OUT',
      'TRANSFER_IN',
    ]);
  });

  describe('produits par quantité', () => {
    it("déplace le stock d'une boutique à l'autre", async () => {
      const outbound = new TransferService(source);
      const { transferId } = await outbound.request({
        toShopId: fixture.shopB,
        lines: [{ productId: fixture.cable, label: '', quantity: 15 }],
      });

      const stock = new StockRepository(fixture.db);
      // Réservé, mais pas encore sorti.
      expect(await stock.levelOf(fixture.cable, fixture.shopA)).toEqual({
        quantity: 40,
        reserved: 15,
      });

      await outbound.approve(transferId);
      await outbound.ship(transferId);
      expect(await stock.levelOf(fixture.cable, fixture.shopA)).toEqual({
        quantity: 25,
        reserved: 0,
      });

      await new TransferService(destination).receive(transferId);
      expect((await stock.levelOf(fixture.cable, fixture.shopB)).quantity).toBe(15);
    });

    it('refuse de transférer plus que le stock disponible', async () => {
      await expect(
        new TransferService(source).request({
          toShopId: fixture.shopB,
          lines: [{ productId: fixture.cable, label: '', quantity: 60 }],
        }),
      ).rejects.toThrow(/stock insuffisant/i);
    });

    it('accepte une réception partielle et reste en transit', async () => {
      const outbound = new TransferService(source);
      const { transferId } = await outbound.request({
        toShopId: fixture.shopB,
        lines: [{ productId: fixture.cable, label: '', quantity: 10 }],
      });
      await outbound.approve(transferId);
      await outbound.ship(transferId);

      const lines = await new TransferRepository(fixture.db).lines(transferId);
      const inbound = new TransferService(destination);
      await inbound.receive(transferId, [{ lineId: lines[0]!.id, quantity: 6 }]);

      expect((await new TransferRepository(fixture.db).byId(transferId))?.status).toBe(
        'IN_TRANSIT',
      );
      await inbound.receive(transferId, [{ lineId: lines[0]!.id, quantity: 4 }]);
      expect((await new TransferRepository(fixture.db).byId(transferId))?.status).toBe('RECEIVED');
      expect(
        (await new StockRepository(fixture.db).levelOf(fixture.cable, fixture.shopB)).quantity,
      ).toBe(10);
    });

    it('refuse de recevoir plus que ce qui a été expédié', async () => {
      const outbound = new TransferService(source);
      const { transferId } = await outbound.request({
        toShopId: fixture.shopB,
        lines: [{ productId: fixture.cable, label: '', quantity: 5 }],
      });
      await outbound.approve(transferId);
      await outbound.ship(transferId);
      const lines = await new TransferRepository(fixture.db).lines(transferId);

      await expect(
        new TransferService(destination).receive(transferId, [
          { lineId: lines[0]!.id, quantity: 9 },
        ]),
      ).rejects.toThrow(/9 reçus pour 5 attendus/);
    });
  });

  it('dépose un événement pour chaque étape du cycle', async () => {
    const { transferId } = await requestPhone();
    const outbound = new TransferService(source);
    await outbound.approve(transferId);
    await outbound.ship(transferId);
    await new TransferService(destination).receive(transferId);

    const events = await fixture.db.select<{ type: string }>(
      "SELECT type FROM sync_outbox WHERE entity = 'transfer' ORDER BY rowid",
    );
    expect(events.map((event) => event.type)).toEqual([
      'STOCK_TRANSFER_REQUESTED',
      'STOCK_TRANSFER_APPROVED',
      'STOCK_TRANSFER_SHIPPED',
      'STOCK_TRANSFER_RECEIVED',
    ]);
  });
});
