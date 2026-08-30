import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSIONS, formatMoney, parseMoney, variantLabel } from '@boutique/shared';
import type { Money, Product, ProductUnit } from '@boutique/shared';
import {
  ProductRepository,
  type ProductWithStock,
} from '@/core/db/repositories/product.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { CustomerRepository, customerName } from '@/core/db/repositories/customer.repository';
import { SaleService, computeSaleTotals } from '@/core/services/sale.service';
import { InvoiceService } from '@/core/services/invoice.service';
import { activePaymentMethods } from '@/core/services/setup.service';
import { Bouton } from '@/components/ui/Bouton';
import { Icone } from '@/components/ui/Icone';
import { Badge } from '@/components/ui/Badge';
import { Carte, Erreur, Vide } from '@/components/ui/Page';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste } from '@/components/ui/Champ';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';
import { TicketImprimable } from './TicketImprimable';
import { ChoixArticle } from './ChoixArticle';
import { NavigationCatalogue } from './NavigationCatalogue';

/**
 * Écran d'encaissement (§12).
 *
 * PENSÉ POUR LE COMPTOIR, pas pour la démonstration :
 *
 *  - le champ de recherche garde le focus en permanence ; un scanner de
 *    codes-barres n'est qu'un clavier, et il tape là où est le curseur ;
 *  - un IMEI scanné ajoute DIRECTEMENT l'appareil au panier, sans étape
 *    intermédiaire — c'est le geste le plus fréquent de la journée ;
 *  - F2 revient à la recherche, F4 ouvre le paiement, Échap vide le panier ;
 *  - le panier n'est jamais enregistré tant que le paiement n'est pas validé :
 *    un client qui change d'avis ne laisse aucune trace.
 */

interface LignePanier {
  cle: string;
  produit: Product;
  unite: ProductUnit | null;
  quantite: number;
  prixUnitaire: Money;
  remise: Money;
}

export function Caisse() {
  const contexte = useContexte();
  const { db, shopId, settings, peut } = useSession();
  const { aller } = useNavigation();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();

  const [recherche, setRecherche] = useState('');
  const rechercheDifferee = useDifferee(recherche, 180);
  const [panier, setPanier] = useState<LignePanier[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [dialoguePaiement, setDialoguePaiement] = useState(false);
  const [dialogueClient, setDialogueClient] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [dernierTicket, setDernierTicket] = useState<string | null>(null);
  /** Produit dont on choisit la déclinaison et l'exemplaire. */
  const [choix, setChoix] = useState<Product | null>(null);
  const champRecherche = useRef<HTMLInputElement>(null);

  const peutRemiser = peut(PERMISSIONS.saleDiscount);
  // La page peut être ouverte sans le droit d'encaisser — consulter un prix au
  // comptoir est légitime. Le bouton d'encaissement, lui, ne doit pas mentir.
  const peutEncaisser = peut(PERMISSIONS.saleCreate);

  /* ─── Recherche ───────────────────────────────────────────────────────── */
  const resultats = useChargement(async () => {
    if (!db || rechercheDifferee.trim().length < 2) return { produits: [], unite: null };
    const unites = new UnitRepository(db);
    // Un identifiant exact l'emporte : c'est un scan, pas une recherche.
    const unite = await unites.byIdentifier(rechercheDifferee);
    if (unite && unite.shopId === shopId) return { produits: [], unite };

    const page = await new ProductRepository(db).search({
      shopId,
      query: rechercheDifferee,
      limit: 30,
    });
    return { produits: page.items, unite: null };
  }, [db, shopId, rechercheDifferee]);

  const ajouterUnite = useCallback(
    async (unite: ProductUnit, connu?: Product) => {
      if (!db) return;
      const produit = connu ?? (await new ProductRepository(db).byId(unite.productId));
      if (!produit) return;
      setPanier((precedent) => {
        if (precedent.some((ligne) => ligne.unite?.id === unite.id)) {
          setErreur('Cet appareil figure déjà dans le panier.');
          return precedent;
        }
        setErreur(null);
        return [
          ...precedent,
          {
            cle: unite.id,
            produit,
            unite,
            quantite: 1,
            prixUnitaire: produit.salePrice,
            remise: 0,
          },
        ];
      });
      setRecherche('');
      champRecherche.current?.focus();
    },
    [db],
  );

  /** Ajoute une quantité au panier. Le produit est déjà arrêté. */
  const ajouterQuantite = useCallback((produit: Product) => {
    setErreur(null);
    setPanier((precedent) => {
      const existante = precedent.find((ligne) => ligne.produit.id === produit.id && !ligne.unite);
      if (existante) {
        return precedent.map((ligne) =>
          ligne === existante ? { ...ligne, quantite: ligne.quantite + 1 } : ligne,
        );
      }
      return [
        ...precedent,
        {
          cle: produit.id,
          produit,
          unite: null,
          quantite: 1,
          prixUnitaire: produit.salePrice,
          remise: 0,
        },
      ];
    });
    setRecherche('');
    champRecherche.current?.focus();
  }, []);

  /**
   * Clic sur un produit de la liste.
   *
   * On n'ajoute JAMAIS directement un article identifié : il faut savoir lequel
   * — quelle déclinaison, quel exemplaire. Un produit décliné en plusieurs
   * couleurs ou capacités passe par le même choix, même suivi par quantité :
   * « une housse Samsung » ne suffit pas à préparer un paquet.
   */
  const ouvrirChoix = useCallback(
    (produit: ProductWithStock) => {
      const decline = (produit.variantCount ?? 1) > 1;
      if (produit.tracking === 'QUANTITY' && !decline) {
        ajouterQuantite(produit);
        return;
      }
      setErreur(null);
      setChoix(produit);
    },
    [ajouterQuantite],
  );

  /* Un identifiant scanné entre directement dans le panier. */
  useEffect(() => {
    const unite = resultats.donnees?.unite;
    if (unite) void ajouterUnite(unite);
  }, [resultats.donnees?.unite, ajouterUnite]);

  /* ─── Raccourcis ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const surTouche = (evenement: KeyboardEvent) => {
      if (evenement.key === 'F2') {
        evenement.preventDefault();
        champRecherche.current?.focus();
        champRecherche.current?.select();
      } else if (evenement.key === 'F4' && panier.length > 0 && peutEncaisser) {
        evenement.preventDefault();
        setDialoguePaiement(true);
      } else if (evenement.key === 'Escape' && !dialoguePaiement && !dialogueClient) {
        setRecherche('');
      }
    };
    window.addEventListener('keydown', surTouche);
    return () => window.removeEventListener('keydown', surTouche);
  }, [panier.length, dialoguePaiement, dialogueClient, peutEncaisser]);

  useEffect(() => {
    champRecherche.current?.focus();
  }, []);

  /* ─── Totaux ──────────────────────────────────────────────────────────── */
  const totaux = useMemo(
    () =>
      computeSaleTotals(
        panier.map((ligne) => ({
          productId: ligne.produit.id,
          label: ligne.produit.name,
          quantity: ligne.quantite,
          unitPrice: ligne.prixUnitaire,
          discount: ligne.remise,
          taxRate: settings.taxEnabled ? ligne.produit.taxRate : null,
        })),
      ),
    [panier, settings.taxEnabled],
  );

  const client = useChargement(
    async () => (db && clientId ? new CustomerRepository(db).byId(clientId) : null),
    [db, clientId],
  );

  const encaisser = async (
    reglements: { method: string; amount: Money; reference?: string | null }[],
    rendu: Money,
  ) => {
    const service = new SaleService(contexte);
    const resultat = await service.checkout({
      lines: panier.map((ligne) => ({
        productId: ligne.produit.id,
        unitId: ligne.unite?.id ?? null,
        quantity: ligne.quantite,
        unitPrice: ligne.prixUnitaire,
        discount: ligne.remise,
      })),
      payments: reglements,
      customerId: clientId,
      changeGiven: rendu,
    });
    setPanier([]);
    setClientId(null);
    setDialoguePaiement(false);
    setDernierTicket(resultat.saleId);
    notifier(`Ticket ${resultat.number} enregistré — ${monnaie(resultat.total)}`);
    champRecherche.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* Colonne gauche : recherche et catalogue */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-encre-400">
            <Icone nom="recherche" taille={18} />
          </span>
          <input
            ref={champRecherche}
            value={recherche}
            onChange={(evenement) => setRecherche(evenement.target.value)}
            placeholder="Scanner un IMEI ou un code-barres, ou chercher un produit…   (F2)"
            className="h-12 w-full rounded-lg border border-encre-300 bg-white pl-10 pr-3 text-base shadow-carte placeholder:text-encre-400 focus:border-marque-500"
          />
        </div>

        {erreur ? <Erreur message={erreur} /> : null}

        <Carte compact className="flex min-h-0 flex-1 flex-col">
          {recherche.trim().length < 2 ? (
            /* Tant qu'on n'a rien tapé, le catalogue se PARCOURT. Exiger une
               recherche bloquait la vente d'un article dont le vendeur ne
               connaît ni le nom exact ni la référence — un cache-écran, une
               housse — et le scanner ne sert à rien sur ces produits-là. */
            <NavigationCatalogue onChoisir={ouvrirChoix} />
          ) : resultats.donnees && resultats.donnees.produits.length === 0 ? (
            <Vide
              icone="boite"
              titre="Aucun article trouvé"
              detail={`Rien ne correspond à « ${recherche} ».`}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Article</th>
                    <th>SKU</th>
                    <th>Suivi</th>
                    <th className="num">Disponible</th>
                    <th className="num">Prix</th>
                  </tr>
                </thead>
                <tbody>
                  {(resultats.donnees?.produits ?? []).map((produit) => (
                    <tr key={produit.id} data-clickable="" onClick={() => ouvrirChoix(produit)}>
                      <td>
                        <div className="font-medium text-encre-900">{produit.name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-encre-500">
                          {produit.brand ? <span>{produit.brand}</span> : null}
                          {variantLabel(produit.color, produit.capacity) ? (
                            <span>{variantLabel(produit.color, produit.capacity)}</span>
                          ) : null}
                          {(produit.variantCount ?? 1) > 1 ? (
                            <Badge ton="neutre">{produit.variantCount} déclinaisons</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="mono text-encre-600">{produit.sku}</td>
                      <td>
                        <Badge ton={produit.tracking === 'QUANTITY' ? 'neutre' : 'info'}>
                          {produit.tracking === 'IMEI'
                            ? 'IMEI'
                            : produit.tracking === 'SERIAL'
                              ? 'Série'
                              : 'Quantité'}
                        </Badge>
                      </td>
                      <td className="num">
                        <span className={produit.available <= 0 ? 'text-danger-600' : ''}>
                          {produit.available}
                        </span>
                      </td>
                      <td className="num font-medium">{monnaie(produit.salePrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Carte>
      </div>

      {/* Colonne droite : panier */}
      <div className="flex w-[26rem] shrink-0 flex-col gap-3">
        <Carte compact className="min-h-0 flex-1">
          <div className="flex items-center justify-between border-b border-encre-200 px-3 py-2">
            <h2 className="text-encre-800">Panier</h2>
            {panier.length > 0 ? (
              <Bouton taille="petit" variante="discret" onClick={() => setPanier([])}>
                Vider
              </Bouton>
            ) : null}
          </div>

          {panier.length === 0 ? (
            <Vide icone="caisse" titre="Panier vide" detail="Scannez un article pour commencer." />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              {panier.map((ligne) => (
                <LignePanierVue
                  key={ligne.cle}
                  ligne={ligne}
                  peutRemiser={peutRemiser}
                  monnaie={monnaie}
                  decimales={settings.currency.decimals}
                  onChanger={(modifiee) =>
                    setPanier((precedent) =>
                      precedent.map((element) => (element.cle === ligne.cle ? modifiee : element)),
                    )
                  }
                  onRetirer={() =>
                    setPanier((precedent) =>
                      precedent.filter((element) => element.cle !== ligne.cle),
                    )
                  }
                />
              ))}
            </div>
          )}

          <div className="border-t border-encre-200 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setDialogueClient(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-encre-100"
            >
              <span className="text-encre-400">
                <Icone nom="client" taille={16} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {client.donnees ? customerName(client.donnees) : 'Aucun client sélectionné'}
              </span>
              {clientId ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="text-encre-400 hover:text-danger-600"
                  onClick={(evenement) => {
                    evenement.stopPropagation();
                    setClientId(null);
                  }}
                  onKeyDown={(evenement) => {
                    if (evenement.key === 'Enter') setClientId(null);
                  }}
                >
                  <Icone nom="croix" taille={14} />
                </span>
              ) : (
                <span className="text-encre-400">
                  <Icone nom="plus" taille={14} />
                </span>
              )}
            </button>
          </div>

          <div className="space-y-1 border-t border-encre-200 bg-encre-50 px-4 py-3 text-sm">
            <Rangee libelle="Sous-total" valeur={monnaie(totaux.subtotal)} />
            {totaux.discount > 0 ? (
              <Rangee libelle="Remises" valeur={`− ${monnaie(totaux.discount)}`} accent="danger" />
            ) : null}
            {settings.taxEnabled && totaux.tax > 0 ? (
              <Rangee libelle="TVA" valeur={monnaie(totaux.tax)} />
            ) : null}
            <div className="flex items-baseline justify-between pt-1.5 text-lg font-semibold">
              <span>Total</span>
              <span data-nombre>{monnaie(totaux.total)}</span>
            </div>
          </div>

          <div className="border-t border-encre-200 p-3">
            <Bouton
              variante="principal"
              taille="grand"
              pleineLargeur
              icone="check"
              disabled={panier.length === 0 || !peutEncaisser}
              onClick={() => setDialoguePaiement(true)}
            >
              Encaisser (F4)
            </Bouton>
            {!peutEncaisser ? (
              <p className="mt-2 text-center text-xs text-encre-500">
                Votre rôle ne permet pas d'encaisser.
              </p>
            ) : null}
          </div>
        </Carte>

        {dernierTicket ? (
          <div className="carte flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="text-encre-600">Dernier ticket enregistré</span>
            <div className="flex gap-1.5">
              <Bouton taille="petit" onClick={() => aller('tickets', dernierTicket)}>
                Ouvrir
              </Bouton>
              <TicketImprimable saleId={dernierTicket} />
            </div>
          </div>
        ) : null}
      </div>

      {choix ? (
        <ChoixArticle
          produit={choix}
          onFermer={() => setChoix(null)}
          onChoisir={(produit, unite) => {
            setChoix(null);
            if (unite) void ajouterUnite(unite, produit);
            else ajouterQuantite(produit);
          }}
        />
      ) : null}

      <DialoguePaiement
        ouvert={dialoguePaiement}
        total={totaux.total}
        onFermer={() => setDialoguePaiement(false)}
        onValider={encaisser}
      />

      <DialogueClient
        ouvert={dialogueClient}
        onFermer={() => setDialogueClient(false)}
        onChoisir={(id) => {
          setClientId(id);
          setDialogueClient(false);
        }}
      />
    </div>
  );
}

function Rangee({
  libelle,
  valeur,
  accent,
}: {
  libelle: string;
  valeur: string;
  accent?: 'danger';
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-encre-600">{libelle}</span>
      <span className={accent === 'danger' ? 'text-danger-600' : 'text-encre-800'} data-nombre>
        {valeur}
      </span>
    </div>
  );
}

function LignePanierVue({
  ligne,
  peutRemiser,
  monnaie,
  decimales,
  onChanger,
  onRetirer,
}: {
  ligne: LignePanier;
  peutRemiser: boolean;
  monnaie: (valeur: Money) => string;
  decimales: number;
  onChanger: (ligne: LignePanier) => void;
  onRetirer: () => void;
}) {
  const total = ligne.quantite * ligne.prixUnitaire - ligne.remise;
  return (
    <div className="border-b border-encre-100 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-encre-900">{ligne.produit.name}</p>
          {ligne.unite ? (
            <p className="mono truncate text-xs text-encre-500">
              {ligne.unite.imei1 ?? ligne.unite.serial}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRetirer}
          aria-label="Retirer"
          className="shrink-0 rounded p-1 text-encre-400 hover:bg-danger-50 hover:text-danger-600"
        >
          <Icone nom="croix" taille={14} />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        {ligne.unite ? (
          <span className="text-xs text-encre-500">1 appareil</span>
        ) : (
          <div className="flex items-center rounded border border-encre-300">
            <button
              type="button"
              className="px-2 py-0.5 text-encre-600 hover:bg-encre-100"
              onClick={() => onChanger({ ...ligne, quantite: Math.max(1, ligne.quantite - 1) })}
            >
              −
            </button>
            <input
              value={ligne.quantite}
              onChange={(evenement) => {
                const valeur = Number(evenement.target.value.replace(/\D/g, ''));
                onChanger({ ...ligne, quantite: Math.max(1, valeur || 1) });
              }}
              className="w-10 border-x border-encre-300 py-0.5 text-center text-sm"
              data-nombre
            />
            <button
              type="button"
              className="px-2 py-0.5 text-encre-600 hover:bg-encre-100"
              onClick={() => onChanger({ ...ligne, quantite: ligne.quantite + 1 })}
            >
              +
            </button>
          </div>
        )}

        {peutRemiser ? (
          <input
            value={ligne.remise === 0 ? '' : String(ligne.remise)}
            onChange={(evenement) => {
              const valeur = parseMoney(evenement.target.value, decimales);
              onChanger({ ...ligne, remise: Math.max(0, valeur ?? 0) });
            }}
            placeholder="Remise"
            className="h-7 w-24 rounded border border-encre-300 px-2 text-right text-sm placeholder:text-encre-400"
            data-nombre
          />
        ) : null}

        <span className="ml-auto text-sm font-medium" data-nombre>
          {monnaie(total)}
        </span>
      </div>
    </div>
  );
}

/**
 * Paiement.
 *
 * Le montant reçu est saisi en premier et la monnaie à rendre s'affiche
 * immédiatement, en grand : c'est le chiffre que le caissier lit à voix haute.
 * Le paiement mixte est possible — deux modes suffisent à couvrir la quasi-
 * totalité des cas réels, sans transformer la boîte en formulaire.
 */
function DialoguePaiement({
  ouvert,
  total,
  onFermer,
  onValider,
}: {
  ouvert: boolean;
  total: Money;
  onFermer: () => void;
  onValider: (
    reglements: { method: string; amount: Money; reference?: string | null }[],
    rendu: Money,
  ) => Promise<void>;
}) {
  const { db, settings } = useSession();
  const [mode, setMode] = useState('CASH');
  const [recu, setRecu] = useState('');
  const [reference, setReference] = useState('');
  const [secondMode, setSecondMode] = useState('');
  const [secondMontant, setSecondMontant] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const modes = useChargement(async () => (db ? activePaymentMethods(db) : []), [db]);

  useEffect(() => {
    if (ouvert) {
      setRecu('');
      setReference('');
      setSecondMode('');
      setSecondMontant('');
      setErreur(null);
    }
  }, [ouvert]);

  const montantSecond = parseMoney(secondMontant, settings.currency.decimals) ?? 0;
  const montantPrincipal = parseMoney(recu, settings.currency.decimals) ?? 0;
  const encaisse = montantPrincipal + (secondMode ? montantSecond : 0);
  const rendu = Math.max(0, encaisse - total);
  const manquant = Math.max(0, total - encaisse);

  const valider = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const reglements: { method: string; amount: Money; reference?: string | null }[] = [];
      // Le règlement principal est plafonné au total : la monnaie rendue n'est
      // pas un encaissement, elle ressort de la caisse. L'enregistrer gonflerait
      // le chiffre d'affaires de la journée.
      const principal = Math.min(montantPrincipal, total);
      if (principal > 0) {
        reglements.push({ method: mode, amount: principal, reference: reference || null });
      }
      if (secondMode && montantSecond > 0) {
        reglements.push({ method: secondMode, amount: Math.min(montantSecond, total - principal) });
      }
      await onValider(reglements, rendu);
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert={ouvert}
      titre="Encaissement"
      onFermer={onFermer}
      largeur="sm"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Retour
          </Bouton>
          <Bouton
            variante="principal"
            occupe={occupe}
            disabled={manquant > 0}
            onClick={() => void valider()}
          >
            Valider la vente
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md bg-encre-100 px-4 py-3 text-center">
          <p className="text-xs text-encre-500">Total à encaisser</p>
          <p className="text-2xl font-semibold text-encre-900" data-nombre>
            {formatMoney(total, settings.currency)}
          </p>
        </div>

        <Liste
          label="Mode de paiement"
          value={mode}
          onChange={(evenement) => setMode(evenement.target.value)}
          options={(modes.donnees ?? []).map((methode) => ({
            valeur: methode.code,
            libelle: methode.label,
          }))}
        />

        <Champ
          label="Montant reçu"
          value={recu}
          autoFocus
          inputMode="decimal"
          onChange={(evenement) => setRecu(evenement.target.value)}
          aide={`Reste à payer : ${formatMoney(manquant, settings.currency)}`}
        />

        {mode !== 'CASH' ? (
          <Champ
            label="Référence"
            value={reference}
            onChange={(evenement) => setReference(evenement.target.value)}
            aide="N° d'autorisation, référence mobile money…"
          />
        ) : null}

        <details className="rounded-md border border-encre-200 px-3 py-2">
          <summary className="cursor-pointer text-sm text-encre-700">
            Paiement en deux modes
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Liste
              label="Second mode"
              value={secondMode}
              vide="Aucun"
              onChange={(evenement) => setSecondMode(evenement.target.value)}
              options={(modes.donnees ?? [])
                .filter((methode) => methode.code !== mode)
                .map((methode) => ({ valeur: methode.code, libelle: methode.label }))}
            />
            <Champ
              label="Montant"
              value={secondMontant}
              inputMode="decimal"
              disabled={!secondMode}
              onChange={(evenement) => setSecondMontant(evenement.target.value)}
            />
          </div>
        </details>

        {rendu > 0 ? (
          <div className="rounded-md border border-succes-200 bg-succes-50 px-4 py-3 text-center">
            <p className="text-xs text-succes-700">Monnaie à rendre</p>
            <p className="text-2xl font-semibold text-succes-900" data-nombre>
              {formatMoney(rendu, settings.currency)}
            </p>
          </div>
        ) : null}

        {erreur ? <Erreur message={erreur} /> : null}
      </div>
    </Dialogue>
  );
}

function DialogueClient({
  ouvert,
  onFermer,
  onChoisir,
}: {
  ouvert: boolean;
  onFermer: () => void;
  onChoisir: (id: string) => void;
}) {
  const { db, shopId } = useSession();
  const { notifier } = useNotifications();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche, 200);
  const [nom, setNom] = useState('');
  const [prenom, setPrenom] = useState('');
  const [telephone, setTelephone] = useState('');
  const [occupe, setOccupe] = useState(false);

  const clients = useChargement(
    async () => (db ? new CustomerRepository(db).search(differee, 20) : []),
    [db, differee],
  );

  const creer = async () => {
    if (!db || nom.trim() === '') return;
    setOccupe(true);
    try {
      const id = await new CustomerRepository(db).create({
        lastName: nom.trim(),
        firstName: prenom.trim() || null,
        phone: telephone.trim() || null,
        shopId,
      });
      notifier('Client créé.');
      setNom('');
      setPrenom('');
      setTelephone('');
      onChoisir(id);
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue ouvert={ouvert} titre="Client" onFermer={onFermer} largeur="md">
      <div className="space-y-4">
        <Champ
          label="Rechercher"
          value={recherche}
          autoFocus
          onChange={(evenement) => setRecherche(evenement.target.value)}
          aide="Nom, prénom ou téléphone"
        />

        <div className="max-h-60 overflow-auto rounded-md border border-encre-200">
          {(clients.donnees ?? []).length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-encre-500">Aucun client trouvé.</p>
          ) : (
            <ul className="divide-y divide-encre-100">
              {(clients.donnees ?? []).map((client) => (
                <li key={client.id}>
                  <button
                    type="button"
                    onClick={() => onChoisir(client.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-marque-50"
                  >
                    <span className="text-sm text-encre-900">{customerName(client)}</span>
                    <span className="text-xs text-encre-500">{client.phone ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-md border border-encre-200 p-3">
          <h3 className="mb-2 text-encre-800">Nouveau client</h3>
          <div className="grid grid-cols-3 gap-2">
            <Champ label="Nom" requis value={nom} onChange={(e) => setNom(e.target.value)} />
            <Champ label="Prénom" value={prenom} onChange={(e) => setPrenom(e.target.value)} />
            <Champ
              label="Téléphone"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
            />
          </div>
          <Bouton
            variante="secondaire"
            icone="plus"
            occupe={occupe}
            disabled={nom.trim() === ''}
            onClick={() => void creer()}
          >
            Créer et sélectionner
          </Bouton>
        </div>
      </div>
    </Dialogue>
  );
}

/** Émission de la facture d'un ticket, depuis la caisse. */
export function BoutonFacture({ saleId }: { saleId: string }) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [occupe, setOccupe] = useState(false);

  return (
    <Bouton
      taille="petit"
      icone="facture"
      occupe={occupe}
      onClick={async () => {
        setOccupe(true);
        try {
          const facture = await new InvoiceService(contexte).issueForSale(saleId);
          notifier(`Facture ${facture.number} émise.`);
        } catch (cause) {
          notifier(messageDe(cause), 'erreur');
        } finally {
          setOccupe(false);
        }
      }}
    >
      Facturer
    </Bouton>
  );
}
