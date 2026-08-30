import { useState } from 'react';
import { PERMISSIONS, SHOP_STATUS } from '@boutique/shared';
import type { ShopStatus } from '@boutique/shared';
import { ShopService, type ShopSummary } from '@/core/services/shop.service';
import {
  Avertissement,
  Carte,
  EnTetePage,
  Erreur,
  Information,
  LectureSeule,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Confirmation, Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste } from '@/components/ui/Champ';
import { Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { messageDe, useChargement } from '@/app/hooks';

/**
 * Boutiques de la société.
 *
 * Le réseau entier est décrit dans CHAQUE base : créer une boutique ici la rend
 * immédiatement disponible comme destination de transfert, avant même la
 * première synchronisation.
 *
 * Une seule est celle du poste, et c'est elle qui signe les ventes. En changer
 * est une opération rare et lourde — l'écran le dit plutôt que de la présenter
 * comme un réglage ordinaire.
 */
const LIBELLES_STATUT: Record<ShopStatus, { texte: string; ton: 'succes' | 'attente' | 'neutre' }> =
  {
    ACTIVE: { texte: 'Active', ton: 'succes' },
    SUSPENDED: { texte: 'Suspendue', ton: 'attente' },
    CLOSED: { texte: 'Fermée', ton: 'neutre' },
  };

export function Boutiques() {
  const contexte = useContexte();
  const { shopId } = useSession();
  const { notifier } = useNotifications();
  const [edite, setEdite] = useState<ShopSummary | null>(null);
  const [creation, setCreation] = useState(false);
  const [fermeture, setFermeture] = useState<ShopSummary | null>(null);
  const [designation, setDesignation] = useState<ShopSummary | null>(null);
  const [occupe, setOccupe] = useState(false);

  const service = new ShopService(contexte);
  const etat = useChargement(async () => service.list(), [contexte.db]);

  const agir = async (executer: () => Promise<unknown>, message: string) => {
    setOccupe(true);
    try {
      await executer();
      notifier(message);
      etat.recharger();
      setFermeture(null);
      setDesignation(null);
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Boutiques"
        sousTitre="Toutes les boutiques de la société. Chacune tient sa propre base ; celle-ci est décrite sur tous les postes."
        actions={
          <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
            Nouvelle boutique
          </Bouton>
        }
      />

      <Information>
        Créer une boutique ici la rend disponible comme destination de transfert. Il faut ensuite
        installer l'application sur son poste et l'y désigner comme boutique locale.
      </Information>

      <Carte compact className="mt-3 min-h-0 flex-1">
        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setEdite(ligne)}
            ligneActive={(ligne) => ligne.id === shopId}
            vide={{ icone: 'fournisseur', titre: 'Aucune boutique' }}
            colonnes={[
              {
                cle: 'code',
                titre: 'Code',
                rendu: (l) => (
                  <span className="flex items-center gap-2">
                    <span className="mono font-medium">{l.code}</span>
                    {l.isLocal ? <Badge ton="info">Ce poste</Badge> : null}
                  </span>
                ),
              },
              {
                cle: 'nom',
                titre: 'Nom',
                rendu: (l) => (
                  <div>
                    <div className="font-medium text-encre-900">{l.name}</div>
                    <div className="text-xs text-encre-500">{l.address ?? ''}</div>
                  </div>
                ),
              },
              { cle: 'tel', titre: 'Téléphone', rendu: (l) => l.phone ?? '—' },
              { cle: 'users', titre: 'Comptes', num: true, rendu: (l) => l.users },
              { cle: 'units', titre: 'Appareils', num: true, rendu: (l) => l.units },
              {
                cle: 'transferts',
                titre: 'Transferts en cours',
                num: true,
                rendu: (l) =>
                  l.pendingTransfers > 0 ? (
                    <Badge ton="attente">{l.pendingTransfers}</Badge>
                  ) : (
                    <span className="text-encre-400">0</span>
                  ),
              },
              {
                cle: 'statut',
                titre: 'Statut',
                rendu: (l) => (
                  <Badge ton={LIBELLES_STATUT[l.status].ton}>
                    {LIBELLES_STATUT[l.status].texte}
                  </Badge>
                ),
              },
              {
                cle: 'actions',
                titre: '',
                rendu: (l) =>
                  l.isLocal ? null : (
                    <span className="flex justify-end gap-1.5">
                      <Bouton
                        taille="petit"
                        onClick={(evenement) => {
                          evenement.stopPropagation();
                          setDesignation(l);
                        }}
                      >
                        Désigner ce poste
                      </Bouton>
                      {l.status !== 'CLOSED' ? (
                        <Bouton
                          taille="petit"
                          variante="danger"
                          onClick={(evenement) => {
                            evenement.stopPropagation();
                            setFermeture(l);
                          }}
                        >
                          Fermer
                        </Bouton>
                      ) : null}
                    </span>
                  ),
              },
            ]}
          />
        )}
      </Carte>

      {creation || edite ? (
        <FormulaireBoutique
          boutique={edite}
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

      <Confirmation
        ouvert={fermeture !== null}
        titre={`Fermer « ${fermeture?.name ?? ''} »`}
        libelleAction="Fermer la boutique"
        danger
        occupe={occupe}
        onConfirmer={() =>
          fermeture && void agir(() => service.close(fermeture.id), 'Boutique fermée.')
        }
        onFermer={() => setFermeture(null)}
        message="La boutique passe au statut « fermée » : elle disparaît des destinations de transfert. Elle n'est jamais effacée — les ventes, achats et transferts qui la citent doivent rester lisibles."
      >
        {fermeture && fermeture.users > 0 ? (
          <Avertissement>
            {fermeture.users} compte(s) y sont rattachés. La fermeture sera refusée tant qu'un
            compte actif y reste : réaffectez-les d'abord.
          </Avertissement>
        ) : null}
      </Confirmation>

      <Confirmation
        ouvert={designation !== null}
        titre="Désigner la boutique de ce poste"
        libelleAction="Désigner"
        danger
        occupe={occupe}
        onConfirmer={() =>
          designation &&
          void agir(
            () => service.setLocal(designation.id),
            'Boutique du poste modifiée. Reconnectez-vous pour que tous les écrans en tiennent compte.',
          )
        }
        onFermer={() => setDesignation(null)}
        message={
          <>
            Ce poste enregistrera désormais ses ventes sous «&nbsp;
            {designation?.name}&nbsp;». L'historique déjà écrit reste rattaché à l'ancienne boutique
            : il ne se réécrit pas.
            <br />
            <br />
            L'opération est refusée si ce poste a déjà enregistré des ventes — mélanger deux
            boutiques dans les mêmes rapports les rendrait faux.
          </>
        }
      />
    </div>
  );
}

function FormulaireBoutique({
  boutique,
  onFermer,
  onEnregistre,
}: {
  boutique: ShopSummary | null;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const contexte = useContexte();
  const { peut } = useSession();
  const { notifier } = useNotifications();
  const peutModifier = peut(PERMISSIONS.shopManage);
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const entree = {
        code: champ('code', boutique?.code ?? ''),
        name: champ('name', boutique?.name ?? ''),
        address: champ('address', boutique?.address ?? '') || null,
        phone: champ('phone', boutique?.phone ?? '') || null,
        email: champ('email', boutique?.email ?? '') || null,
        status: champ('status', boutique?.status ?? 'ACTIVE') as ShopStatus,
      };
      const service = new ShopService(contexte);
      if (boutique) await service.update(boutique.id, entree);
      else await service.create(entree);
      notifier(boutique ? 'Boutique modifiée.' : 'Boutique créée.');
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
      titre={boutique ? `Boutique ${boutique.code}` : 'Nouvelle boutique'}
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
        {!peutModifier ? <LectureSeule quoi="modifier les boutiques" /> : null}

        <div className="grid grid-cols-3 gap-3">
          <Champ
            label="Code"
            requis
            value={champ('code', boutique?.code ?? '')}
            onChange={(e) => changer('code', e.target.value.toUpperCase())}
            aide="2 à 8 caractères."
          />
          <Champ
            label="Nom"
            requis
            className="col-span-2"
            value={champ('name', boutique?.name ?? '')}
            onChange={(e) => changer('name', e.target.value)}
          />
        </div>

        <Information>
          Le code apparaît dans tous les numéros de documents — par exemple{' '}
          <span className="mono">
            T-{champ('code', boutique?.code ?? 'CODE') || 'CODE'}-2026-00001
          </span>
          . C'est lui qui rend un numéro unique dans tout le réseau, sans coordination entre les
          boutiques. Deux boutiques partageant un code produiraient des numéros identiques.
        </Information>

        <Champ
          label="Adresse"
          value={champ('address', boutique?.address ?? '')}
          onChange={(e) => changer('address', e.target.value)}
        />
        <div className="grid grid-cols-3 gap-3">
          <Champ
            label="Téléphone"
            value={champ('phone', boutique?.phone ?? '')}
            onChange={(e) => changer('phone', e.target.value)}
          />
          <Champ
            label="E-mail"
            value={champ('email', boutique?.email ?? '')}
            onChange={(e) => changer('email', e.target.value)}
          />
          <Liste
            label="Statut"
            value={champ('status', boutique?.status ?? 'ACTIVE')}
            onChange={(e) => changer('status', e.target.value)}
            options={[
              { valeur: SHOP_STATUS.active, libelle: 'Active' },
              { valeur: SHOP_STATUS.suspended, libelle: 'Suspendue' },
            ]}
            aide="Une boutique suspendue reste visible mais n'accepte plus de transfert."
          />
        </div>
      </fieldset>
    </Dialogue>
  );
}
