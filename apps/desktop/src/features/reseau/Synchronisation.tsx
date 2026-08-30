import { useMemo, useState } from 'react';
import { PERMISSIONS } from '@boutique/shared';
import { SyncEngine, type SyncOutcome } from '@/core/sync/engine';
import { HttpSyncTransport } from '@/core/sync/transport';
import { OutboxRepository } from '@/core/db/repositories/outbox.repository';
import { SettingRepository, SETTING_KEYS } from '@/core/db/repositories/setting.repository';
import {
  Carte,
  Chargement,
  EnTetePage,
  Erreur,
  Information,
  Avertissement,
  Vide,
  CarteChiffre,
  LectureSeule,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Champ } from '@/components/ui/Champ';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';

/**
 * Écran de synchronisation (§18).
 *
 * Il rend visible ce qui, sinon, resterait invisible : ce qui attend d'être
 * envoyé, ce que le serveur a refusé, quand la dernière synchronisation a eu
 * lieu. Un logiciel hors ligne qui ne montre pas son retard fait croire à ses
 * utilisateurs qu'ils sont à jour.
 *
 * LE DÉCLENCHEMENT EST MANUEL, et l'écran l'assume : rien ne part sans qu'on
 * l'ait demandé.
 */
export function Synchronisation() {
  const contexte = useContexte();
  const { db, shopId, shopCode, shopName, settings, deviceId, rechargerParametres, peut } =
    useSession();
  // Consulter l'état de la file est utile à un gérant ; la déclencher engage
  // une connexion et modifie les données des autres boutiques.
  const peutSynchroniser = peut(PERMISSIONS.syncRun);
  const { notifier } = useNotifications();
  const [resultat, setResultat] = useState<SyncOutcome | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [url, setUrl] = useState(settings.syncServerUrl);
  const [jeton, setJeton] = useState(settings.syncShopToken);

  const moteur = useMemo(() => {
    const transport = new HttpSyncTransport({
      baseUrl: settings.syncServerUrl,
      token: settings.syncShopToken,
    });
    return new SyncEngine(contexte, transport, deviceId);
  }, [contexte, settings.syncServerUrl, settings.syncShopToken, deviceId]);

  const etat = useChargement(async () => {
    const [instantane, conflits, echecs] = await Promise.all([
      moteur.snapshot(),
      db ? new OutboxRepository(db).conflicts(50) : Promise.resolve([]),
      moteur.inboxFailures(50),
    ]);
    return { instantane, conflits, echecs };
  }, [moteur, db, resultat]);

  const synchroniser = async () => {
    setOccupe(true);
    try {
      const sortie = await moteur.run();
      setResultat(sortie);
      if (sortie.transportError) {
        notifier(sortie.transportError, 'erreur');
      } else {
        notifier(
          `Synchronisation terminée : ${sortie.pushed} envoyé(s), ${sortie.applied.applied} reçu(s).`,
        );
      }
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const enregistrerServeur = async () => {
    if (!db) return;
    const depot = new SettingRepository(db);
    await depot.set(SETTING_KEYS.syncServerUrl, url.trim(), shopId);
    await depot.set(SETTING_KEYS.syncShopToken, jeton.trim(), shopId);
    await rechargerParametres();
    notifier('Paramètres de synchronisation enregistrés.');
  };

  const instantane = etat.donnees?.instantane;

  return (
    <div className="space-y-4">
      <EnTetePage
        titre="Synchronisation"
        sousTitre="La boutique fonctionne hors ligne. La synchronisation ne sert qu'à échanger avec les autres boutiques."
        actions={
          <Bouton
            variante="principal"
            icone="synchro"
            occupe={occupe}
            disabled={!peutSynchroniser || !instantane?.serverConfigured}
            onClick={() => void synchroniser()}
          >
            Synchroniser maintenant
          </Bouton>
        }
      />

      {!peutSynchroniser ? <LectureSeule quoi="lancer une synchronisation" /> : null}

      {!instantane?.serverConfigured ? (
        <Avertissement>
          Aucun serveur de synchronisation n'est configuré. La boutique fonctionne normalement ;
          seuls les échanges avec les autres boutiques sont impossibles.
        </Avertissement>
      ) : null}

      {etat.chargement && !instantane ? (
        <Chargement />
      ) : etat.erreur ? (
        <Erreur message={etat.erreur} />
      ) : instantane ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CarteChiffre
              libelle="Dernière synchronisation"
              valeur={instantane.lastSyncAt ? formaterDate(instantane.lastSyncAt, true) : 'Jamais'}
              icone="synchro"
              ton={instantane.lastSyncAt ? 'neutre' : 'attente'}
            />
            <CarteChiffre
              libelle="En attente d'envoi"
              valeur={instantane.pending.PENDING + instantane.pending.FAILED}
              detail="opérations locales"
              icone="export"
              ton={instantane.pending.PENDING > 0 ? 'attente' : 'neutre'}
            />
            <CarteChiffre
              libelle="Conflits"
              valeur={instantane.conflicts}
              detail="refusés par le serveur"
              icone="alerte"
              ton={instantane.conflicts > 0 ? 'danger' : 'neutre'}
            />
            <CarteChiffre
              libelle="Position de lecture"
              valeur={instantane.cursor}
              detail="dernier événement reçu"
              icone="info"
            />
          </div>

          {resultat ? (
            <Carte titre="Résultat de la dernière synchronisation">
              {resultat.transportError ? (
                <Erreur message={resultat.transportError} />
              ) : (
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge ton="succes">{resultat.pushed} envoyé(s)</Badge>
                  <Badge ton="neutre">{resultat.duplicates} déjà connu(s)</Badge>
                  <Badge ton={resultat.rejected > 0 ? 'danger' : 'neutre'}>
                    {resultat.rejected} refusé(s)
                  </Badge>
                  <Badge ton="info">{resultat.pulled} reçu(s)</Badge>
                  <Badge ton="succes">{resultat.applied.applied} appliqué(s)</Badge>
                  {resultat.applied.failed > 0 ? (
                    <Badge ton="danger">{resultat.applied.failed} en échec</Badge>
                  ) : null}
                </div>
              )}
            </Carte>
          ) : null}

          {(etat.donnees?.conflits.length ?? 0) > 0 ? (
            <Carte
              titre="Opérations refusées par le serveur"
              actions={
                <Bouton
                  taille="petit"
                  onClick={async () => {
                    const nombre = await moteur.retryConflicts();
                    notifier(`${nombre} opération(s) remise(s) en file.`);
                    etat.recharger();
                  }}
                >
                  Réessayer
                </Bouton>
              }
            >
              <Information>
                Un conflit signifie qu'une autre boutique détient déjà ce que celle-ci déclare — le
                plus souvent, un IMEI saisi deux fois. Il ne se résout pas tout seul : quelqu'un
                doit décider laquelle des deux saisies est la bonne.
              </Information>
              <table className="tableau mt-3">
                <thead>
                  <tr>
                    <th>Opération</th>
                    <th>Entité</th>
                    <th>Créée le</th>
                    <th>Motif du refus</th>
                  </tr>
                </thead>
                <tbody>
                  {(etat.donnees?.conflits ?? []).map((conflit) => (
                    <tr key={conflit.id}>
                      <td>{conflit.type}</td>
                      <td className="mono text-xs">{conflit.entityId.slice(0, 12)}</td>
                      <td>{formaterDate(conflit.createdAt, true)}</td>
                      <td className="text-danger-700">{conflit.lastError}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Carte>
          ) : null}

          {(etat.donnees?.echecs.length ?? 0) > 0 ? (
            <Carte titre="Événements reçus non appliqués">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Rang</th>
                    <th>Type</th>
                    <th>Boutique</th>
                    <th>Erreur</th>
                  </tr>
                </thead>
                <tbody>
                  {(etat.donnees?.echecs ?? []).map((echec) => (
                    <tr key={echec.eventId}>
                      <td className="num">{echec.seq}</td>
                      <td>{echec.type}</td>
                      <td className="mono text-xs">{echec.shopId.slice(0, 8)}</td>
                      <td className="text-danger-700">{echec.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Carte>
          ) : null}

          {instantane.pending.PENDING === 0 &&
          instantane.conflicts === 0 &&
          (etat.donnees?.echecs.length ?? 0) === 0 ? (
            <Carte>
              <Vide
                icone="check"
                titre="Tout est à jour"
                detail="Aucune opération en attente, aucun conflit."
              />
            </Carte>
          ) : null}
        </>
      ) : null}

      <Carte titre="Serveur de synchronisation">
        <div className="grid grid-cols-2 gap-3">
          <Champ
            label="Adresse du serveur"
            value={url}
            onChange={(evenement) => setUrl(evenement.target.value)}
            placeholder="https://synchro.exemple.com"
            aide="Laissez vide pour travailler entièrement hors ligne."
          />
          <Champ
            label="Jeton de la boutique"
            type="password"
            value={jeton}
            onChange={(evenement) => setJeton(evenement.target.value)}
            aide="Fourni par l'administrateur du réseau."
          />
        </div>
        <LigneEnrolement
          shopId={shopId}
          code={shopCode}
          nom={shopName}
          jeton={jeton}
          onJeton={setJeton}
        />

        <Bouton variante="principal" onClick={() => void enregistrerServeur()}>
          Enregistrer
        </Bouton>
      </Carte>
    </div>
  );
}

/**
 * Ligne à coller dans la configuration du serveur.
 *
 * POURQUOI ELLE EST PRODUITE ICI. Enrôler une boutique demande son identifiant
 * technique — trente-six signes — son code, son nom et un jeton. Le faire
 * recopier à la main est le geste qui casse : une lettre de travers, et la
 * première synchronisation répond « jeton invalide » sans dire pourquoi.
 *
 * Le jeton est TIRÉ AU SORT ici, et non choisi : un jeton qu'on invente se
 * devine, et il ouvre l'accès au journal du réseau. Il n'est produit que si le
 * champ est vide — le régénérer alors qu'il est déjà déclaré au serveur
 * couperait la boutique jusqu'à ce que quelqu'un mette la configuration à jour.
 */
function LigneEnrolement({
  shopId,
  code,
  nom,
  jeton,
  onJeton,
}: {
  shopId: string;
  code: string;
  nom: string;
  jeton: string;
  onJeton: (valeur: string) => void;
}) {
  const [copie, setCopie] = useState(false);

  // Le nom ne peut contenir ni virgule ni deux-points : ce sont les séparateurs
  // de la variable d'environnement du serveur.
  const nomPropre = nom.replace(/[:,]/g, ' ').trim() || code;
  const ligne = jeton.trim() === '' ? '' : `${shopId}:${code}:${nomPropre}:${jeton.trim()}`;

  const produire = () => {
    const octets = crypto.getRandomValues(new Uint8Array(24));
    let texte = '';
    for (const octet of octets) texte += octet.toString(16).padStart(2, '0');
    onJeton(texte);
  };

  return (
    <div className="mt-3 rounded-md border border-encre-200 bg-encre-50 px-3.5 py-3">
      <p className="text-sm font-medium text-encre-800">Enrôler cette boutique sur le serveur</p>
      <p className="mt-0.5 text-sm text-encre-600">
        Collez cette ligne dans la variable <code className="mono">BOUTIQUES</code> du serveur, en
        séparant les boutiques par une virgule.
      </p>

      {ligne === '' ? (
        <Bouton className="mt-2" onClick={produire}>
          Produire le jeton de cette boutique
        </Bouton>
      ) : (
        <>
          <p className="mono mt-2 break-all rounded border border-encre-200 bg-white px-3 py-2 text-xs text-encre-800">
            {ligne}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Bouton
              taille="petit"
              onClick={() => {
                void navigator.clipboard?.writeText(ligne).catch(() => undefined);
                setCopie(true);
                setTimeout(() => setCopie(false), 1500);
              }}
            >
              {copie ? 'Copié' : 'Copier la ligne'}
            </Bouton>
            <Bouton taille="petit" variante="discret" onClick={produire}>
              Produire un nouveau jeton
            </Bouton>
          </div>
          <p className="mt-2 text-xs text-encre-500">
            Changer le jeton coupe la boutique tant que le serveur n’a pas été mis à jour.
            N’enregistrez qu’après avoir collé la nouvelle ligne.
          </p>
        </>
      )}
    </div>
  );
}
