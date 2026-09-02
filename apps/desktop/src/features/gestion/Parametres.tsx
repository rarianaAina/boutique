import { useState } from 'react';
import { DEFAULT_NUMBERING, PERMISSIONS, formatDocumentNumber } from '@boutique/shared';
import type { Mention } from '@boutique/documents';
import { SettingRepository, SETTING_KEYS } from '@/core/db/repositories/setting.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { Licence } from './Licence';
import { BackupService, type BackupInfo } from '@/core/services/backup.service';
import { SeedService } from '@/core/services/seed.service';
import type { CostMethod } from '@/core/services/cost.service';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import {
  Carte,
  Chargement,
  EnTetePage,
  Erreur,
  Information,
  Avertissement,
  LectureSeule,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Champ, Case, Liste, ZoneTexte } from '@/components/ui/Champ';
import { Confirmation } from '@/components/ui/Dialogue';
import { AuthService } from '@/core/services/auth.service';
import { PortabiliteService, type Archive } from '@/core/services/portabilite.service';
import { lireFichier, lireImage, telecharger } from './telechargement';
import { Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';

/**
 * Paramètres (§33).
 *
 * Tout ce qui varie d'une boutique à l'autre se règle ici, et rien n'est écrit
 * en dur dans le code : devise, TVA, numérotation, mentions du ticket, seuils,
 * sauvegardes.
 */
const DEVISES = [
  { code: 'MGA', symbol: 'Ar', decimals: 0, symbolBefore: false, libelle: 'Ariary (Ar)' },
  { code: 'EUR', symbol: '€', decimals: 2, symbolBefore: false, libelle: 'Euro (€)' },
  { code: 'USD', symbol: '$', decimals: 2, symbolBefore: true, libelle: 'Dollar ($)' },
  { code: 'XOF', symbol: 'F CFA', decimals: 0, symbolBefore: false, libelle: 'Franc CFA' },
  { code: 'MAD', symbol: 'DH', decimals: 2, symbolBefore: false, libelle: 'Dirham (DH)' },
];

export function Parametres() {
  const contexte = useContexte();
  const { db, shopId, shopCode, settings, rechargerParametres, peut } = useSession();
  const peutRegler = peut(PERMISSIONS.settingsManage);
  const { notifier } = useNotifications();

  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [tva, setTva] = useState(settings.taxEnabled);
  const [negatif, setNegatif] = useState(settings.allowNegativeStock);
  const [imeiStrict, setImeiStrict] = useState(settings.strictImeiChecksum);
  const [valorisation, setValorisation] = useState<CostMethod>(settings.costMethod);
  const [sauvegardeAuto, setSauvegardeAuto] = useState(settings.backupDaily);
  const [occupe, setOccupe] = useState(false);
  const [demonstration, setDemonstration] = useState(false);
  const [integrite, setIntegrite] = useState<string | null>(null);
  /**
   * Mentions libres de la facture.
   *
   * Une LISTE et non des champs fixes : ce qu'une société doit ou veut faire
   * figurer — registre du commerce, capital, banque, numéro Mvola — varie de
   * l'une à l'autre, et une case par mention obligerait à toucher au logiciel
   * à chaque nouveau besoin.
   */
  const [mentions, setMentions] = useState<Mention[]>(settings.invoiceMentions);
  const [logo, setLogo] = useState(settings.invoiceLogo);
  const [avecLogo, setAvecLogo] = useState(settings.invoiceShowLogo);
  const [avecFiscal, setAvecFiscal] = useState(settings.invoiceShowIdentifiers);
  const [avecSignatures, setAvecSignatures] = useState(settings.invoiceShowSignatures);
  const [signatures, setSignatures] = useState(settings.invoiceSignatures);

  const boutique = useChargement(
    async () => (db ? new ShopRepository(db).byId(shopId) : null),
    [db, shopId],
  );
  const sauvegardes = useChargement(
    async () => new BackupService(contexte).list().catch(() => [] as BackupInfo[]),
    [contexte.db],
  );
  const derniereSauvegarde = useChargement(
    async () => new BackupService(contexte).lastBackupAt(),
    [contexte.db, sauvegardes.donnees],
  );

  const choisirLogo = async () => {
    try {
      const image = await lireImage();
      if (image) setLogo(image);
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    }
  };

  const modifierMention = (rang: number, parties: Partial<Mention>) =>
    setMentions((precedent) =>
      precedent.map((mention, autre) => (autre === rang ? { ...mention, ...parties } : mention)),
    );

  const champ = (cle: string, defaut: string) => valeurs[cle] ?? defaut;
  const changer = (cle: string, valeur: string) =>
    setValeurs((precedent) => ({ ...precedent, [cle]: valeur }));

  const enregistrer = async () => {
    if (!db) return;
    setOccupe(true);
    try {
      const depot = new SettingRepository(db);
      const devise =
        DEVISES.find((element) => element.code === champ('devise', settings.currency.code)) ??
        DEVISES[0]!;

      await depot.set(
        SETTING_KEYS.currency,
        {
          code: devise.code,
          symbol: devise.symbol,
          decimals: devise.decimals,
          symbolBefore: devise.symbolBefore,
        },
        shopId,
      );
      await depot.set(SETTING_KEYS.taxEnabled, tva, shopId);
      await depot.set(
        SETTING_KEYS.defaultTaxRate,
        Math.round(Number(champ('tauxTva', String(settings.defaultTaxRate / 100))) * 100) || 0,
        shopId,
      );
      await depot.set(SETTING_KEYS.receiptHeader, champ('entete', settings.receiptHeader), shopId);
      await depot.set(SETTING_KEYS.receiptFooter, champ('pied', settings.receiptFooter), shopId);
      await depot.set(
        SETTING_KEYS.invoiceMentions,
        // Une mention sans libellé ni valeur n'a rien à faire sur une facture :
        // c'est une ligne qu'on a commencée puis abandonnée.
        mentions.filter((mention) => mention.libelle.trim() !== '' || mention.valeur.trim() !== ''),
        shopId,
      );
      await depot.set(
        SETTING_KEYS.invoiceFooter,
        champ('piedFacture', settings.invoiceFooter),
        shopId,
      );
      await depot.set(SETTING_KEYS.invoiceLogo, logo, shopId);
      await depot.set(SETTING_KEYS.invoiceShowLogo, avecLogo, shopId);
      await depot.set(SETTING_KEYS.invoiceShowIdentifiers, avecFiscal, shopId);
      await depot.set(
        SETTING_KEYS.invoiceConditions,
        champ('conditions', settings.invoiceConditions),
        shopId,
      );
      await depot.set(SETTING_KEYS.invoiceShowSignatures, avecSignatures, shopId);
      await depot.set(SETTING_KEYS.invoiceSignatures, signatures, shopId);
      await depot.set(
        SETTING_KEYS.lowStockThreshold,
        Number(champ('seuil', String(settings.lowStockThreshold))) || 0,
        shopId,
      );
      await depot.set(SETTING_KEYS.allowNegativeStock, negatif, shopId);
      await depot.set(SETTING_KEYS.strictImeiChecksum, imeiStrict, shopId);
      await depot.set(SETTING_KEYS.costMethod, valorisation, shopId);
      await depot.set(SETTING_KEYS.backupDaily, sauvegardeAuto, shopId);
      await depot.set(
        SETTING_KEYS.sessionDays,
        Number(champ('session', String(settings.sessionDays))),
        shopId,
      );
      await depot.set(
        SETTING_KEYS.backupKeep,
        Number(champ('conserver', String(settings.backupKeep))) || 14,
        shopId,
      );

      // Les coordonnées de la boutique figurent sur les tickets : elles se
      // règlent au même endroit que le reste.
      await new ShopRepository(db).update(shopId, {
        name: champ('nom', boutique.donnees?.name ?? ''),
        address: champ('adresse', boutique.donnees?.address ?? ''),
        phone: champ('telephone', boutique.donnees?.phone ?? ''),
        email: champ('email', boutique.donnees?.email ?? ''),
        nif: champ('nif', boutique.donnees?.nif ?? ''),
        stat: champ('stat', boutique.donnees?.stat ?? ''),
      });

      await rechargerParametres();
      notifier('Paramètres enregistrés.');
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const sauvegarder = async () => {
    setOccupe(true);
    try {
      const info = await new BackupService(contexte).run();
      notifier(`Sauvegarde créée : ${info.path}`);
      sauvegardes.recharger();
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const verifier = async () => {
    setOccupe(true);
    try {
      const resultat = await new BackupService(contexte).checkIntegrity();
      setIntegrite(resultat);
      notifier(
        resultat === 'ok' ? 'Base saine.' : `Anomalie détectée : ${resultat}`,
        resultat === 'ok' ? 'succes' : 'erreur',
      );
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const exempleTicket = formatDocumentNumber(
    settings.numbering['sale'] ?? DEFAULT_NUMBERING['sale']!,
    { shopCode, sequence: 42 },
  );

  return (
    <div className="space-y-4">
      <EnTetePage
        titre="Paramètres"
        actions={
          peutRegler ? (
            <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
              Enregistrer
            </Bouton>
          ) : null
        }
      />

      {/* L'activation ne dépend PAS du droit de régler les paramètres : un
          gérant sans ce droit doit pouvoir lire son échéance et saisir la clé
          qu'on vient de lui envoyer, sinon le poste se ferme faute d'un
          réglage que personne sur place n'a le droit de toucher. */}
      <Licence />

      <CleDeSecours />

      <Portabilite />

      {!peutRegler ? <LectureSeule quoi="modifier les paramètres" /> : null}

      <fieldset disabled={!peutRegler} className="grid gap-4 lg:grid-cols-2">
        <Carte titre="Boutique">
          {boutique.chargement ? (
            <Chargement />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Champ
                  label="Nom"
                  value={champ('nom', boutique.donnees?.name ?? '')}
                  onChange={(e) => changer('nom', e.target.value)}
                />
                <Champ
                  label="Code"
                  value={shopCode}
                  disabled
                  aide="Il apparaît dans les numéros de documents et ne change pas."
                />
                <Champ
                  label="Téléphone"
                  value={champ('telephone', boutique.donnees?.phone ?? '')}
                  onChange={(e) => changer('telephone', e.target.value)}
                />
                <Champ
                  label="E-mail"
                  value={champ('email', boutique.donnees?.email ?? '')}
                  onChange={(e) => changer('email', e.target.value)}
                />
              </div>
              <Champ
                label="Adresse"
                value={champ('adresse', boutique.donnees?.address ?? '')}
                onChange={(e) => changer('adresse', e.target.value)}
              />
              {/*
                Sans NIF ni STAT, une facture n'a aucune valeur pour la
                comptabilité d'une entreprise cliente : elle ne peut ni la
                déduire, ni la produire en cas de contrôle.
              */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Champ
                  label="NIF"
                  value={champ('nif', boutique.donnees?.nif ?? '')}
                  onChange={(e) => changer('nif', e.target.value)}
                  aide="Imprimé sur les factures."
                />
                <Champ
                  label="STAT"
                  value={champ('stat', boutique.donnees?.stat ?? '')}
                  onChange={(e) => changer('stat', e.target.value)}
                />
              </div>
            </div>
          )}
        </Carte>

        <Carte titre="Session">
          <div className="space-y-3">
            <Liste
              label="Garder la session ouverte"
              value={champ('session', String(settings.sessionDays))}
              onChange={(e) => changer('session', e.target.value)}
              options={[
                { valeur: '0', libelle: 'Redemander à chaque ouverture' },
                { valeur: '1', libelle: 'Une journée' },
                { valeur: '7', libelle: 'Une semaine' },
                { valeur: '30', libelle: 'Un mois' },
                { valeur: '365', libelle: 'Un an' },
              ]}
              aide="Évite de ressaisir le mot de passe quand on ferme et rouvre le logiciel."
            />
            {/*
              L'avertissement n'est pas décoratif : c'est le seul endroit où le
              commerçant peut mesurer ce qu'il échange contre le confort.
            */}
            {Number(champ('session', String(settings.sessionDays))) > 0 ? (
              <Avertissement>
                La personne qui ouvrira le logiciel agira sous le nom du dernier connecté, jusqu’à
                ce qu’elle se déconnecte. Sur un poste partagé, ses ventes et ses remises porteront
                un nom qui n’est pas le sien.
              </Avertissement>
            ) : null}
            <Information>
              La session se ferme d’elle-même à la déconnexion, au changement de mot de passe, et si
              le compte est suspendu.
            </Information>
          </div>
        </Carte>

        <Carte titre="Commerce">
          <div className="space-y-3">
            <Liste
              label="Devise"
              value={champ('devise', settings.currency.code)}
              onChange={(e) => changer('devise', e.target.value)}
              options={DEVISES.map((devise) => ({ valeur: devise.code, libelle: devise.libelle }))}
              aide="Les montants déjà enregistrés ne sont pas convertis."
            />
            <Case
              label="Appliquer la TVA"
              aide="Désactivée, aucune taxe n'apparaît sur les tickets ni dans les rapports."
              checked={tva}
              onChange={(e) => setTva(e.target.checked)}
            />
            {tva ? (
              <Champ
                label="Taux de TVA par défaut (%)"
                inputMode="decimal"
                value={champ('tauxTva', String(settings.defaultTaxRate / 100))}
                onChange={(e) => changer('tauxTva', e.target.value)}
              />
            ) : null}
            <Champ
              label="Seuil d'alerte de stock"
              inputMode="numeric"
              value={champ('seuil', String(settings.lowStockThreshold))}
              onChange={(e) => changer('seuil', e.target.value)}
              aide="S'applique aux produits qui n'ont pas leur propre seuil."
            />
            <Liste
              label="Valorisation des sorties de stock"
              value={valorisation}
              onChange={(e) => setValorisation(e.target.value as CostMethod)}
              options={[
                { valeur: 'CATALOGUE', libelle: "Prix d'achat du catalogue" },
                { valeur: 'FIFO', libelle: 'FIFO — premier entré, premier sorti' },
              ]}
              aide="Ne concerne que les produits suivis par quantité. Un appareil identifié porte toujours son propre coût d'acquisition, ce qui est plus exact que toute convention."
            />
            <Case
              label="Contrôler la clé des IMEI"
              aide="La dernière décimale d'un IMEI est une clé de contrôle : elle attrape les chiffres inversés à la saisie. Ne désactivez ce contrôle que si votre parc comporte des appareils dont l'IMEI ne la respecte pas — la longueur et l'unicité restent vérifiées."
              checked={imeiStrict}
              onChange={(e) => setImeiStrict(e.target.checked)}
            />
            <Case
              label="Autoriser le stock négatif"
              aide="Déconseillé : un stock négatif signale presque toujours une erreur de saisie qu'il vaut mieux corriger tout de suite."
              checked={negatif}
              onChange={(e) => setNegatif(e.target.checked)}
            />
          </div>
        </Carte>

        <Carte titre="Tickets et factures">
          <div className="space-y-3">
            <Information>
              Exemple de numéro de ticket : <span className="mono">{exempleTicket}</span>. Le code
              de la boutique y figure, ce qui rend le numéro unique dans tout le réseau sans
              coordination entre les boutiques.
            </Information>
            <ZoneTexte
              label="En-tête du ticket"
              rows={2}
              value={champ('entete', settings.receiptHeader)}
              onChange={(e) => changer('entete', e.target.value)}
              aide="Adresse, téléphone, numéro fiscal…"
            />
            <ZoneTexte
              label="Pied de ticket"
              rows={2}
              value={champ('pied', settings.receiptFooter)}
              onChange={(e) => changer('pied', e.target.value)}
              aide="Conditions de retour, remerciements…"
            />

            <Case
              label="Imprimer le logo sur la facture"
              checked={avecLogo}
              onChange={(e) => setAvecLogo(e.target.checked)}
              aide={logo ? undefined : 'Aucun logo chargé pour le moment.'}
            />
            {avecLogo ? (
              <div className="flex items-center gap-3">
                {logo ? (
                  <img
                    src={logo}
                    alt="Logo de la boutique"
                    className="h-12 w-auto rounded border border-encre-200 bg-white p-1"
                  />
                ) : null}
                <Bouton icone="import" onClick={() => void choisirLogo()}>
                  {logo ? 'Remplacer' : 'Choisir une image'}
                </Bouton>
                {logo ? (
                  <Bouton icone="poubelle" onClick={() => setLogo('')}>
                    Retirer
                  </Bouton>
                ) : null}
              </div>
            ) : null}

            <Case
              label="Imprimer les identifiants fiscaux (NIF, STAT)"
              checked={avecFiscal}
              onChange={(e) => setAvecFiscal(e.target.checked)}
              aide="De la boutique et du client. Sans eux, une entreprise cliente ne peut pas déduire l’achat."
            />

            <ZoneTexte
              label="Conditions de vente"
              rows={3}
              value={champ('conditions', settings.invoiceConditions)}
              onChange={(e) => changer('conditions', e.target.value)}
              aide="Imprimées au-dessus des signatures : elles engagent l’acheteur."
            />

            <Case
              label="Cases à signer en bas de facture"
              checked={avecSignatures}
              onChange={(e) => setAvecSignatures(e.target.checked)}
            />
            {avecSignatures ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Champ
                  label="Case de gauche"
                  value={signatures.gauche}
                  onChange={(e) => setSignatures({ ...signatures, gauche: e.target.value })}
                />
                <Champ
                  label="Case de droite"
                  value={signatures.droite}
                  onChange={(e) => setSignatures({ ...signatures, droite: e.target.value })}
                />
              </div>
            ) : null}

            <ZoneTexte
              label="Mentions légales de la facture"
              rows={3}
              value={champ('piedFacture', settings.invoiceFooter)}
              onChange={(e) => changer('piedFacture', e.target.value)}
              aide="Régime de TVA, garantie, pénalités de retard. Distinct du pied de ticket."
            />

            <div className="space-y-2">
              <p className="text-sm font-medium">Mentions en tête de facture</p>
              <p className="text-xs text-encre-600">
                Registre du commerce, capital, banque, numéro Mvola… Elles s’impriment sous les
                coordonnées de la boutique.
              </p>
              {mentions.map((mention, rang) => (
                <div key={rang} className="flex items-end gap-2">
                  <Champ
                    label={rang === 0 ? 'Libellé' : ''}
                    className="w-40"
                    value={mention.libelle}
                    onChange={(e) => modifierMention(rang, { libelle: e.target.value })}
                  />
                  <Champ
                    label={rang === 0 ? 'Valeur' : ''}
                    className="flex-1"
                    value={mention.valeur}
                    onChange={(e) => modifierMention(rang, { valeur: e.target.value })}
                  />
                  <Bouton
                    icone="poubelle"
                    onClick={() => setMentions(mentions.filter((_, autre) => autre !== rang))}
                  >
                    Retirer
                  </Bouton>
                </div>
              ))}
              <Bouton onClick={() => setMentions([...mentions, { libelle: '', valeur: '' }])}>
                Ajouter une mention
              </Bouton>
            </div>
          </div>
        </Carte>

        <Carte
          titre="Sauvegardes"
          actions={
            <>
              <Bouton taille="petit" occupe={occupe} onClick={() => void verifier()}>
                Vérifier l'intégrité
              </Bouton>
              <Bouton
                taille="petit"
                variante="principal"
                icone="sauvegarde"
                occupe={occupe}
                onClick={() => void sauvegarder()}
              >
                Sauvegarder
              </Bouton>
            </>
          }
        >
          <div className="space-y-3">
            <Information>
              L'application fonctionne hors ligne : les ventes du jour n'existent nulle part
              ailleurs tant qu'elles n'ont pas été synchronisées. Une sauvegarde quotidienne est le
              seul filet.
            </Information>

            {integrite ? (
              integrite === 'ok' ? (
                <Badge ton="succes">Base saine</Badge>
              ) : (
                <Erreur message={`Anomalie : ${integrite}`} />
              )
            ) : null}

            <div className="text-sm text-encre-600">
              Dernière sauvegarde :{' '}
              <strong>{formaterDate(derniereSauvegarde.donnees, true)}</strong>
            </div>

            <Case
              label="Sauvegarde automatique quotidienne"
              aide="Déclenchée à la connexion, une fois par jour."
              checked={sauvegardeAuto}
              onChange={(e) => setSauvegardeAuto(e.target.checked)}
            />
            <Champ
              label="Nombre de copies conservées"
              inputMode="numeric"
              value={champ('conserver', String(settings.backupKeep))}
              onChange={(e) => changer('conserver', e.target.value)}
            />

            <Tableau
              lignes={sauvegardes.donnees ?? []}
              cleDe={(ligne) => ligne.path}
              vide={{ icone: 'sauvegarde', titre: 'Aucune sauvegarde' }}
              colonnes={[
                {
                  cle: 'fichier',
                  titre: 'Fichier',
                  rendu: (l) => <span className="mono text-xs">{l.path.split(/[\\/]/).pop()}</span>,
                },
                {
                  cle: 'taille',
                  titre: 'Taille',
                  num: true,
                  rendu: (l) => `${Math.round(l.bytes / 1024)} Ko`,
                },
              ]}
            />
          </div>
        </Carte>

        <Carte titre="Entretien" className="lg:col-span-2">
          <div className="flex flex-wrap gap-2">
            <Bouton
              icone="mouvement"
              occupe={occupe}
              onClick={async () => {
                if (!db) return;
                setOccupe(true);
                try {
                  const nombre = await new StockRepository(db).rebuildLevels(shopId);
                  notifier(`${nombre} niveau(x) de stock recalculé(s) depuis les mouvements.`);
                } finally {
                  setOccupe(false);
                }
              }}
            >
              Recalculer les niveaux de stock
            </Bouton>
            <Bouton icone="boite" onClick={() => setDemonstration(true)}>
              Charger le jeu de démonstration
            </Bouton>
          </div>
          <Avertissement>
            Le recalcul reconstruit les quantités à partir des mouvements, qui font foi. À utiliser
            si un total paraît incohérent après un incident.
          </Avertissement>
        </Carte>
      </fieldset>

      <Confirmation
        ouvert={demonstration}
        titre="Charger le jeu de démonstration"
        libelleAction="Charger les données"
        occupe={occupe}
        onConfirmer={async () => {
          setOccupe(true);
          try {
            const rapport = await new SeedService(contexte).run();
            notifier(
              `Démonstration chargée : ${rapport.products} produits, ${rapport.units} appareils, ${rapport.sales} ventes. Mot de passe des comptes : ${rapport.password}`,
            );
            setDemonstration(false);
          } catch (cause) {
            notifier(messageDe(cause), 'erreur');
          } finally {
            setOccupe(false);
          }
        }}
        onFermer={() => setDemonstration(false)}
        message="Des boutiques, utilisateurs, produits, achats, ventes, transferts et échanges fictifs seront créés. L'opération est refusée si la base contient déjà des ventes réelles."
      />
    </div>
  );
}

/**
 * Renouvellement de la clé de secours.
 *
 * Le geste qu'on fait quand la clé a été égarée, ou qu'elle a circulé — dictée
 * au téléphone, photographiée. L'ancienne cesse aussitôt de valoir, et la
 * nouvelle ne s'affiche qu'une fois.
 *
 * Réservé à qui administre les comptes : c'est le pouvoir de reprendre le
 * compte administrateur qui se renouvelle ici.
 */
function CleDeSecours() {
  const contexte = useContexte();
  const { peut } = useSession();
  const { notifier } = useNotifications();
  const [nouvelle, setNouvelle] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [occupe, setOccupe] = useState(false);

  if (!peut(PERMISSIONS.userManage)) return null;

  const renouveler = async () => {
    setOccupe(true);
    try {
      setNouvelle(await new AuthService(contexte.db).renewRecoveryKey(contexte));
      setConfirmation(false);
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Carte titre="Clé de secours de l’administrateur">
      <Information>
        Cette clé est le seul moyen de rouvrir le logiciel si le dernier administrateur oublie son
        mot de passe. Elle vous a été remise à l’installation. Si vous l’avez égarée, ou si elle a
        circulé, produisez-en une nouvelle — l’ancienne cessera aussitôt de valoir.
      </Information>

      {nouvelle ? (
        <div className="mt-3">
          <Avertissement>
            <strong>Notez cette clé hors de cet ordinateur.</strong> Elle ne sera plus affichée.
          </Avertissement>
          <p className="mono mt-2 select-all rounded-lg border-2 border-marque-300 bg-marque-50 px-4 py-3 text-center tracking-widest text-encre-900">
            {nouvelle}
          </p>
        </div>
      ) : (
        <Bouton className="mt-3" occupe={occupe} onClick={() => setConfirmation(true)}>
          Produire une nouvelle clé de secours
        </Bouton>
      )}

      <Confirmation
        ouvert={confirmation}
        titre="Produire une nouvelle clé de secours ?"
        message="L’ancienne clé cessera immédiatement de fonctionner. Assurez-vous de pouvoir noter la nouvelle : elle ne sera affichée qu’une seule fois."
        libelleAction="Produire la clé"
        occupe={occupe}
        onConfirmer={() => void renouveler()}
        onFermer={() => setConfirmation(false)}
      />
    </Carte>
  );
}

/**
 * Emporter ou reprendre un commerce.
 *
 * TROIS USAGES, un seul écran : changer d'ordinateur, passer à l'offre en
 * ligne, en revenir. C'est aussi la sauvegarde qu'on emporte — celle qui
 * survit à la panne de la machine, contrairement aux sauvegardes locales qui
 * dorment sur le même disque.
 */
function Portabilite() {
  const contexte = useContexte();
  const { peut } = useSession();
  const { notifier } = useNotifications();
  const [occupe, setOccupe] = useState(false);
  const [candidate, setCandidate] = useState<{ archive: Archive; vierge: boolean } | null>(null);

  if (!peut(PERMISSIONS.settingsManage)) return null;

  const exporter = async () => {
    setOccupe(true);
    try {
      const archive = await new PortabiliteService(contexte).exporter();
      const nom = `boutique-${archive.manifeste.boutique?.code ?? 'export'}-${archive.manifeste.exporteLe.slice(0, 10)}.json`;
      const chemin = await telecharger(nom, JSON.stringify(archive), 'json');
      if (chemin) {
        const lignes = Object.values(archive.manifeste.comptes).reduce((s, n) => s + n, 0);
        notifier(`Archive enregistrée : ${lignes.toLocaleString('fr-FR')} lignes.`);
      }
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const choisir = async () => {
    setOccupe(true);
    try {
      const brut = await lireFichier(['json'], 'Archive de boutique');
      if (!brut) return;
      const service = new PortabiliteService(contexte);
      const archive = JSON.parse(brut) as Archive;
      // On VÉRIFIE avant de proposer : personne ne doit découvrir après coup
      // que l'archive venait d'une version incompatible.
      service.verifier(archive);
      setCandidate({ archive, vierge: await service.baseVierge() });
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const importer = async () => {
    if (!candidate) return;
    setOccupe(true);
    try {
      const rapport = await new PortabiliteService(contexte).importer(candidate.archive, {
        remplacer: !candidate.vierge,
      });
      setCandidate(null);
      notifier(
        `${rapport.lignes.toLocaleString('fr-FR')} lignes reprises. Redémarrez l’application.`,
      );
    } catch (cause) {
      notifier(messageDe(cause), 'erreur');
    } finally {
      setOccupe(false);
    }
  };

  const manifeste = candidate?.archive.manifeste;

  return (
    <Carte titre="Emporter ou reprendre ce commerce">
      <Information>
        L’archive contient l’intégralité du commerce : catalogue, stock, ventes, clients, comptes.
        Elle sert à changer d’ordinateur, à passer à l’offre en ligne, ou à en revenir. Elle
        n’emporte NI la licence NI la clé de secours — la machine d’arrivée repart avec son propre
        code d’installation.
      </Information>

      <Avertissement>
        Ce fichier contient vos prix d’achat, vos clients et les empreintes des mots de passe.
        Rangez-le comme vous rangeriez votre comptabilité.
      </Avertissement>

      <div className="mt-3 flex flex-wrap gap-2">
        <Bouton icone="export" occupe={occupe} onClick={() => void exporter()}>
          Exporter tout le commerce
        </Bouton>
        <Bouton icone="import" occupe={occupe} onClick={() => void choisir()}>
          Reprendre une archive
        </Bouton>
      </div>

      <Confirmation
        ouvert={candidate !== null}
        danger={!candidate?.vierge}
        titre={candidate?.vierge ? 'Reprendre cette archive ?' : 'REMPLACER tout le commerce ?'}
        libelleAction={candidate?.vierge ? 'Reprendre' : 'Remplacer définitivement'}
        occupe={occupe}
        message={
          manifeste ? (
            <div className="space-y-2">
              <p>
                Archive de <strong>{manifeste.boutique?.nom ?? 'boutique inconnue'}</strong>
                {manifeste.boutique?.code ? ` (${manifeste.boutique.code})` : ''}, produite le{' '}
                {formaterDate(manifeste.exporteLe, true)}.
              </p>
              <p>
                {Object.values(manifeste.comptes)
                  .reduce((somme, n) => somme + n, 0)
                  .toLocaleString('fr-FR')}{' '}
                lignes, dont {manifeste.comptes['sale'] ?? 0} vente(s) et{' '}
                {manifeste.comptes['product'] ?? 0} produit(s).
              </p>
              {!candidate?.vierge ? (
                <p className="font-medium text-danger-700">
                  Cette base contient déjà un commerce. Il sera entièrement effacé et remplacé.
                  L’opération est irréversible : exportez-le d’abord si vous tenez à le garder.
                </p>
              ) : null}
            </div>
          ) : (
            ''
          )
        }
        onConfirmer={() => void importer()}
        onFermer={() => setCandidate(null)}
      />
    </Carte>
  );
}
