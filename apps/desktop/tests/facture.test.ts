import { beforeEach, describe, expect, it } from 'vitest';
import { InvoiceService } from '@/core/services/invoice.service';
import { SaleService } from '@/core/services/sale.service';
import { StockService } from '@/core/services/stock.service';
import { CustomerRepository } from '@/core/db/repositories/customer.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { SettingRepository, SETTING_KEYS } from '@/core/db/repositories/setting.repository';
import { contextFor } from './helpers/context';
import { imeiSeries, seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * De la base au document imprimé.
 *
 * Le PDF lui-même est éprouvé dans `@boutique/facture`, sur un modèle construit
 * à la main. Ce qui se joue ici est la COUTURE : qu'un NIF saisi dans les
 * paramètres arrive jusqu'à la facture, qu'un client professionnel y figure
 * avec le sien, que les règlements portent le nom du moyen et non son code.
 * C'est la partie qui se casse en silence — le document se produit quand même,
 * simplement il lui manque ce qui le rend valable.
 */
describe('réglages de facture', () => {
  it('font l’aller-retour par la base sans se déformer', async () => {
    const fixture = await seedFixture();
    const depot = new SettingRepository(fixture.db);
    const mentions = [
      { libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' },
      { libelle: 'Mvola', valeur: '034 12 345 67' },
    ];

    await depot.set(SETTING_KEYS.invoiceMentions, mentions, fixture.shopA);
    await depot.set(SETTING_KEYS.invoiceFooter, 'TVA non applicable.', fixture.shopA);

    const relus = await depot.load(fixture.shopA);
    expect(relus.invoiceMentions).toEqual(mentions);
    expect(relus.invoiceFooter).toBe('TVA non applicable.');
  });
});

describe('facture imprimée', () => {
  let fixture: Fixture;
  let context: AppContext;
  let invoiceId: string;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);

    await new ShopRepository(fixture.db).update(fixture.shopA, {
      nif: '3000123456',
      stat: '47120 11 2019 0 12345',
      address: 'Analamahitsy, Antananarivo',
    });

    const clientId = await new CustomerRepository(fixture.db).create({
      lastName: 'Rakoto & Fils',
      nif: '3000987654',
      stat: '46900 11 2020 0 54321',
      address: 'Ampefiloha',
      shopId: fixture.shopA,
    });

    const stock = new StockService(context);
    const unites = await stock.receiveUnits({
      productId: fixture.phone,
      units: imeiSeries(1).map((value) => ({ imei1: value, costPrice: 2_400_000 })),
    });

    context = await contextFor(fixture.db, fixture.adminId, {
      settings: {
        invoiceMentions: [{ libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' }],
        invoiceFooter: 'TVA non applicable.',
      },
    });
    const vente = await new SaleService(context).checkout({
      customerId: clientId,
      lines: [{ productId: fixture.phone, unitId: unites[0], quantity: 1 }],
      payments: [{ method: 'CASH', amount: 3_000_000 }],
    });

    const facture = await new InvoiceService(context).issueForSale(vente.saleId);
    invoiceId = facture.id;
  });

  it('porte les identifiants fiscaux des deux parties', async () => {
    const document = await new InvoiceService(context).documentFacture(invoiceId);

    expect(document.emetteur.nif).toBe('3000123456');
    expect(document.emetteur.stat).toBe('47120 11 2019 0 12345');
    expect(document.destinataire?.nif).toBe('3000987654');
    expect(document.destinataire?.stat).toBe('46900 11 2020 0 54321');
  });

  it('reprend les mentions libres et le pied de la boutique', async () => {
    const document = await new InvoiceService(context).documentFacture(invoiceId);

    expect(document.mentions).toEqual([{ libelle: 'RCS', valeur: 'Antananarivo 2019 B 00123' }]);
    expect(document.piedDePage).toBe('TVA non applicable.');
  });

  it('nomme les moyens de règlement plutôt que d’en donner le code', async () => {
    const document = await new InvoiceService(context).documentFacture(invoiceId);

    expect(document.reglements).toHaveLength(1);
    // « CASH » sur une facture remise à un client ne veut rien dire.
    expect(document.reglements[0]?.moyen).not.toBe('CASH');
    expect(document.reglements[0]?.moyen).toBeTruthy();
  });

  it('recopie l’IMEI sur la ligne facturée', async () => {
    const document = await new InvoiceService(context).documentFacture(invoiceId);

    expect(document.lignes).toHaveLength(1);
    expect(document.lignes[0]?.identifiant).toMatch(/^\d{15}$/);
  });

  it('produit un fichier PDF', async () => {
    // Le contenu du PDF est éprouvé dans `@boutique/facture`, qui le relit
    // page par page. Ici on vérifie seulement que la chaîne va jusqu'au bout
    // et rend un fichier qu'un lecteur acceptera d'ouvrir.
    const octets = await new InvoiceService(context).pdf(invoiceId);

    expect(Buffer.from(octets.slice(0, 5)).toString()).toBe('%PDF-');
    expect(octets.byteLength).toBeGreaterThan(1_000);
  });

  it('accepte une facture sans client', async () => {
    const stock = new StockService(context);
    await stock.receiveQuantity({ productId: fixture.cable, quantity: 5 });
    const vente = await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 100_000 }],
    });
    const facture = await new InvoiceService(context).issueForSale(vente.saleId);

    const document = await new InvoiceService(context).documentFacture(facture.id);
    expect(document.destinataire).toBeNull();
    await expect(new InvoiceService(context).pdf(facture.id)).resolves.toBeInstanceOf(Uint8Array);
  });
});
