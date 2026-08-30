import { useState } from 'react';
import { DEFAULT_NUMBERING, formatDocumentNumber } from '@boutique/shared';
import { SettingRepository, SETTING_KEYS } from '@/core/db/repositories/setting.repository';
import { ShopRepository } from '@/core/db/repositories/shop.repository';
import { BackupService, type BackupInfo } from '@/core/services/backup.service';
import { SeedService } from '@/core/services/seed.service';
import { StockRepository } from '@/core/db/repositories/stock.repository';
import {
  Carte,
  Chargement,
  EnTetePage,
  Erreur,
  Information,
  Avertissement,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Champ, Case, Liste, ZoneTexte } from '@/components/ui/Champ';
import { Confirmation } from '@/components/ui/Dialogue';
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
  const { db, shopId, shopCode, settings, rechargerParametres } = useSession();
  const { notifier } = useNotifications();

  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [tva, setTva] = useState(settings.taxEnabled);
  const [negatif, setNegatif] = useState(settings.allowNegativeStock);
  const [imeiStrict, setImeiStrict] = useState(settings.strictImeiChecksum);
  const [sauvegardeAuto, setSauvegardeAuto] = useState(settings.backupDaily);
  const [occupe, setOccupe] = useState(false);
  const [demonstration, setDemonstration] = useState(false);
  const [integrite, setIntegrite] = useState<string | null>(null);

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
        SETTING_KEYS.lowStockThreshold,
        Number(champ('seuil', String(settings.lowStockThreshold))) || 0,
        shopId,
      );
      await depot.set(SETTING_KEYS.allowNegativeStock, negatif, shopId);
      await depot.set(SETTING_KEYS.strictImeiChecksum, imeiStrict, shopId);
      await depot.set(SETTING_KEYS.backupDaily, sauvegardeAuto, shopId);
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
          <Bouton variante="principal" occupe={occupe} onClick={() => void enregistrer()}>
            Enregistrer
          </Bouton>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Carte titre="Boutique">
          {boutique.chargement ? (
            <Chargement />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
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
            </div>
          )}
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
      </div>

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
