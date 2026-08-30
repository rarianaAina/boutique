import { TRACKING, checkImei, normalizeSerial, parseMoney } from '@boutique/shared';
import type { Tracking, UnitCondition } from '@boutique/shared';
import { derivedSku } from '@boutique/shared';
import { FIELD_BY_KEY, parseCondition, parseTracking } from './fields';
import type { SheetData } from './workbook';

/**
 * Analyse d'un fichier avant import (§8).
 *
 * TOUT est vérifié AVANT d'écrire quoi que ce soit : format des IMEI, doublons
 * dans le fichier, doublons déjà en base, prix illisibles, champs obligatoires
 * manquants. Un import à moitié passé est le pire résultat possible — on ne sait
 * plus ce qui est entré, et rejouer le fichier crée des doublons.
 *
 * L'analyse ne DÉCIDE rien : elle produit un rapport que l'utilisateur regarde,
 * corrige et confirme.
 */

export type RowOutcome = 'CREATE' | 'UPDATE' | 'SKIP' | 'ERROR';

export interface AnalyzedRow {
  /** Numéro de ligne dans la feuille, en-tête comprise : celui qu'Excel affiche. */
  rowNumber: number;
  outcome: RowOutcome;
  values: Record<string, string>;
  /** Vrai si le SKU a été dérivé faute de référence dans le fichier. */
  skuDerived: boolean;
  /** Catégorie lue dans le fichier, à créer si elle manque. */
  categoryLabel: string | null;
  /** Code fournisseur lu dans le fichier, à créer s'il manque. */
  supplierLabel: string | null;
  condition: UnitCondition | null;
  product: {
    sku: string;
    name: string;
    tracking: Tracking;
    purchasePrice: number;
    salePrice: number;
    minPrice: number | null;
    taxRate: number | null;
    brand: string | null;
    model: string | null;
    reference: string | null;
    barcode: string | null;
    unit: string;
    minStock: number;
    attributes: Record<string, string>;
  } | null;
  unit: { imei1: string | null; imei2: string | null; serial: string | null } | null;
  quantity: number;
  problems: string[];
  warnings: string[];
}

export interface AnalysisReport {
  rows: AnalyzedRow[];
  counts: Record<RowOutcome, number>;
  /** Champs obligatoires non mappés : l'import est impossible tant qu'ils manquent. */
  missingFields: string[];
}

export interface AnalysisContext {
  /** SKU déjà présents en base. */
  existingSkus: Set<string>;
  /** Identifiants (IMEI, série) déjà présents en base. */
  existingIdentifiers: Set<string>;
  /** Autorise-t-on la mise à jour des produits existants ? */
  mode: 'CREATE_ONLY' | 'CREATE_AND_UPDATE' | 'UPDATE_ONLY';
  /** Décimales de la devise, pour lire les prix. */
  currencyDecimals: number;
  /** Refuser un IMEI dont la clé de contrôle est fausse (réglage de la boutique). */
  strictImeiChecksum: boolean;
  /**
   * Famille choisie par l'utilisateur avant l'import (« Smartphones »,
   * « Câbles »…).
   *
   * Elle prime sur la colonne « catégorie » du fichier : les feuilles réelles
   * sont mono-famille — un fichier « Boitiers » ne contient que des boîtiers —
   * et le nom de la famille n'y figure nulle part. La demander une fois vaut
   * mieux que de la deviner mille fois.
   */
  forcedCategory?: string | null;
  /**
   * Mode de suivi imposé par la famille choisie.
   *
   * Un smartphone se suit par IMEI même si la colonne est encore vide ; un
   * câble se suit par quantité même si quelqu'un a collé un numéro de série
   * dans une cellule.
   */
  forcedTracking?: Tracking | null;
}

export function analyze(
  sheet: SheetData,
  mapping: Record<number, string>,
  context: AnalysisContext,
): AnalysisReport {
  const mapped = new Set(Object.values(mapping));
  const missingFields = [...FIELD_BY_KEY.values()]
    .filter((field) => field.required && !mapped.has(field.key))
    .map((field) => field.label);

  /**
   * Mode de suivi déduit des COLONNES présentes.
   *
   * C'est le point le plus important de l'analyse : un fichier de téléphones
   * comporte une colonne IMEI même lorsqu'elle est encore vide — les numéros
   * seront scannés à la réception de la marchandise. Déduire le suivi des
   * seules valeurs de la ligne créerait ces téléphones en « suivi par
   * quantité », et il serait alors impossible de leur rattacher un IMEI.
   */
  const trackingFromColumns: Tracking = mapped.has('imei1')
    ? TRACKING.imei
    : mapped.has('serial')
      ? TRACKING.serial
      : TRACKING.quantity;

  const partages = recenserReferencesPartagees(sheet, mapping);

  const rows: AnalyzedRow[] = [];
  const counts: Record<RowOutcome, number> = { CREATE: 0, UPDATE: 0, SKIP: 0, ERROR: 0 };

  // Doublons À L'INTÉRIEUR du fichier : ils se comptent au fil de la lecture,
  // et l'on nomme la première ligne fautive pour que l'utilisateur la retrouve.
  const seenIdentifiers = new Map<string, number>();
  const seenSkus = new Map<string, number>();

  for (const [index, raw] of sheet.rows.entries()) {
    // +2 : l'en-tête occupe une ligne, et Excel numérote à partir de 1.
    const rowNumber = index + 2;
    const values: Record<string, string> = {};
    for (const [column, key] of Object.entries(mapping)) {
      const value = raw[Number(column)] ?? '';
      if (value !== '') values[key] = value;
    }

    const problems: string[] = [];
    const warnings: string[] = [];

    const condition = values['condition'] ? parseCondition(values['condition']) : null;

    // Référence : celle du fichier, ou une référence dérivée du modèle. Ce qui
    // distingue un modèle d'un autre entre dans la dérivation — deux housses
    // « Samsung » de capacité et de couleur identiques SONT le même produit.
    const providedSku = (values['sku'] ?? '').trim();
    const skuDerived = providedSku === '';

    /*
     * Une même référence pour plusieurs appareils n'est PAS une faute.
     *
     * Un verre trempé « Standard 9H » porte une seule référence et s'adapte à
     * plusieurs téléphones ; le client écrit une ligne par compatibilité, en
     * mettant l'appareil visé dans la colonne « Marque ». C'est un seul article
     * du catalogue, pas cinq.
     *
     * Dans ce cas l'appareil sort du NOM — sinon l'article s'appellerait du nom
     * du premier téléphone rencontré — et devient une compatibilité, sous
     * laquelle le comptoir saura le retrouver.
     */
    const compatibilites = skuDerived ? [] : (partages.get(providedSku)?.marques ?? []);
    const referencePartagee = compatibilites.length > 1;

    const name = composeName(values, referencePartagee);
    if (name === '') {
      problems.push('Ni désignation, ni marque, ni modèle : la ligne ne nomme aucun produit.');
    }

    const sku = skuDerived
      ? derivedSku([name, values['brand'], values['capacity'], values['color']])
      : providedSku;
    if (skuDerived && name !== '') {
      warnings.push(`Référence absente : « ${sku} » a été dérivée du modèle.`);
    }

    const imei1 = readImei(values['imei1'], 'IMEI 1', problems, warnings, context);
    const imei2 = readImei(values['imei2'], 'IMEI 2', problems, warnings, context);
    const serial = values['serial'] ? normalizeSerial(values['serial']) : null;

    // Priorité : la colonne « suivi » si elle existe, sinon ce que la ligne
    // porte réellement, sinon ce que les colonnes du fichier laissent entendre.
    const declared = values['tracking'] ? parseTracking(values['tracking']) : null;
    const tracking = (context.forcedTracking ??
      declared ??
      (imei1 ? TRACKING.imei : serial ? TRACKING.serial : trackingFromColumns)) as Tracking;

    // Un identifiant absent n'est PAS une erreur : le produit est créé, sans
    // stock, et les appareils lui seront rattachés à la réception. Refuser la
    // ligne obligerait à saisir tout le catalogue à la main avant la première
    // livraison.
    if (tracking === TRACKING.imei && !imei1) {
      warnings.push('Aucun IMEI : le produit est créé sans stock, à compléter à la réception.');
    }
    if (tracking === TRACKING.serial && !serial) {
      warnings.push('Aucun numéro de série : le produit est créé sans stock.');
    }

    const salePrice = readMoney(
      values['salePrice'],
      'Prix de vente',
      context.currencyDecimals,
      problems,
    );
    const purchasePrice =
      readMoney(values['purchasePrice'], "Prix d'achat", context.currencyDecimals, problems) ?? 0;
    const minPrice = values['minPrice']
      ? readMoney(values['minPrice'], 'Prix plancher', context.currencyDecimals, problems)
      : null;

    if (salePrice !== null && purchasePrice > salePrice && purchasePrice > 0) {
      warnings.push("Le prix d'achat dépasse le prix de vente.");
    }

    // Doublons d'identifiants.
    for (const [label, value] of [
      ['IMEI', imei1],
      ['IMEI', imei2],
      ['Numéro de série', serial],
    ] as const) {
      if (!value) continue;
      const previous = seenIdentifiers.get(value);
      if (previous !== undefined) {
        problems.push(`${label} ${value} apparaît déjà ligne ${previous}.`);
      } else {
        seenIdentifiers.set(value, rowNumber);
      }
      if (context.existingIdentifiers.has(value)) {
        problems.push(`${label} ${value} est déjà enregistré dans la base.`);
      }
    }
    if (imei1 && imei2 && imei1 === imei2) {
      problems.push("Les deux IMEI d'un appareil bi-SIM doivent être différents.");
    }

    const existsInBase = context.existingSkus.has(sku);
    // Un SKU répété n'est un problème que pour les produits suivis par
    // quantité : plusieurs téléphones du même modèle partagent leur référence,
    // c'est même la règle.
    //
    // Et la nature du doublon compte.
    //
    // Une référence SAISIE deux fois désigne le même article : le client répète
    // sa référence pour chaque appareil compatible, ou simplement pour un
    // réassort. Les quantités se cumulent sur un seul produit, et la ligne
    // passe — la rejeter obligeait à découper un fichier parfaitement valide.
    //
    // Une référence DÉRIVÉE qui se répète est autre chose : elle signale que le
    // fichier ne permet pas de distinguer deux lignes. On ignore alors la
    // seconde, sans cumuler, parce qu'on ne sait pas si c'est le même article.
    let duplicateOfLine: number | null = null;
    if (sku !== '' && tracking === TRACKING.quantity) {
      const previous = seenSkus.get(sku);
      if (previous !== undefined) {
        if (skuDerived) {
          duplicateOfLine = previous;
          warnings.push(
            `Même modèle qu'à la ligne ${previous} : ligne ignorée, les quantités ne sont pas cumulées.`,
          );
        } else {
          warnings.push(
            `Référence déjà vue ligne ${previous} : même article, les quantités sont cumulées.`,
          );
          // Un prix différent d'une ligne à l'autre serait perdu en silence :
          // c'est la première ligne qui fixe le prix du produit.
          const prixPrecedent = partages.get(sku)?.prix;
          if (prixPrecedent && prixPrecedent.size > 1) {
            warnings.push(
              `Prix de vente différents pour la même référence (${[...prixPrecedent].join(', ')}) : celui de la ligne ${previous} est retenu.`,
            );
          }
        }
      } else {
        seenSkus.set(sku, rowNumber);
      }
    }

    let outcome: RowOutcome;
    if (problems.length > 0) {
      outcome = 'ERROR';
    } else if (duplicateOfLine !== null) {
      outcome = 'SKIP';
    } else if (existsInBase) {
      outcome =
        context.mode === 'CREATE_ONLY'
          ? tracking === TRACKING.quantity
            ? 'SKIP'
            : 'CREATE' // Le produit existe, mais l'appareil est nouveau.
          : 'UPDATE';
    } else {
      outcome = context.mode === 'UPDATE_ONLY' ? 'SKIP' : 'CREATE';
    }

    if (outcome === 'SKIP' && existsInBase && context.mode === 'CREATE_ONLY') {
      warnings.push('Produit déjà présent : ligne ignorée (mode « création seule »).');
    }

    counts[outcome] += 1;
    rows.push({
      rowNumber,
      outcome,
      values,
      skuDerived,
      categoryLabel: context.forcedCategory?.trim() || values['category']?.trim() || null,
      supplierLabel: values['supplier']?.trim() || null,
      condition,
      product:
        outcome === 'ERROR'
          ? null
          : {
              sku,
              name,
              tracking,
              purchasePrice,
              salePrice: salePrice ?? 0,
              minPrice,
              taxRate: readTaxRate(values['taxRate']),
              brand: values['brand'] ?? null,
              model: values['model'] ?? null,
              reference: values['reference'] ?? null,
              barcode: values['barcode'] ?? null,
              unit: values['unit'] ?? 'pièce',
              minStock: Number(values['minStock'] ?? 0) || 0,
              attributes: attributesOf(values, compatibilites),
            },
      unit: imei1 || imei2 || serial ? { imei1, imei2, serial } : null,
      quantity: readQuantity(values['quantity'], tracking),
      problems,
      warnings,
    });
  }

  return { rows, counts, missingFields };
}

/**
 * Lecture d'un IMEI.
 *
 * Une clé de contrôle fausse est un REFUS quand le contrôle strict est actif, et
 * un simple avertissement sinon — le numéro est alors retenu tel quel. Dans les
 * deux cas le problème est nommé : c'est ce qui distingue une donnée acceptée
 * en connaissance de cause d'une donnée acceptée par inadvertance.
 */
function readImei(
  value: string | undefined,
  label: string,
  problems: string[],
  warnings: string[],
  context: AnalysisContext,
): string | null {
  if (!value || value.trim() === '') return null;
  const check = checkImei(value, { requireChecksum: context.strictImeiChecksum });
  if (!check.valid) {
    problems.push(`${label} : ${check.message ?? 'invalide'}`);
    return null;
  }
  if (check.problem === 'BAD_CHECKSUM') {
    warnings.push(`${label} : ${check.message} Numéro retenu tel quel.`);
  }
  return check.value;
}

function readMoney(
  value: string | undefined,
  label: string,
  decimals: number,
  problems: string[],
): number | null {
  if (!value || value.trim() === '') {
    if (label === 'Prix de vente') problems.push('Prix de vente manquant.');
    return label === 'Prix de vente' ? null : 0;
  }
  const parsed = parseMoney(value, decimals);
  if (parsed === null) {
    problems.push(`${label} illisible : « ${value} ».`);
    return null;
  }
  if (parsed < 0) {
    problems.push(`${label} négatif.`);
    return null;
  }
  return parsed;
}

/** TVA en pourcentage -> centièmes de point (20 -> 2000). */
function readTaxRate(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const parsed = Number(value.replace(',', '.').replace('%', '').trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function readQuantity(value: string | undefined, tracking: Tracking): number {
  if (tracking !== TRACKING.quantity) return 1;
  const parsed = Number((value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * Caractéristiques libres.
 *
 * Tout ce que le fichier apporte et qui n'a pas de colonne dédiée au schéma est
 * conservé ici plutôt que jeté : l'emplacement de stockage, la garantie, la
 * santé de la batterie et le nombre de cycles sont exactement ce qu'un vendeur
 * consulte avant de céder un téléphone d'occasion.
 */
/*
 * L'EMPLACEMENT N'EST PLUS REPRIS ICI, et c'est délibéré.
 *
 * « DPKNG/Stock » désigne une BOUTIQUE, pas une caractéristique du produit. Le
 * ranger dans les attributs donnait à un même modèle un emplacement unique,
 * forcément faux dès qu'il était présent dans deux boutiques. Il sert
 * désormais à proposer la boutique de destination de l'import.
 */
function attributesOf(
  values: Record<string, string>,
  compatibilites: string[] = [],
): Record<string, string> {
  const attributes: Record<string, string> = {};
  // Écrite en clair et séparée par des virgules : le comptoir la découpe pour
  // proposer chaque appareil, et le vendeur la lit telle quelle sur la fiche.
  if (compatibilites.length > 1) attributes['compatibilite'] = compatibilites.join(', ');
  const reprendre = (source: string, cible: string, suffixe = '') => {
    const valeur = values[source]?.trim();
    if (valeur) attributes[cible] = `${valeur}${suffixe}`;
  };
  reprendre('type', 'type');
  reprendre('power', 'puissance');
  reprendre('withCase', 'avec_boitier');
  reprendre('withCable', 'avec_cable');
  reprendre('color', 'couleur');
  reprendre('capacity', 'capacite');
  reprendre('warranty', 'garantie', ' mois');
  reprendre('batteryHealth', 'batterie', ' %');
  reprendre('cycles', 'cycles');
  return attributes;
}

/**
 * Désignation d'une ligne.
 *
 * Les fichiers réels ne portent pas de désignation : ils décrivent un article
 * par sa marque, son modèle et un qualificatif (« 45W », « Verre », « avec
 * boîtier »). On la compose donc, dans l'ordre où un vendeur la prononcerait.
 *
 * Les qualificatifs entrent dans le NOM et pas seulement dans les attributs :
 * sans eux, deux chargeurs Samsung de 25 et 45 W porteraient le même nom, donc
 * la même référence dérivée, et le second écraserait le premier. La couleur et
 * la mémoire en sont exclues : ce sont des axes de variante, affichés à part.
 */
function composeName(values: Record<string, string>, sansMarque = false): string {
  const explicite = (values['name'] ?? '').trim();
  if (explicite !== '') return explicite;

  const morceaux: string[] = [];
  const ajouter = (valeur: string | undefined) => {
    const propre = valeur?.trim();
    if (propre && !morceaux.some((m) => m.toLowerCase() === propre.toLowerCase())) {
      morceaux.push(propre);
    }
  };
  if (!sansMarque) ajouter(values['brand']);
  ajouter(values['model']);

  // « Oui / Non » ne dit rien hors de son en-tête : on reprend le libellé de la
  // colonne quand c'est oui, et l'on tait la ligne quand c'est non.
  const drapeau = (cle: string, libelle: string) => {
    const valeur = values[cle]?.trim().toLowerCase();
    if (!valeur) return;
    if (['non', 'no', 'n', '0', 'false', 'sans'].includes(valeur)) return;
    if (['oui', 'yes', 'o', 'y', '1', 'true', 'avec'].includes(valeur)) ajouter(libelle);
    else ajouter(values[cle]);
  };
  ajouter(values['type']);
  ajouter(values['power']);
  drapeau('withCase', 'avec boîtier');
  drapeau('withCable', 'avec câble');

  return morceaux.join(' ');
}

/**
 * Références saisies qui reviennent sur plusieurs lignes du fichier.
 *
 * Relever d'avance ce que chaque référence couvre est nécessaire : la PREMIÈRE
 * ligne doit déjà savoir que l'article est partagé, sans quoi elle prendrait le
 * nom du premier téléphone rencontré et le catalogue s'appellerait « Samsung
 * S23 Ultra Standard 9H » pour un verre qui va sur dix appareils.
 */
function recenserReferencesPartagees(
  sheet: SheetData,
  mapping: Record<number, string>,
): Map<string, { marques: string[]; prix: Set<string> }> {
  const releve = new Map<string, { marques: string[]; prix: Set<string> }>();
  for (const raw of sheet.rows) {
    const lu: Record<string, string> = {};
    for (const [column, key] of Object.entries(mapping)) {
      const value = raw[Number(column)] ?? '';
      if (value !== '') lu[key] = value;
    }
    const reference = (lu['sku'] ?? '').trim();
    if (reference === '') continue;

    const entree = releve.get(reference) ?? { marques: [], prix: new Set<string>() };
    const marque = (lu['brand'] ?? '').trim();
    if (marque && !entree.marques.some((connue) => connue.toLowerCase() === marque.toLowerCase())) {
      entree.marques.push(marque);
    }
    const prix = (lu['salePrice'] ?? '').trim();
    if (prix) entree.prix.add(prix);
    releve.set(reference, entree);
  }
  return releve;
}
