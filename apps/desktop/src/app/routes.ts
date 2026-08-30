import { PAGE_PERMISSIONS } from '@boutique/shared';
import type { PagePermission } from '@boutique/shared';
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
  | 'journal'
  | 'boutiques'
  | 'prix';

export interface Ecran {
  cle: CleEcran;
  titre: string;
  icone: NomIcone;
  /**
   * Permission d'ACCÈS à la page.
   *
   * Chaque écran a la sienne, sans exception : c'est ce qui permet de régler
   * l'accès page par page pour chaque rôle. Les droits d'AGIR — encaisser,
   * réceptionner, rembourser — sont des permissions distinctes, vérifiées à
   * l'intérieur de l'écran.
   */
  permission: PagePermission;
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
    ecrans: [
      {
        cle: 'tableau',
        titre: 'Tableau de bord',
        icone: 'tableau',
        permission: PAGE_PERMISSIONS.tableau,
        raccourci: '1',
      },
    ],
  },
  {
    titre: 'Ventes',
    ecrans: [
      {
        cle: 'caisse',
        titre: 'Nouvelle vente',
        icone: 'caisse',
        permission: PAGE_PERMISSIONS.caisse,
        raccourci: '2',
      },
      {
        cle: 'tickets',
        titre: 'Tickets',
        icone: 'ticket',
        permission: PAGE_PERMISSIONS.tickets,
        raccourci: '3',
      },
      {
        cle: 'factures',
        titre: 'Factures',
        icone: 'facture',
        permission: PAGE_PERMISSIONS.factures,
      },
      {
        cle: 'remboursements',
        titre: 'Remboursements',
        icone: 'retour',
        permission: PAGE_PERMISSIONS.remboursements,
      },
      {
        cle: 'echanges',
        titre: 'Échanges',
        icone: 'echange',
        permission: PAGE_PERMISSIONS.echanges,
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
        permission: PAGE_PERMISSIONS.produits,
        raccourci: '4',
      },
      {
        cle: 'appareils',
        titre: 'IMEI / Séries',
        icone: 'telephone',
        permission: PAGE_PERMISSIONS.appareils,
        raccourci: '5',
      },
      {
        cle: 'mouvements',
        titre: 'Mouvements',
        icone: 'mouvement',
        permission: PAGE_PERMISSIONS.mouvements,
      },
      {
        cle: 'inventaire',
        titre: 'Inventaire',
        icone: 'inventaire',
        permission: PAGE_PERMISSIONS.inventaire,
      },
      {
        cle: 'stock-faible',
        titre: 'Stock faible',
        icone: 'alerte',
        permission: PAGE_PERMISSIONS['stock-faible'],
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
        permission: PAGE_PERMISSIONS.fournisseurs,
      },
      {
        cle: 'achats',
        titre: 'Commandes et réceptions',
        icone: 'achat',
        permission: PAGE_PERMISSIONS.achats,
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
        permission: PAGE_PERMISSIONS.transferts,
      },
      {
        cle: 'synchronisation',
        titre: 'Synchronisation',
        icone: 'synchro',
        permission: PAGE_PERMISSIONS.synchronisation,
      },
    ],
  },
  {
    titre: 'Gestion',
    ecrans: [
      {
        cle: 'clients',
        titre: 'Clients',
        icone: 'client',
        permission: PAGE_PERMISSIONS.clients,
      },
      {
        cle: 'rapports',
        titre: 'Rapports',
        icone: 'rapport',
        permission: PAGE_PERMISSIONS.rapports,
      },
      {
        cle: 'prix',
        titre: 'Évolution des prix',
        icone: 'mouvement',
        permission: PAGE_PERMISSIONS.prix,
      },
      {
        cle: 'import',
        titre: 'Import Excel',
        icone: 'import',
        permission: PAGE_PERMISSIONS.import,
      },
      {
        cle: 'journal',
        titre: "Journal d'audit",
        icone: 'info',
        permission: PAGE_PERMISSIONS.journal,
      },
      {
        cle: 'boutiques',
        titre: 'Boutiques',
        icone: 'fournisseur',
        permission: PAGE_PERMISSIONS.boutiques,
      },
      {
        cle: 'utilisateurs',
        // « Utilisateurs » seul cachait la gestion des rôles derrière un
        // onglet, et personne ne l'y cherchait. Un intitulé de menu doit
        // annoncer TOUT ce que l'écran permet.
        titre: 'Utilisateurs et rôles',
        icone: 'utilisateur',
        permission: PAGE_PERMISSIONS.utilisateurs,
      },
      {
        cle: 'parametres',
        titre: 'Paramètres',
        icone: 'reglage',
        permission: PAGE_PERMISSIONS.parametres,
      },
    ],
  },
];

export const TOUS_LES_ECRANS: Ecran[] = NAVIGATION.flatMap((groupe) => groupe.ecrans);

export function ecranParCle(cle: CleEcran): Ecran | undefined {
  return TOUS_LES_ECRANS.find((ecran) => ecran.cle === cle);
}
