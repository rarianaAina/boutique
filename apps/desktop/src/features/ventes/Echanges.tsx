import { useState } from 'react';
import { UnitRepository } from '@/core/db/repositories/unit.repository';
import { ExchangeRepository } from '@/core/db/repositories/refund.repository';
import { ExchangeService } from '@/core/services/exchange.service';
import { activePaymentMethods } from '@/core/services/setup.service';
import { Carte, EnTetePage, Erreur, Information, Avertissement } from '@/components/ui/Page';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste, ZoneTexte, Case } from '@/components/ui/Champ';
import { Pagination, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useMonnaie } from '@/app/hooks';

/**
 * Échanges d'appareils (§15).
 *
 * Le déroulé de l'écran suit celui du comptoir : on scanne l'appareil que le
 * client rapporte, le logiciel retrouve la vente d'origine et la valeur
 * créditée, puis on scanne l'appareil qu'on lui remet. La différence de prix
 * s'affiche immédiatement, dans un sens ou dans l'autre.
 *
 * LA VENTE D'ORIGINE N'EST JAMAIS MODIFIÉE : l'échange est un document distinct
 * qui la référence.
 */
export function Echanges() {
  const { db, shopId } = useSession();
  const monnaie = useMonnaie();
  const [offset, setOffset] = useState(0);
  const [nouveau, setNouveau] = useState(false);
  const limite = 50;

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new ExchangeRepository(db).list({ shopId, limit: limite, offset });
  }, [db, shopId, offset]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Échanges"
        sousTitre={etat.donnees ? `${etat.donnees.total} échange(s)` : undefined}
        actions={
          <Bouton variante="principal" icone="echange" onClick={() => setNouveau(true)}>
            Nouvel échange
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
            vide={{ icone: 'echange', titre: 'Aucun échange' }}
            colonnes={[
              {
                cle: 'numero',
                titre: 'Numéro',
                rendu: (l) => <span className="mono">{l.number}</span>,
              },
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.exchangedAt, true) },
              {
                cle: 'vente',
                titre: "Vente d'origine",
                rendu: (l) => <span className="mono">{l.saleNumber}</span>,
              },
              { cle: 'motif', titre: 'Motif', rendu: (l) => l.reason ?? '—' },
              {
                cle: 'difference',
                titre: 'Différence',
                num: true,
                rendu: (l) => (
                  <span
                    className={
                      l.priceDifference > 0
                        ? 'text-succes-700'
                        : l.priceDifference < 0
                          ? 'text-danger-700'
                          : ''
                    }
                  >
                    {l.priceDifference > 0 ? '+' : ''}
                    {monnaie(l.priceDifference)}
                  </span>
                ),
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
        <DialogueEchange
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

function DialogueEchange({ onFermer, onFait }: { onFermer: () => void; onFait: () => void }) {
  const contexte = useContexte();
  const { db, settings } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();

  const [imeiRendu, setImeiRendu] = useState('');
  const [prepare, setPrepare] = useState<Awaited<ReturnType<ExchangeService['prepare']>> | null>(
    null,
  );
  const [imeiNouveau, setImeiNouveau] = useState('');
  const [nouvelleUnite, setNouvelleUnite] = useState<{
    id: string;
    libelle: string;
    prix: number;
  } | null>(null);
  const [prixNouveau, setPrixNouveau] = useState('');
  const [credite, setCredite] = useState('');
  const [mode, setMode] = useState('CASH');
  const [motif, setMotif] = useState('');
  const [remiseEnStock, setRemiseEnStock] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const modes = useChargement(async () => (db ? activePaymentMethods(db) : []), [db]);

  const chercherRendu = async () => {
    setErreur(null);
    try {
      const resultat = await new ExchangeService(contexte).prepare(imeiRendu.trim());
      setPrepare(resultat);
      setCredite(String(resultat.creditedValue));
    } catch (cause) {
      setPrepare(null);
      setErreur(messageDe(cause));
    }
  };

  const chercherNouveau = async () => {
    setErreur(null);
    if (!db) return;
    const unite = await new UnitRepository(db).byIdentifier(imeiNouveau.trim());
    if (!unite) {
      setErreur('Aucun appareil ne porte cet identifiant.');
      return;
    }
    const { ProductRepository } = await import('@/core/db/repositories/product.repository');
    const produit = await new ProductRepository(db).byId(unite.productId);
    setNouvelleUnite({
      id: unite.id,
      libelle: `${produit?.name ?? ''} — ${unite.imei1 ?? unite.serial ?? ''}`,
      prix: produit?.salePrice ?? 0,
    });
    setPrixNouveau(String(produit?.salePrice ?? 0));
  };

  const valeurCreditee = Number(credite) || 0;
  const prix = Number(prixNouveau) || 0;
  const difference = prix - valeurCreditee;

  const valider = async () => {
    if (!prepare || !nouvelleUnite) return;
    setErreur(null);
    setOccupe(true);
    try {
      const resultat = await new ExchangeService(contexte).exchange({
        originalSaleId: prepare.saleId,
        returnedUnitId: prepare.unitId,
        newUnitId: nouvelleUnite.id,
        newUnitPrice: prix,
        creditedValue: valeurCreditee,
        settlement:
          difference > 0 ? { method: mode, amount: difference } : { method: mode, amount: 0 },
        reason: motif || null,
        restock: remiseEnStock,
      });
      notifier(
        `Échange ${resultat.number} enregistré · différence ${monnaie(resultat.priceDifference)}`,
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
      titre="Nouvel échange"
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
            disabled={!prepare || !nouvelleUnite}
            onClick={() => void valider()}
          >
            Enregistrer l'échange
          </Bouton>
        </>
      }
    >
      <div className="space-y-4">
        {erreur ? <Erreur message={erreur} /> : null}

        <section>
          <h3 className="mb-2 text-encre-800">1. Appareil rapporté par le client</h3>
          <div className="flex items-end gap-2">
            <Champ
              label="IMEI ou numéro de série"
              className="flex-1"
              autoFocus
              value={imeiRendu}
              onChange={(evenement) => setImeiRendu(evenement.target.value)}
              onKeyDown={(evenement) => {
                if (evenement.key === 'Enter') void chercherRendu();
              }}
            />
            <Bouton icone="recherche" className="mb-5" onClick={() => void chercherRendu()}>
              Retrouver la vente
            </Bouton>
          </div>
          {prepare ? (
            <Information>
              {prepare.productName} — vendu le {formaterDate(prepare.soldAt)} sur le ticket{' '}
              <span className="mono">{prepare.saleNumber}</span>. Valeur créditée proposée :{' '}
              <strong>{monnaie(prepare.creditedValue)}</strong>.
            </Information>
          ) : null}
        </section>

        {prepare ? (
          <section>
            <h3 className="mb-2 text-encre-800">2. Appareil remis au client</h3>
            <div className="flex items-end gap-2">
              <Champ
                label="IMEI ou numéro de série"
                className="flex-1"
                value={imeiNouveau}
                onChange={(evenement) => setImeiNouveau(evenement.target.value)}
                onKeyDown={(evenement) => {
                  if (evenement.key === 'Enter') void chercherNouveau();
                }}
              />
              <Bouton icone="recherche" className="mb-5" onClick={() => void chercherNouveau()}>
                Sélectionner
              </Bouton>
            </div>
            {nouvelleUnite ? <Information>{nouvelleUnite.libelle}</Information> : null}
          </section>
        ) : null}

        {prepare && nouvelleUnite ? (
          <section className="space-y-3">
            <h3 className="text-encre-800">3. Règlement</h3>
            <div className="grid grid-cols-3 gap-3">
              <Champ
                label="Valeur créditée pour la reprise"
                inputMode="decimal"
                value={credite}
                onChange={(evenement) => setCredite(evenement.target.value)}
              />
              <Champ
                label="Prix du nouvel appareil"
                inputMode="decimal"
                value={prixNouveau}
                onChange={(evenement) => setPrixNouveau(evenement.target.value)}
              />
              <Liste
                label={difference >= 0 ? "Mode d'encaissement" : 'Mode de remboursement'}
                value={mode}
                onChange={(evenement) => setMode(evenement.target.value)}
                options={(modes.donnees ?? []).map((methode) => ({
                  valeur: methode.code,
                  libelle: methode.label,
                }))}
              />
            </div>

            <div
              className={`rounded-md px-4 py-3 text-center ${
                difference > 0
                  ? 'bg-succes-50 text-succes-900'
                  : difference < 0
                    ? 'bg-alerte-50 text-alerte-900'
                    : 'bg-encre-100 text-encre-800'
              }`}
            >
              <p className="text-xs">
                {difference > 0
                  ? 'Le client complète'
                  : difference < 0
                    ? 'La boutique rembourse'
                    : 'Échange à valeur égale'}
              </p>
              <p className="text-2xl font-semibold" data-nombre>
                {monnaie(Math.abs(difference))}
              </p>
            </div>

            {difference < 0 ? (
              <Avertissement>
                Le solde en faveur du client donnera lieu à un remboursement rattaché à la vente
                d'origine, dans la limite de ce qui y reste remboursable.
              </Avertissement>
            ) : null}

            <Case
              label="Remettre l'appareil repris en stock vendable"
              aide="Décochez si l'appareil revient défectueux : il sera repris sans rejoindre le stock."
              checked={remiseEnStock}
              onChange={(evenement) => setRemiseEnStock(evenement.target.checked)}
            />

            <ZoneTexte
              label="Motif de l'échange"
              rows={2}
              value={motif}
              onChange={(evenement) => setMotif(evenement.target.value)}
            />
            {settings.taxEnabled ? null : null}
          </section>
        ) : null}
      </div>
    </Dialogue>
  );
}
