import type { Money } from '@boutique/shared';
import type { SqlExecutor } from '../db/client';

/**
 * Méthode de valorisation des sorties de stock.
 *
 * OÙ EN EST LE LOGICIEL, PRÉCISÉMENT :
 *
 *  - Les produits suivis par IMEI ou par numéro de série relèvent de
 *    l'IDENTIFICATION SPÉCIFIQUE, et pas du FIFO : chaque appareil porte son
 *    propre coût d'acquisition, frais logistiques ventilés compris, et c'est
 *    CE coût qui est figé sur la ligne de vente. C'est plus exact que le FIFO —
 *    on ne suppose pas quel exemplaire est parti, on le sait. La liste des
 *    exemplaires disponibles est d'ailleurs triée du plus ancien au plus
 *    récent, ce qui rend l'écoulement FIFO naturel sans jamais l'imposer.
 *
 *  - Les produits suivis par QUANTITÉ n'ont pas d'exemplaire identifiable. Il
 *    faut donc une convention, et c'est ici qu'un choix se pose :
 *
 *      CATALOGUE — le prix d'achat de la fiche produit au moment de la vente.
 *                  Simple et prévisible, mais la marge suit les décisions de
 *                  prix plutôt que les couches réellement achetées.
 *      FIFO      — les couches d'entrée sont consommées dans l'ordre
 *                  d'arrivée. La marge reflète alors ce qui a réellement été
 *                  payé pour les unités qui sortent.
 *
 * Le choix est un paramètre de boutique, et CATALOGUE reste la valeur par
 * défaut : basculer une base existante en FIFO changerait rétroactivement la
 * lecture des marges à venir, ce qui ne doit pas arriver sans décision.
 */

export type CostMethod = 'CATALOGUE' | 'FIFO';

interface Layer {
  quantity: number;
  unitCost: number | null;
}

/**
 * Coût unitaire moyen des `quantity` prochaines unités à sortir, en FIFO.
 *
 * Les couches sont RECALCULÉES à chaque appel depuis les mouvements, plutôt
 * que tenues dans une table dédiée. Deux raisons : les mouvements font déjà
 * foi — c'est d'eux qu'on reconstruit un stock qui aurait divergé — et une
 * table de couches à maintenir en parallèle finirait par s'en écarter, sans
 * qu'on sache laquelle croire.
 *
 * Une ligne de vente ne porte qu'UN coût unitaire : quand la sortie enjambe
 * plusieurs couches, on renvoie leur moyenne pondérée. C'est exact au total,
 * qui est la seule chose qui compte pour la marge.
 */
export async function fifoUnitCost(
  db: SqlExecutor,
  productId: string,
  shopId: string,
  quantity: number,
  fallback: Money,
): Promise<Money> {
  if (quantity <= 0) return fallback;

  // Entrées : réceptions, retours, transferts entrants. L'ordre est celui de
  // l'arrivée réelle, départagé par le `rowid` quand deux mouvements tombent
  // dans la même milliseconde.
  const entrees = await db.select<Layer>(
    `SELECT quantity, unit_cost AS unitCost
     FROM stock_movement
     WHERE product_id = ? AND shop_id = ? AND unit_id IS NULL AND quantity > 0
     ORDER BY occurred_at, rowid`,
    [productId, shopId],
  );
  if (entrees.length === 0) return fallback;

  const sorties = await db.select<{ total: number }>(
    `SELECT COALESCE(SUM(-quantity), 0) AS total
     FROM stock_movement
     WHERE product_id = ? AND shop_id = ? AND unit_id IS NULL AND quantity < 0`,
    [productId, shopId],
  );

  // Les couches déjà consommées sont sautées : c'est ce qui fait le « premier
  // entré, premier sorti ».
  let aSauter = sorties[0]?.total ?? 0;
  let restant = quantity;
  let cumul = 0;
  let pris = 0;

  for (const couche of entrees) {
    let disponible = couche.quantity;
    if (aSauter > 0) {
      const saute = Math.min(aSauter, disponible);
      aSauter -= saute;
      disponible -= saute;
    }
    if (disponible <= 0) continue;

    const prises = Math.min(disponible, restant);
    // Une entrée sans coût — une correction d'inventaire, par exemple — est
    // valorisée au prix catalogue : l'ignorer décalerait toutes les couches
    // suivantes et fausserait le FIFO bien au-delà de cette unité.
    cumul += prises * (couche.unitCost ?? fallback);
    pris += prises;
    restant -= prises;
    if (restant <= 0) break;
  }

  // Stock épuisé ou négatif : le solde manquant est valorisé au prix catalogue.
  if (restant > 0) {
    cumul += restant * fallback;
    pris += restant;
  }

  return pris > 0 ? Math.round(cumul / pris) : fallback;
}

/**
 * Couches d'entrée encore en stock, de la plus ancienne à la plus récente.
 *
 * Sert à montrer au gérant ce que le FIFO consommera en premier — et, à
 * l'écran des prix, à expliquer d'où vient le coût d'une vente.
 */
export async function remainingLayers(
  db: SqlExecutor,
  productId: string,
  shopId: string,
): Promise<{ quantity: number; unitCost: number | null; at: string; label: string | null }[]> {
  const entrees = await db.select<{
    quantity: number;
    unitCost: number | null;
    at: string;
    label: string | null;
  }>(
    `SELECT quantity, unit_cost AS unitCost, occurred_at AS at, source_label AS label
     FROM stock_movement
     WHERE product_id = ? AND shop_id = ? AND unit_id IS NULL AND quantity > 0
     ORDER BY occurred_at, rowid`,
    [productId, shopId],
  );
  const sorties = await db.select<{ total: number }>(
    `SELECT COALESCE(SUM(-quantity), 0) AS total
     FROM stock_movement
     WHERE product_id = ? AND shop_id = ? AND unit_id IS NULL AND quantity < 0`,
    [productId, shopId],
  );

  let aSauter = sorties[0]?.total ?? 0;
  const restantes: {
    quantity: number;
    unitCost: number | null;
    at: string;
    label: string | null;
  }[] = [];

  for (const couche of entrees) {
    let disponible = couche.quantity;
    if (aSauter > 0) {
      const saute = Math.min(aSauter, disponible);
      aSauter -= saute;
      disponible -= saute;
    }
    if (disponible > 0) restantes.push({ ...couche, quantity: disponible });
  }
  return restantes;
}
