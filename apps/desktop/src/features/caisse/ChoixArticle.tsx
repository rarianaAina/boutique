import { useMemo, useState } from 'react';
import { variantLabel } from '@boutique/shared';
import type { Product, ProductUnit } from '@boutique/shared';
import {
  ProductRepository,
  type ProductWithStock,
} from '@/core/db/repositories/product.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Badge, BadgeUnite } from '@/components/ui/Badge';
import { Chargement, Erreur, Information, Vide } from '@/components/ui/Page';
import { ChampRecherche } from '@/components/ui/Tableau';
import { useSession } from '@/app/session';
import { formaterDate, useChargement, useMonnaie } from '@/app/hooks';

/**
 * Choix d'un article au comptoir.
 *
 * DEUX BESOINS, ET UN SEUL ÉCRAN.
 *
 * 1. LA VARIANTE. « iPhone 17 Pro Max » n'est pas un article : il faut dire
 *    lequel — rouge 256 Go, noir 128 Go. Les capacités et les couleurs
 *    réellement au catalogue sont proposées, y compris celles à zéro : un
 *    vendeur doit pouvoir répondre « le rouge, je ne l'ai plus » plutôt que de
 *    laisser croire qu'il n'existe pas.
 *
 * 2. L'APPAREIL. Le scanner tombe en panne, le code-barres est décollé, le
 *    téléphone est déjà déballé — et la vente ne doit pas s'arrêter là. La
 *    liste des exemplaires disponibles permet d'en désigner un à l'œil, avec
 *    son IMEI, son état et sa date d'entrée. Scanner reste le geste le plus
 *    rapide ; ce n'est plus le seul.
 */
export function ChoixArticle({
  produit,
  onFermer,
  onChoisir,
}: {
  produit: Product;
  onFermer: () => void;
  /** Une unité pour un produit identifié, `null` pour une quantité. */
  onChoisir: (produit: Product, unite: ProductUnit | null) => void;
}) {
  const { db, shopId } = useSession();
  const monnaie = useMonnaie();
  const [variantChoisie, setVariantChoisie] = useState<string>(produit.id);
  const [filtre, setFiltre] = useState('');

  const variantes = useChargement(async () => {
    if (!db) return [] as ProductWithStock[];
    if (!produit.variantGroup) {
      const page = await new ProductRepository(db).search({ shopId, query: produit.sku, limit: 1 });
      return page.items;
    }
    return new ProductRepository(db).variantsOf(produit.variantGroup, shopId);
  }, [db, shopId, produit.variantGroup, produit.sku]);

  const courante = useMemo(
    () => (variantes.donnees ?? []).find((element) => element.id === variantChoisie) ?? null,
    [variantes.donnees, variantChoisie],
  );

  const unites = useChargement(async () => {
    if (!db || !courante || courante.tracking === 'QUANTITY') return [] as ProductUnit[];
    return new UnitRepository(db).availableFor(courante.id, shopId, 200);
  }, [db, shopId, courante?.id, courante?.tracking]);

  /* Les axes ne sont proposés que s'ils VARIENT : afficher un unique bouton
     « 256 Go » ferait cliquer pour rien. */
  const capacites = axes(variantes.donnees ?? [], (element) => element.capacity);
  const couleurs = axes(variantes.donnees ?? [], (element) => element.color);
  const plusieurs = (variantes.donnees ?? []).length > 1;

  const choisirAxe = (capacite: string | null, couleur: string | null) => {
    const cible = (variantes.donnees ?? []).find(
      (element) =>
        (capacite === null || element.capacity === capacite) &&
        (couleur === null || element.color === couleur),
    );
    if (cible) setVariantChoisie(cible.id);
  };

  const listeUnites = (unites.donnees ?? []).filter((unite) => {
    const terme = filtre.trim().toLowerCase();
    if (terme === '') return true;
    return [unite.imei1, unite.imei2, unite.serial]
      .filter(Boolean)
      .some((valeur) => valeur!.toLowerCase().includes(terme));
  });

  return (
    <Dialogue
      ouvert
      titre={produit.name}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton onClick={onFermer}>Annuler</Bouton>
          {courante?.tracking === 'QUANTITY' ? (
            <Bouton
              variante="principal"
              icone="plus"
              disabled={!courante}
              onClick={() => courante && onChoisir(courante, null)}
            >
              Ajouter au panier
            </Bouton>
          ) : (
            <Bouton
              variante="principal"
              icone="plus"
              disabled={listeUnites.length === 0}
              onClick={() => {
                const premiere = listeUnites[0];
                if (courante && premiere) onChoisir(courante, premiere);
              }}
            >
              Prendre le plus ancien
            </Bouton>
          )}
        </>
      }
    >
      {variantes.chargement ? (
        <Chargement />
      ) : variantes.erreur ? (
        <Erreur message={variantes.erreur} />
      ) : (
        <div className="space-y-4">
          {plusieurs ? (
            <section className="space-y-3">
              {capacites.length > 1 ? (
                <Axe
                  titre="Mémoire"
                  valeurs={capacites}
                  actif={courante?.capacity ?? null}
                  disponible={(valeur) =>
                    (variantes.donnees ?? []).some(
                      (element) => element.capacity === valeur && element.available > 0,
                    )
                  }
                  onChoisir={(valeur) => choisirAxe(valeur, courante?.color ?? null)}
                />
              ) : null}
              {couleurs.length > 1 ? (
                <Axe
                  titre="Couleur"
                  valeurs={couleurs}
                  actif={courante?.color ?? null}
                  disponible={(valeur) =>
                    (variantes.donnees ?? []).some(
                      (element) => element.color === valeur && element.available > 0,
                    )
                  }
                  onChoisir={(valeur) => choisirAxe(courante?.capacity ?? null, valeur)}
                />
              ) : null}
              {capacites.length <= 1 && couleurs.length <= 1 ? (
                <Axe
                  titre="Déclinaison"
                  valeurs={(variantes.donnees ?? []).map((element) => element.sku)}
                  actif={courante?.sku ?? null}
                  disponible={(valeur) =>
                    (variantes.donnees ?? []).some(
                      (element) => element.sku === valeur && element.available > 0,
                    )
                  }
                  onChoisir={(valeur) => {
                    const cible = (variantes.donnees ?? []).find(
                      (element) => element.sku === valeur,
                    );
                    if (cible) setVariantChoisie(cible.id);
                  }}
                />
              ) : null}
            </section>
          ) : null}

          {courante ? (
            <div className="flex items-center justify-between rounded-md bg-encre-100 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-medium text-encre-900">
                  {courante.name}
                  {variantLabel(courante.color, courante.capacity) ? (
                    <span className="ml-2 text-encre-600">
                      {variantLabel(courante.color, courante.capacity)}
                    </span>
                  ) : null}
                </p>
                <p className="mono text-xs text-encre-500">{courante.sku}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold" data-nombre>
                  {monnaie(courante.salePrice)}
                </p>
                <p className="text-xs text-encre-500">{courante.available} disponible(s)</p>
              </div>
            </div>
          ) : null}

          {courante && courante.tracking !== 'QUANTITY' ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-encre-800">Appareils disponibles</h3>
                <ChampRecherche
                  valeur={filtre}
                  onChanger={setFiltre}
                  placeholder="Filtrer par IMEI…"
                  largeur="w-56"
                />
              </div>

              {unites.chargement ? (
                <Chargement />
              ) : listeUnites.length === 0 ? (
                <Vide
                  icone="telephone"
                  titre="Aucun appareil disponible"
                  detail="Cette déclinaison n'a plus de stock dans cette boutique. Choisissez-en une autre, ou demandez un transfert."
                />
              ) : (
                <div className="max-h-72 overflow-auto rounded-md border border-encre-200">
                  <table className="tableau">
                    <thead>
                      <tr>
                        <th>Identifiant</th>
                        <th>État</th>
                        <th>Statut</th>
                        <th>Entré le</th>
                        <th style={{ width: '6rem' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {listeUnites.map((unite) => (
                        <tr key={unite.id}>
                          <td className="mono">{unite.imei1 ?? unite.serial ?? '—'}</td>
                          <td>
                            <Badge ton="neutre">{unite.condition}</Badge>
                          </td>
                          <td>
                            <BadgeUnite statut={unite.status} />
                          </td>
                          <td>{formaterDate(unite.receivedAt)}</td>
                          <td>
                            <Bouton
                              taille="petit"
                              variante="principal"
                              onClick={() => onChoisir(courante, unite)}
                            >
                              Choisir
                            </Bouton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Information>
                Scanner l'IMEI reste le geste le plus rapide, mais il n'est pas obligatoire :
                désignez l'appareil dans cette liste si le scanner est indisponible.
              </Information>
            </section>
          ) : null}
        </div>
      )}
    </Dialogue>
  );
}

/** Boutons d'un axe de variation : mémoire, couleur. */
function Axe({
  titre,
  valeurs,
  actif,
  disponible,
  onChoisir,
}: {
  titre: string;
  valeurs: string[];
  actif: string | null;
  disponible: (valeur: string) => boolean;
  onChoisir: (valeur: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-encre-600">{titre}</p>
      <div className="flex flex-wrap gap-1.5">
        {valeurs.map((valeur) => {
          const enStock = disponible(valeur);
          const choisi = actif === valeur;
          return (
            <button
              key={valeur}
              type="button"
              onClick={() => onChoisir(valeur)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                choisi
                  ? 'border-marque-600 bg-marque-600 font-medium text-white'
                  : enStock
                    ? 'border-encre-300 bg-white text-encre-800 hover:border-marque-400'
                    : // Épuisé : proposé quand même, mais visiblement en retrait.
                      'border-encre-200 bg-encre-50 text-encre-400 hover:border-encre-300'
              }`}
            >
              {valeur}
              {!enStock ? <span className="ml-1.5 text-xs">épuisé</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Valeurs distinctes d'un axe, dans l'ordre du catalogue. */
function axes(
  variantes: readonly ProductWithStock[],
  lire: (produit: ProductWithStock) => string | null,
): string[] {
  const vues = new Set<string>();
  for (const variante of variantes) {
    const valeur = lire(variante)?.trim();
    if (valeur) vues.add(valeur);
  }
  return [...vues];
}
