import { useState } from 'react';
import {
  LANDED_COST_LABELS,
  LANDED_COST_KIND,
  PERMISSIONS,
  PURCHASE_LABELS,
  PURCHASE_STATUS,
  TRACKING,
  valuesOf,
} from '@boutique/shared';
import type { LandedCostKind, PurchaseStatus } from '@boutique/shared';
import { PurchaseRepository } from '@/core/db/repositories/purchase.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { PurchaseService, type ReceiptLineInput } from '@/core/services/purchase.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { BadgeAchat, Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
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
import { formaterDate, messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';

/**
 * Achats, réceptions et coûts logistiques (§10, §11).
 *
 * La réception est l'écran le plus délicat : c'est là qu'on saisit les IMEI des
 * appareils qui arrivent. Il autorise la saisie par bloc — coller une colonne
 * entière depuis un bordereau, ou enchaîner les scans — parce que saisir trente
 * IMEI un par un dans trente champs est le meilleur moyen d'en manquer un.
 */
export function Achats({ parametre }: { parametre?: string | null }) {
  const { db, shopId, peut } = useSession();
  const monnaie = useMonnaie();
  const [statut, setStatut] = useState('');
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [offset, setOffset] = useState(0);

  const [ouvert, setOuvert] = useState<string | null>(parametre ?? null);
  const [creation, setCreation] = useState(false);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new PurchaseRepository(db).list({
      shopId,
      status: statut ? (statut as PurchaseStatus) : null,
      query: differee,
      limit: limite,
      offset,
    });
  }, [db, shopId, statut, differee, offset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Achats"
        sousTitre="Commandes fournisseurs, réceptions et frais logistiques."
        actions={
          peut(PERMISSIONS.purchaseCreate) ? (
            <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
              Nouvelle commande
            </Bouton>
          ) : null
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
            placeholder="N° de commande, référence, fournisseur…"
            largeur="w-72"
          />
          <ListeFiltre
            valeur={statut}
            onChanger={(valeur) => {
              setStatut(valeur);
              setOffset(0);
            }}
            vide="Tous les statuts"
            options={valuesOf(PURCHASE_STATUS).map((valeur) => ({
              valeur,
              libelle: PURCHASE_LABELS[valeur],
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
            onLigneCliquee={(ligne) => setOuvert(ligne.id)}
            vide={{ icone: 'achat', titre: 'Aucune commande' }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              { cle: 'fournisseur', titre: 'Fournisseur', rendu: (l) => l.supplierName },
              {
                cle: 'reference',
                titre: 'Réf. fournisseur',
                rendu: (l) => l.supplierReference ?? '—',
              },
              { cle: 'date', titre: 'Commandé le', rendu: (l) => formaterDate(l.orderedAt) },
              { cle: 'statut', titre: 'Statut', rendu: (l) => <BadgeAchat statut={l.status} /> },
              {
                cle: 'frais',
                titre: 'Frais',
                num: true,
                rendu: (l) => (l.landedCostTotal > 0 ? monnaie(l.landedCostTotal) : '—'),
              },
              {
                cle: 'total',
                titre: 'Total',
                num: true,
                rendu: (l) => <span className="font-medium">{monnaie(l.total)}</span>,
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

      {creation ? (
        <NouvelleCommande
          onFermer={() => setCreation(false)}
          onCree={(id) => {
            setCreation(false);
            setOuvert(id);
            etat.recharger();
          }}
        />
      ) : null}

      {ouvert ? (
        <FicheAchat
          purchaseId={ouvert}
          onFermer={() => setOuvert(null)}
          onChange={() => etat.recharger()}
        />
      ) : null}
    </div>
  );
}

interface LigneBrouillon {
  cle: string;
  productId: string;
  label: string;
  quantite: string;
  prix: string;
}

function NouvelleCommande({
  onFermer,
  onCree,
}: {
  onFermer: () => void;
  onCree: (id: string) => void;
}) {
  const contexte = useContexte();
  const { db, shopId } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lignes, setLignes] = useState<LigneBrouillon[]>([]);
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const fournisseurs = useChargement(
    async () => (db ? new SupplierRepository(db).list({ activeOnly: true }) : []),
    [db],
  );

  const produits = useChargement(async () => {
    if (!db || differee.trim().length < 2) return [];
    const page = await new ProductRepository(db).search({ shopId, query: differee, limit: 15 });
    return page.items;
  }, [db, shopId, differee]);

  const total = lignes.reduce(
    (somme, ligne) => somme + (Number(ligne.quantite) || 0) * (Number(ligne.prix) || 0),
    0,
  );

  const creer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const id = await new PurchaseService(contexte).create({
        supplierId,
        supplierReference: reference || null,
        notes: notes || null,
        lines: lignes.map((ligne) => ({
          productId: ligne.productId,
          label: ligne.label,
          quantity: Number(ligne.quantite) || 0,
          unitPrice: Number(ligne.prix) || 0,
        })),
      });
      notifier('Commande créée en brouillon.');
      onCree(id);
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre="Nouvelle commande fournisseur"
      onFermer={onFermer}
      largeur="xl"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton
            variante="principal"
            occupe={occupe}
            disabled={supplierId === '' || lignes.length === 0}
            onClick={() => void creer()}
          >
            Créer la commande ({monnaie(total)})
          </Bouton>
        </>
      }
    >
      <div className="space-y-4">
        {erreur ? <Erreur message={erreur} /> : null}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Liste
            label="Fournisseur"
            requis
            vide="Choisir…"
            value={supplierId}
            onChange={(evenement) => setSupplierId(evenement.target.value)}
            options={(fournisseurs.donnees ?? []).map((f) => ({ valeur: f.id, libelle: f.name }))}
          />
          <Champ
            label="Référence fournisseur"
            value={reference}
            onChange={(evenement) => setReference(evenement.target.value)}
            aide="N° de proforma, de facture…"
          />
          <Champ
            label="Notes"
            value={notes}
            onChange={(evenement) => setNotes(evenement.target.value)}
          />
        </div>

        <div>
          <Champ
            label="Ajouter un produit"
            value={recherche}
            onChange={(evenement) => setRecherche(evenement.target.value)}
            aide="Cherchez par nom ou SKU, puis cliquez pour ajouter une ligne."
          />
          {(produits.donnees ?? []).length > 0 ? (
            <div className="max-h-40 overflow-auto rounded-md border border-encre-200">
              {(produits.donnees ?? []).map((produit) => (
                <button
                  key={produit.id}
                  type="button"
                  onClick={() => {
                    setLignes((precedent) => [
                      ...precedent,
                      {
                        cle: `${produit.id}-${precedent.length}`,
                        productId: produit.id,
                        label: produit.name,
                        quantite: '1',
                        prix: String(produit.purchasePrice),
                      },
                    ]);
                    setRecherche('');
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-marque-50"
                >
                  <span>{produit.name}</span>
                  <span className="mono text-xs text-encre-500">{produit.sku}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {lignes.length > 0 ? (
          <table className="tableau">
            <thead>
              <tr>
                <th>Produit</th>
                <th className="num" style={{ width: '7rem' }}>
                  Quantité
                </th>
                <th className="num" style={{ width: '10rem' }}>
                  Prix unitaire
                </th>
                <th className="num">Total</th>
                <th style={{ width: '3rem' }} />
              </tr>
            </thead>
            <tbody>
              {lignes.map((ligne, index) => (
                <tr key={ligne.cle}>
                  <td>{ligne.label}</td>
                  <td className="num">
                    <input
                      value={ligne.quantite}
                      onChange={(evenement) =>
                        setLignes((precedent) =>
                          precedent.map((element, position) =>
                            position === index
                              ? { ...element, quantite: evenement.target.value }
                              : element,
                          ),
                        )
                      }
                      className="h-7 w-20 rounded border border-encre-300 px-2 text-right"
                    />
                  </td>
                  <td className="num">
                    <input
                      value={ligne.prix}
                      onChange={(evenement) =>
                        setLignes((precedent) =>
                          precedent.map((element, position) =>
                            position === index
                              ? { ...element, prix: evenement.target.value }
                              : element,
                          ),
                        )
                      }
                      className="h-7 w-28 rounded border border-encre-300 px-2 text-right"
                    />
                  </td>
                  <td className="num">
                    {monnaie((Number(ligne.quantite) || 0) * (Number(ligne.prix) || 0))}
                  </td>
                  <td>
                    <Bouton
                      taille="petit"
                      variante="discret"
                      icone="croix"
                      onClick={() =>
                        setLignes((precedent) =>
                          precedent.filter((_, position) => position !== index),
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </Dialogue>
  );
}

function FicheAchat({
  purchaseId,
  onFermer,
  onChange,
}: {
  purchaseId: string;
  onFermer: () => void;
  onChange: () => void;
}) {
  const contexte = useContexte();
  const { db, peut } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [reception, setReception] = useState(false);
  const [fraisOuvert, setFraisOuvert] = useState(false);
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new PurchaseRepository(db).detail(purchaseId);
  }, [db, purchaseId]);

  const action = async (executer: () => Promise<unknown>, message: string) => {
    setOccupe(true);
    try {
      await executer();
      notifier(message);
      etat.recharger();
      onChange();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const detail = etat.donnees;
  const service = new PurchaseService(contexte);

  return (
    <>
      <Dialogue
        ouvert
        titre={detail ? `Achat ${detail.purchase.number}` : 'Achat'}
        onFermer={onFermer}
        largeur="xl"
        pied={
          detail ? (
            <>
              {peut(PERMISSIONS.landedCostManage) && detail.purchase.status !== 'CANCELLED' ? (
                <Bouton icone="plus" onClick={() => setFraisOuvert(true)}>
                  Ajouter un frais
                </Bouton>
              ) : null}
              {detail.purchase.status === 'DRAFT' && peut(PERMISSIONS.purchaseCreate) ? (
                <Bouton
                  occupe={occupe}
                  onClick={() =>
                    void action(() => service.markOrdered(purchaseId), 'Commande envoyée.')
                  }
                >
                  Marquer commandé
                </Bouton>
              ) : null}
              {['ORDERED', 'PARTIALLY_RECEIVED'].includes(detail.purchase.status) &&
              peut(PERMISSIONS.purchaseReceive) ? (
                <Bouton variante="principal" icone="boite" onClick={() => setReception(true)}>
                  Réceptionner
                </Bouton>
              ) : null}
              <Bouton onClick={onFermer}>Fermer</Bouton>
            </>
          ) : null
        }
      >
        {etat.chargement ? (
          <Chargement />
        ) : etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
              <Donnee libelle="Fournisseur" valeur={detail.supplierName} />
              <Donnee libelle="Référence" valeur={detail.purchase.supplierReference ?? '—'} />
              <Donnee libelle="Commandé le" valeur={formaterDate(detail.purchase.orderedAt)} />
              <Donnee libelle="Statut" valeur={<BadgeAchat statut={detail.purchase.status} />} />
            </div>

            <table className="tableau">
              <thead>
                <tr>
                  <th>Produit</th>
                  <th className="num">Commandé</th>
                  <th className="num">Reçu</th>
                  <th className="num">Prix unitaire</th>
                  <th className="num">Frais imputés</th>
                  <th className="num">Coût réel unitaire</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((ligne) => (
                  <tr key={ligne.id}>
                    <td>{ligne.label}</td>
                    <td className="num">{ligne.quantity}</td>
                    <td className="num">
                      <Badge
                        ton={
                          ligne.receivedQuantity >= ligne.quantity
                            ? 'succes'
                            : ligne.receivedQuantity > 0
                              ? 'attente'
                              : 'neutre'
                        }
                      >
                        {ligne.receivedQuantity}
                      </Badge>
                    </td>
                    <td className="num">{monnaie(ligne.unitPrice)}</td>
                    <td className="num">
                      {ligne.allocatedCost > 0 ? monnaie(ligne.allocatedCost) : '—'}
                    </td>
                    <td className="num font-medium">
                      {monnaie(
                        ligne.quantity > 0
                          ? Math.round((ligne.lineTotal + ligne.allocatedCost) / ligne.quantity)
                          : ligne.unitPrice,
                      )}
                    </td>
                    <td className="num">{monnaie(ligne.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {detail.costs.length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-encre-800">Coûts logistiques</h3>
                <table className="tableau">
                  <thead>
                    <tr>
                      <th>Nature</th>
                      <th>Libellé</th>
                      <th>Ventilation</th>
                      <th className="num">Montant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.costs.map((cout) => (
                      <tr key={cout.id}>
                        <td>{LANDED_COST_LABELS[cout.kind]}</td>
                        <td>{cout.label ?? '—'}</td>
                        <td>
                          {cout.allocation === 'BY_VALUE'
                            ? 'Au prorata de la valeur'
                            : 'Au prorata des quantités'}
                        </td>
                        <td className="num">{monnaie(cout.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Information>
                  Les frais sont ventilés sur les lignes ; c'est le coût ainsi obtenu qui est porté
                  par chaque appareil entré en stock, et donc celui qui sert au calcul de la marge.
                </Information>
              </div>
            ) : null}

            <div className="flex justify-end">
              <div className="w-72 space-y-1 text-sm">
                <LigneTotal libelle="Sous-total" valeur={monnaie(detail.purchase.subtotal)} />
                {detail.purchase.discount > 0 ? (
                  <LigneTotal libelle="Remises" valeur={`− ${monnaie(detail.purchase.discount)}`} />
                ) : null}
                {detail.purchase.tax > 0 ? (
                  <LigneTotal libelle="Taxes" valeur={monnaie(detail.purchase.tax)} />
                ) : null}
                <LigneTotal
                  libelle="Frais logistiques"
                  valeur={monnaie(detail.purchase.landedCostTotal)}
                />
                <div className="flex justify-between border-t border-encre-200 pt-1 text-base font-semibold">
                  <span>Coût total</span>
                  <span data-nombre>{monnaie(detail.purchase.total)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Dialogue>

      {reception && detail ? (
        <DialogueReception
          purchaseId={purchaseId}
          lignes={detail.lines}
          onFermer={() => setReception(false)}
          onFait={() => {
            setReception(false);
            etat.recharger();
            onChange();
          }}
        />
      ) : null}

      {fraisOuvert ? (
        <DialogueFrais
          purchaseId={purchaseId}
          onFermer={() => setFraisOuvert(false)}
          onFait={() => {
            setFraisOuvert(false);
            etat.recharger();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Réception : quantités reçues et identifiants des appareils.
 *
 * Les IMEI se saisissent EN BLOC, un par ligne : c'est ainsi qu'on les colle
 * depuis un bordereau, et c'est ainsi que le scanner les enchaîne. Trente
 * champs séparés seraient le meilleur moyen d'en manquer un.
 */
function DialogueReception({
  purchaseId,
  lignes,
  onFermer,
  onFait,
}: {
  purchaseId: string;
  lignes: {
    id: string;
    productId: string;
    label: string;
    quantity: number;
    receivedQuantity: number;
  }[];
  onFermer: () => void;
  onFait: () => void;
}) {
  const contexte = useContexte();
  const { db } = useSession();
  const { notifier } = useNotifications();
  const [quantites, setQuantites] = useState<Record<string, string>>({});
  const [identifiants, setIdentifiants] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const produits = useChargement(async () => {
    if (!db) return new Map<string, string>();
    const repository = new ProductRepository(db);
    const map = new Map<string, string>();
    for (const ligne of lignes) {
      const produit = await repository.byId(ligne.productId);
      if (produit) map.set(ligne.id, produit.tracking);
    }
    return map;
  }, [db, lignes]);

  const valider = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const entrees: ReceiptLineInput[] = [];
      for (const ligne of lignes) {
        const suivi = produits.donnees?.get(ligne.id) ?? TRACKING.quantity;
        if (suivi === TRACKING.quantity) {
          const quantite = Number(quantites[ligne.id] ?? 0) || 0;
          if (quantite > 0) entrees.push({ purchaseLineId: ligne.id, quantity: quantite });
          continue;
        }
        const valeurs = (identifiants[ligne.id] ?? '')
          .split(/[\s,;]+/)
          .map((valeur) => valeur.trim())
          .filter(Boolean);
        if (valeurs.length === 0) continue;
        entrees.push({
          purchaseLineId: ligne.id,
          quantity: valeurs.length,
          units: valeurs.map((valeur) =>
            suivi === TRACKING.imei ? { imei1: valeur } : { serial: valeur },
          ),
        });
      }
      if (entrees.length === 0) throw new Error('Aucune quantité à réceptionner.');

      const resultat = await new PurchaseService(contexte).receive(
        purchaseId,
        entrees,
        note || null,
      );
      notifier(
        resultat.unitIds.length > 0
          ? `Réception enregistrée · ${resultat.unitIds.length} appareil(s) entré(s) en stock.`
          : 'Réception enregistrée.',
      );
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
      titre="Réception de marchandise"
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton variante="principal" occupe={occupe} onClick={() => void valider()}>
            Enregistrer la réception
          </Bouton>
        </>
      }
    >
      <div className="space-y-4">
        {erreur ? <Erreur message={erreur} /> : null}

        {lignes.map((ligne) => {
          const suivi = produits.donnees?.get(ligne.id) ?? TRACKING.quantity;
          const restant = ligne.quantity - ligne.receivedQuantity;
          if (restant <= 0) return null;
          return (
            <div key={ligne.id} className="rounded-md border border-encre-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-encre-900">{ligne.label}</span>
                <Badge ton="neutre">{restant} attendu(s)</Badge>
              </div>
              {suivi === TRACKING.quantity ? (
                <Champ
                  label="Quantité reçue"
                  inputMode="numeric"
                  value={quantites[ligne.id] ?? ''}
                  onChange={(evenement) =>
                    setQuantites((precedent) => ({
                      ...precedent,
                      [ligne.id]: evenement.target.value,
                    }))
                  }
                />
              ) : (
                <ZoneTexte
                  label={suivi === TRACKING.imei ? 'IMEI reçus' : 'Numéros de série reçus'}
                  rows={Math.min(8, Math.max(3, restant))}
                  value={identifiants[ligne.id] ?? ''}
                  onChange={(evenement) =>
                    setIdentifiants((precedent) => ({
                      ...precedent,
                      [ligne.id]: evenement.target.value,
                    }))
                  }
                  aide="Un par ligne. Le nombre saisi détermine la quantité reçue."
                />
              )}
            </div>
          );
        })}

        <ZoneTexte
          label="Note de réception"
          rows={2}
          value={note}
          onChange={(evenement) => setNote(evenement.target.value)}
        />
      </div>
    </Dialogue>
  );
}

function DialogueFrais({
  purchaseId,
  onFermer,
  onFait,
}: {
  purchaseId: string;
  onFermer: () => void;
  onFait: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [nature, setNature] = useState<LandedCostKind>('TRANSPORT');
  const [libelle, setLibelle] = useState('');
  const [montant, setMontant] = useState('');
  const [ventilation, setVentilation] = useState<'BY_VALUE' | 'BY_QUANTITY'>('BY_VALUE');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const ajouter = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      await new PurchaseService(contexte).addLandedCost(purchaseId, {
        kind: nature,
        label: libelle || null,
        amount: Number(montant) || 0,
        allocation: ventilation,
      });
      notifier('Frais ajouté et ventilé sur les lignes.');
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
      titre="Ajouter un coût logistique"
      onFermer={onFermer}
      largeur="sm"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton variante="principal" occupe={occupe} onClick={() => void ajouter()}>
            Ajouter
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        {erreur ? <Erreur message={erreur} /> : null}
        <Liste
          label="Nature"
          value={nature}
          onChange={(evenement) => setNature(evenement.target.value as LandedCostKind)}
          options={valuesOf(LANDED_COST_KIND).map((valeur) => ({
            valeur,
            libelle: LANDED_COST_LABELS[valeur],
          }))}
        />
        <Champ
          label="Libellé"
          value={libelle}
          onChange={(evenement) => setLibelle(evenement.target.value)}
          aide="Facultatif : n° de dossier de douane, transporteur…"
        />
        <Champ
          label="Montant"
          requis
          autoFocus
          inputMode="decimal"
          value={montant}
          onChange={(evenement) => setMontant(evenement.target.value)}
        />
        <Liste
          label="Ventilation"
          value={ventilation}
          onChange={(evenement) =>
            setVentilation(evenement.target.value as 'BY_VALUE' | 'BY_QUANTITY')
          }
          options={[
            { valeur: 'BY_VALUE', libelle: 'Au prorata de la valeur des lignes' },
            { valeur: 'BY_QUANTITY', libelle: 'Au prorata des quantités' },
          ]}
          aide="La douane suit la valeur ; le transport suit le volume."
        />
      </div>
    </Dialogue>
  );
}

function Donnee({ libelle, valeur }: { libelle: string; valeur: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-encre-500">{libelle}</p>
      <div className="text-encre-900">{valeur}</div>
    </div>
  );
}

function LigneTotal({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-encre-600">{libelle}</span>
      <span data-nombre>{valeur}</span>
    </div>
  );
}
