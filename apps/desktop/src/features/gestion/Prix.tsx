import { useState } from 'react';
import {
  PriceHistoryRepository,
  type PriceKind,
  type PricePoint,
} from '@/core/db/repositories/price-history.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import {
  Carte,
  CarteChiffre,
  Chargement,
  EnTetePage,
  Erreur,
  Information,
  Vide,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { BarreFiltres, ChampRecherche, ListeFiltre, Tableau } from '@/components/ui/Tableau';
import { useSession } from '@/app/session';
import { formaterDate, useChargement, useDifferee, useMonnaie } from '@/app/hooks';
import { telecharger } from './telechargement';

/**
 * Évolution des prix (§5, §22).
 *
 * L'écran répond à la question que pose tout gérant dont les fournisseurs
 * bougent : « ce que je paie aujourd'hui correspond-il encore à ce que dit ma
 * fiche produit ? »
 *
 * DEUX NATURES D'INFORMATION, jamais mélangées :
 *
 *  - le prix CATALOGUE est une décision — quelqu'un l'a saisie ;
 *  - le prix CONSTATÉ est un fait — ce que le fournisseur a réellement facturé,
 *    frais logistiques ventilés compris.
 *
 * L'ÉCART entre les deux est ce qui doit alerter : un prix d'achat catalogue
 * périmé fausse la marge de chaque vente, en silence, jusqu'à ce que quelqu'un
 * compare. C'est donc lui qui ouvre l'écran.
 */
const LIBELLES_NATURE: Record<PriceKind, { texte: string; ton: 'info' | 'neutre' | 'succes' }> = {
  OBSERVED_PURCHASE: { texte: 'Coût constaté', ton: 'info' },
  PURCHASE: { texte: "Prix d'achat catalogue", ton: 'neutre' },
  SALE: { texte: 'Prix de vente', ton: 'succes' },
  MIN: { texte: 'Prix plancher', ton: 'neutre' },
};

export function Prix() {
  const { db, settings } = useSession();
  const monnaie = useMonnaie();
  const [seuil, setSeuil] = useState('5');
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [ouvert, setOuvert] = useState<{ id: string; nom: string } | null>(null);

  const ecarts = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new PriceHistoryRepository(db).divergences(Number(seuil) || 0, 200);
  }, [db, seuil]);

  const recents = useChargement(async () => {
    if (!db) return [] as (PricePoint & { productName: string })[];
    const rows = await db.select<{
      id: string;
      product_id: string;
      product_name: string;
      kind: PriceKind;
      old_value: number | null;
      new_value: number;
      source: string;
      source_label: string | null;
      supplier_name: string | null;
      user_label: string | null;
      at: string;
    }>(
      `SELECT h.id, h.product_id, p.name AS product_name, h.kind, h.old_value, h.new_value,
              h.source, h.source_label, s.name AS supplier_name, h.user_label, h.at
       FROM price_history h
       JOIN product p ON p.id = h.product_id
       LEFT JOIN supplier s ON s.id = h.supplier_id
       ${differee.trim() ? "WHERE p.search_key LIKE ? ESCAPE '\\\\'" : ''}
       ORDER BY h.at DESC, h.id DESC
       LIMIT 200`,
      differee.trim() ? [`%${differee.trim().toLowerCase()}%`] : [],
    );
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      kind: row.kind,
      oldValue: row.old_value,
      newValue: row.new_value,
      source: row.source as PricePoint['source'],
      sourceId: null,
      sourceLabel: row.source_label,
      supplierId: null,
      supplierName: row.supplier_name,
      userLabel: row.user_label,
      note: null,
      at: row.at,
    }));
  }, [db, differee]);

  const hausses = (ecarts.donnees ?? []).filter((ligne) => ligne.variationPercent > 0);
  const baisses = (ecarts.donnees ?? []).filter((ligne) => ligne.variationPercent < 0);

  const exporter = () => {
    if (!ecarts.donnees) return;
    telecharger(
      exportFileName('ecarts-de-prix'),
      toCsv(ecarts.donnees, [
        { header: 'SKU', value: (l) => l.sku },
        { header: 'Produit', value: (l) => l.name },
        { header: 'Fournisseur', value: (l) => l.supplierName ?? '' },
        {
          header: "Prix d'achat catalogue",
          value: (l) => csvMoney(l.cataloguePrice, settings.currency),
        },
        {
          header: 'Coût réel constaté',
          value: (l) => csvMoney(l.observedPrice, settings.currency),
        },
        { header: 'Écart %', value: (l) => l.variationPercent },
        { header: 'Constaté le', value: (l) => formaterDate(l.at) },
      ]),
    );
  };

  return (
    <div className="space-y-4">
      <EnTetePage
        titre="Évolution des prix"
        sousTitre="Ce que vous avez décidé, et ce que vos fournisseurs facturent réellement."
        actions={
          <Bouton icone="export" onClick={exporter} disabled={!ecarts.donnees}>
            Exporter les écarts
          </Bouton>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CarteChiffre
          libelle="Produits en écart"
          valeur={ecarts.donnees?.length ?? 0}
          detail={`au-delà de ${seuil} %`}
          icone="alerte"
          ton={(ecarts.donnees?.length ?? 0) > 0 ? 'attente' : 'neutre'}
        />
        <CarteChiffre
          libelle="Hausses fournisseur"
          valeur={hausses.length}
          detail="coût réel supérieur au catalogue"
          icone="mouvement"
          ton={hausses.length > 0 ? 'danger' : 'neutre'}
        />
        <CarteChiffre
          libelle="Baisses fournisseur"
          valeur={baisses.length}
          detail="marge sous-estimée"
          icone="mouvement"
          ton="succes"
        />
        <CarteChiffre
          libelle="Changements enregistrés"
          valeur={recents.donnees?.length ?? 0}
          detail="derniers mouvements de prix"
          icone="rapport"
        />
      </div>

      <Carte
        titre="Écarts entre le prix catalogue et le coût réel"
        compact
        actions={
          <ListeFiltre
            valeur={seuil}
            onChanger={setSeuil}
            options={[
              { valeur: '0', libelle: 'Tout écart' },
              { valeur: '2', libelle: 'Au-delà de 2 %' },
              { valeur: '5', libelle: 'Au-delà de 5 %' },
              { valeur: '10', libelle: 'Au-delà de 10 %' },
            ]}
          />
        }
      >
        {ecarts.erreur ? (
          <Erreur message={ecarts.erreur} />
        ) : (
          <>
            {(ecarts.donnees?.length ?? 0) > 0 ? (
              <Information>
                Le prix d'achat de la fiche produit sert au calcul de la marge. Tant qu'il ne suit
                pas le coût réel, chaque vente de ces produits affiche une marge fausse.
              </Information>
            ) : null}
            <Tableau
              chargement={ecarts.chargement}
              lignes={ecarts.donnees ?? []}
              cleDe={(ligne) => ligne.productId}
              onLigneCliquee={(ligne) => setOuvert({ id: ligne.productId, nom: ligne.name })}
              vide={{
                icone: 'check',
                titre: 'Aucun écart significatif',
                detail: 'Les prix catalogue suivent les coûts réellement facturés.',
              }}
              colonnes={[
                {
                  cle: 'produit',
                  titre: 'Produit',
                  rendu: (l) => (
                    <div>
                      <div className="font-medium text-encre-900">{l.name}</div>
                      <div className="mono text-xs text-encre-500">{l.sku}</div>
                    </div>
                  ),
                },
                { cle: 'fournisseur', titre: 'Fournisseur', rendu: (l) => l.supplierName ?? '—' },
                {
                  cle: 'catalogue',
                  titre: 'Catalogue',
                  num: true,
                  rendu: (l) => monnaie(l.cataloguePrice),
                },
                {
                  cle: 'reel',
                  titre: 'Coût réel',
                  num: true,
                  rendu: (l) => <span className="font-medium">{monnaie(l.observedPrice)}</span>,
                },
                {
                  cle: 'ecart',
                  titre: 'Écart',
                  num: true,
                  rendu: (l) => (
                    <Badge ton={l.variationPercent > 0 ? 'danger' : 'succes'}>
                      {l.variationPercent > 0 ? '+' : ''}
                      {l.variationPercent} %
                    </Badge>
                  ),
                },
                { cle: 'date', titre: 'Constaté le', rendu: (l) => formaterDate(l.at) },
              ]}
            />
          </>
        )}
      </Carte>

      <Carte titre="Derniers changements de prix" compact>
        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={setRecherche}
            placeholder="Filtrer par produit…"
            largeur="w-72"
          />
        </BarreFiltres>
        {recents.erreur ? (
          <Erreur message={recents.erreur} />
        ) : (
          <Tableau
            chargement={recents.chargement}
            lignes={recents.donnees ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setOuvert({ id: ligne.productId, nom: ligne.productName })}
            vide={{ icone: 'rapport', titre: 'Aucun changement de prix enregistré' }}
            colonnes={[
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.at, true) },
              { cle: 'produit', titre: 'Produit', rendu: (l) => l.productName },
              {
                cle: 'nature',
                titre: 'Nature',
                rendu: (l) => (
                  <Badge ton={LIBELLES_NATURE[l.kind].ton}>{LIBELLES_NATURE[l.kind].texte}</Badge>
                ),
              },
              {
                cle: 'variation',
                titre: 'Variation',
                num: true,
                rendu: (l) => <Variation ancien={l.oldValue} nouveau={l.newValue} />,
              },
              {
                cle: 'origine',
                titre: 'Origine',
                rendu: (l) => l.sourceLabel ?? l.supplierName ?? l.userLabel ?? '—',
              },
            ]}
          />
        )}
      </Carte>

      {ouvert ? (
        <HistoriqueProduit
          productId={ouvert.id}
          nom={ouvert.nom}
          onFermer={() => setOuvert(null)}
        />
      ) : null}
    </div>
  );
}

/** Ancien prix, flèche, nouveau prix — et le sens de la variation en couleur. */
function Variation({ ancien, nouveau }: { ancien: number | null; nouveau: number }) {
  const monnaie = useMonnaie();
  if (ancien === null) {
    return <span className="text-encre-600">{monnaie(nouveau)}</span>;
  }
  const hausse = nouveau > ancien;
  const pourcent = ancien > 0 ? Math.round(((nouveau - ancien) / ancien) * 1000) / 10 : null;
  return (
    <span className="whitespace-nowrap">
      <span className="text-encre-500">{monnaie(ancien)}</span>
      <span className="mx-1 text-encre-400">→</span>
      <span className={hausse ? 'font-medium text-danger-700' : 'font-medium text-succes-700'}>
        {monnaie(nouveau)}
      </span>
      {pourcent !== null ? (
        <span className="ml-1 text-xs text-encre-500">
          ({hausse ? '+' : ''}
          {pourcent} %)
        </span>
      ) : null}
    </span>
  );
}

/**
 * Historique complet d'un produit.
 *
 * Les points sont présentés du plus récent au plus ancien, chaque nature
 * distinguée par sa couleur. Le dernier coût constaté par fournisseur figure en
 * tête : c'est le chiffre à comparer avant de repasser commande.
 */
function HistoriqueProduit({
  productId,
  nom,
  onFermer,
}: {
  productId: string;
  nom: string;
  onFermer: () => void;
}) {
  const { db, shopId } = useSession();
  const monnaie = useMonnaie();
  const [nature, setNature] = useState('');

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    const depot = new PriceHistoryRepository(db);
    const [points, parFournisseur, lots, produit] = await Promise.all([
      depot.forProduct(productId, nature ? (nature as PriceKind) : undefined),
      depot.lastObservedBySupplier(productId),
      depot.lotsOf(productId, shopId),
      new ProductRepository(db).byId(productId),
    ]);
    return { points, parFournisseur, lots, produit };
  }, [db, shopId, productId, nature]);

  return (
    <Dialogue
      ouvert
      titre={`Historique des prix — ${nom}`}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <Bouton variante="principal" onClick={onFermer}>
          Fermer
        </Bouton>
      }
    >
      {etat.chargement ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : (
        <div className="space-y-4">
          {etat.donnees?.produit ? (
            <div className="grid grid-cols-3 gap-3 rounded-md bg-encre-50 px-3 py-2.5 text-sm">
              <div>
                <p className="text-xs text-encre-500">Prix d'achat catalogue</p>
                <p className="font-medium" data-nombre>
                  {monnaie(etat.donnees.produit.purchasePrice)}
                </p>
              </div>
              <div>
                <p className="text-xs text-encre-500">Prix de vente</p>
                <p className="font-medium" data-nombre>
                  {monnaie(etat.donnees.produit.salePrice)}
                </p>
              </div>
              <div>
                <p className="text-xs text-encre-500">Marge théorique</p>
                <p className="font-medium" data-nombre>
                  {monnaie(etat.donnees.produit.salePrice - etat.donnees.produit.purchasePrice)}
                </p>
              </div>
            </div>
          ) : null}

          {(etat.donnees?.lots.length ?? 0) > 0 ? (
            <div>
              <h3 className="mb-1.5 text-encre-800">Lots d'approvisionnement</h3>
              <Information>
                Chaque arrivage avec son coût, sa quantité et le prix de vente en vigueur ce
                jour-là. C'est la lecture qui répond à « combien m'a coûté le lot de lundi, et à
                combien l'ai-je vendu ? ».
              </Information>
              <table className="tableau mt-2">
                <thead>
                  <tr>
                    <th>Arrivage</th>
                    <th>Fournisseur</th>
                    <th>Document</th>
                    <th className="num">Reçus</th>
                    <th className="num">Restants</th>
                    <th className="num">Coût unitaire</th>
                    <th className="num">Vendu à</th>
                    <th className="num">Marge unitaire</th>
                  </tr>
                </thead>
                <tbody>
                  {(etat.donnees?.lots ?? []).map((lot, index) => (
                    <tr key={`${lot.at}-${lot.unitCost}-${index}`}>
                      <td>{formaterDate(lot.at)}</td>
                      <td>{lot.supplierName ?? '—'}</td>
                      <td className="mono text-xs">{lot.sourceLabel ?? '—'}</td>
                      <td className="num">{lot.received}</td>
                      <td className="num">
                        {lot.remaining < 0 ? (
                          <span
                            className="text-encre-400"
                            title="Suivi par quantité : le reste d'un lot précis n'est pas connaissable"
                          >
                            —
                          </span>
                        ) : (
                          <Badge ton={lot.remaining > 0 ? 'succes' : 'neutre'}>
                            {lot.remaining}
                          </Badge>
                        )}
                      </td>
                      <td className="num">{monnaie(lot.unitCost)}</td>
                      <td className="num">
                        {lot.salePriceThen !== null ? monnaie(lot.salePriceThen) : '—'}
                      </td>
                      <td className="num font-medium">
                        {lot.salePriceThen !== null ? (
                          <span
                            className={
                              lot.salePriceThen - lot.unitCost >= 0
                                ? 'text-succes-700'
                                : 'text-danger-700'
                            }
                          >
                            {monnaie(lot.salePriceThen - lot.unitCost)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {(etat.donnees?.parFournisseur.length ?? 0) > 0 ? (
            <div>
              <h3 className="mb-1.5 text-encre-800">Dernier coût réel, par fournisseur</h3>
              <table className="tableau">
                <tbody>
                  {(etat.donnees?.parFournisseur ?? []).map((ligne) => (
                    <tr key={`${ligne.supplierId ?? 'sans'}-${ligne.at}`}>
                      <td>{ligne.supplierName ?? 'Fournisseur non renseigné'}</td>
                      <td>{formaterDate(ligne.at)}</td>
                      <td className="num font-medium">{monnaie(ligne.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <h3 className="text-encre-800">Historique</h3>
              <ListeFiltre
                valeur={nature}
                onChanger={setNature}
                vide="Toutes les natures"
                options={(Object.keys(LIBELLES_NATURE) as PriceKind[]).map((cle) => ({
                  valeur: cle,
                  libelle: LIBELLES_NATURE[cle].texte,
                }))}
              />
            </div>

            {(etat.donnees?.points.length ?? 0) === 0 ? (
              <Vide
                icone="rapport"
                titre="Aucun changement enregistré"
                detail="L'historique se remplit à chaque modification de prix et à chaque réception d'achat."
              />
            ) : (
              <ol className="space-y-2 border-l-2 border-encre-200 pl-4">
                {(etat.donnees?.points ?? []).map((point) => (
                  <li key={point.id} className="relative">
                    <span
                      className={`absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full ${
                        point.kind === 'OBSERVED_PURCHASE' ? 'bg-marque-500' : 'bg-encre-400'
                      }`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <Badge ton={LIBELLES_NATURE[point.kind].ton}>
                        {LIBELLES_NATURE[point.kind].texte}
                      </Badge>
                      <Variation ancien={point.oldValue} nouveau={point.newValue} />
                      <span className="text-xs text-encre-500">{formaterDate(point.at, true)}</span>
                    </div>
                    <p className="text-xs text-encre-500">
                      {[point.supplierName, point.sourceLabel, point.userLabel]
                        .filter(Boolean)
                        .join(' · ')}
                      {point.note ? ` — ${point.note}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Dialogue>
  );
}
