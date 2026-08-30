import { PAGE_PERMISSIONS } from '@boutique/shared';
import type { FonctionBoutique, PagePermission } from '@boutique/shared';
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
  /**
   * Fonction de la LICENCE qui ouvre cet écran.
   *
   * Distincte de la permission, et pour une raison qui se voit à l'écran : une
   * page fermée par le rôle se règle chez le client, dans « Utilisateurs et
   * rôles » ; une page fermée par la licence ne se règle qu'en achetant le
   * module. Les confondre ferait chercher pendant une heure un réglage qui
   * n'existe pas.
   *
   * Absente, l'écran relève du noyau : il est toujours ouvert, tant que la
   * licence n'est pas échue.
   */
  fonction?: FonctionBoutique;
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
        fonction: 'apres-vente',
      },
      {
        cle: 'echanges',
        titre: 'Échanges',
        icone: 'echange',
        permission: PAGE_PERMISSIONS.echanges,
        fonction: 'apres-vente',
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
        fonction: 'achats',
      },
      {
        cle: 'achats',
        titre: 'Commandes et réceptions',
        icone: 'achat',
        permission: PAGE_PERMISSIONS.achats,
        fonction: 'achats',
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
        fonction: 'multiboutique',
      },
      {
        cle: 'synchronisation',
        titre: 'Synchronisation',
        icone: 'synchro',
        permission: PAGE_PERMISSIONS.synchronisation,
        fonction: 'synchronisation',
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
        fonction: 'clients',
      },
      {
        cle: 'rapports',
        titre: 'Rapports',
        icone: 'rapport',
        permission: PAGE_PERMISSIONS.rapports,
        fonction: 'rapports',
      },
      {
        cle: 'prix',
        titre: 'Évolution des prix',
        icone: 'mouvement',
        permission: PAGE_PERMISSIONS.prix,
        fonction: 'rapports',
      },
      {
        cle: 'import',
        titre: 'Import Excel',
        icone: 'import',
        permission: PAGE_PERMISSIONS.import,
        fonction: 'import',
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
        // PAS de fonction de licence : éditer le nom, l'adresse et le
        // téléphone de sa propre boutique n'est pas une option vendable —
        // c'est ce qui s'imprime sur les tickets. Ce qui relève du
        // multi-boutique, c'est d'en avoir PLUSIEURS, et cela se règle par le
        // plafond de la licence, à la création.
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
