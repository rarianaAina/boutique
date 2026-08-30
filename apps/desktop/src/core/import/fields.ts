import { TRACKING, UNIT_CONDITION, normalizeText } from '@boutique/shared';
// La dérivation d'une référence est une règle du DOMAINE, pas une particularité
// de l'import : le formulaire produit s'en sert aussi. Elle vit donc dans le
// paquet partagé, et n'est que ré-exportée ici pour les appelants de l'import.
export { derivedSku } from '@boutique/shared';
import type { UnitCondition } from '@boutique/shared';

/**
 * Champs cibles de l'import et détection automatique des colonnes (§8).
 *
 * Le mapping N'EST PAS écrit pour un fichier précis : chaque champ porte une
 * liste de libellés reconnus, en français et en anglais, avec les variantes que
 * l'on trouve réellement dans les fichiers des boutiques (« Prix Achat »,
 * « P.A. », « cout », « purchase price »). La détection propose, l'utilisateur
 * dispose — aucun mapping n'est appliqué sans qu'il l'ait vu à l'écran.
 */

export interface ImportField {
  key: string;
  label: string;
  /** Un import ne peut pas aboutir sans ce champ. */
  required: boolean;
  type: 'text' | 'money' | 'number' | 'tracking' | 'condition' | 'imei' | 'serial';
  /** Libellés reconnus, déjà normalisés (sans accent ni ponctuation). */
  aliases: string[];
  help?: string;
}

/** Construit la liste des alias normalisés d'un champ. */
const alias = (...labels: string[]): string[] => labels.map(normalizeText);

export const IMPORT_FIELDS: ImportField[] = [
  {
    key: 'sku',
    label: 'SKU / Référence interne',
    // NON obligatoire : dans les fichiers réels des boutiques, près d'une ligne
    // sur deux n'en porte pas, et certaines feuilles n'ont pas la colonne du
    // tout. L'exiger rejetterait la moitié d'un catalogue alors que le nom, la
    // marque et la déclinaison suffisent à identifier le modèle — l'importateur
    // en dérive alors une référence lisible.
    required: false,
    type: 'text',
    aliases: alias(
      'sku',
      'code',
      'code article',
      'reference',
      'reference interne',
      'ref',
      'ref interne',
      'code produit',
      'article',
    ),
    help: 'Deux lignes portant le même SKU désignent le même modèle. Dérivée si absente.',
  },
  {
    key: 'name',
    label: 'Désignation',
    // FACULTATIVE : les fichiers réels décrivent un article par sa marque, son
    // modèle et ses qualificatifs, sans jamais écrire de désignation complète.
    // L'importateur la compose — exiger une colonne que personne ne remplit
    // rejetterait des catalogues entiers.
    required: false,
    type: 'text',
    aliases: alias('designation', 'nom', 'libelle', 'produit', 'name', 'description', 'article'),
    help: 'Composée à partir de la marque, du modèle et des qualificatifs si absente.',
  },
  {
    key: 'brand',
    label: 'Marque',
    required: false,
    type: 'text',
    aliases: alias('marque', 'brand', 'fabricant', 'constructeur'),
  },
  {
    key: 'model',
    label: 'Modèle',
    required: false,
    type: 'text',
    aliases: alias('modele', 'model'),
  },
  {
    key: 'reference',
    label: 'Référence fournisseur',
    required: false,
    type: 'text',
    aliases: alias('reference fournisseur', 'ref fournisseur', 'supplier reference', 'ref four'),
  },
  {
    key: 'barcode',
    label: 'Code-barres',
    required: false,
    type: 'text',
    aliases: alias('code barre', 'code barres', 'codebarre', 'ean', 'gencod', 'barcode', 'upc'),
  },
  {
    key: 'category',
    label: 'Catégorie',
    required: false,
    type: 'text',
    aliases: alias(
      'categorie',
      'category',
      'famille',
      'rayon',
      'groupe',
      // « Étiquettes » est l'intitulé qu'emploient les exports de la boutique :
      // c'est bien la catégorie, pas un champ libre.
      'etiquettes',
      'etiquette',
      'tag',
      'tags',
    ),
  },
  {
    key: 'tracking',
    label: 'Mode de suivi',
    required: false,
    type: 'tracking',
    aliases: alias('suivi', 'tracking', 'type de suivi', 'mode de suivi'),
    help: "IMEI, SERIE ou QUANTITE. Déduit de la présence d'un IMEI si la colonne manque.",
  },
  {
    key: 'purchasePrice',
    label: "Prix d'achat",
    required: false,
    type: 'money',
    aliases: alias(
      'prix achat',
      'pa',
      'p a',
      'cout',
      'cout achat',
      'purchase price',
      'cost',
      'achat',
    ),
  },
  {
    key: 'salePrice',
    label: 'Prix de vente',
    required: true,
    type: 'money',
    aliases: alias(
      'prix vente',
      'pv',
      'p v',
      'prix',
      'sale price',
      'price',
      'vente',
      'prix public',
    ),
  },
  {
    key: 'minPrice',
    label: 'Prix plancher',
    required: false,
    type: 'money',
    aliases: alias('prix minimum', 'prix mini', 'prix plancher', 'min price', 'plancher'),
  },
  {
    key: 'taxRate',
    label: 'TVA (%)',
    required: false,
    type: 'number',
    aliases: alias('tva', 'taxe', 'tax', 'vat'),
  },
  {
    key: 'unit',
    label: 'Unité',
    required: false,
    type: 'text',
    aliases: alias('unite', 'unit', 'uom'),
  },
  {
    key: 'minStock',
    label: 'Stock minimum',
    required: false,
    type: 'number',
    aliases: alias('stock minimum', 'stock mini', 'seuil', 'min stock', 'alerte'),
  },
  {
    key: 'imei1',
    label: 'IMEI 1',
    required: false,
    type: 'imei',
    aliases: alias('imei', 'imei 1', 'imei1', 'imei principal', 'numero imei'),
  },
  {
    key: 'imei2',
    label: 'IMEI 2 (bi-SIM)',
    required: false,
    type: 'imei',
    aliases: alias('imei 2', 'imei2', 'imei secondaire', 'second imei'),
  },
  {
    key: 'serial',
    label: 'Numéro de série',
    required: false,
    type: 'serial',
    aliases: alias('numero de serie', 'num serie', 'serie', 'serial', 'sn', 's n', 'serial number'),
  },
  {
    key: 'quantity',
    label: 'Quantité',
    required: false,
    type: 'number',
    aliases: alias('quantite', 'qte', 'qty', 'quantity', 'stock', 'nombre'),
  },
  {
    key: 'color',
    label: 'Couleur',
    required: false,
    type: 'text',
    aliases: alias('couleur', 'color', 'coloris'),
  },
  {
    key: 'capacity',
    label: 'Capacité',
    required: false,
    type: 'text',
    aliases: alias('capacite', 'capacity', 'stockage', 'memoire', 'ram memoire', 'go', 'gb'),
  },
  {
    key: 'type',
    label: 'Type',
    required: false,
    type: 'text',
    aliases: alias('type', 'variante', 'matiere'),
    help: 'Verre, hydrogel… Sert de second niveau de choix au comptoir.',
  },
  {
    key: 'power',
    label: 'Puissance',
    required: false,
    type: 'text',
    aliases: alias('puissance', 'watt', 'watts', 'w', 'power'),
  },
  {
    key: 'withCase',
    label: 'Avec boîtier',
    required: false,
    type: 'text',
    aliases: alias('avec boitier', 'avec boite', 'boitier inclus', 'with box'),
  },
  {
    key: 'withCable',
    label: 'Avec câble',
    required: false,
    type: 'text',
    aliases: alias('avec cable', 'cable inclus', 'with cable'),
  },
  {
    key: 'condition',
    label: "État de l'appareil",
    required: false,
    type: 'condition',
    aliases: alias('etat', 'condition', 'etat appareil', 'grade'),
    help: 'Neuf, scellé, reconditionné, occasion, défectueux.',
  },
  {
    key: 'location',
    label: 'Emplacement de stockage',
    required: false,
    type: 'text',
    aliases: alias('emplacement', 'localisation', 'location', 'zone', 'rayonnage'),
  },
  {
    key: 'warranty',
    label: 'Garantie (mois)',
    required: false,
    type: 'text',
    aliases: alias('garantie', 'warranty'),
  },
  {
    key: 'batteryHealth',
    label: 'Santé de la batterie (%)',
    required: false,
    type: 'text',
    aliases: alias('batterie', 'batterie pourcent', 'battery', 'sante batterie'),
  },
  {
    key: 'cycles',
    label: 'Cycles de charge',
    required: false,
    type: 'text',
    aliases: alias('cycle', 'cycles', 'battery cycles'),
  },
  {
    key: 'supplier',
    label: 'Fournisseur',
    required: false,
    type: 'text',
    aliases: alias('fournisseur', 'fournisseurs', 'supplier', 'vendor'),
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    type: 'text',
    aliases: alias('note', 'notes', 'commentaire', 'observation', 'remarque'),
  },
];

export const FIELD_BY_KEY = new Map(IMPORT_FIELDS.map((field) => [field.key, field]));

/**
 * Propose une correspondance colonne -> champ à partir des en-têtes.
 *
 * Deux passes : d'abord les correspondances EXACTES, ensuite seulement les
 * approchantes. Sans cette précaution, une colonne « Prix » pourrait rafler le
 * champ « prix d'achat » avant que « Prix Achat » n'ait eu sa chance.
 */
export function suggestMapping(headers: readonly string[]): Record<number, string> {
  const mapping: Record<number, string> = {};
  const taken = new Set<string>();
  const normalized = headers.map((header) => normalizeText(String(header ?? '')));

  for (const field of IMPORT_FIELDS) {
    const index = normalized.findIndex(
      (header, position) =>
        header !== '' && field.aliases.includes(header) && mapping[position] === undefined,
    );
    if (index >= 0 && !taken.has(field.key)) {
      mapping[index] = field.key;
      taken.add(field.key);
    }
  }

  for (const field of IMPORT_FIELDS) {
    if (taken.has(field.key)) continue;
    const index = normalized.findIndex(
      (header, position) =>
        header !== '' &&
        mapping[position] === undefined &&
        field.aliases.some((candidate) => header.includes(candidate) || candidate.includes(header)),
    );
    if (index >= 0) {
      mapping[index] = field.key;
      taken.add(field.key);
    }
  }

  return mapping;
}

/**
 * Traduit une colonne « État » vers l'énumération des conditions.
 *
 * « Scellé » est traité comme neuf : commercialement, un appareil scellé EST un
 * appareil neuf, et lui inventer une catégorie à part compliquerait les
 * rapports pour une nuance que le vendeur exprime déjà à l'oral.
 */
export function parseCondition(value: string): UnitCondition | null {
  const normalized = normalizeText(value);
  if (normalized === '') return null;
  if (normalized.includes('scelle') || normalized.includes('neuf') || normalized.includes('new')) {
    return UNIT_CONDITION.new;
  }
  if (normalized.includes('reconditionne') || normalized.includes('refurb')) {
    return UNIT_CONDITION.refurbished;
  }
  if (normalized.includes('ouvert') || normalized.includes('open box'))
    return UNIT_CONDITION.openBox;
  if (
    normalized.includes('defectueux') ||
    normalized.includes('casse') ||
    normalized.includes('hs') ||
    normalized.includes('damaged')
  ) {
    return UNIT_CONDITION.damaged;
  }
  // « Bon état », « occasion », « seconde main »… : tout le reste est de l'usagé.
  return UNIT_CONDITION.used;
}

/** Traduit une valeur de colonne « suivi » vers l'énumération du domaine. */
export function parseTracking(value: string): string | null {
  const normalized = normalizeText(value);
  if (normalized === '') return null;
  if (normalized.includes('imei')) return TRACKING.imei;
  if (normalized.includes('serie') || normalized.includes('serial')) return TRACKING.serial;
  if (normalized.includes('quantite') || normalized.includes('quantity') || normalized === 'qte') {
    return TRACKING.quantity;
  }
  return null;
}
