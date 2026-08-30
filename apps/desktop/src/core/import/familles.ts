import { TRACKING } from '@boutique/shared';
import type { Tracking } from '@boutique/shared';

/**
 * Familles d'articles proposées au début d'un import.
 *
 * Les fichiers du client sont mono-famille : une feuille « Boitiers » ne
 * contient que des boîtiers, une feuille « IPHONE » que des téléphones. Le nom
 * de la famille, lui, n'apparaît nulle part de façon fiable — la colonne
 * « Etiquettes » l'écrit tantôt « Cache-écrans », tantôt « Montre connectée ».
 *
 * Faire choisir la famille UNE fois règle trois choses d'un coup :
 *   — la catégorie sous laquelle les produits seront rangés,
 *   — le mode de suivi (un téléphone se suit par IMEI, un câble par quantité),
 *   — la colonne qui sert de second niveau de choix au comptoir.
 *
 * Elle reste facultative : « Déduire du fichier » conserve l'ancien
 * comportement pour les catalogues qui portent déjà leur catégorie.
 */
export interface Famille {
  /** Identifiant stable, utilisé par les listes déroulantes. */
  code: string;
  /** Libellé de la catégorie créée en base. */
  label: string;
  tracking: Tracking;
  /**
   * Attribut qui distingue les articles à l'intérieur de la famille, présenté
   * comme un second écran au comptoir (« Verre » ou « Hydrogel »).
   */
  facette?: string;
  /** Mots reconnus dans le nom du fichier ou de la feuille. */
  indices: string[];
}

export const FAMILLES: Famille[] = [
  {
    code: 'smartphones',
    label: 'Smartphones',
    tracking: TRACKING.imei,
    facette: 'capacite',
    indices: ['telephone', 'phone', 'iphone', 'smartphone', 'samsung', 'mobile'],
  },
  {
    code: 'montres',
    label: 'Montres connectées',
    tracking: TRACKING.quantity,
    indices: ['montre', 'watch'],
  },
  {
    code: 'boitiers',
    label: 'Boîtiers de charge',
    tracking: TRACKING.quantity,
    facette: 'puissance',
    indices: ['boitier', 'chargeur', 'adaptateur'],
  },
  {
    code: 'cables',
    label: 'Câbles',
    tracking: TRACKING.quantity,
    facette: 'avec_boitier',
    indices: ['cable'],
  },
  {
    code: 'powerbank',
    label: 'Powerbanks',
    tracking: TRACKING.quantity,
    facette: 'puissance',
    indices: ['powerbank', 'batterie externe'],
  },
  {
    code: 'cache-ecrans',
    label: 'Cache-écrans',
    tracking: TRACKING.quantity,
    facette: 'type',
    indices: ['cache ecran', 'cache-ecran', 'verre', 'hydrogel', 'protection'],
  },
  {
    code: 'housses',
    label: 'Housses',
    tracking: TRACKING.quantity,
    facette: 'couleur',
    indices: ['housse', 'coque', 'etui'],
  },
  {
    code: 'ecouteurs',
    label: 'Écouteurs',
    tracking: TRACKING.quantity,
    indices: ['ecouteur', 'airpods', 'buds'],
  },
  {
    code: 'casques',
    label: 'Casques',
    tracking: TRACKING.quantity,
    indices: ['casque', 'headphone'],
  },
  { code: 'micros', label: 'Micros', tracking: TRACKING.quantity, indices: ['micro', 'mic'] },
  { code: 'cameras', label: 'Caméras', tracking: TRACKING.quantity, indices: ['camera', 'cam'] },
  {
    code: 'stabilisateurs',
    label: 'Stabilisateurs',
    tracking: TRACKING.quantity,
    indices: ['stabilisateur', 'gimbal', 'osmo'],
  },
  {
    code: 'informatique',
    label: 'Matériel informatique',
    tracking: TRACKING.serial,
    indices: ['ordinateur', 'pc', 'laptop', 'informatique'],
  },
  {
    code: 'accessoires',
    label: 'Accessoires divers',
    tracking: TRACKING.quantity,
    indices: ['accessoire', 'divers'],
  },
];

export const FAMILLE_PAR_CODE = new Map(FAMILLES.map((f) => [f.code, f]));

function sansAccent(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Devine la famille d'après le nom du fichier, celui de la feuille et la
 * colonne « Etiquettes ».
 *
 * On propose, on n'impose pas : la suggestion arrive pré-sélectionnée dans la
 * liste et l'utilisateur la corrige d'un clic si elle est fausse.
 */
export function devinerFamille(...sources: (string | null | undefined)[]): Famille | null {
  const texte = sansAccent(sources.filter(Boolean).join(' '));
  let meilleure: Famille | null = null;
  let meilleurIndice = -1;
  for (const famille of FAMILLES) {
    for (const indice of famille.indices) {
      // Le mot le plus long l'emporte : « cache ecran » doit battre « ecran »,
      // et « batterie externe » battre « batterie ».
      if (texte.includes(sansAccent(indice)) && indice.length > meilleurIndice) {
        meilleure = famille;
        meilleurIndice = indice.length;
      }
    }
  }
  return meilleure;
}
