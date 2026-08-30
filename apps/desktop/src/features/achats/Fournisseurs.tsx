import { useState } from 'react';
import { PERMISSIONS } from '@boutique/shared';
import { SupplierRepository, type SupplierInput } from '@/core/db/repositories/supplier.repository';
import { SupplierService } from '@/core/services/catalog.service';
import { Carte, EnTetePage, Erreur, LectureSeule } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, ZoneTexte, Case } from '@/components/ui/Champ';
import { BarreFiltres, ChampRecherche, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';

/** Fournisseurs (§9), avec l'historique d'achats sur la fiche. */
export function Fournisseurs({ parametre }: { parametre?: string | null }) {
  const { db, peut } = useSession();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [edite, setEdite] = useState<string | null>(parametre ?? null);
  const [creation, setCreation] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new SupplierRepository(db).list({ query: differee });
  }, [db, differee]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Fournisseurs"
        sousTitre={etat.donnees ? `${etat.donnees.length} fournisseur(s)` : undefined}
        actions={
          peut(PERMISSIONS.supplierManage) ? (
            <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
              Nouveau fournisseur
            </Bouton>
          ) : null
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={setRecherche}
            placeholder="Nom, société, pays…"
            largeur="w-72"
          />
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setEdite(ligne.id)}
            vide={{ icone: 'fournisseur', titre: 'Aucun fournisseur' }}
            colonnes={[
              { cle: 'code', titre: 'Code', rendu: (l) => <span className="mono">{l.code}</span> },
              {
                cle: 'nom',
                titre: 'Nom',
                rendu: (l) => (
                  <div>
                    <div className="font-medium text-encre-900">{l.name}</div>
                    <div className="text-xs text-encre-500">{l.company ?? ''}</div>
                  </div>
                ),
              },
              { cle: 'pays', titre: 'Pays', rendu: (l) => l.country ?? '—' },
              { cle: 'telephone', titre: 'Téléphone', rendu: (l) => l.phone ?? '—' },
              { cle: 'email', titre: 'E-mail', rendu: (l) => l.email ?? '—' },
              {
                cle: 'actif',
                titre: 'État',
                rendu: (l) => (
                  <Badge ton={l.isActive ? 'succes' : 'neutre'}>
                    {l.isActive ? 'Actif' : 'Inactif'}
                  </Badge>
                ),
              },
            ]}
          />
        )}
      </Carte>

      {creation || edite ? (
        <FicheFournisseur
          supplierId={edite}
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

function FicheFournisseur({
  supplierId,
  onFermer,
  onEnregistre,
}: {
  supplierId: string | null;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const contexte = useContexte();
  const { db, peut } = useSession();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const peutModifier = peut(PERMISSIONS.supplierManage);
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  /** `null` tant que l'utilisateur n'a pas touché la case : la valeur du
   *  fournisseur chargé fait alors foi. */
  const [actif, setActif] = useState<boolean | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const donnees = useChargement(async () => {
    if (!db || !supplierId) return { fournisseur: null, resume: null };
    const [fournisseur, resume] = await Promise.all([
      new SupplierRepository(db).byId(supplierId),
      new SupplierRepository(db).purchaseSummary(supplierId),
    ]);
    return { fournisseur, resume };
  }, [db, supplierId]);

  const fournisseur = donnees.donnees?.fournisseur ?? null;
  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const entree: SupplierInput = {
        code: champ('code', fournisseur?.code ?? '')
          .trim()
          .toUpperCase(),
        name: champ('name', fournisseur?.name ?? '').trim(),
        company: champ('company', fournisseur?.company ?? '') || null,
        phone: champ('phone', fournisseur?.phone ?? '') || null,
        email: champ('email', fournisseur?.email ?? '') || null,
        address: champ('address', fournisseur?.address ?? '') || null,
        country: champ('country', fournisseur?.country ?? '') || null,
        terms: champ('terms', fournisseur?.terms ?? '') || null,
        notes: champ('notes', fournisseur?.notes ?? '') || null,
        isActive: actif ?? fournisseur?.isActive ?? true,
      };
      await new SupplierService(contexte).save(entree, supplierId ?? undefined);
      notifier(supplierId ? 'Fournisseur modifié.' : 'Fournisseur créé.');
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
      titre={supplierId ? 'Fiche fournisseur' : 'Nouveau fournisseur'}
      onFermer={onFermer}
      largeur="md"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            {peutModifier ? 'Annuler' : 'Fermer'}
          </Bouton>
          {peutModifier ? (
            <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
              Enregistrer
            </Bouton>
          ) : null}
        </>
      }
    >
      <fieldset disabled={!peutModifier} className="space-y-3">
        {erreur ? <Erreur message={erreur} /> : null}
        {!peutModifier ? <LectureSeule quoi="modifier les fournisseurs" /> : null}

        {donnees.donnees?.resume ? (
          <div className="grid grid-cols-3 gap-3 rounded-md bg-encre-50 px-3 py-2.5 text-sm">
            <div>
              <p className="text-xs text-encre-500">Achats</p>
              <p className="font-medium" data-nombre>
                {donnees.donnees.resume.purchases}
              </p>
            </div>
            <div>
              <p className="text-xs text-encre-500">Montant total</p>
              <p className="font-medium" data-nombre>
                {monnaie(donnees.donnees.resume.total)}
              </p>
            </div>
            <div>
              <p className="text-xs text-encre-500">Dernier achat</p>
              <p className="font-medium">{formaterDate(donnees.donnees.resume.lastAt)}</p>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-3">
          <Champ
            label="Code"
            requis
            value={champ('code', fournisseur?.code ?? '')}
            onChange={(e) => changer('code', e.target.value)}
          />
          <Champ
            label="Nom"
            requis
            className="col-span-2"
            value={champ('name', fournisseur?.name ?? '')}
            onChange={(e) => changer('name', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Champ
            label="Société"
            value={champ('company', fournisseur?.company ?? '')}
            onChange={(e) => changer('company', e.target.value)}
          />
          <Champ
            label="Pays"
            value={champ('country', fournisseur?.country ?? '')}
            onChange={(e) => changer('country', e.target.value)}
          />
          <Champ
            label="Téléphone"
            value={champ('phone', fournisseur?.phone ?? '')}
            onChange={(e) => changer('phone', e.target.value)}
          />
          <Champ
            label="E-mail"
            value={champ('email', fournisseur?.email ?? '')}
            onChange={(e) => changer('email', e.target.value)}
          />
        </div>

        <Champ
          label="Adresse"
          value={champ('address', fournisseur?.address ?? '')}
          onChange={(e) => changer('address', e.target.value)}
        />
        <ZoneTexte
          label="Conditions commerciales"
          rows={2}
          value={champ('terms', fournisseur?.terms ?? '')}
          onChange={(e) => changer('terms', e.target.value)}
          aide="Délai de paiement, acompte, incoterm…"
        />
        <ZoneTexte
          label="Notes"
          rows={2}
          value={champ('notes', fournisseur?.notes ?? '')}
          onChange={(e) => changer('notes', e.target.value)}
        />
        <Case
          label="Fournisseur actif"
          aide="Un fournisseur inactif reste sur les achats passés mais ne s'affiche plus dans les listes."
          checked={actif ?? fournisseur?.isActive ?? true}
          onChange={(e) => setActif(e.target.checked)}
        />
      </fieldset>
    </Dialogue>
  );
}
