import { useState } from 'react';
import { PERMISSIONS, TRACKING, parseMoney, variantLabel } from '@boutique/shared';
import type { Tracking } from '@boutique/shared';
import {
  ProductRepository,
  type ProductInput,
  type ProductWithStock,
} from '@/core/db/repositories/product.repository';
import { CategoryRepository } from '@/core/db/repositories/category.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { ProductService } from '@/core/services/catalog.service';
import { StockService } from '@/core/services/stock.service';
import { toCsv, csvMoney, exportFileName } from '@/core/services/export.service';
import { Carte, EnTetePage, Erreur } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Confirmation, Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste, ZoneTexte } from '@/components/ui/Champ';
import {
  BarreFiltres,
  ChampRecherche,
  ListeFiltre,
  Pagination,
  Tableau,
} from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Catalogue produits (§5).
 *
 * La liste affiche le STOCK à côté de chaque produit : c'est la première chose
 * qu'on vient y chercher. Le formulaire distingue clairement le produit (le
 * modèle) de ses exemplaires — le mode de suivi commande tout le reste, et il
 * est verrouillé dès qu'un produit a du stock, parce qu'en changer rendrait
 * incohérent tout ce qui existe déjà.
 */
const LIBELLES_SUIVI: Record<Tracking, string> = {
  IMEI: 'IMEI (smartphone)',
  SERIAL: 'Numéro de série',
  QUANTITY: 'Quantité',
};

export function Produits({ parametre }: { parametre?: string | null }) {
  const { db, shopId, settings, peut } = useSession();
  const monnaie = useMonnaie();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [categorie, setCategorie] = useState('');
  const [suivi, setSuivi] = useState('');
  const [offset, setOffset] = useState(0);
  const [edite, setEdite] = useState<string | null>(parametre ?? null);
  const [creation, setCreation] = useState(false);
  const limite = 50;
  const voitLesCouts = peut(PERMISSIONS.costView);

  const categories = useChargement(async () => (db ? new CategoryRepository(db).list() : []), [db]);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new ProductRepository(db).search({
      shopId,
      query: differee,
      categoryId: categorie || null,
      tracking: suivi ? (suivi as Tracking) : null,
      limit: limite,
      offset,
    });
  }, [db, shopId, differee, categorie, suivi, offset]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('produits'),
      toCsv(etat.donnees.items, [
        { header: 'SKU', value: (l) => l.sku },
        { header: 'Désignation', value: (l) => l.name },
        { header: 'Marque', value: (l) => l.brand ?? '' },
        { header: 'Suivi', value: (l) => l.tracking },
        { header: 'Disponible', value: (l) => l.available },
        {
          header: "Prix d'achat",
          value: (l) => (voitLesCouts ? csvMoney(l.purchasePrice, settings.currency) : ''),
        },
        { header: 'Prix de vente', value: (l) => csvMoney(l.salePrice, settings.currency) },
        { header: 'Stock minimum', value: (l) => l.minStock },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Produits"
        sousTitre={etat.donnees ? `${etat.donnees.total} références` : undefined}
        actions={
          <>
            <Bouton icone="export" onClick={exporter} disabled={!etat.donnees}>
              Exporter
            </Bouton>
            {peut(PERMISSIONS.productManage) ? (
              <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
                Nouveau produit
              </Bouton>
            ) : null}
          </>
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={(valeur) => {
              setRecherche(valeur);
              setOffset(0);
            }}
            placeholder="Nom, SKU, marque, code-barres…"
            largeur="w-72"
          />
          <ListeFiltre
            valeur={categorie}
            onChanger={(valeur) => {
              setCategorie(valeur);
              setOffset(0);
            }}
            vide="Toutes les catégories"
            options={(categories.donnees ?? []).map((element) => ({
              valeur: element.id,
              libelle: element.name,
            }))}
          />
          <ListeFiltre
            valeur={suivi}
            onChanger={(valeur) => {
              setSuivi(valeur);
              setOffset(0);
            }}
            vide="Tous les suivis"
            options={Object.entries(LIBELLES_SUIVI).map(([valeur, libelle]) => ({
              valeur,
              libelle,
            }))}
          />
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees?.items ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setEdite(ligne.id)}
            vide={{
              icone: 'boite',
              titre: 'Aucun produit',
              detail: 'Ajustez les filtres, ou importez votre catalogue Excel.',
            }}
            colonnes={[
              {
                cle: 'nom',
                titre: 'Désignation',
                rendu: (l) => (
                  <div>
                    <div className="font-medium text-encre-900">{l.name}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-encre-500">
                      {l.brand ? <span>{l.brand}</span> : null}
                      {variantLabel(l.color, l.capacity) ? (
                        <span className="rounded bg-encre-100 px-1.5 py-0.5">
                          {variantLabel(l.color, l.capacity)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ),
              },
              { cle: 'sku', titre: 'SKU', rendu: (l) => <span className="mono">{l.sku}</span> },
              {
                cle: 'suivi',
                titre: 'Suivi',
                rendu: (l) => (
                  <Badge ton={l.tracking === 'QUANTITY' ? 'neutre' : 'info'}>
                    {l.tracking === 'IMEI'
                      ? 'IMEI'
                      : l.tracking === 'SERIAL'
                        ? 'Série'
                        : 'Quantité'}
                  </Badge>
                ),
              },
              {
                cle: 'dispo',
                titre: 'Disponible',
                num: true,
                rendu: (l) => (
                  <span
                    className={
                      l.available <= 0
                        ? 'text-danger-600'
                        : l.available <= (l.minStock || settings.lowStockThreshold)
                          ? 'text-alerte-700'
                          : ''
                    }
                  >
                    {l.available}
                  </span>
                ),
              },
              ...(voitLesCouts
                ? [
                    {
                      cle: 'achat',
                      titre: "Prix d'achat",
                      num: true,
                      rendu: (l: ProductWithStock) => monnaie(l.purchasePrice),
                    },
                  ]
                : []),
              {
                cle: 'vente',
                titre: 'Prix de vente',
                num: true,
                rendu: (l) => <span className="font-medium">{monnaie(l.salePrice)}</span>,
              },
            ]}
          />
        )}

        <Pagination
          offset={offset}
          limite={limite}
          total={etat.donnees?.total ?? 0}
          onChanger={setOffset}
        />
      </Carte>

      {creation || edite ? (
        <FormulaireProduit
          productId={edite}
          onFermer={() => {
            setCreation(false);
            setEdite(null);
          }}
          onEnregistre={() => {
            setCreation(false);
            setEdite(null);
            etat.recharger();
          }}
        />
      ) : null}
    </div>
  );
}

function FormulaireProduit({
  productId,
  onFermer,
  onEnregistre,
}: {
  productId: string | null;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const contexte = useContexte();
  const { db, settings, peut } = useSession();
  const { notifier } = useNotifications();
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [entree, setEntree] = useState(false);
  const [suppression, setSuppression] = useState(false);

  const references = useChargement(async () => {
    if (!db) return { categories: [], fournisseurs: [], produit: null };
    const [categories, fournisseurs, produit] = await Promise.all([
      new CategoryRepository(db).list(),
      new SupplierRepository(db).list({ activeOnly: true }),
      productId ? new ProductRepository(db).byId(productId) : Promise.resolve(null),
    ]);
    return { categories, fournisseurs, produit };
  }, [db, productId]);

  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const produit = references.donnees?.produit ?? null;

  // Les valeurs du formulaire sont initialisées une fois le produit chargé.
  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const decimales = settings.currency.decimals;
      const entreeProduit: ProductInput = {
        // Vide : le service en dérivera une du modèle.
        sku: champ('sku', produit?.sku ?? '').trim() || undefined,
        name: champ('name', produit?.name ?? '').trim(),
        brand: champ('brand', produit?.brand ?? '') || null,
        model: champ('model', produit?.model ?? '') || null,
        reference: champ('reference', produit?.reference ?? '') || null,
        barcode: champ('barcode', produit?.barcode ?? '') || null,
        categoryId: champ('categoryId', produit?.categoryId ?? '') || null,
        description: champ('description', produit?.description ?? '') || null,
        tracking: champ('tracking', produit?.tracking ?? TRACKING.quantity) as Tracking,
        purchasePrice:
          parseMoney(champ('purchasePrice', String(produit?.purchasePrice ?? 0)), decimales) ?? 0,
        salePrice: parseMoney(champ('salePrice', String(produit?.salePrice ?? 0)), decimales) ?? 0,
        minPrice: champ('minPrice', produit?.minPrice != null ? String(produit.minPrice) : '')
          ? parseMoney(champ('minPrice', String(produit?.minPrice ?? '')), decimales)
          : null,
        defaultSupplierId: champ('supplierId', produit?.defaultSupplierId ?? '') || null,
        unit: champ('unit', produit?.unit ?? 'pièce'),
        minStock: Number(champ('minStock', String(produit?.minStock ?? 0))) || 0,
        status: 'ACTIVE',
        color: champ('color', produit?.color ?? '') || null,
        capacity: champ('capacity', produit?.capacity ?? '') || null,
        attributes: produit?.attributes ?? {},
      };

      const service = new ProductService(contexte);
      if (productId) await service.update(productId, entreeProduit);
      else await service.create(entreeProduit);

      notifier(productId ? 'Produit modifié.' : 'Produit créé.');
      onEnregistre();
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  const suiviCourant = champ('tracking', produit?.tracking ?? TRACKING.quantity) as Tracking;

  return (
    <>
      <Dialogue
        ouvert
        titre={productId ? 'Modifier le produit' : 'Nouveau produit'}
        onFermer={onFermer}
        largeur="lg"
        pied={
          <>
            {productId ? (
              <Bouton
                variante="danger"
                icone="poubelle"
                className="mr-auto"
                onClick={() => setSuppression(true)}
              >
                Supprimer
              </Bouton>
            ) : null}
            {productId && peut(PERMISSIONS.stockAdjust) ? (
              <Bouton icone="plus" onClick={() => setEntree(true)}>
                Entrée en stock
              </Bouton>
            ) : null}
            <Bouton onClick={onFermer} disabled={occupe}>
              Annuler
            </Bouton>
            <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
              Enregistrer
            </Bouton>
          </>
        }
      >
        <div className="space-y-3">
          {erreur ? <Erreur message={erreur} /> : null}

          <div className="grid grid-cols-3 gap-3">
            <Champ
              label="SKU / Référence interne"
              value={champ('sku', produit?.sku ?? '')}
              onChange={(e) => changer('sku', e.target.value)}
              placeholder={productId ? undefined : 'Laissez vide pour la générer'}
              aide={
                productId
                  ? 'Modifiable. Vider le champ conserve la référence actuelle.'
                  : 'Facultative : elle sera dérivée du modèle si vous la laissez vide.'
              }
            />
            <Champ
              label="Code-barres"
              value={champ('barcode', produit?.barcode ?? '')}
              onChange={(e) => changer('barcode', e.target.value)}
            />
            <Champ
              label="Référence fournisseur"
              value={champ('reference', produit?.reference ?? '')}
              onChange={(e) => changer('reference', e.target.value)}
            />
          </div>

          <Champ
            label="Désignation"
            requis
            value={champ('name', produit?.name ?? '')}
            onChange={(e) => changer('name', e.target.value)}
          />

          <div className="grid grid-cols-3 gap-3">
            <Champ
              label="Marque"
              value={champ('brand', produit?.brand ?? '')}
              onChange={(e) => changer('brand', e.target.value)}
            />
            <Champ
              label="Modèle"
              value={champ('model', produit?.model ?? '')}
              onChange={(e) => changer('model', e.target.value)}
            />
            <Liste
              label="Catégorie"
              vide="Aucune"
              value={champ('categoryId', produit?.categoryId ?? '')}
              onChange={(e) => changer('categoryId', e.target.value)}
              options={(references.donnees?.categories ?? []).map((c) => ({
                valeur: c.id,
                libelle: c.name,
              }))}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Liste
              label="Mode de suivi"
              requis
              disabled={productId !== null}
              value={suiviCourant}
              onChange={(e) => changer('tracking', e.target.value)}
              options={Object.entries(LIBELLES_SUIVI).map(([valeur, libelle]) => ({
                valeur,
                libelle,
              }))}
              aide={
                productId
                  ? 'Verrouillé : le changer rendrait incohérent le stock existant.'
                  : 'IMEI pour les smartphones, série pour le matériel identifié, quantité pour le reste.'
              }
            />
            <Liste
              label="Fournisseur principal"
              vide="Aucun"
              value={champ('supplierId', produit?.defaultSupplierId ?? '')}
              onChange={(e) => changer('supplierId', e.target.value)}
              options={(references.donnees?.fournisseurs ?? []).map((f) => ({
                valeur: f.id,
                libelle: f.name,
              }))}
            />
            <Champ
              label="Unité"
              value={champ('unit', produit?.unit ?? 'pièce')}
              onChange={(e) => changer('unit', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Champ
              label="Couleur"
              value={champ('color', produit?.color ?? '')}
              onChange={(e) => changer('color', e.target.value)}
              aide="Axe de variation : proposé au comptoir."
            />
            <Champ
              label="Mémoire / capacité"
              value={champ('capacity', produit?.capacity ?? '')}
              onChange={(e) => changer('capacity', e.target.value)}
              aide="256 Go, 8/256…"
            />
            <Champ
              label="Stock minimum"
              inputMode="numeric"
              value={champ('minStock', String(produit?.minStock ?? 0))}
              onChange={(e) => changer('minStock', e.target.value)}
              aide="Seuil d'alerte."
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Champ
              label="Prix d'achat"
              inputMode="decimal"
              value={champ('purchasePrice', String(produit?.purchasePrice ?? ''))}
              onChange={(e) => changer('purchasePrice', e.target.value)}
            />
            <Champ
              label="Prix de vente"
              requis
              inputMode="decimal"
              value={champ('salePrice', String(produit?.salePrice ?? ''))}
              onChange={(e) => changer('salePrice', e.target.value)}
            />
            <Champ
              label="Prix plancher"
              inputMode="decimal"
              value={champ('minPrice', produit?.minPrice != null ? String(produit.minPrice) : '')}
              onChange={(e) => changer('minPrice', e.target.value)}
              aide="Aucune remise ne pourra descendre en dessous."
            />
          </div>

          <ZoneTexte
            label="Description"
            value={champ('description', produit?.description ?? '')}
            onChange={(e) => changer('description', e.target.value)}
          />
        </div>
      </Dialogue>

      {suppression && productId ? (
        <DialogueSuppression
          productId={productId}
          nom={produit?.name ?? ''}
          onFermer={() => setSuppression(false)}
          onSupprime={() => {
            setSuppression(false);
            onEnregistre();
          }}
        />
      ) : null}

      {entree && productId ? (
        <DialogueEntreeStock
          productId={productId}
          tracking={suiviCourant}
          onFermer={() => setEntree(false)}
          onFait={() => {
            setEntree(false);
            onEnregistre();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Entrée en stock manuelle.
 *
 * Elle sert aux cas hors circuit d'achat : un reliquat, une reprise, un stock
 * initial. Les IMEI sont saisis un par ligne — c'est ainsi qu'on les colle
 * depuis un bordereau ou qu'on les enchaîne au scanner.
 */
function DialogueEntreeStock({
  productId,
  tracking,
  onFermer,
  onFait,
}: {
  productId: string;
  tracking: Tracking;
  onFermer: () => void;
  onFait: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [texte, setTexte] = useState('');
  const [quantite, setQuantite] = useState('1');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const valider = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const service = new StockService(contexte);
      if (tracking === TRACKING.quantity) {
        await service.receiveQuantity({ productId, quantity: Number(quantite) || 0 });
        notifier(`${quantite} article(s) entré(s) en stock.`);
      } else {
        const identifiants = texte
          .split(/[\s,;]+/)
          .map((valeur) => valeur.trim())
          .filter(Boolean);
        if (identifiants.length === 0) throw new Error('Saisissez au moins un identifiant.');
        await service.receiveUnits({
          productId,
          units: identifiants.map((valeur) =>
            tracking === TRACKING.imei ? { imei1: valeur } : { serial: valeur },
          ),
        });
        notifier(`${identifiants.length} appareil(s) entré(s) en stock.`);
      }
      onFait();
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre="Entrée en stock"
      onFermer={onFermer}
      largeur="sm"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton variante="principal" occupe={occupe} onClick={() => void valider()}>
            Entrer en stock
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        {erreur ? <Erreur message={erreur} /> : null}
        {tracking === TRACKING.quantity ? (
          <Champ
            label="Quantité"
            requis
            autoFocus
            inputMode="numeric"
            value={quantite}
            onChange={(e) => setQuantite(e.target.value)}
          />
        ) : (
          <ZoneTexte
            label={tracking === TRACKING.imei ? 'IMEI' : 'Numéros de série'}
            requis
            autoFocus
            rows={8}
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            aide="Un par ligne. Le scanner les enchaîne directement."
          />
        )}
      </div>
    </Dialogue>
  );
}

/**
 * Suppression d'un produit.
 *
 * DEUX ISSUES, et l'écran les annonce AVANT d'agir plutôt que de les découvrir
 * après :
 *
 *  - un produit que rien ne cite — créé par erreur, jamais reçu ni vendu — est
 *    effacé pour de bon. Laisser une fiche fantôme au catalogue serait une
 *    pollution que personne ne nettoie jamais.
 *  - un produit qui a une histoire est ARCHIVÉ : il quitte les listes et le
 *    comptoir, mais les ventes, achats et mouvements qui le citent restent
 *    lisibles. C'est la règle du §27, et elle n'est pas négociable : effacer un
 *    produit vendu rendrait illisible un ticket déjà remis à un client.
 */
function DialogueSuppression({
  productId,
  nom,
  onFermer,
  onSupprime,
}: {
  productId: string;
  nom: string;
  onFermer: () => void;
  onSupprime: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [occupe, setOccupe] = useState(false);

  const impact = useChargement(
    async () => new ProductService(contexte).deletionImpact(productId),
    [contexte.db, productId],
  );

  const definitive = impact.donnees?.removable ?? false;

  const supprimer = async () => {
    setOccupe(true);
    try {
      const resultat = await new ProductService(contexte).remove(productId);
      notifier(
        resultat.definitive
          ? `« ${nom} » a été supprimé définitivement.`
          : `« ${nom} » a été archivé : son historique reste consultable.`,
      );
      onSupprime();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const references: { libelle: string; nombre: number }[] = impact.donnees
    ? [
        { libelle: 'appareils enregistrés', nombre: impact.donnees.units },
        { libelle: 'en stock', nombre: impact.donnees.stock },
        { libelle: 'lignes de vente', nombre: impact.donnees.saleLines },
        { libelle: "lignes d'achat", nombre: impact.donnees.purchaseLines },
        { libelle: 'lignes de transfert', nombre: impact.donnees.transferLines },
        { libelle: 'mouvements de stock', nombre: impact.donnees.movements },
      ].filter((element) => element.nombre > 0)
    : [];

  return (
    <Confirmation
      ouvert
      titre={`Supprimer « ${nom} »`}
      libelleAction={definitive ? 'Supprimer définitivement' : 'Archiver le produit'}
      danger
      occupe={occupe || impact.chargement}
      onConfirmer={() => void supprimer()}
      onFermer={onFermer}
      message={
        impact.chargement ? (
          'Vérification des documents qui citent ce produit…'
        ) : definitive ? (
          "Rien ne cite ce produit : il sera effacé pour de bon. L'opération est irréversible."
        ) : (
          <>
            Ce produit a une histoire : il sera <strong>archivé</strong>, pas effacé. Il disparaîtra
            des listes et du comptoir, mais les documents qui le citent resteront lisibles.
          </>
        )
      }
    >
      {references.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-encre-700">
          {references.map((element) => (
            <li key={element.libelle}>
              <strong data-nombre>{element.nombre}</strong> {element.libelle}
            </li>
          ))}
        </ul>
      ) : null}
    </Confirmation>
  );
}
