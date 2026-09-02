import { useState } from 'react';
import { SaleRepository } from '@/core/db/repositories/sale.repository';
import { RefundRepository } from '@/core/db/repositories/refund.repository';
import { RefundService } from '@/core/services/refund.service';
import { activePaymentMethods } from '@/core/services/setup.service';
import { Carte, Chargement, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, Case, Liste, ZoneTexte } from '@/components/ui/Champ';
import { Pagination, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useMonnaie } from '@/app/hooks';

/**
 * Remboursements (§16).
 *
 * L'écran part TOUJOURS d'une vente : on ne rembourse pas dans le vide. Le
 * vendeur saisit le numéro de ticket ou l'IMEI, le logiciel retrouve la vente,
 * affiche ce qui reste remboursable, et refuse tout ce qui dépasse. Le plafond
 * n'est pas une suggestion : rembourser deux fois la même vente est l'erreur la
 * plus coûteuse d'un comptoir, et elle passe inaperçue si rien ne l'empêche.
 */
export function Remboursements() {
  const { db, shopId } = useSession();
  const monnaie = useMonnaie();
  const [offset, setOffset] = useState(0);
  const [nouveau, setNouveau] = useState(false);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new RefundRepository(db).list({ shopId, limit: limite, offset });
  }, [db, shopId, offset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Remboursements"
        sousTitre={
          etat.donnees
            ? `${etat.donnees.total} remboursement(s) · ${monnaie(etat.donnees.sum)} rendus`
            : undefined
        }
        actions={
          <Bouton variante="principal" icone="retour" onClick={() => setNouveau(true)}>
            Nouveau remboursement
          </Bouton>
        }
      />

      <Carte compact className="min-h-0 flex-1">
        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees?.items ?? []}
            cleDe={(ligne) => ligne.id}
            vide={{ icone: 'retour', titre: 'Aucun remboursement' }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.refundedAt, true) },
              {
                cle: 'vente',
                titre: 'Ticket',
                rendu: (l) => <span className="mono">{l.saleNumber}</span>,
              },
              { cle: 'mode', titre: 'Mode', rendu: (l) => l.method },
              { cle: 'motif', titre: 'Motif', rendu: (l) => l.reason ?? '—' },
              {
                cle: 'total',
                titre: 'Montant',
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

      {nouveau ? (
        <DialogueRemboursement
          onFermer={() => setNouveau(false)}
          onFait={() => {
            setNouveau(false);
            etat.recharger();
          }}
        />
      ) : null}
    </div>
  );
}

function DialogueRemboursement({ onFermer, onFait }: { onFermer: () => void; onFait: () => void }) {
  const contexte = useContexte();
  const { db, shopId } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [reference, setReference] = useState('');
  const [saleId, setSaleId] = useState<string | null>(null);
  const [quantites, setQuantites] = useState<Record<string, number>>({});
  const [remises, setRemises] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState('CASH');
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const modes = useChargement(async () => (db ? activePaymentMethods(db) : []), [db]);

  const remboursable = useChargement(async () => {
    if (!saleId) return null;
    return new RefundService(contexte).refundable(saleId);
  }, [contexte.db, saleId]);

  const detail = useChargement(
    async () => (db && saleId ? new SaleRepository(db).detail(saleId) : null),
    [db, saleId],
  );

  const chercher = async () => {
    setErreur(null);
    if (!db) return;
    const terme = reference.trim();
    if (terme === '') return;
    // Un numéro de ticket ou un IMEI : les deux mènent à la même vente.
    const parNumero = await new SaleRepository(db).byNumber(shopId, terme);
    if (parNumero) {
      setSaleId(parNumero.id);
      return;
    }
    const { UnitRepository } = await import('@/core/db/repositories/unit.repository');
    const unite = await new UnitRepository(db).byIdentifier(terme);
    if (unite?.saleId) {
      setSaleId(unite.saleId);
      return;
    }
    setErreur('Aucune vente ne correspond à ce numéro de ticket ni à cet IMEI.');
  };

  const valider = async () => {
    if (!saleId) return;
    setErreur(null);
    setOccupe(true);
    try {
      const lignes = Object.entries(quantites)
        .filter(([, quantite]) => quantite > 0)
        .map(([saleLineId, quantite]) => ({
          saleLineId,
          quantity: quantite,
          restock: remises[saleLineId] ?? true,
        }));
      if (lignes.length === 0) throw new Error('Sélectionnez au moins un article à rembourser.');

      const resultat = await new RefundService(contexte).refund({
        saleId,
        lines: lignes,
        method: mode,
        reason: motif || null,
      });
      notifier(`Remboursement ${resultat.number} — ${monnaie(resultat.total)}`);
      onFait();
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  const total = Object.entries(quantites).reduce((somme, [ligneId, quantite]) => {
    const ligne = remboursable.donnees?.lines.find((element) => element.line.id === ligneId);
    if (!ligne || quantite <= 0) return somme;
    return somme + Math.round((ligne.line.lineTotal * quantite) / ligne.line.quantity);
  }, 0);

  return (
    <Dialogue
      ouvert
      titre="Nouveau remboursement"
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
            disabled={!saleId || total === 0}
            onClick={() => void valider()}
          >
            Rembourser {total > 0 ? monnaie(total) : ''}
          </Bouton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <Champ
            label="Ticket ou IMEI"
            className="flex-1"
            autoFocus
            value={reference}
            onChange={(evenement) => setReference(evenement.target.value)}
            onKeyDown={(evenement) => {
              if (evenement.key === 'Enter') void chercher();
            }}
            aide="Scannez l'IMEI de l'appareil rendu, ou saisissez le numéro du ticket."
          />
          <Bouton icone="recherche" className="mb-5" onClick={() => void chercher()}>
            Rechercher
          </Bouton>
        </div>

        {erreur ? <Erreur message={erreur} /> : null}

        {saleId && detail.donnees ? (
          <>
            <Information>
              Ticket {detail.donnees.sale.number} du {formaterDate(detail.donnees.sale.soldAt)} —
              total {monnaie(detail.donnees.sale.total)}. Reste remboursable :{' '}
              <strong>{monnaie(remboursable.donnees?.amount ?? 0)}</strong>.
            </Information>

            {remboursable.chargement ? (
              <Chargement />
            ) : (
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Article</th>
                    <th>Identifiant</th>
                    <th className="num">Vendu</th>
                    <th className="num">Rendable</th>
                    <th className="num" style={{ width: '6rem' }}>
                      À rendre
                    </th>
                    <th>Retour en stock</th>
                  </tr>
                </thead>
                <tbody>
                  {(remboursable.donnees?.lines ?? []).map(({ line, remaining }) => (
                    <tr key={line.id}>
                      <td>{line.label}</td>
                      <td className="mono">{line.identifier ?? '—'}</td>
                      <td className="num">{line.quantity}</td>
                      <td className="num">{remaining}</td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          max={remaining}
                          value={quantites[line.id] ?? 0}
                          onChange={(evenement) =>
                            setQuantites((precedent) => ({
                              ...precedent,
                              [line.id]: Math.max(
                                0,
                                Math.min(remaining, Number(evenement.target.value) || 0),
                              ),
                            }))
                          }
                          className="h-7 w-16 rounded border border-encre-300 px-2 text-right"
                        />
                      </td>
                      <td>
                        <Case
                          label="Remettre en stock"
                          checked={remises[line.id] ?? true}
                          onChange={(evenement) =>
                            setRemises((precedent) => ({
                              ...precedent,
                              [line.id]: evenement.target.checked,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Liste
                label="Mode de remboursement"
                value={mode}
                onChange={(evenement) => setMode(evenement.target.value)}
                options={(modes.donnees ?? []).map((methode) => ({
                  valeur: methode.code,
                  libelle: methode.label,
                }))}
              />
              <ZoneTexte
                label="Motif"
                rows={2}
                value={motif}
                onChange={(evenement) => setMotif(evenement.target.value)}
              />
            </div>
          </>
        ) : null}
      </div>
    </Dialogue>
  );
}
