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

    const name = (values['name'] ?? '').trim();
    if (name === '') problems.push('Désignation manquante.');

    const condition = values['condition'] ? parseCondition(values['condition']) : null;

    // Référence : celle du fichier, ou une référence dérivée du modèle. Ce qui
    // distingue un modèle d'un autre entre dans la dérivation — deux housses
    // « Samsung » de capacité et de couleur identiques SONT le même produit.
    const providedSku = (values['sku'] ?? '').trim();
    const skuDerived = providedSku === '';
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
    const tracking = (declared ??
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
    // Et la nature du doublon compte : une référence SAISIE deux fois est une
    // faute de saisie à corriger ; une référence DÉRIVÉE qui se répète signale
    // seulement que le fichier ne permet pas de distinguer deux lignes. Dans ce
    // second cas, la ligne est ignorée avec un avertissement, pas rejetée.
    let duplicateOfLine: number | null = null;
    if (sku !== '' && tracking === TRACKING.quantity) {
      const previous = seenSkus.get(sku);
      if (previous !== undefined) {
        duplicateOfLine = previous;
        if (skuDerived) {
          warnings.push(
            `Même modèle qu'à la ligne ${previous} : ligne ignorée, les quantités ne sont pas cumulées.`,
          );
        } else {
          problems.push(`Le SKU ${sku} apparaît déjà ligne ${previous}.`);
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
      categoryLabel: values['category']?.trim() || null,
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
              attributes: attributesOf(values),
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
function attributesOf(values: Record<string, string>): Record<string, string> {
  const attributes: Record<string, string> = {};
  const reprendre = (source: string, cible: string, suffixe = '') => {
    const valeur = values[source]?.trim();
    if (valeur) attributes[cible] = `${valeur}${suffixe}`;
  };
  reprendre('color', 'couleur');
  reprendre('capacity', 'capacite');
  reprendre('location', 'emplacement');
  reprendre('warranty', 'garantie', ' mois');
  reprendre('batteryHealth', 'batterie', ' %');
  reprendre('cycles', 'cycles');
  return attributes;
}
