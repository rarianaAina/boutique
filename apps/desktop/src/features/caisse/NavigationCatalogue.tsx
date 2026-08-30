import { useMemo, useState } from 'react';
import { variantLabel } from '@boutique/shared';
import {
  ProductRepository,
  type ProductWithStock,
} from '@/core/db/repositories/product.repository';
import { CategoryRepository } from '@/core/db/repositories/category.repository';
import { useSession } from '@/app/session';
import { useChargement, useMonnaie } from '@/app/hooks';
import { Badge } from '@/components/ui/Badge';
import { Icone } from '@/components/ui/Icone';
import { Bouton } from '@/components/ui/Bouton';
import { Chargement, Vide } from '@/components/ui/Page';
import {
  axeSeparant,
  axesPour,
  filtrer,
  libelleValeur,
  correspond,
  valeursDe,
  type Etape,
} from '@/core/catalogue/facettes';

/**
 * Parcours du catalogue au comptoir (§7).
 *
 * Un vendeur ne connaît pas la référence d'un cache-écran : on lui demande
 * « un hydrogel pour un S23 ». Le champ de recherche sert au scan et aux
 * articles qu'on sait nommer ; ce navigateur sert à tout le reste.
 *
 * Le parcours n'est pas figé à deux niveaux : on affiche les catégories, puis
 * on descend tant qu'un critère SÉPARE encore les articles restants — le type,
 * puis la puissance, puis la couleur. Une catégorie de deux articles s'ouvre
 * donc directement sur ses deux articles, sans écran intermédiaire inutile.
 */

export function NavigationCatalogue({
  onChoisir,
}: {
  onChoisir: (produit: ProductWithStock) => void;
}) {
  const { db, shopId } = useSession();
  const [categorie, setCategorie] = useState<{ id: string; nom: string } | null>(null);
  const [etapes, setEtapes] = useState<Etape[]>([]);
  /** Sortie de secours : afficher le lot entier sans descendre plus bas. */
  const [toutVoir, setToutVoir] = useState(false);

  const revenirAuxCategories = () => {
    setCategorie(null);
    setEtapes([]);
    setToutVoir(false);
  };

  const categories = useChargement(async () => {
    if (!db) return [];
    const liste = await new CategoryRepository(db).list();
    // Le compte sert aussi à masquer les catégories vides : au comptoir, une
    // tuile qui ne mène à rien est une perte de temps répétée cent fois.
    const comptes = await new ProductRepository(db).countByCategory();
    return liste
      .map((element) => ({
        id: element.id,
        nom: element.name,
        compte: comptes.get(element.id) ?? 0,
      }))
      .filter((element) => element.compte > 0);
  }, [db, shopId]);

  const identifiantCategorie = categorie?.id ?? null;
  const produits = useChargement(async () => {
    if (!db || !identifiantCategorie) return [];
    const page = await new ProductRepository(db).search({
      shopId,
      categoryId: identifiantCategorie,
      limit: 500,
    });
    return page.items;
  }, [db, shopId, identifiantCategorie]);

  const restants = useMemo(
    () => filtrer(produits.donnees ?? [], etapes),
    [produits.donnees, etapes],
  );

  // L'ordre de descente dépend du rayon ouvert : un smartphone se choisit par
  // marque, un cache-écran par type.
  const axes = useMemo(() => axesPour(categorie?.nom), [categorie?.nom]);

  const suivant = useMemo(
    () =>
      toutVoir
        ? null
        : axeSeparant(
            restants,
            etapes.map((etape) => etape.axe.cle),
            axes,
          ),
    [restants, etapes, toutVoir, axes],
  );

  /* ─── Fil d'Ariane ──────────────────────────────────────────────────────
     Il ne décore pas : au comptoir on se trompe de branche, et remonter d'un
     niveau doit coûter un clic, jamais un retour à zéro. */
  const fil = (
    <div className="flex flex-wrap items-center gap-1 border-b border-encre-200 px-2 py-2 text-sm">
      <Miette libelle="Catégories" onClick={revenirAuxCategories} />
      {categorie ? (
        <>
          <Separateur />
          <Miette
            libelle={categorie.nom}
            onClick={() => {
              setEtapes([]);
              setToutVoir(false);
            }}
          />
        </>
      ) : null}
      {etapes.map((etape, index) => (
        <span key={etape.axe.cle} className="flex items-center gap-1">
          <Separateur />
          <Miette
            libelle={libelleValeur(etape.valeur, etape.axe)}
            onClick={() => {
              setEtapes(etapes.slice(0, index + 1));
              setToutVoir(false);
            }}
          />
        </span>
      ))}
    </div>
  );

  if (!categorie) {
    if (categories.chargement) return <Chargement />;
    const liste = categories.donnees ?? [];
    if (liste.length === 0) {
      return (
        <Vide
          icone="boite"
          titre="Aucun rayon en stock"
          detail="Importez un fichier ou créez des produits pour voir apparaître les catégories."
        />
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {fil}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <Tuiles>
            {liste.map((element) => (
              <Tuile
                key={element.id}
                titre={element.nom}
                detail={compter(element.compte)}
                onClick={() => {
                  setCategorie({ id: element.id, nom: element.nom });
                  setEtapes([]);
                  setToutVoir(false);
                }}
              />
            ))}
          </Tuiles>
        </div>
      </div>
    );
  }

  if (produits.chargement) return <Chargement />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fil}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {suivant ? (
          <>
            <p className="mb-2 px-0.5 text-sm text-encre-600">{suivant.label}</p>
            <Tuiles>
              {valeursDe(restants, suivant).map((valeur) => (
                <Tuile
                  key={valeur}
                  titre={libelleValeur(valeur, suivant)}
                  detail={compter(
                    restants.filter((produit) => correspond(produit, suivant, valeur)).length,
                  )}
                  onClick={() => setEtapes([...etapes, { axe: suivant, valeur }])}
                />
              ))}
            </Tuiles>
            <div className="mt-3">
              <Bouton taille="petit" variante="discret" onClick={() => setToutVoir(true)}>
                Voir les {restants.length} articles sans distinguer
              </Bouton>
            </div>
          </>
        ) : restants.length === 0 ? (
          <Vide icone="boite" titre="Rien à cet endroit du catalogue" />
        ) : (
          <Tuiles>
            {restants.map((produit) => (
              <TuileProduit key={produit.id} produit={produit} onClick={() => onChoisir(produit)} />
            ))}
          </Tuiles>
        )}
      </div>
    </div>
  );
}

function compter(nombre: number): string {
  return `${nombre} article${nombre > 1 ? 's' : ''}`;
}

function Separateur() {
  return <span className="text-encre-300">/</span>;
}

function Miette({ libelle, onClick }: { libelle: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-marque-700 hover:bg-marque-50"
    >
      {libelle}
    </button>
  );
}

function Tuiles({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2.5">{children}</div>
  );
}

function Tuile({
  titre,
  detail,
  onClick,
}: {
  titre: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[4.5rem] flex-col justify-center gap-1 rounded-lg border border-encre-200 bg-white px-3.5 py-3 text-left shadow-carte transition hover:border-marque-400 hover:bg-marque-50/40 focus:border-marque-500 focus:outline-none"
    >
      <span className="font-medium leading-tight text-encre-900">{titre}</span>
      {detail ? <span className="text-xs text-encre-500">{detail}</span> : null}
    </button>
  );
}

function TuileProduit({ produit, onClick }: { produit: ProductWithStock; onClick: () => void }) {
  const monnaie = useMonnaie();
  const declinaison = variantLabel(produit.color, produit.capacity);
  return (
    <button
      type="button"
      onClick={onClick}
      // Un article en rupture reste VISIBLE et cliquable : le vendeur doit
      // pouvoir en annoncer le prix et le délai, pas le chercher en vain.
      className="flex min-h-[5.5rem] flex-col justify-between gap-1 rounded-lg border border-encre-200 bg-white px-3.5 py-3 text-left shadow-carte transition hover:border-marque-400 hover:bg-marque-50/40 focus:border-marque-500 focus:outline-none"
    >
      <span className="font-medium leading-tight text-encre-900">{produit.name}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-encre-500">
        {declinaison ? <span>{declinaison}</span> : null}
        {produit.available <= 0 ? (
          <Badge ton="danger">Rupture</Badge>
        ) : (
          <span>{produit.available} dispo.</span>
        )}
      </span>
      <span className="flex items-center justify-between text-sm font-medium text-encre-900">
        {monnaie(produit.salePrice)}
        <span className="text-encre-300">
          <Icone nom="chevron" taille={14} />
        </span>
      </span>
    </button>
  );
}
