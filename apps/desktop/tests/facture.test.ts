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
 * Le PDF lui-même est éprouvé dans `@boutique/documents`, sur un modèle construit
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
    // Le contenu du PDF est éprouvé dans `@boutique/documents`, qui le relit
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

describe('les options traversent vraiment la base', () => {
  /**
   * LE TROU QUE CETTE ÉPREUVE BOUCHE. Les autres construisent le contexte à la
   * main, avec des réglages passés directement : elles vérifient que le
   * service les respecte, jamais qu'ils survivent à l'aller-retour par la
   * base. Un réglage enregistré mais mal relu donnerait un aperçu et un PDF
   * différents — et c'est arrivé.
   */
  it('un réglage enregistré est celui que la facture applique', async () => {
    const fixture = await seedFixture();
    const depart = await contextFor(fixture.db, fixture.adminId);

    await new ShopRepository(fixture.db).update(fixture.shopA, {
      nif: '3000123456',
      stat: '47120',
    });
    const depot = new SettingRepository(fixture.db);
    await new StockService(depart).receiveQuantity({ productId: fixture.cable, quantity: 5 });
    const vente = await new SaleService(depart).checkout({
      lines: [{ productId: fixture.cable, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 100_000 }],
    });
    const facture = await new InvoiceService(depart).issueForSale(vente.saleId);

    /** Ce que fait la session : enregistrer, puis relire comme au démarrage. */
    const apres = async (valeur: boolean) => {
      await depot.set(SETTING_KEYS.invoiceShowIdentifiers, valeur, fixture.shopA);
      const relus = await depot.load(fixture.shopA);
      const contexte = await contextFor(fixture.db, fixture.adminId, { settings: relus });
      return new InvoiceService(contexte).documentFacture(facture.id);
    };

    expect((await apres(true)).emetteur.nif).toBe('3000123456');
    expect((await apres(false)).emetteur.nif).toBeNull();
    expect((await apres(true)).emetteur.nif).toBe('3000123456');
  });

  it('le logo enregistré traverse la base sans se déformer', async () => {
    const fixture = await seedFixture();
    const depot = new SettingRepository(fixture.db);
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    await depot.set(SETTING_KEYS.invoiceLogo, image, fixture.shopA);
    await depot.set(SETTING_KEYS.invoiceShowLogo, true, fixture.shopA);

    const relus = await depot.load(fixture.shopA);
    expect(relus.invoiceLogo).toBe(image);
    expect(relus.invoiceShowLogo).toBe(true);
  });

  it('les libellés de signature traversent la base', async () => {
    const fixture = await seedFixture();
    const depot = new SettingRepository(fixture.db);
    const libelles = { gauche: 'Le gérant', droite: "L'acheteur" };

    await depot.set(SETTING_KEYS.invoiceShowSignatures, true, fixture.shopA);
    await depot.set(SETTING_KEYS.invoiceSignatures, libelles, fixture.shopA);

    const relus = await depot.load(fixture.shopA);
    expect(relus.invoiceShowSignatures).toBe(true);
    expect(relus.invoiceSignatures).toEqual(libelles);
  });
});

describe('options d’impression', () => {
  let fixture: Fixture;
  let invoiceId: string;

  beforeEach(async () => {
    fixture = await seedFixture();
    const base = await contextFor(fixture.db, fixture.adminId);

    await new ShopRepository(fixture.db).update(fixture.shopA, { nif: '3000123456' });
    const clientId = await new CustomerRepository(fixture.db).create({
      lastName: 'Rakoto',
      nif: '3000987654',
      shopId: fixture.shopA,
    });

    await new StockService(base).receiveQuantity({ productId: fixture.cable, quantity: 5 });
    const vente = await new SaleService(base).checkout({
      customerId: clientId,
      lines: [{ productId: fixture.cable, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 100_000 }],
    });
    invoiceId = (await new InvoiceService(base).issueForSale(vente.saleId)).id;
  });

  const documentAvec = async (settings: Parameters<typeof contextFor>[2]) =>
    new InvoiceService(await contextFor(fixture.db, fixture.adminId, settings)).documentFacture(
      invoiceId,
    );

  it('retire les identifiants fiscaux des DEUX parties quand la case est décochée', async () => {
    const avec = await documentAvec({ settings: { invoiceShowIdentifiers: true } });
    expect(avec.emetteur.nif).toBe('3000123456');
    expect(avec.destinataire?.nif).toBe('3000987654');

    const sans = await documentAvec({ settings: { invoiceShowIdentifiers: false } });
    expect(sans.emetteur.nif).toBeNull();
    expect(sans.destinataire?.nif).toBeNull();
  });

  it('n’imprime le logo que si la case est cochée', async () => {
    const image = 'data:image/png;base64,AAAA';

    expect(
      (await documentAvec({ settings: { invoiceLogo: image, invoiceShowLogo: true } })).logo,
    ).toBe(image);
    expect(
      (await documentAvec({ settings: { invoiceLogo: image, invoiceShowLogo: false } })).logo,
    ).toBeNull();
    // Case cochée mais aucune image chargée : rien à imprimer.
    expect(
      (await documentAvec({ settings: { invoiceLogo: '', invoiceShowLogo: true } })).logo,
    ).toBeNull();
  });

  it('n’imprime les cases à signer que si elles sont demandées', async () => {
    const signatures = { gauche: 'Le gérant', droite: "L'acheteur" };

    expect(
      (
        await documentAvec({
          settings: { invoiceShowSignatures: true, invoiceSignatures: signatures },
        })
      ).signatures,
    ).toEqual(signatures);
    expect(
      (
        await documentAvec({
          settings: { invoiceShowSignatures: false, invoiceSignatures: signatures },
        })
      ).signatures,
    ).toBeNull();
  });

  it('reprend les conditions de vente', async () => {
    const document = await documentAvec({
      settings: { invoiceConditions: 'Marchandise vendue non reprise après huit jours.' },
    });
    expect(document.conditions).toBe('Marchandise vendue non reprise après huit jours.');
  });
});
