import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@boutique/shared';
import { suggestMapping } from '@/core/import/fields';
import type { SheetData } from '@/core/import/workbook';
import { boutiqueDepuisEmplacement, emplacementDeLaFeuille } from '@/core/import/emplacement';
import { ImportService } from '@/core/services/import.service';
import { TransferService } from '@/core/services/transfer.service';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { contextFor } from './helpers/context';
import { seedFixture, type Fixture } from './helpers/fixtures';
import type { AppContext } from '@/core/services/context';

/**
 * L'admin importe pour une autre boutique.
 *
 * LE SCÉNARIO, tel que le client le décrit : l'administrateur reçoit un
 * fichier de marchandise qui se trouve à Tamatave. Elle y est vraiment. Mais
 * elle ne doit pas apparaître dans le stock de Tamatave sans que quelqu'un
 * SUR PLACE ait confirmé ce qui est arrivé — c'est exactement là que naissent
 * les écarts d'inventaire.
 *
 * Le chemin retenu : la marchandise entre chez l'importateur, puis part
 * aussitôt en transfert. Le gérant de la destination réceptionne. Aucun
 * mécanisme nouveau : ce sont les transferts, qui savent déjà refuser qu'une
 * boutique réceptionne à la place d'une autre.
 */

const FEUILLE_ACCESSOIRES: SheetData = {
  name: 'Housses',
  headers: ['Marque', 'Modèle', 'Emplacement', 'Prix de vente', 'Quantité'],
  rows: [
    ['Samsung', 'Iphone 17 Pro Max', 'NORD/Stock', '45000', '10'],
    ['Redmi', 'Redmi Note 15', 'NORD/Stock', '20000', '15'],
  ],
};

const FEUILLE_TELEPHONES: SheetData = {
  name: 'IPHONE',
  headers: ['Marque', 'Désignation', 'Emplacement', 'Prix de vente', 'IMEI'],
  rows: [['Oppo', 'Oppo A73', 'NORD/Stock', '1300000', '863038050322748']],
};

describe('l’emplacement désigne une boutique', () => {
  const boutiques = [
    { id: 'b-centre', code: 'CENT', name: 'Boutique Centre' },
    { id: 'b-nord', code: 'NORD', name: 'Boutique Nord' },
  ];

  it('reconnaît la boutique au code écrit avant la barre oblique', () => {
    // « NORD/Stock » et « NORD/Vitrine » désignent la même boutique : ce qui
    // suit décrit un rayon, et le logiciel ne suit pas les rayons.
    expect(boutiqueDepuisEmplacement('NORD/Stock', boutiques)?.id).toBe('b-nord');
    expect(boutiqueDepuisEmplacement('NORD/Vitrine', boutiques)?.id).toBe('b-nord');
    expect(boutiqueDepuisEmplacement(' nord ', boutiques)?.id).toBe('b-nord');
  });

  it('reconnaît aussi le nom complet, au cas où il aurait été tapé', () => {
    expect(boutiqueDepuisEmplacement('Boutique Nord', boutiques)?.id).toBe('b-nord');
  });

  it('ne devine rien quand rien ne correspond', () => {
    // Deviner en silence ferait entrer un stock entier dans la mauvaise
    // boutique, et l'erreur ne se verrait qu'à l'inventaire suivant.
    expect(boutiqueDepuisEmplacement('DPKNG/Stock', boutiques)).toBeNull();
    expect(boutiqueDepuisEmplacement('', boutiques)).toBeNull();
    expect(boutiqueDepuisEmplacement(null, boutiques)).toBeNull();
  });

  it('lit la première valeur renseignée de la colonne', () => {
    expect(emplacementDeLaFeuille(FEUILLE_ACCESSOIRES.headers, FEUILLE_ACCESSOIRES.rows)).toBe(
      'NORD/Stock',
    );
    expect(emplacementDeLaFeuille(['Marque', 'Modèle'], [['Samsung', 'A']])).toBe('');
  });
});

describe('import destiné à une autre boutique', () => {
  let fixture: Fixture;
  let context: AppContext;
  let service: ImportService;

  beforeEach(async () => {
    fixture = await seedFixture();
    context = await contextFor(fixture.db, fixture.adminId);
    service = new ImportService(context);
  });

  const importer = async (feuille: SheetData, destination: string | null) =>
    service.plan(
      feuille,
      suggestMapping(feuille.headers),
      'CREATE_ONLY',
      'stock-tamatave.xlsx',
      null,
      destination,
    );

  describe('quantités', () => {
    it('émet un transfert vers la boutique de destination', async () => {
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopB));

      expect(resultat.transfer).not.toBeNull();
      expect(resultat.transfer?.toShopId).toBe(fixture.shopB);
      // Une ligne par produit, et non par ligne du fichier.
      expect(resultat.transfer?.lines).toBe(2);
    });

    it('laisse la marchandise EN TRANSIT, pas encore dans le stock du destinataire', async () => {
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopB));

      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.transfer.status).toBe('SHIPPED');

      const produit = await new ProductRepository(fixture.db).search({
        shopId: fixture.shopB,
        query: 'Samsung Iphone 17',
      });
      expect(produit.items[0]?.available ?? 0).toBe(0);
    });

    it('cumule les quantités d’un même produit répété dans le fichier', async () => {
      // Deux lignes, une seule référence : l'import n'en fait qu'un article et
      // additionne les quantités. Le colis porte donc UNE ligne de quinze, et
      // non deux — un bordereau qui répète le même article se recompte mal.
      const feuille: SheetData = {
        name: 'Housses',
        headers: [
          'Marque',
          'Modèle',
          'Réference interne',
          'Emplacement',
          'Prix de vente',
          'Quantité',
        ],
        rows: [
          ['Samsung', 'Iphone 17 Pro Max', 'HOU-IP17PM', 'NORD/Stock', '45000', '10'],
          ['Samsung', 'Iphone 17 Pro Max', 'HOU-IP17PM', 'NORD/Stock', '45000', '5'],
        ],
      };
      const resultat = await service.apply(await importer(feuille, fixture.shopB));
      expect(resultat.transfer?.lines).toBe(1);

      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.lines[0]?.quantity).toBe(15);
    });

    it('n’expédie pas deux fois une ligne que l’import a ignorée', async () => {
      // Sans référence, deux lignes identiques ne se cumulent pas : la seconde
      // est ignorée. Le colis doit refléter ce qui est RÉELLEMENT entré, pas ce
      // que le fichier annonçait.
      const feuille: SheetData = {
        ...FEUILLE_ACCESSOIRES,
        rows: [
          ['Samsung', 'Iphone 17 Pro Max', 'NORD/Stock', '45000', '10'],
          ['Samsung', 'Iphone 17 Pro Max', 'NORD/Stock', '45000', '5'],
        ],
      };
      const resultat = await service.apply(await importer(feuille, fixture.shopB));
      expect(resultat.skipped).toBe(1);

      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.lines[0]?.quantity).toBe(10);
    });

    it('porte le nom du fichier en note, pour qu’on sache d’où vient le colis', async () => {
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopB));
      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.transfer.note).toContain('stock-tamatave.xlsx');
    });
  });

  describe('appareils identifiés', () => {
    it('expédie chaque appareil, avec son identifiant', async () => {
      const resultat = await service.apply(await importer(FEUILLE_TELEPHONES, fixture.shopB));

      expect(resultat.unitsCreated).toBe(1);
      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.lines).toHaveLength(1);
      expect(detail?.lines[0]?.identifier).toBe('863038050322748');
    });

    it('met l’appareil en transfert, pas en stock chez l’expéditeur', async () => {
      await service.apply(await importer(FEUILLE_TELEPHONES, fixture.shopB));
      const unite = await new UnitRepository(fixture.db).byIdentifier('863038050322748');
      expect(unite?.status).toBe('IN_TRANSFER');
    });
  });

  describe('réception par la destination', () => {
    it('le gérant de la destination valide, et le stock arrive enfin', async () => {
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopB));

      // Le gérant de la boutique Nord, sur place.
      const nord = await contextFor(fixture.db, fixture.adminId, { shopId: fixture.shopB });
      await new TransferService(nord).receive(resultat.transfer!.id);

      const detail = await new TransferRepository(fixture.db).detail(resultat.transfer!.id);
      expect(detail?.transfer.status).toBe('RECEIVED');

      const produit = await new ProductRepository(fixture.db).search({
        shopId: fixture.shopB,
        query: 'Samsung Iphone 17',
      });
      const niveau = await new StockRepository(fixture.db).levelOf(
        produit.items[0]!.id,
        fixture.shopB,
      );
      expect(niveau.quantity).toBe(10);
    });

    it('REFUSE que l’expéditeur réceptionne à la place du destinataire', async () => {
      // C'est le cœur de la demande : la validation appartient à celui qui a la
      // marchandise sous les yeux, et à personne d'autre — pas même à l'admin
      // qui a lancé l'import.
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopB));
      await expect(new TransferService(context).receive(resultat.transfer!.id)).rejects.toThrow(
        /Seule la boutique destinataire/,
      );
    });

    it('rend la marchandise à l’expéditeur quand la destination refuse', async () => {
      const resultat = await service.apply(await importer(FEUILLE_TELEPHONES, fixture.shopB));
      const nord = await contextFor(fixture.db, fixture.adminId, { shopId: fixture.shopB });
      await new TransferService(nord).reject(resultat.transfer!.id, 'Colis jamais arrivé');

      const unite = await new UnitRepository(fixture.db).byIdentifier('863038050322748');
      expect(unite?.status).toBe('IN_STOCK');
      expect(unite?.shopId).toBe(fixture.shopA);
    });
  });

  describe('garde-fous', () => {
    it('n’émet aucun transfert quand la destination est la boutique courante', async () => {
      const resultat = await service.apply(await importer(FEUILLE_ACCESSOIRES, fixture.shopA));
      expect(resultat.transfer).toBeNull();

      const produit = await new ProductRepository(fixture.db).search({
        shopId: fixture.shopA,
        query: 'Samsung Iphone 17',
      });
      expect(produit.items[0]?.available).toBe(10);
    });

    it('n’émet aucun transfert quand rien n’a pu être importé', async () => {
      const vide: SheetData = {
        ...FEUILLE_ACCESSOIRES,
        rows: [['Samsung', 'Housse', 'NORD/Stock', '', '10']],
      };
      const resultat = await service.apply(await importer(vide, fixture.shopB));
      expect(resultat.errors).toBe(1);
      expect(resultat.transfer).toBeNull();
    });

    it('refuse une boutique de destination inconnue', async () => {
      await expect(
        service.apply(await importer(FEUILLE_ACCESSOIRES, 'boutique-fantome')),
      ).rejects.toThrow(/Boutique de destination introuvable/);
    });

    it('exige les droits de transfert AVANT d’écrire quoi que ce soit', async () => {
      // Les découvrir après l'import laisserait le stock chez l'importateur,
      // sans transfert et sans que personne l'ait voulu.
      const sansTransfert = await contextFor(fixture.db, fixture.adminId, {
        permissions: [PERMISSIONS.importRun, PERMISSIONS.productManage, PERMISSIONS.stockAdjust],
      });
      const bride = new ImportService(sansTransfert);
      const plan = await bride.plan(
        FEUILLE_ACCESSOIRES,
        suggestMapping(FEUILLE_ACCESSOIRES.headers),
        'CREATE_ONLY',
        'stock-tamatave.xlsx',
        null,
        fixture.shopB,
      );

      await expect(bride.apply(plan)).rejects.toThrow();
      const produits = await new ProductRepository(fixture.db).search({ shopId: fixture.shopA });
      expect(produits.items).toHaveLength(3); // les trois du jeu de départ, rien de plus
    });
  });
});
