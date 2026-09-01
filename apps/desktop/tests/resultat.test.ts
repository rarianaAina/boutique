import { CHARGE_CATEGORY, PERMISSIONS } from '@boutique/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ResultatService } from '@/core/services/resultat.service';
import { SaleService } from '@/core/services/sale.service';
import { RefundService } from '@/core/services/refund.service';
import { StockService } from '@/core/services/stock.service';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * Le compte de résultat.
 *
 * Un document qui se trompe EN SILENCE : il sort toujours un nombre, et rien
 * dans sa présentation ne dit s'il est juste. Les épreuves portent donc sur
 * l'arithmétique, cas par cas — une vente simple, une remise, un retour repris
 * en stock, un retour cassé, une vente annulée — puis sur la seule propriété
 * qui les relie toutes : le résultat est la marge moins les charges.
 */

const TOUTE_LA_PERIODE = { du: '2000-01-01', au: '2999-12-31' };

describe('compte de résultat', () => {
  let fixture: Fixture;
  let context: AppContext;

  /**
   * Prix négocié, et coût du câble tel que la fixture le déclare.
   *
   * Le coût vient du CATALOGUE et non du dernier réapprovisionnement : c'est
   * la méthode de valorisation par défaut, et l'épreuve doit tenir compte de
   * ce que le logiciel fait réellement, pas de ce qu'on lui a passé.
   */
  const PRIX = 100_000;
  const COUT = 4_000;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    await new StockService(context).receiveQuantity({ productId: fixture.cable, quantity: 50 });
  });

  const vendre = async (quantite: number, remise = 0) =>
    new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: quantite, unitPrice: PRIX, discount: remise }],
      payments: [{ method: 'CASH', amount: PRIX * quantite - remise }],
    });

  const etablir = () =>
    new ResultatService(context).etablir(TOUTE_LA_PERIODE.du, TOUTE_LA_PERIODE.au);

  it('compte une vente simple : produit, coût, marge', async () => {
    await vendre(2);
    const compte = await etablir();

    expect(compte.ventes).toBe(2 * PRIX);
    expect(compte.chiffreAffairesNet).toBe(2 * PRIX);
    expect(compte.coutMarchandises).toBe(2 * COUT);
    expect(compte.margeBrute).toBe(2 * (PRIX - COUT));
    expect(compte.nombreVentes).toBe(1);
  });

  it('déduit la remise accordée sur le ticket', async () => {
    await vendre(2, 20_000);
    const compte = await etablir();

    expect(compte.remises).toBe(20_000);
    expect(compte.chiffreAffairesNet).toBe(2 * PRIX - 20_000);
    // La remise sort de la marge, pas du coût : la marchandise a coûté pareil.
    expect(compte.coutMarchandises).toBe(2 * COUT);
    expect(compte.margeBrute).toBe(2 * (PRIX - COUT) - 20_000);
  });

  it('ignore entièrement une vente annulée', async () => {
    const vente = await vendre(3);
    await new SaleService(context).cancel(vente.saleId, 'Erreur de saisie');

    const compte = await etablir();
    expect(compte.ventes).toBe(0);
    expect(compte.coutMarchandises).toBe(0);
    expect(compte.nombreVentes).toBe(0);
  });

  it('rend le coût d’un article repris en stock', async () => {
    const vente = await vendre(2);
    const lignes = (await new SaleRepository(fixture.db).detail(vente.saleId))?.lines ?? [];

    await new RefundService(context).refund({
      saleId: vente.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lignes[0]!.id, quantity: 1, restock: true }],
    });

    const compte = await etablir();
    expect(compte.retours).toBe(PRIX);
    expect(compte.chiffreAffairesNet).toBe(PRIX);
    // L'article est revenu : son coût sort du coût des marchandises vendues.
    expect(compte.coutMarchandises).toBe(COUT);
    expect(compte.margeBrute).toBe(PRIX - COUT);
  });

  it('laisse le coût d’un article rendu cassé peser sur le résultat', async () => {
    const vente = await vendre(2);
    const lignes = (await new SaleRepository(fixture.db).detail(vente.saleId))?.lines ?? [];

    await new RefundService(context).refund({
      saleId: vente.saleId,
      method: 'CASH',
      lines: [{ saleLineId: lignes[0]!.id, quantity: 1, restock: false }],
    });

    const compte = await etablir();
    expect(compte.retours).toBe(PRIX);
    expect(compte.chiffreAffairesNet).toBe(PRIX);
    // L'article n'est pas revenu : le commerce a rendu l'argent ET perdu la
    // marchandise. Les deux coûts restent.
    expect(compte.coutMarchandises).toBe(2 * COUT);
    expect(compte.margeBrute).toBe(PRIX - 2 * COUT);
  });

  it('retranche les charges et donne le bénéfice', async () => {
    await vendre(10);
    const service = new ResultatService(context);
    await service.creerCharge({
      category: CHARGE_CATEGORY.rent,
      label: 'Loyer de septembre',
      amount: 300_000,
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    await service.creerCharge({
      category: CHARGE_CATEGORY.utilities,
      label: 'JIRAMA',
      amount: 45_000,
      occurredAt: '2026-09-05T00:00:00.000Z',
    });

    const compte = await etablir();
    expect(compte.margeBrute).toBe(10 * (PRIX - COUT));
    expect(compte.totalCharges).toBe(345_000);
    expect(compte.resultat).toBe(10 * (PRIX - COUT) - 345_000);
    expect(compte.charges.map((ligne) => ligne.categorie)).toEqual(['LOYER', 'ELECTRICITE_EAU']);
  });

  it('annonce une perte quand les charges dépassent la marge', async () => {
    await vendre(1);
    await new ResultatService(context).creerCharge({
      category: CHARGE_CATEGORY.wages,
      label: 'Salaires',
      amount: 500_000,
      occurredAt: '2026-09-30T00:00:00.000Z',
    });

    const compte = await etablir();
    expect(compte.resultat).toBeLessThan(0);
  });

  it('ne retient que les charges de la période', async () => {
    const service = new ResultatService(context);
    await service.creerCharge({
      category: CHARGE_CATEGORY.rent,
      label: 'Loyer de janvier',
      amount: 300_000,
      occurredAt: '2026-01-10T00:00:00.000Z',
    });
    await service.creerCharge({
      category: CHARGE_CATEGORY.rent,
      label: 'Loyer de février',
      amount: 300_000,
      occurredAt: '2026-02-10T00:00:00.000Z',
    });

    const janvier = await service.etablir('2026-01-01', '2026-01-31');
    expect(janvier.totalCharges).toBe(300_000);
    expect(janvier.charges[0]?.nombre).toBe(1);
  });

  it('ne compte pas une charge supprimée', async () => {
    const service = new ResultatService(context);
    const id = await service.creerCharge({
      category: CHARGE_CATEGORY.other,
      label: 'Saisie en double',
      amount: 90_000,
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    expect((await etablir()).totalCharges).toBe(90_000);

    await service.supprimerCharge(id);
    expect((await etablir()).totalCharges).toBe(0);
  });

  it('donne un taux de marge, et zéro plutôt qu’une division par zéro', async () => {
    expect((await etablir()).tauxMarge).toBe(0);

    await vendre(1);
    // 96 000 de marge sur 100 000 de chiffre d'affaires : 96 %.
    expect((await etablir()).tauxMarge).toBe(9_600);
  });

  it('retient une vente du dernier soir de la période', async () => {
    // LE PIÈGE : à Madagascar, trois heures en avance sur UTC, une vente du
    // 30 septembre à 23 h 30 est enregistrée le 30 à 20 h 30 UTC. Une borne de
    // fin mal convertie la ferait basculer dans le mois suivant — ou le
    // contraire — et personne ne s'en apercevrait : les chiffres resteraient
    // plausibles. On construit donc l'instant en heure LOCALE, comme le
    // logiciel le fait au moment de la vente.
    const soir = new Date(2026, 8, 30, 23, 30, 0).toISOString();
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 1, unitPrice: PRIX }],
      payments: [{ method: 'CASH', amount: PRIX }],
      soldAt: soir,
    });

    const septembre = await new ResultatService(context).etablir('2026-09-01', '2026-09-30');
    expect(septembre.nombreVentes).toBe(1);

    const octobre = await new ResultatService(context).etablir('2026-10-01', '2026-10-31');
    expect(octobre.nombreVentes).toBe(0);
  });

  it('retient une vente du premier matin de la période', async () => {
    const matin = new Date(2026, 8, 1, 0, 15, 0).toISOString();
    await new SaleService(context).checkout({
      lines: [{ productId: fixture.cable, quantity: 1, unitPrice: PRIX }],
      payments: [{ method: 'CASH', amount: PRIX }],
      soldAt: matin,
    });

    expect(
      (await new ResultatService(context).etablir('2026-09-01', '2026-09-30')).nombreVentes,
    ).toBe(1);
    expect(
      (await new ResultatService(context).etablir('2026-08-01', '2026-08-31')).nombreVentes,
    ).toBe(0);
  });

  it('refuse une date illisible', async () => {
    await expect(new ResultatService(context).etablir('septembre', '2026-09-30')).rejects.toThrow(
      /illisible/,
    );
  });

  it('refuse un intervalle à l’envers', async () => {
    await expect(new ResultatService(context).etablir('2026-12-31', '2026-01-01')).rejects.toThrow(
      /postérieure/,
    );
  });

  it('refuse la saisie d’une charge à qui n’en a pas le droit', async () => {
    const vendeur = await contextFor(fixture.db, fixture.adminId, {
      permissions: [PERMISSIONS.reportView],
    });
    await expect(
      new ResultatService(vendeur).creerCharge({
        category: CHARGE_CATEGORY.rent,
        label: 'Loyer',
        amount: 100,
        occurredAt: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();
  });

  it('refuse un montant nul ou négatif', async () => {
    for (const montant of [0, -1_000]) {
      await expect(
        new ResultatService(context).creerCharge({
          category: CHARGE_CATEGORY.rent,
          label: 'Loyer',
          amount: montant,
          occurredAt: '2026-09-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/positif/);
    }
  });
});
