import { useState } from 'react';
import { PERMISSIONS } from '@boutique/shared';
import { CustomerRepository, customerName } from '@/core/db/repositories/customer.repository';
import { Carte, Chargement, EnTetePage, Erreur, Vide } from '@/components/ui/Page';
import { BadgeVente } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Dialogue } from '@/components/ui/Dialogue';
import { Champ, ZoneTexte } from '@/components/ui/Champ';
import { BarreFiltres, ChampRecherche, Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useSession } from '@/app/session';
import { useNavigation } from '@/app/navigation';
import { formaterDate, messageDe, useChargement, useDifferee, useMonnaie } from '@/app/hooks';

/**
 * Clients (§14).
 *
 * La fiche répond à la question qu'on pose vraiment au comptoir : « quels
 * appareils ce client a-t-il achetés chez nous ? ». Les IMEI figurent donc en
 * bonne place, à côté des tickets.
 */
export function Clients({ parametre }: { parametre?: string | null }) {
  const { db, peut } = useSession();
  const [recherche, setRecherche] = useState('');
  const differee = useDifferee(recherche);
  const [ouvert, setOuvert] = useState<string | null>(parametre ?? null);
  const [creation, setCreation] = useState(false);

  const etat = useChargement(async () => {
    if (!db) throw new Error('Base indisponible.');
    return new CustomerRepository(db).search(differee, 100);
  }, [db, differee]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnTetePage
        titre="Clients"
        sousTitre={etat.donnees ? `${etat.donnees.length} client(s)` : undefined}
        actions={
          peut(PERMISSIONS.customerManage) ? (
            <Bouton variante="principal" icone="plus" onClick={() => setCreation(true)}>
              Nouveau client
            </Bouton>
          ) : null
        }
      />

      <Carte compact className="min-h-0 flex-1">
        <BarreFiltres>
          <ChampRecherche
            valeur={recherche}
            onChanger={setRecherche}
            placeholder="Nom, prénom, téléphone…"
            largeur="w-72"
            autoFocus
          />
        </BarreFiltres>

        {etat.erreur ? (
          <Erreur message={etat.erreur} />
        ) : (
          <Tableau
            chargement={etat.chargement}
            lignes={etat.donnees ?? []}
            cleDe={(ligne) => ligne.id}
            onLigneCliquee={(ligne) => setOuvert(ligne.id)}
            vide={{ icone: 'client', titre: 'Aucun client' }}
            colonnes={[
              { cle: 'nom', titre: 'Nom', rendu: (l) => customerName(l) },
              { cle: 'telephone', titre: 'Téléphone', rendu: (l) => l.phone ?? '—' },
              { cle: 'email', titre: 'E-mail', rendu: (l) => l.email ?? '—' },
              { cle: 'depuis', titre: 'Client depuis', rendu: (l) => formaterDate(l.createdAt) },
            ]}
          />
        )}
      </Carte>

      {creation || ouvert ? (
        <FicheClient
          customerId={ouvert}
          onFermer={() => {
            setCreation(false);
            setOuvert(null);
          }}
          onEnregistre={() => {
            setCreation(false);
            setOuvert(null);
            etat.recharger();
          }}
        />
      ) : null}
    </div>
  );
}

function FicheClient({
  customerId,
  onFermer,
  onEnregistre,
}: {
  customerId: string | null;
  onFermer: () => void;
  onEnregistre: () => void;
}) {
  const { db, shopId, peut } = useSession();
  const { aller } = useNavigation();
  const { notifier } = useNotifications();
  const monnaie = useMonnaie();
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const donnees = useChargement(async () => {
    if (!db || !customerId) return { client: null, historique: null };
    const depot = new CustomerRepository(db);
    const [client, historique] = await Promise.all([
      depot.byId(customerId),
      depot.history(customerId),
    ]);
    return { client, historique };
  }, [db, customerId]);

  const client = donnees.donnees?.client ?? null;
  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    if (!db) return;
    setErreur(null);
    setOccupe(true);
    try {
      const entree = {
        lastName: champ('lastName', client?.lastName ?? '').trim(),
        firstName: champ('firstName', client?.firstName ?? '') || null,
        phone: champ('phone', client?.phone ?? '') || null,
        email: champ('email', client?.email ?? '') || null,
        address: champ('address', client?.address ?? '') || null,
        nif: champ('nif', client?.nif ?? '').trim() || null,
        stat: champ('stat', client?.stat ?? '').trim() || null,
        notes: champ('notes', client?.notes ?? '') || null,
        shopId,
      };
      if (entree.lastName === '') throw new Error('Le nom est obligatoire.');
      const depot = new CustomerRepository(db);
      if (customerId) await depot.update(customerId, entree);
      else await depot.create(entree);
      notifier(customerId ? 'Client modifié.' : 'Client créé.');
      onEnregistre();
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  const historique = donnees.donnees?.historique;

  return (
    <Dialogue
      ouvert
      titre={customerId ? 'Fiche client' : 'Nouveau client'}
      onFermer={onFermer}
      largeur="lg"
      pied={
        <>
          <Bouton onClick={onFermer} disabled={occupe}>
            Fermer
          </Bouton>
          {peut(PERMISSIONS.customerManage) ? (
            <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
              Enregistrer
            </Bouton>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {erreur ? <Erreur message={erreur} /> : null}

        {historique ? (
          <div className="grid grid-cols-3 gap-3 rounded-md bg-encre-50 px-3 py-2.5 text-sm">
            <div>
              <p className="text-xs text-encre-500">Achats</p>
              <p className="font-medium" data-nombre>
                {historique.totals.salesCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-encre-500">Total dépensé</p>
              <p className="font-medium" data-nombre>
                {monnaie(historique.totals.totalSpent)}
              </p>
            </div>
            <div>
              <p className="text-xs text-encre-500">Remboursé</p>
              <p className="font-medium" data-nombre>
                {monnaie(historique.totals.refunded)}
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Champ
            label="Nom"
            requis
            value={champ('lastName', client?.lastName ?? '')}
            onChange={(e) => changer('lastName', e.target.value)}
          />
          <Champ
            label="Prénom"
            value={champ('firstName', client?.firstName ?? '')}
            onChange={(e) => changer('firstName', e.target.value)}
          />
          <Champ
            label="Téléphone"
            value={champ('phone', client?.phone ?? '')}
            onChange={(e) => changer('phone', e.target.value)}
          />
          <Champ
            label="E-mail"
            value={champ('email', client?.email ?? '')}
            onChange={(e) => changer('email', e.target.value)}
          />
        </div>
        <Champ
          label="Adresse"
          value={champ('address', client?.address ?? '')}
          onChange={(e) => changer('address', e.target.value)}
        />
        {/*
          NIF et STAT n'ont de sens que pour un client PROFESSIONNEL : sans
          eux, sa comptabilité refuse la facture. Un particulier laisse les
          deux champs vides, et ils ne s'impriment pas.
        */}
        <div className="grid grid-cols-2 gap-3">
          <Champ
            label="NIF"
            value={champ('nif', client?.nif ?? '')}
            onChange={(e) => changer('nif', e.target.value)}
            aide="Client professionnel uniquement."
          />
          <Champ
            label="STAT"
            value={champ('stat', client?.stat ?? '')}
            onChange={(e) => changer('stat', e.target.value)}
          />
        </div>
        <ZoneTexte
          label="Notes"
          rows={2}
          value={champ('notes', client?.notes ?? '')}
          onChange={(e) => changer('notes', e.target.value)}
        />

        {customerId ? (
          donnees.chargement ? (
            <Chargement />
          ) : (
            <>
              <div>
                <h3 className="mb-1.5 text-encre-800">Appareils achetés</h3>
                {historique && historique.devices.length > 0 ? (
                  <table className="tableau">
                    <tbody>
                      {historique.devices.map((appareil) => (
                        <tr
                          key={appareil.unitId}
                          data-clickable=""
                          onClick={() => aller('appareils', appareil.unitId)}
                        >
                          <td className="mono">{appareil.identifier ?? '—'}</td>
                          <td>{appareil.productName}</td>
                          <td>{formaterDate(appareil.soldAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Vide icone="telephone" titre="Aucun appareil identifié acheté" />
                )}
              </div>

              <div>
                <h3 className="mb-1.5 text-encre-800">Tickets</h3>
                {historique && historique.sales.length > 0 ? (
                  <table className="tableau">
                    <tbody>
                      {historique.sales.map((vente) => (
                        <tr
                          key={vente.id}
                          data-clickable=""
                          onClick={() => aller('tickets', vente.id)}
                        >
                          <td className="mono">{vente.number}</td>
                          <td>{formaterDate(vente.soldAt, true)}</td>
                          <td>
                            <BadgeVente statut={vente.status as never} />
                          </td>
                          <td className="num font-medium">{monnaie(vente.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Vide icone="ticket" titre="Aucun achat" />
                )}
              </div>
            </>
          )
        ) : null}
      </div>
    </Dialogue>
  );
}
