import { useState } from 'react';
import { CHARGE_CATEGORY, CHARGE_LABELS, PERMISSIONS, localDay, valuesOf } from '@boutique/shared';
import type { Charge, ChargeCategory } from '@boutique/shared';
import { ChargeRepository } from '@/core/db/repositories/charge.repository';
import { ResultatService } from '@/core/services/resultat.service';
import { exportFileName, toCsv, csvMoney } from '@/core/services/export.service';
import { Carte, EnTetePage, Erreur, LectureSeule } from '@/components/ui/Page';
import { Bouton } from '@/components/ui/Bouton';
import { Confirmation, Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste, ZoneTexte } from '@/components/ui/Champ';
import { BarreFiltres, ListeFiltre, Tableau } from '@/components/ui/Tableau';
import { ChoixPeriode, usePeriode } from '@/components/ui/Periode';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useMonnaie } from '@/app/hooks';
import { telecharger } from './telechargement';

/**
 * Charges d'exploitation.
 *
 * CE QUE CET ÉCRAN SERT À OBTENIR : un bénéfice, et non une marge. Le logiciel
 * savait déjà ce que la boutique achète et ce qu'elle vend ; il ignorait ce
 * qu'elle dépense pour rester ouverte. Chaque ligne saisie ici descend
 * directement dans le compte de résultat.
 *
 * LES ACHATS DE MARCHANDISE N'ONT RIEN À Y FAIRE : ils entrent par les achats,
 * et leur coût rejoint le résultat par le prix de revient des articles vendus.
 * Les saisir ici aussi les compterait deux fois — et le résultat serait faux
 * dans le sens le plus trompeur : trop bas les mois de réapprovisionnement,
 * trop haut les autres. L'écran le dit, parce que c'est l'erreur qu'on fait.
 */

const CATEGORIES = valuesOf(CHARGE_CATEGORY).map((code) => ({
  valeur: code,
  libelle: CHARGE_LABELS[code],
}));

export function Charges() {
  const { db, shopId, peut, settings } = useSession();
  const monnaie = useMonnaie();
  const periode = usePeriode('30');
  const [categorie, setCategorie] = useState('');
  const [edition, setEdition] = useState<Charge | 'nouvelle' | null>(null);
  const [aSupprimer, setASupprimer] = useState<Charge | null>(null);
  const peutSaisir = peut(PERMISSIONS.chargeManage);

  const bornes = periode.bornes;
  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new ChargeRepository(db).list({
      shopId,
      category: (categorie || null) as ChargeCategory | null,
      from: bornes.from,
      to: bornes.to,
      limit: 500,
    });
  }, [db, shopId, categorie, bornes.from, bornes.to]);

  const total = (etat.donnees ?? []).reduce((somme, charge) => somme + charge.amount, 0);

  const exporter = () => {
    if (!etat.donnees) return;
    void telecharger(
      exportFileName('charges'),
      toCsv(etat.donnees, [
        { header: 'Date', value: (c) => c.occurredAt.slice(0, 10) },
        { header: 'Catégorie', value: (c) => CHARGE_LABELS[c.category] },
        { header: 'Libellé', value: (c) => c.label },
        { header: 'Montant', value: (c) => csvMoney(c.amount, settings.currency) },
        { header: 'Pièce', value: (c) => c.reference ?? '' },
        { header: 'Notes', value: (c) => c.notes ?? '' },
      ]),
    );
  };

  return (
    <>
      <EnTetePage
        titre="Charges d'exploitation"
        sousTitre="Ce que la boutique dépense pour fonctionner : loyer, salaires, JIRAMA, transport, impôts."
        actions={
          <>
            <Bouton icone="export" onClick={exporter}>
              Exporter
            </Bouton>
            {peutSaisir ? (
              <Bouton variante="principal" icone="plus" onClick={() => setEdition('nouvelle')}>
                Saisir une charge
              </Bouton>
            ) : null}
          </>
        }
      />

      {!peutSaisir ? <LectureSeule quoi="saisir des charges" /> : null}

      <Carte>
        <BarreFiltres>
          <ChoixPeriode etat={periode} />
          <ListeFiltre
            valeur={categorie}
            onChanger={setCategorie}
            options={[{ valeur: '', libelle: 'Toutes les catégories' }, ...CATEGORIES]}
          />
          <span className="ml-auto text-sm">
            <span className="text-encre-600">Total {periode.libelle} : </span>
            <span className="font-semibold" data-nombre>
              {monnaie(total)}
            </span>
          </span>
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees ?? []}
            cleDe={(charge) => charge.id}
            vide={{
              icone: 'rapport',
              titre: 'Aucune charge sur la période',
              detail:
                'Sans charges saisies, le compte de résultat ne donne qu’une marge sur marchandises, pas un bénéfice.',
            }}
            colonnes={[
              {
                cle: 'date',
                titre: 'Date',
                rendu: (charge) => formaterDate(charge.occurredAt),
              },
              {
                cle: 'categorie',
                titre: 'Catégorie',
                rendu: (charge) => CHARGE_LABELS[charge.category],
              },
              { cle: 'libelle', titre: 'Libellé', rendu: (charge) => charge.label },
              {
                cle: 'piece',
                titre: 'Pièce',
                rendu: (charge) => <span className="mono text-xs">{charge.reference ?? '—'}</span>,
              },
              {
                cle: 'montant',
                titre: 'Montant',
                num: true,
                rendu: (charge) => monnaie(charge.amount),
              },
              {
                cle: 'actions',
                titre: '',
                rendu: (charge) =>
                  peutSaisir ? (
                    <div className="flex justify-end gap-1">
                      <Bouton icone="crayon" onClick={() => setEdition(charge)}>
                        Modifier
                      </Bouton>
                      <Bouton icone="poubelle" onClick={() => setASupprimer(charge)}>
                        Supprimer
                      </Bouton>
                    </div>
                  ) : null,
              },
            ]}
          />
        )}
      </Carte>

      {edition ? (
        <FormulaireCharge
          charge={edition === 'nouvelle' ? null : edition}
          onFermer={() => setEdition(null)}
          onEnregistre={() => {
            setEdition(null);
            etat.recharger();
          }}
        />
      ) : null}

      {aSupprimer ? (
        <SuppressionCharge
          charge={aSupprimer}
          onFermer={() => setASupprimer(null)}
          onSupprime={() => {
            setASupprimer(null);
            etat.recharger();
          }}
        />
      ) : null}
    </>
  );
}

function FormulaireCharge({
  charge,
  onFermer,
  onEnregistre,
}: {
  charge: Charge | null;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const service = new ResultatService(contexte);
      const jour = champ('date', charge?.occurredAt.slice(0, 10) ?? localDay());
      const entree = {
        category: champ('categorie', charge?.category ?? CHARGE_CATEGORY.rent) as ChargeCategory,
        label: champ('libelle', charge?.label ?? '').trim(),
        // Midi, et non minuit : quelle que soit la façon dont la journée est
        // bornée ensuite, une charge datée du 12 tombe le 12.
        occurredAt: new Date(`${jour}T12:00:00`).toISOString(),
        amount: Math.round(
          Number(champ('montant', String(charge?.amount ?? '')).replace(',', '.')),
        ),
        reference: champ('piece', charge?.reference ?? '').trim() || null,
        notes: champ('notes', charge?.notes ?? '').trim() || null,
      };

      if (charge) await service.modifierCharge(charge.id, entree);
      else await service.creerCharge(entree);

      notifier(charge ? 'Charge modifiée.' : 'Charge enregistrée.');
      onEnregistre();
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre={charge ? 'Modifier la charge' : 'Saisir une charge'}
      onFermer={onFermer}
      pied={
        <>
          <Bouton onClick={onFermer}>Annuler</Bouton>
          <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
            Enregistrer
          </Bouton>
        </>
      }
    >
      <div className="space-y-3">
        {erreur ? <Erreur message={erreur} /> : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Liste
            label="Catégorie"
            value={champ('categorie', charge?.category ?? CHARGE_CATEGORY.rent)}
            onChange={(e) => changer('categorie', e.target.value)}
            options={CATEGORIES}
          />
          <Champ
            label="Date"
            type="date"
            value={champ('date', charge?.occurredAt.slice(0, 10) ?? localDay())}
            onChange={(e) => changer('date', e.target.value)}
            aide="Date d’engagement, pas de saisie."
          />
        </div>

        <Champ
          label="Libellé"
          requis
          value={champ('libelle', charge?.label ?? '')}
          onChange={(e) => changer('libelle', e.target.value)}
          aide="« Loyer de septembre », « JIRAMA août »…"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Champ
            label="Montant"
            requis
            inputMode="decimal"
            value={champ('montant', String(charge?.amount ?? ''))}
            onChange={(e) => changer('montant', e.target.value)}
          />
          <Champ
            label="Pièce justificative"
            value={champ('piece', charge?.reference ?? '')}
            onChange={(e) => changer('piece', e.target.value)}
            aide="N° de facture, quittance ou reçu."
          />
        </div>

        <ZoneTexte
          label="Notes"
          rows={2}
          value={champ('notes', charge?.notes ?? '')}
          onChange={(e) => changer('notes', e.target.value)}
        />
      </div>
    </Dialogue>
  );
}

function SuppressionCharge({
  charge,
  onFermer,
  onSupprime,
}: {
  charge: Charge;
  onFermer: () => void;
  onSupprime: () => void;
}) {
  const contexte = useContexte();
  const { notifier } = useNotifications();

  return (
    <Confirmation
      ouvert
      titre="Supprimer cette charge ?"
      message={`« ${charge.label} » sortira du compte de résultat de sa période. L’opération est tracée dans le journal.`}
      libelleAction="Supprimer"
      danger
      onFermer={onFermer}
      onConfirmer={async () => {
        try {
          await new ResultatService(contexte).supprimerCharge(charge.id);
          notifier('Charge supprimée.');
          onSupprime();
        } catch (cause) {
          notifier(messageDe(cause), 'erreur');
        }
      }}
    />
  );
}
