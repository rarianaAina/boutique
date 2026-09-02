import { useState } from 'react';
import { PERMISSIONS, TRANSFER_LABELS, TRANSFER_STATUS, valuesOf } from '@boutique/shared';
import type { TransferStatus } from '@boutique/shared';
import { TransferRepository } from '@/core/db/repositories/transfer.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { TransferService } from '@/core/services/transfer.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { BadgeTransfert, Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue, Confirmation } from '@/components/ui/Dialogue';
import { Champ, Liste, ZoneTexte } from '@/components/ui/Champ';
import { BarreFiltres, ListeFiltre, Pagination, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';

/**
 * Transferts entre boutiques (§17).
 *
 * L'écran distingue nettement CE QUE J'ENVOIE de CE QUE JE REÇOIS : ce ne sont
 * pas les mêmes gestes ni les mêmes droits. L'expéditeur demande, valide et
 * expédie ; le destinataire réceptionne ou refuse.
 *
 * Toutes ces étapes s'écrivent hors ligne. Seule leur transmission à l'autre
 * boutique passe par la synchronisation, et l'écran le rappelle plutôt que de
 * laisser croire que le colis est annoncé dès qu'on clique.
 */
export function Transferts({ parametre }: { parametre?: string | null }) {
  const { db, shopId, peut } = useSession();
  const [sens, setSens] = useState<'out' | 'in' | 'both'>('both');
  const [statut, setStatut] = useState('');
  const [offset, setOffset] = useState(0);
  const [ouvert, setOuvert] = useState<string | null>(parametre ?? null);
  const [creation, setCreation] = useState(false);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new TransferRepository(db).list({
      shopId,
      direction: sens,
      status: statut ? (statut as TransferStatus) : null,
      limit: limite,
      offset,
    });
  }, [db, shopId, sens, statut, offset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Transferts"
        sousTitre="Mouvements de marchandise entre les boutiques du réseau."
        actions={
          peut(PERMISSIONS.transferCreate) ? (
            <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
              Nouveau transfert
            </Bouton>
          ) : null
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ListeFiltre
            valeur={sens}
            onChanger={(valeur) => {
              setSens(valeur as 'out' | 'in' | 'both');
              setOffset(0);
            }}
            options={[
              { valeur: 'both', libelle: 'Tous les transferts' },
              { valeur: 'out', libelle: "Ce que j'envoie" },
              { valeur: 'in', libelle: 'Ce que je reçois' },
            ]}
          />
          <ListeFiltre
            valeur={statut}
            onChanger={(valeur) => {
              setStatut(valeur);
              setOffset(0);
            }}
            vide="Tous les statuts"
            options={valuesOf(TRANSFER_STATUS).map((valeur) => ({
              valeur,
              libelle: TRANSFER_LABELS[valeur],
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
            vide={{ icone: 'camion', titre: 'Aucun transfert' }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              {
                cle: 'sens',
                titre: 'Sens',
                rendu: (l) => (
                  <Badge ton={l.fromShopId === shopId ? 'info' : 'attente'}>
                    {l.fromShopId === shopId ? 'Envoi' : 'Réception'}
                  </Badge>
                ),
              },
              { cle: 'date', titre: 'Demandé le', rendu: (l) => formaterDate(l.requestedAt) },
              { cle: 'articles', titre: 'Articles', num: true, rendu: (l) => l.itemCount },
              {
                cle: 'statut',
                titre: 'Statut',
                rendu: (l) => <BadgeTransfert statut={l.status} />,
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
        <NouveauTransfert
          onFermer={() => setCreation(false)}
          onCree={(id) => {
            setCreation(false);
            setOuvert(id);
            etat.recharger();
          }}
        />
      ) : null}

      {ouvert ? (
        <FicheTransfert
          transferId={ouvert}
          onFermer={() => setOuvert(null)}
          onChange={() => etat.recharger()}
        />
      ) : null}
    </div>
  );
}

interface LigneTransfert {
  cle: string;
  productId: string;
  unitId: string | null;
  libelle: string;
  identifiant: string | null;
  quantite: number;
}

function NouveauTransfert({
  onFermer,
  onCree,
}: {
  onFermer: () => void;
  onCree: (id: string) => void;
}) {
  const contexte = useContexte();
  const { db, shopId } = useSession();
  const { notifier } = useNotifications();
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [saisie, setSaisie] = useState('');
  const [lignes, setLignes] = useState<LigneTransfert[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const boutiques = useChargement(async () => {
    if (!db) return [];
    const toutes = await new ShopRepository(db).list();
    return toutes.filter((boutique) => boutique.id !== shopId);
  }, [db, shopId]);

  const ajouter = async () => {
    setErreur(null);
    if (!db) return;
    const terme = saisie.trim();
    if (terme === '') return;

    const unite = await new UnitRepository(db).byIdentifier(terme);
    if (unite) {
      if (unite.shopId !== shopId) {
        setErreur("Cet appareil n'est pas dans cette boutique.");
        return;
      }
      if (lignes.some((ligne) => ligne.unitId === unite.id)) {
        setErreur('Cet appareil figure déjà dans le transfert.');
        return;
      }
      const produit = await new ProductRepository(db).byId(unite.productId);
      setLignes((precedent) => [
        ...precedent,
        {
          cle: unite.id,
          productId: unite.productId,
          unitId: unite.id,
          libelle: produit?.name ?? '',
          identifiant: unite.imei1 ?? unite.serial ?? null,
          quantite: 1,
        },
      ]);
      setSaisie('');
      return;
    }

    const produit = await new ProductRepository(db).bySku(terme);
    if (produit) {
      if (produit.tracking !== 'QUANTITY') {
        setErreur("Ce produit est suivi à l'unité : scannez l'IMEI de l'appareil.");
        return;
      }
      setLignes((precedent) => [
        ...precedent,
        {
          cle: `${produit.id}-${precedent.length}`,
          productId: produit.id,
          unitId: null,
          libelle: produit.name,
          identifiant: null,
          quantite: 1,
        },
      ]);
      setSaisie('');
      return;
    }

    setErreur('Aucun appareil ni produit ne correspond à cette saisie.');
  };

  const creer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const { transferId } = await new TransferService(contexte).request({
        toShopId: destination,
        note: note || null,
        lines: lignes.map((ligne) => ({
          productId: ligne.productId,
          unitId: ligne.unitId,
          label: ligne.libelle,
          identifier: ligne.identifiant,
          quantity: ligne.quantite,
        })),
      });
      notifier('Transfert demandé. Les articles sont réservés.');
      onCree(transferId);
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre="Nouveau transfert"
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton
            variante="principal"
            occupe={occupe}
            disabled={destination === '' || lignes.length === 0}
            onClick={() => void creer()}
          >
            Demander le transfert
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        {erreur ? <Erreur message={erreur} /> : null}

        <Liste
          label="Boutique de destination"
          requis
          vide="Choisir…"
          value={destination}
          onChange={(evenement) => setDestination(evenement.target.value)}
          options={(boutiques.donnees ?? []).map((boutique) => ({
            valeur: boutique.id,
            libelle: `${boutique.name} (${boutique.code})`,
          }))}
        />

        <div className="flex items-end gap-2">
          <Champ
            label="Ajouter un article"
            className="flex-1"
            autoFocus
            value={saisie}
            onChange={(evenement) => setSaisie(evenement.target.value)}
            onKeyDown={(evenement) => {
              if (evenement.key === 'Enter') void ajouter();
            }}
            aide="Scannez un IMEI, ou saisissez le SKU d'un produit suivi par quantité."
          />
          <Bouton icone="plus" className="mb-5" onClick={() => void ajouter()}>
            Ajouter
          </Bouton>
        </div>

        {lignes.length > 0 ? (
          <table className="tableau">
            <thead>
              <tr>
                <th>Article</th>
                <th>Identifiant</th>
                <th className="num" style={{ width: '6rem' }}>
                  Qté
                </th>
                <th style={{ width: '3rem' }} />
              </tr>
            </thead>
            <tbody>
              {lignes.map((ligne, index) => (
                <tr key={ligne.cle}>
                  <td>{ligne.libelle}</td>
                  <td className="mono">{ligne.identifiant ?? '—'}</td>
                  <td className="num">
                    {ligne.unitId ? (
                      1
                    ) : (
                      <input
                        value={ligne.quantite}
                        onChange={(evenement) =>
                          setLignes((precedent) =>
                            precedent.map((element, position) =>
                              position === index
                                ? { ...element, quantite: Number(evenement.target.value) || 1 }
                                : element,
                            ),
                          )
                        }
                        className="h-7 w-16 rounded border border-encre-300 px-2 text-right"
                      />
                    )}
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

        <ZoneTexte
          label="Note"
          rows={2}
          value={note}
          onChange={(evenement) => setNote(evenement.target.value)}
        />
      </div>
    </Dialogue>
  );
}

function FicheTransfert({
  transferId,
  onFermer,
  onChange,
}: {
  transferId: string;
  onFermer: () => void;
  onChange: () => void;
}) {
  const contexte = useContexte();
  const { db, shopId, peut } = useSession();
  const { notifier } = useNotifications();
  const [refus, setRefus] = useState(false);
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new TransferRepository(db).detail(transferId);
  }, [db, transferId]);

  const service = new TransferService(contexte);
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
  const estSource = detail?.transfer.fromShopId === shopId;
  const estDestination = detail?.transfer.toShopId === shopId;
  const statut = detail?.transfer.status;

  return (
    <>
      <Dialogue
        ouvert
        titre={detail ? `Transfert ${detail.transfer.number}` : 'Transfert'}
        onFermer={onFermer}
        largeur="lg"
        pied={
          detail ? (
            <>
              {estSource && statut === 'REQUESTED' && peut(PERMISSIONS.transferApprove) ? (
                <Bouton
                  occupe={occupe}
                  onClick={() =>
                    void action(() => service.approve(transferId), 'Transfert validé.')
                  }
                >
                  Valider
                </Bouton>
              ) : null}
              {estSource &&
              (statut === 'APPROVED' || statut === 'REQUESTED') &&
              peut(PERMISSIONS.transferApprove) ? (
                <Bouton
                  variante="principal"
                  icone="camion"
                  occupe={occupe}
                  onClick={() =>
                    void action(
                      () => service.ship(transferId),
                      'Transfert expédié. Le stock est sorti.',
                    )
                  }
                >
                  Expédier
                </Bouton>
              ) : null}
              {estSource && ['DRAFT', 'REQUESTED', 'APPROVED'].includes(statut ?? '') ? (
                <Bouton
                  variante="danger"
                  occupe={occupe}
                  onClick={() =>
                    void action(
                      () => service.cancel(transferId, 'Annulé par la boutique expéditrice'),
                      'Transfert annulé, réservations levées.',
                    )
                  }
                >
                  Annuler
                </Bouton>
              ) : null}
              {estDestination &&
              ['SHIPPED', 'IN_TRANSIT'].includes(statut ?? '') &&
              peut(PERMISSIONS.transferReceive) ? (
                <>
                  <Bouton variante="danger" onClick={() => setRefus(true)}>
                    Refuser
                  </Bouton>
                  <Bouton
                    variante="principal"
                    icone="check"
                    occupe={occupe}
                    onClick={() =>
                      void action(
                        () => service.receive(transferId),
                        'Transfert réceptionné. Les articles sont entrés en stock.',
                      )
                    }
                  >
                    Réceptionner
                  </Bouton>
                </>
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
              <Donnee libelle="De" valeur={detail.fromShopName} />
              <Donnee libelle="Vers" valeur={detail.toShopName} />
              <Donnee
                libelle="Demandé le"
                valeur={formaterDate(detail.transfer.requestedAt, true)}
              />
              <Donnee
                libelle="Statut"
                valeur={<BadgeTransfert statut={detail.transfer.status} />}
              />
              <Donnee libelle="Validé le" valeur={formaterDate(detail.transfer.approvedAt, true)} />
              <Donnee libelle="Expédié le" valeur={formaterDate(detail.transfer.shippedAt, true)} />
              <Donnee libelle="Reçu le" valeur={formaterDate(detail.transfer.receivedAt, true)} />
              <Donnee libelle="Note" valeur={detail.transfer.note ?? '—'} />
            </div>

            {detail.transfer.rejectionReason ? (
              <Erreur message={`Refusé : ${detail.transfer.rejectionReason}`} />
            ) : null}

            {statut === 'SHIPPED' || statut === 'IN_TRANSIT' ? (
              <Information>
                La marchandise est sortie du stock de {detail.fromShopName} et n'est pas encore
                entrée dans celui de {detail.toShopName} : elle reste sous la responsabilité de
                l'expéditeur jusqu'à la réception.
              </Information>
            ) : null}

            {['REQUESTED', 'APPROVED', 'SHIPPED'].includes(statut ?? '') ? (
              <Information>
                Cette étape est enregistrée localement. Elle ne sera connue de l'autre boutique
                qu'après une synchronisation.
              </Information>
            ) : null}

            <table className="tableau">
              <thead>
                <tr>
                  <th>Article</th>
                  <th>Identifiant</th>
                  <th className="num">Quantité</th>
                  <th className="num">Reçu</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((ligne) => (
                  <tr key={ligne.id}>
                    <td>{ligne.label}</td>
                    <td className="mono">{ligne.identifier ?? '—'}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Dialogue>

      <Confirmation
        ouvert={refus}
        titre="Refuser ce transfert"
        libelleAction="Refuser"
        danger
        occupe={occupe}
        onConfirmer={() =>
          void action(() => service.reject(transferId, motif), 'Transfert refusé.').then(() =>
            setRefus(false),
          )
        }
        onFermer={() => setRefus(false)}
        message="La marchandise sera rendue à la boutique expéditrice."
      >
        <ZoneTexte
          label="Motif du refus"
          requis
          value={motif}
          onChange={(evenement) => setMotif(evenement.target.value)}
        />
      </Confirmation>
    </>
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
