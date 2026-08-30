import { PERMISSIONS } from '@boutique/shared';
import type { Permission } from '@boutique/shared';
import type { NomIcone } from '@/components/ui/Icone';

/**
 * Navigation (§26).
 *
 * Une seule déclaration décrit à la fois le menu, les droits d'accès et le
 * titre de la page. Sans elle, un écran ajouté au routeur mais oublié dans le
 * menu deviendrait inaccessible, et un écran retiré du menu resterait
 * atteignable par son adresse.
 */

export type CleEcran =
  | 'tableau'
  | 'caisse'
  | 'tickets'
  | 'factures'
  | 'remboursements'
  | 'echanges'
  | 'produits'
  | 'stock'
  | 'appareils'
  | 'mouvements'
  | 'inventaire'
  | 'stock-faible'
  | 'fournisseurs'
  | 'achats'
  | 'transferts'
  | 'clients'
  | 'rapports'
  | 'utilisateurs'
  | 'parametres'
  | 'synchronisation'
  | 'import'
  | 'journal';

export interface Ecran {
  cle: CleEcran;
  titre: string;
  icone: NomIcone;
  /** Permission minimale. Absente : accessible à toute session ouverte. */
  permission?: Permission;
  /** Raccourci clavier global, avec la touche Alt. */
  raccourci?: string;
}

export interface Groupe {
  titre: string;
  ecrans: Ecran[];
}

export const NAVIGATION: Groupe[] = [
  {
    titre: '',
    ecrans: [{ cle: 'tableau', titre: 'Tableau de bord', icone: 'tableau', raccourci: '1' }],
  },
  {
    titre: 'Ventes',
    ecrans: [
      {
        cle: 'caisse',
        titre: 'Nouvelle vente',
        icone: 'caisse',
        permission: PERMISSIONS.saleCreate,
        raccourci: '2',
      },
      { cle: 'tickets', titre: 'Tickets', icone: 'ticket', raccourci: '3' },
      {
        cle: 'factures',
        titre: 'Factures',
        icone: 'facture',
        permission: PERMISSIONS.invoiceManage,
      },
      {
        cle: 'remboursements',
        titre: 'Remboursements',
        icone: 'retour',
        permission: PERMISSIONS.refundCreate,
      },
      {
        cle: 'echanges',
        titre: 'Échanges',
        icone: 'echange',
        permission: PERMISSIONS.exchangeCreate,
      },
    ],
  },
  {
    titre: 'Stock',
    ecrans: [
      {
        cle: 'produits',
        titre: 'Produits',
        icone: 'boite',
        permission: PERMISSIONS.productView,
        raccourci: '4',
      },
      {
        cle: 'appareils',
        titre: 'IMEI / Séries',
        icone: 'telephone',
        permission: PERMISSIONS.stockView,
        raccourci: '5',
      },
      {
        cle: 'mouvements',
        titre: 'Mouvements',
        icone: 'mouvement',
        permission: PERMISSIONS.stockView,
      },
      {
        cle: 'inventaire',
        titre: 'Inventaire',
        icone: 'inventaire',
        permission: PERMISSIONS.inventoryManage,
      },
      {
        cle: 'stock-faible',
        titre: 'Stock faible',
        icone: 'alerte',
        permission: PERMISSIONS.stockView,
      },
    ],
  },
  {
    titre: 'Achats',
    ecrans: [
      {
        cle: 'fournisseurs',
        titre: 'Fournisseurs',
        icone: 'fournisseur',
        permission: PERMISSIONS.purchaseView,
      },
      {
        cle: 'achats',
        titre: 'Commandes et réceptions',
        icone: 'achat',
        permission: PERMISSIONS.purchaseView,
      },
    ],
  },
  {
    titre: 'Réseau',
    ecrans: [
      {
        cle: 'transferts',
        titre: 'Transferts',
        icone: 'camion',
        permission: PERMISSIONS.transferCreate,
      },
      {
        cle: 'synchronisation',
        titre: 'Synchronisation',
        icone: 'synchro',
        permission: PERMISSIONS.syncRun,
      },
    ],
  },
  {
    titre: 'Gestion',
    ecrans: [
      { cle: 'clients', titre: 'Clients', icone: 'client', permission: PERMISSIONS.customerView },
      { cle: 'rapports', titre: 'Rapports', icone: 'rapport', permission: PERMISSIONS.reportView },
      { cle: 'import', titre: 'Import Excel', icone: 'import', permission: PERMISSIONS.importRun },
      {
        cle: 'journal',
        titre: "Journal d'audit",
        icone: 'info',
        permission: PERMISSIONS.auditView,
      },
      {
        cle: 'utilisateurs',
        titre: 'Utilisateurs',
        icone: 'utilisateur',
        permission: PERMISSIONS.userManage,
      },
      {
        cle: 'parametres',
        titre: 'Paramètres',
        icone: 'reglage',
        permission: PERMISSIONS.settingsManage,
      },
    ],
  },
];

export const TOUS_LES_ECRANS: Ecran[] = NAVIGATION.flatMap((groupe) => groupe.ecrans);

export function ecranParCle(cle: CleEcran): Ecran | undefined {
  return TOUS_LES_ECRANS.find((ecran) => ecran.cle === cle);
}
