import { useState } from 'react';
import { MOVEMENT_LABELS, PERMISSIONS, UNIT_STATUS, valuesOf } from '@boutique/shared';
import type { UnitStatus } from '@boutique/shared';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { ProductRepository } from '@/core/db/repositories/product.repository';
import { SupplierRepository } from '@/core/db/repositories/supplier.repository';
import { ExchangeRepository } from '@/core/db/repositories/refund.repository';
import { StockService } from '@/core/services/stock.service';
import { toCsv, exportFileName } from '@/core/services/export.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { Badge, BadgeUnite } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Confirmation, Dialogue } from '@/components/ui/Dialogue';
import { Liste, ZoneTexte } from '@/components/ui/Champ';
import {
  BarreFiltres,
  BarreSelection,
  ChampRecherche,
  ListeFiltre,
  Pagination,
  Tableau,
} from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { formaterDate, messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';
import { telecharger } from '@/features/gestion/telechargement';

/**
 * Appareils identifiés : IMEI et numéros de série (§7).
 *
 * LA FICHE D'UN APPAREIL est le cœur de cet écran, et l'exigence la plus
 * explicite du cahier des charges (§23) : d'où il vient, chez quel fournisseur
 * il a été acheté, dans quelle boutique il se trouve, quand il a été vendu, à
 * qui, s'il est revenu, s'il a été échangé, s'il a été transféré. Tout est là,
 * en une page, dans l'ordre chronologique.
 */
const LIBELLES_STATUT: Record<UnitStatus, string> = {
  IN_STOCK: 'En stock',
  RESERVED: 'Réservé',
  SOLD: 'Vendu',
  IN_TRANSFER: 'En transfert',
  TRANSFERRED: 'Transféré',
  RETURNED: 'Retourné',
  EXCHANGED: 'Échangé',
  REFUNDED: 'Remboursé',
  DEFECTIVE: 'Défectueux',
  LOST: 'Perdu',
  BLOCKED: 'Bloqué',
};

export function Appareils({ parametre }: { parametre?: string | null }) {
  const { db, shopId, peut } = useSession();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [statut, setStatut] = useState('');
  const [portee, setPortee] = useState('boutique');
  const [offset, setOffset] = useState(0);
  const [ouvert, setOuvert] = useState<string | null>(parametre ?? null);
  const [choisis, setChoisis] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<'sortie' | 'suppression' | null>(null);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new UnitRepository(db).list({
      shopId: portee === 'boutique' ? shopId : null,
      status: statut ? (statut as UnitStatus) : null,
      query: differee,
      limit: limite,
      offset,
    });
  }, [db, shopId, portee, statut, differee, offset]);

  const exporter = () => {
    if (!etat.donnees) return;
    telecharger(
      exportFileName('appareils'),
      toCsv(etat.donnees.items, [
        { header: 'IMEI 1', value: (l) => l.imei1 ?? '' },
        { header: 'IMEI 2', value: (l) => l.imei2 ?? '' },
        { header: 'Numéro de série', value: (l) => l.serial ?? '' },
        { header: 'Produit', value: (l) => l.productName },
        { header: 'SKU', value: (l) => l.productSku },
        { header: 'Boutique', value: (l) => l.shopName },
        { header: 'Statut', value: (l) => LIBELLES_STATUT[l.status] },
        { header: 'Reçu le', value: (l) => formaterDate(l.receivedAt) },
      ]),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="IMEI et numéros de série"
        sousTitre={
          etat.donnees
            ? `${etat.donnees.total} appareil${etat.donnees.total > 1 ? 's' : ''}`
            : undefined
        }
        actions={
          <Bouton icone="export" onClick={exporter} disabled={!etat.donnees}>
            Exporter
          </Bouton>
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreSelection nombre={choisis.size} onEffacer={() => setChoisis(new Set())}>
          {peut(PERMISSIONS.stockAdjust) ? (
            <>
              <Bouton taille="petit" icone="alerte" onClick={() => setAction('sortie')}>
                Déclarer perdus ou défectueux
              </Bouton>
              <Bouton
                taille="petit"
                variante="danger"
                icone="poubelle"
                onClick={() => setAction('suppression')}
              >
                Supprimer les saisies erronées
              </Bouton>
            </>
          ) : null}
        </BarreSelection>

        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={(valeur) => {
              setRecherche(valeur);
              setOffset(0);
            }}
            placeholder="IMEI, numéro de série, SKU…"
            largeur="w-72"
            autoFocus
          />
          <ListeFiltre
            valeur={statut}
            onChanger={(valeur) => {
              setStatut(valeur);
              setOffset(0);
            }}
            vide="Tous les statuts"
            options={valuesOf(UNIT_STATUS).map((valeur) => ({
              valeur,
              libelle: LIBELLES_STATUT[valeur],
            }))}
          />
          <ListeFiltre
            valeur={portee}
            onChanger={(valeur) => {
              setPortee(valeur);
              setOffset(0);
            }}
            options={[
              { valeur: 'boutique', libelle: 'Cette boutique' },
              { valeur: 'reseau', libelle: 'Tout le réseau' },
            ]}
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
            selection={
              peut(PERMISSIONS.stockAdjust)
                ? {
                    clefs: choisis,
                    onChanger: setChoisis,
                    // Un appareil vendu ne se sort pas du stock : il passe par
                    // un retour ou un remboursement, qui rendent l'argent.
                    selectionnable: (ligne) => ligne.status !== 'SOLD',
                  }
                : undefined
            }
            vide={{
              icone: 'telephone',
              titre: 'Aucun appareil',
              detail:
                "Les appareils apparaissent ici dès qu'un IMEI ou un numéro de série entre en stock.",
            }}
            colonnes={[
              {
                cle: 'identifiant',
                titre: 'Identifiant',
                rendu: (l) => (
                  <div>
                    <div className="mono font-medium">{l.imei1 ?? l.serial ?? '—'}</div>
                    {l.imei2 ? <div className="mono text-xs text-encre-500">{l.imei2}</div> : null}
                  </div>
                ),
              },
              {
                cle: 'produit',
                titre: 'Produit',
                rendu: (l) => (
                  <div>
                    <div>{l.productName}</div>
                    <div className="mono text-xs text-encre-500">{l.productSku}</div>
                  </div>
                ),
              },
              { cle: 'boutique', titre: 'Boutique', rendu: (l) => l.shopName },
              { cle: 'statut', titre: 'Statut', rendu: (l) => <BadgeUnite statut={l.status} /> },
              { cle: 'recu', titre: 'Reçu le', rendu: (l) => formaterDate(l.receivedAt) },
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

      {action ? (
        <ActionGroupee
          mode={action}
          ids={[...choisis]}
          onFermer={() => setAction(null)}
          onFait={() => {
            setAction(null);
            setChoisis(new Set());
            etat.recharger();
          }}
        />
      ) : null}

      {ouvert ? (
        <FicheAppareil
          unitId={ouvert}
          onFermer={() => setOuvert(null)}
          onChange={() => etat.recharger()}
          peutCorriger={peut(PERMISSIONS.stockAdjust)}
        />
      ) : null}
    </div>
  );
}

/**
 * Fiche d'un appareil : son histoire complète.
 *
 * Chaque mouvement est présenté comme un événement daté, du plus ancien au plus
 * récent. C'est cette page qu'on ouvre quand un client revient six mois plus
 * tard avec un téléphone et une question.
 */
function FicheAppareil({
  unitId,
  onFermer,
  onChange,
  peutCorriger,
}: {
  unitId: string;
  onFermer: () => void;
  onChange: () => void;
  peutCorriger: boolean;
}) {
  const contexte = useContexte();
  const { db } = useSession();
  const { aller } = useNavigation();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [sortie, setSortie] = useState(false);
  const [statutSortie, setStatutSortie] = useState<'LOST' | 'DEFECTIVE' | 'BLOCKED'>('LOST');
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    const unite = await new UnitRepository(db).byId(unitId);
    if (!unite) throw new Error('Appareil introuvable.');
    const [historique, produit, fournisseur, ventes, echanges] = await Promise.all([
      new StockRepository(db).unitHistory(unitId),
      new ProductRepository(db).byId(unite.productId),
      unite.supplierId ? new SupplierRepository(db).byId(unite.supplierId) : Promise.resolve(null),
      new SaleRepository(db).forUnit(unitId),
      new ExchangeRepository(db).forUnit(unitId),
    ]);
    return { unite, historique, produit, fournisseur, ventes, echanges };
  }, [db, unitId]);

  const sortir = async () => {
    setOccupe(true);
    try {
      await new StockService(contexte).writeOffUnit(unitId, statutSortie, motif);
      notifier('Appareil sorti du stock vendable.');
      setSortie(false);
      setMotif('');
      etat.recharger();
      onChange();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const unite = etat.donnees?.unite;

  return (
    <>
      <Dialogue
        ouvert
        titre={unite ? (unite.imei1 ?? unite.serial ?? 'Appareil') : 'Appareil'}
        onFermer={onFermer}
        largeur="lg"
        pied={
          <>
            {peutCorriger && unite && unite.status !== 'SOLD' ? (
              <Bouton variante="danger" onClick={() => setSortie(true)}>
                Déclarer perdu ou défectueux
              </Bouton>
            ) : null}
            <Bouton variante="principal" onClick={onFermer}>
              Fermer
            </Bouton>
          </>
        }
      >
        {etat.chargement ? (
          <Chargement />
        ) : etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : unite ? (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3 text-sm">
              <Donnee libelle="Produit" valeur={etat.donnees?.produit?.name ?? '—'} />
              <Donnee libelle="Statut" valeur={<BadgeUnite statut={unite.status} />} />
              <Donnee libelle="Fournisseur" valeur={etat.donnees?.fournisseur?.name ?? '—'} />
              <Donnee libelle="Coût d'acquisition" valeur={monnaie(unite.costPrice)} />
              <Donnee
                libelle="IMEI 1"
                valeur={<span className="mono">{unite.imei1 ?? '—'}</span>}
              />
              <Donnee
                libelle="IMEI 2"
                valeur={<span className="mono">{unite.imei2 ?? '—'}</span>}
              />
              <Donnee
                libelle="Numéro de série"
                valeur={<span className="mono">{unite.serial ?? '—'}</span>}
              />
              <Donnee libelle="Reçu le" valeur={formaterDate(unite.receivedAt)} />
              <Donnee libelle="État" valeur={unite.condition} />
              <Donnee libelle="Couleur" valeur={unite.color ?? '—'} />
              <Donnee libelle="Capacité" valeur={unite.capacity ?? '—'} />
              <Donnee libelle="Vendu le" valeur={formaterDate(unite.soldAt)} />
            </div>

            {unite.notes ? (
              <p className="rounded-md bg-encre-50 px-3 py-2 text-sm text-encre-700">
                {unite.notes}
              </p>
            ) : null}

            <div>
              <h3 className="mb-1.5 text-encre-800">Historique</h3>
              <ol className="space-y-2 border-l-2 border-encre-200 pl-4">
                {(etat.donnees?.historique ?? []).map((mouvement) => (
                  <li key={mouvement.id} className="relative">
                    <span className="absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-marque-500" />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium text-encre-900">
                        {MOVEMENT_LABELS[mouvement.type] ?? mouvement.type}
                      </span>
                      <span className="text-xs text-encre-500">
                        {formaterDate(mouvement.occurredAt, true)}
                      </span>
                      {mouvement.sourceLabel ? (
                        <span className="mono text-xs text-encre-600">{mouvement.sourceLabel}</span>
                      ) : null}
                      {mouvement.userLabel ? (
                        <span className="text-xs text-encre-500">· {mouvement.userLabel}</span>
                      ) : null}
                    </div>
                    {mouvement.note ? (
                      <p className="text-xs text-encre-600">{mouvement.note}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>

            {(etat.donnees?.ventes.length ?? 0) > 0 ? (
              <div>
                <h3 className="mb-1.5 text-encre-800">Ventes</h3>
                <div className="flex flex-wrap gap-2">
                  {etat.donnees?.ventes.map((vente) => (
                    <button key={vente.id} type="button" onClick={() => aller('tickets', vente.id)}>
                      <Badge ton="info">
                        {vente.number} · {formaterDate(vente.soldAt)}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {(etat.donnees?.echanges.length ?? 0) > 0 ? (
              <div>
                <h3 className="mb-1.5 text-encre-800">Échanges</h3>
                <div className="flex flex-wrap gap-2">
                  {etat.donnees?.echanges.map((echange) => (
                    <Badge key={echange.id} ton="neutre">
                      {echange.number} · {formaterDate(echange.exchangedAt)}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialogue>

      <Confirmation
        ouvert={sortie}
        titre="Sortir cet appareil du stock"
        libelleAction="Confirmer la sortie"
        danger
        occupe={occupe}
        onConfirmer={() => void sortir()}
        onFermer={() => setSortie(false)}
        message="L'appareil quittera le stock vendable. Son historique reste consultable, et il pourra être remis en stock par une correction."
      >
        <Liste
          label="Nouveau statut"
          value={statutSortie}
          onChange={(e) => setStatutSortie(e.target.value as 'LOST' | 'DEFECTIVE' | 'BLOCKED')}
          options={[
            { valeur: 'LOST', libelle: 'Perdu' },
            { valeur: 'DEFECTIVE', libelle: 'Défectueux' },
            { valeur: 'BLOCKED', libelle: 'Bloqué' },
          ]}
        />
        <ZoneTexte label="Motif" requis value={motif} onChange={(e) => setMotif(e.target.value)} />
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

/**
 * Action groupée sur une sélection d'appareils.
 *
 * DEUX GESTES, et ils ne se valent pas :
 *
 *  - SORTIR DU STOCK écrit un mouvement et conserve l'appareil : c'est ce
 *    qu'on fait pour une perte, une casse, un appareil bloqué. L'histoire de
 *    l'IMEI reste consultable, et l'appareil peut revenir par une correction.
 *
 *  - SUPPRIMER efface pour de bon, et n'est possible que sur un appareil qui
 *    n'a JAMAIS bougé — un IMEI mal recopié qu'on retire dans la minute.
 *    Laisser la fiche fantôme empêcherait de ressaisir le bon numéro, l'IMEI
 *    restant pris.
 */
function ActionGroupee({
  mode,
  ids,
  onFermer,
  onFait,
}: {
  mode: 'sortie' | 'suppression';
  ids: string[];
  onFermer: () => void;
  onFait: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [statut, setStatut] = useState<'LOST' | 'DEFECTIVE' | 'BLOCKED'>('LOST');
  const [motif, setMotif] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [refus, setRefus] = useState<{ identifier: string; reason: string }[]>([]);

  const executer = async () => {
    setOccupe(true);
    try {
      const service = new StockService(contexte);
      if (mode === 'sortie') {
        const rapport = await service.writeOffMany(ids, statut, motif);
        setRefus(rapport.failed.map((e) => ({ identifier: e.identifier, reason: e.reason })));
        notifier(`${rapport.done} appareil(s) sortis du stock.`);
        if (rapport.failed.length === 0) onFait();
      } else {
        const rapport = await service.deleteUntouched(ids);
        setRefus(rapport.kept);
        notifier(`${rapport.deleted} appareil(s) supprimés.`);
        if (rapport.kept.length === 0) onFait();
      }
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre={
        mode === 'sortie'
          ? `Sortir ${ids.length} appareil${ids.length > 1 ? 's' : ''} du stock`
          : `Supprimer ${ids.length} appareil${ids.length > 1 ? 's' : ''}`
      }
      onFermer={refus.length > 0 ? onFait : onFermer}
      largeur="sm"
      pied={
        refus.length > 0 ? (
          <Bouton variante="principal" onClick={onFait}>
            Fermer
          </Bouton>
        ) : (
          <>
            <Bouton onClick={onFermer} disabled={occupe}>
              Annuler
            </Bouton>
            <Bouton
              variante="danger"
              occupe={occupe}
              disabled={mode === 'sortie' && motif.trim() === ''}
              onClick={() => void executer()}
            >
              {mode === 'sortie' ? 'Sortir du stock' : 'Supprimer'}
            </Bouton>
          </>
        )
      }
    >
      {refus.length > 0 ? (
        <div className="space-y-3">
          <Erreur message={`${refus.length} appareil(s) conservés.`} />
          <ul className="max-h-64 list-disc space-y-0.5 overflow-auto pl-5 text-sm text-encre-700">
            {refus.map((ligne) => (
              <li key={ligne.identifier}>
                <span className="mono">{ligne.identifier}</span> — {ligne.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : mode === 'sortie' ? (
        <div className="space-y-3">
          <Information>
            Les appareils quittent le stock vendable, sans disparaître : leur historique reste
            consultable, et une correction peut les y remettre.
          </Information>
          <Liste
            label="Nouveau statut"
            value={statut}
            onChange={(e) => setStatut(e.target.value as 'LOST' | 'DEFECTIVE' | 'BLOCKED')}
            options={[
              { valeur: 'LOST', libelle: 'Perdus' },
              { valeur: 'DEFECTIVE', libelle: 'Défectueux' },
              { valeur: 'BLOCKED', libelle: 'Bloqués' },
            ]}
          />
          <ZoneTexte
            label="Motif"
            requis
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            aide="Il figurera sur chaque mouvement et dans le journal d'audit."
          />
        </div>
      ) : (
        <Information>
          Seuls les appareils qui n'ont <strong>jamais bougé</strong> seront effacés — entrés en
          stock, et rien de plus. Ceux qui ont été vendus, transférés ou corrigés sont conservés, et
          vous serez informé de la liste. C'est le geste pour retirer un IMEI mal saisi, dont le
          numéro doit redevenir disponible.
        </Information>
      )}
    </Dialogue>
  );
}
