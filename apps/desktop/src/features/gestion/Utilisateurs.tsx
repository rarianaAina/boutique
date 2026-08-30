import { useState } from 'react';
import { PERMISSION_GROUPS, PERMISSION_LABELS, USER_STATUS } from '@boutique/shared';
import type { Permission, UserStatus } from '@boutique/shared';
import { UserRepository } from '@/core/db/repositories/user.repository';
import { RoleRepository } from '@/core/db/repositories/role.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { UserService } from '@/core/services/auth.service';
import { Carte, EnTetePage, Erreur, Information } from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, Liste, Case } from '@/components/ui/Champ';
import { Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';

/**
 * Utilisateurs et rôles (§4).
 *
 * Les permissions se règlent sur le RÔLE, pas sur la personne : c'est ce qui
 * permet d'embaucher un vendeur sans reconstituer une liste de vingt cases, et
 * de modifier ce que peut faire « le caissier » en un endroit.
 */
export function Utilisateurs() {
  const { db } = useSession();
  const [onglet, setOnglet] = useState<'utilisateurs' | 'roles'>('utilisateurs');
  const [edite, setEdite] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const [roleEdite, setRoleEdite] = useState<string | null>(null);

  const utilisateurs = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    const [liste, roles, boutiques] = await Promise.all([
      new UserRepository(db).list(),
      new RoleRepository(db).list(),
      new ShopRepository(db).list(),
    ]);
    return { liste, roles, boutiques };
  }, [db]);

  const nomRole = (roleId: string) =>
    utilisateurs.donnees?.roles.find((role) => role.id === roleId)?.name ?? '—';
  const nomBoutique = (shopId: string) =>
    utilisateurs.donnees?.boutiques.find((boutique) => boutique.id === shopId)?.name ?? '—';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Utilisateurs et rôles"
        actions={
          onglet === 'utilisateurs' ? (
            <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
              Nouvel utilisateur
            </Bouton>
          ) : null
        }
      />

      <div className="mb-3 flex gap-1 border-b border-encre-200">
        {(['utilisateurs', 'roles'] as const).map((cle) => (
          <button
            key={cle}
            type="button"
            onClick={() => setOnglet(cle)}
            className={`border-b-2 px-3 py-1.5 text-sm ${
              onglet === cle
                ? 'border-marque-600 font-medium text-marque-700'
                : 'border-transparent text-encre-600 hover:text-encre-900'
            }`}
          >
            {cle === 'utilisateurs' ? 'Utilisateurs' : 'Rôles et permissions'}
          </button>
        ))}
      </div>

      <Carte compact className="min-h-0 flex-1">
        {utilisateurs.erreur ? (
          <Erreur message={utilisateurs.erreur} />
        ) : onglet === 'utilisateurs' ? (
          <Tableau
            chargement={utilisateurs.chargement}
            lignes={utilisateurs.donnees?.liste ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setEdite(ligne.id)}
            vide={{ icone: 'utilisateur', titre: 'Aucun utilisateur' }}
            colonnes={[
              { cle: 'nom', titre: 'Nom', rendu: (l) => l.fullName },
              {
                cle: 'login',
                titre: 'Identifiant',
                rendu: (l) => <span className="mono">{l.login}</span>,
              },
              { cle: 'role', titre: 'Rôle', rendu: (l) => nomRole(l.roleId) },
              { cle: 'boutique', titre: 'Boutique', rendu: (l) => nomBoutique(l.shopId) },
              {
                cle: 'statut',
                titre: 'Statut',
                rendu: (l) => (
                  <Badge ton={l.status === 'ACTIVE' ? 'succes' : 'neutre'}>
                    {l.status === 'ACTIVE'
                      ? 'Actif'
                      : l.status === 'SUSPENDED'
                        ? 'Suspendu'
                        : 'Archivé'}
                  </Badge>
                ),
              },
              {
                cle: 'connexion',
                titre: 'Dernière connexion',
                rendu: (l) => formaterDate(l.lastLoginAt, true),
              },
            ]}
          />
        ) : (
          <Tableau
            chargement={utilisateurs.chargement}
            lignes={utilisateurs.donnees?.roles ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setRoleEdite(ligne.id)}
            vide={{ icone: 'utilisateur', titre: 'Aucun rôle' }}
            colonnes={[
              { cle: 'nom', titre: 'Rôle', rendu: (l) => l.name },
              { cle: 'code', titre: 'Code', rendu: (l) => <span className="mono">{l.code}</span> },
              { cle: 'description', titre: 'Description', rendu: (l) => l.description ?? '—' },
              {
                cle: 'permissions',
                titre: 'Permissions',
                num: true,
                rendu: (l) => l.permissions.length,
              },
              {
                cle: 'systeme',
                titre: '',
                rendu: (l) => (l.isSystem ? <Badge ton="neutre">Livré</Badge> : null),
              },
            ]}
          />
        )}
      </Carte>

      {creation || edite ? (
        <FormulaireUtilisateur
          userId={edite}
          roles={utilisateurs.donnees?.roles ?? []}
          boutiques={utilisateurs.donnees?.boutiques ?? []}
          onFermer={() => {
            setCreation(false);
            setEdite(null);
          }}
          onEnregistre={() => {
            setCreation(false);
            setEdite(null);
            utilisateurs.recharger();
          }}
        />
      ) : null}

      {roleEdite ? (
        <FormulaireRole
          roleId={roleEdite}
          onFermer={() => setRoleEdite(null)}
          onEnregistre={() => {
            setRoleEdite(null);
            utilisateurs.recharger();
          }}
        />
      ) : null}
    </div>
  );
}

function FormulaireUtilisateur({
  userId,
  roles,
  boutiques,
  onFermer,
  onEnregistre,
}: {
  userId: string | null;
  roles: { id: string; name: string }[];
  boutiques: { id: string; name: string }[];
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const contexte = useContexte();
  const { db, shopId } = useSession();
  const { notifier } = useNotifications();
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const utilisateur = useChargement(
    async () => (db && userId ? new UserRepository(db).byId(userId) : null),
    [db, userId],
  );

  const donnees = utilisateur.donnees;
  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    setOccupe(true);
    try {
      const service = new UserService(contexte);
      const entree = {
        fullName: champ('fullName', donnees?.fullName ?? '').trim(),
        login: champ('login', donnees?.login ?? '').trim(),
        email: champ('email', donnees?.email ?? '') || null,
        roleId: champ('roleId', donnees?.roleId ?? ''),
        shopId: champ('shopId', donnees?.shopId ?? shopId),
        status: champ('status', donnees?.status ?? 'ACTIVE') as UserStatus,
      };
      if (userId) {
        await service.update(userId, entree);
        if (motDePasse.trim() !== '') await service.resetPassword(userId, motDePasse);
      } else {
        await service.create(entree, motDePasse);
      }
      notifier(userId ? 'Utilisateur modifié.' : 'Utilisateur créé.');
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
      titre={userId ? "Modifier l'utilisateur" : 'Nouvel utilisateur'}
      onFermer={onFermer}
      largeur="md"
      pied={
        <>
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
        <div className="grid grid-cols-2 gap-3">
          <Champ
            label="Nom complet"
            requis
            value={champ('fullName', donnees?.fullName ?? '')}
            onChange={(e) => changer('fullName', e.target.value)}
          />
          <Champ
            label="Identifiant de connexion"
            requis
            value={champ('login', donnees?.login ?? '')}
            onChange={(e) => changer('login', e.target.value)}
            aide="Court et sans espace : il est tapé plusieurs fois par jour."
          />
          <Liste
            label="Rôle"
            requis
            vide="Choisir…"
            value={champ('roleId', donnees?.roleId ?? '')}
            onChange={(e) => changer('roleId', e.target.value)}
            options={roles.map((role) => ({ valeur: role.id, libelle: role.name }))}
          />
          <Liste
            label="Boutique"
            requis
            value={champ('shopId', donnees?.shopId ?? shopId)}
            onChange={(e) => changer('shopId', e.target.value)}
            options={boutiques.map((boutique) => ({ valeur: boutique.id, libelle: boutique.name }))}
          />
          <Champ
            label="E-mail"
            value={champ('email', donnees?.email ?? '')}
            onChange={(e) => changer('email', e.target.value)}
          />
          <Liste
            label="Statut"
            value={champ('status', donnees?.status ?? 'ACTIVE')}
            onChange={(e) => changer('status', e.target.value)}
            options={[
              { valeur: USER_STATUS.active, libelle: 'Actif' },
              { valeur: USER_STATUS.suspended, libelle: 'Suspendu' },
              { valeur: USER_STATUS.archived, libelle: 'Archivé' },
            ]}
          />
        </div>
        <Champ
          label={userId ? 'Nouveau mot de passe' : 'Mot de passe'}
          type="password"
          requis={!userId}
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
          aide={
            userId
              ? 'Laissez vide pour ne pas le changer. Le renseigner lève aussi un verrouillage.'
              : 'Au moins 8 caractères.'
          }
        />
      </div>
    </Dialogue>
  );
}

function FormulaireRole({
  roleId,
  onFermer,
  onEnregistre,
}: {
  roleId: string;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const { db } = useSession();
  const { notifier } = useNotifications();
  const [choisies, setChoisies] = useState<Set<Permission> | null>(null);
  const [occupe, setOccupe] = useState(false);

  const role = useChargement(
    async () => (db ? new RoleRepository(db).byId(roleId) : null),
    [db, roleId],
  );

  const actives = choisies ?? new Set(role.donnees?.permissions ?? []);

  const basculer = (permission: Permission) => {
    const suite = new Set(actives);
    if (suite.has(permission)) suite.delete(permission);
    else suite.add(permission);
    setChoisies(suite);
  };

  const enregistrer = async () => {
    if (!db) return;
    setOccupe(true);
    try {
      await new RoleRepository(db).update(roleId, { permissions: [...actives] });
      notifier('Permissions du rôle enregistrées.');
      onEnregistre();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Dialogue
      ouvert
      titre={role.donnees ? `Rôle « ${role.donnees.name} »` : 'Rôle'}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Annuler
          </Bouton>
          <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
            Enregistrer
          </Bouton>
        </>
      }
    >
      <div className="space-y-4">
        <Information>
          Ces permissions s'appliquent à tous les comptes portant ce rôle. Elles sont vérifiées à
          l'écran ET dans la couche métier : masquer un bouton ne suffit pas à protéger une donnée.
        </Information>

        {PERMISSION_GROUPS.map((groupe) => (
          <div key={groupe.title}>
            <h3 className="mb-1 text-encre-800">{groupe.title}</h3>
            <div className="grid grid-cols-2 gap-x-4">
              {groupe.permissions.map((permission) => (
                <Case
                  key={permission}
                  label={PERMISSION_LABELS[permission]}
                  checked={actives.has(permission)}
                  onChange={() => basculer(permission)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialogue>
  );
}
