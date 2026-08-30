import { useRef, useState } from 'react';
import { IMPORT_MODE, PERMISSIONS } from '@boutique/shared';
import type { ImportMode } from '@boutique/shared';
import {
  listSheets,
  readSheet,
  readWorkbook,
  type SheetData,
  type SheetInfo,
} from '@/core/import/workbook';
import { IMPORT_FIELDS, suggestMapping } from '@/core/import/fields';
import { ImportService, type ImportPlan, type ImportResult } from '@/core/services/import.service';
import { FAMILLES, devinerFamille } from '@/core/import/familles';
import {
  Carte,
  CarteChiffre,
  Chargement,
  EnTetePage,
  Erreur,
  Information,
  Avertissement,
  LectureSeule,
  Vide,
} from '@/components/ui/Page';
import { Badge } from '@/components/ui/Badge';
import { Bouton } from '@/components/ui/Bouton';
import { Case, Liste } from '@/components/ui/Champ';
import { Confirmation } from '@/components/ui/Dialogue';
import { Tableau } from '@/components/ui/Tableau';
import { useNotifications } from '@/components/ui/Notifications';
import { useContexte, useSession } from '@/app/session';
import { formaterDate, messageDe, useChargement } from '@/app/hooks';

/**
 * Import Excel (§8).
 *
 * L'écran suit exactement les onze étapes du cahier des charges, dans l'ordre :
 * choisir le fichier, choisir la feuille, voir les colonnes, les associer,
 * prévisualiser, voir les erreurs et les doublons, corriger le fichier si
 * besoin, importer, lire le rapport.
 *
 * RIEN N'EST ÉCRIT AVANT L'ÉTAPE « Importer ». L'analyse est purement en
 * lecture : elle peut être relancée autant de fois qu'on veut, en changeant le
 * mapping, sans conséquence.
 */
type Etape = 'fichier' | 'mapping' | 'apercu' | 'rapport';

export function Import() {
  const contexte = useContexte();
  const { peut } = useSession();
  const { notifier } = useNotifications();
  const champFichier = useRef<HTMLInputElement>(null);
  const peutImporter = peut(PERMISSIONS.importRun);

  const [etape, setEtape] = useState<Etape>('fichier');
  const [nomFichier, setNomFichier] = useState('');
  const [feuilles, setFeuilles] = useState<SheetInfo[]>([]);
  const [classeur, setClasseur] = useState<ReturnType<typeof readWorkbook> | null>(null);
  const [feuille, setFeuille] = useState<SheetData | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<ImportMode>(IMPORT_MODE.createOnly);
  // Famille des articles de la feuille. '' = laisser le fichier décider.
  const [famille, setFamille] = useState<string>('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [resultat, setResultat] = useState<ImportResult | null>(null);
  /** Importer toutes les feuilles d'un coup : les classeurs du client en ont
   *  jusqu'à cinq, une par famille de produits. */
  const [toutesFeuilles, setToutesFeuilles] = useState(false);
  const [avancement, setAvancement] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [annulation, setAnnulation] = useState<string | null>(null);

  const service = new ImportService(contexte);
  const historique = useChargement(async () => service.history(20), [contexte.db, resultat]);

  const ouvrirFichier = async (fichier: File) => {
    setErreur(null);
    try {
      const donnees = await fichier.arrayBuffer();
      const livre = readWorkbook(donnees);
      const liste = listSheets(livre);
      setClasseur(livre);
      setFeuilles(liste);
      setNomFichier(fichier.name);

      const premiere = liste[0];
      if (premiere) choisirFeuille(livre, premiere.name, fichier.name);
      setEtape('mapping');
    } catch (cause) {
      setErreur(`Fichier illisible : ${messageDe(cause)}`);
    }
  };

  const choisirFeuille = (
    livre: ReturnType<typeof readWorkbook>,
    nom: string,
    fichier = nomFichier,
  ) => {
    const donnees = readSheet(livre, nom);
    setFeuille(donnees);
    setMapping(suggestMapping(donnees.headers));
    // La famille est devinée par feuille, jamais par classeur : « Boitiers et
    // câbles » en contient trois, qui ne se rangent pas au même endroit.
    setFamille(devinerFamille(nom, etiquetteDe(donnees), fichier)?.code ?? '');
    setPlan(null);
  };

  const analyser = async () => {
    if (!feuille) return;
    setErreur(null);
    setOccupe(true);
    try {
      const prepare = await service.plan(feuille, mapping, mode, nomFichier, famille || null);
      setPlan(prepare);
      setEtape('apercu');
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  const importer = async () => {
    if (!plan) return;
    setErreur(null);
    setOccupe(true);
    try {
      const sortie = await service.apply(plan);
      setResultat(sortie);
      setEtape('rapport');
      notifier(
        `Import terminé : ${sortie.created} créé(s), ${sortie.updated} modifié(s), ${sortie.errors} erreur(s).`,
      );
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setOccupe(false);
    }
  };

  /**
   * Import de toutes les feuilles du classeur.
   *
   * Chaque feuille est analysée avec SA propre association de colonnes : les
   * en-têtes varient d'une feuille à l'autre (certaines portent une colonne
   * « Coût », d'autres non). Réutiliser l'association de la première décalerait
   * silencieusement les prix.
   */
  const importerTout = async () => {
    if (!classeur) return;
    setErreur(null);
    setOccupe(true);
    const cumul: ImportResult = {
      batchId: '',
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      unitsCreated: 0,
      categoriesCreated: 0,
      suppliersCreated: 0,
    };
    try {
      for (const info of feuilles) {
        setAvancement(`Feuille « ${info.name} »…`);
        const donnees = readSheet(classeur, info.name);
        if (donnees.rows.length === 0) continue;
        const prepare = await service.plan(
          donnees,
          suggestMapping(donnees.headers),
          mode,
          `${nomFichier} — ${info.name}`,
          devinerFamille(info.name, etiquetteDe(donnees), nomFichier)?.code ?? null,
        );
        if (prepare.report.missingFields.length > 0) {
          throw new Error(
            `Feuille « ${info.name} » : champs obligatoires non associés (${prepare.report.missingFields.join(', ')}).`,
          );
        }
        const sortie = await service.apply(prepare);
        cumul.batchId = sortie.batchId;
        cumul.created += sortie.created;
        cumul.updated += sortie.updated;
        cumul.skipped += sortie.skipped;
        cumul.errors += sortie.errors;
        cumul.unitsCreated += sortie.unitsCreated;
        cumul.categoriesCreated += sortie.categoriesCreated;
        cumul.suppliersCreated += sortie.suppliersCreated;
      }
      setResultat(cumul);
      setEtape('rapport');
      notifier(
        `${feuilles.length} feuille(s) importée(s) : ${cumul.created} produit(s) créé(s), ${cumul.errors} erreur(s).`,
      );
    } catch (cause) {
      setErreur(messageDe(cause));
    } finally {
      setAvancement(null);
      setOccupe(false);
    }
  };

  const recommencer = () => {
    setEtape('fichier');
    setClasseur(null);
    setFeuille(null);
    setPlan(null);
    setResultat(null);
    setNomFichier('');
    setMapping({});
  };

  return (
    <div className="space-y-4">
      <EnTetePage
        titre="Import Excel"
        sousTitre="Reprise du catalogue et du stock depuis un fichier existant."
        actions={
          etape !== 'fichier' ? <Bouton onClick={recommencer}>Nouveau fichier</Bouton> : null
        }
      />

      <Fil etape={etape} />

      {!peutImporter ? <LectureSeule quoi="importer des fichiers" /> : null}
      {erreur ? <Erreur message={erreur} /> : null}

      {etape === 'fichier' ? (
        <Carte>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-encre-700">Choisissez le fichier Excel à importer.</p>
            <p className="max-w-lg text-xs text-encre-500">
              Formats acceptés : .xlsx, .xls, .csv. Rien n'est écrit tant que vous n'avez pas
              confirmé : le fichier est d'abord analysé, et les erreurs vous sont présentées.
            </p>
            <input
              ref={champFichier}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(evenement) => {
                const fichier = evenement.target.files?.[0];
                if (fichier) void ouvrirFichier(fichier);
              }}
            />
            <Bouton
              variante="principal"
              icone="import"
              taille="grand"
              disabled={!peutImporter}
              onClick={() => champFichier.current?.click()}
            >
              Choisir un fichier
            </Bouton>
          </div>
        </Carte>
      ) : null}

      {etape === 'mapping' && feuille ? (
        <Carte titre={`Colonnes de « ${nomFichier} »`}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Liste
                label="Feuille"
                value={feuille.name}
                onChange={(evenement) => {
                  if (classeur) choisirFeuille(classeur, evenement.target.value);
                }}
                options={feuilles.map((element) => ({
                  valeur: element.name,
                  libelle: `${element.name} (${element.rows} lignes)`,
                }))}
              />
              <Liste
                label="Mode d'import"
                value={mode}
                onChange={(evenement) => setMode(evenement.target.value as ImportMode)}
                options={[
                  { valeur: IMPORT_MODE.createOnly, libelle: 'Création seule — ne modifie rien' },
                  {
                    valeur: IMPORT_MODE.createAndUpdate,
                    libelle: 'Création et mise à jour des produits existants',
                  },
                  { valeur: IMPORT_MODE.updateOnly, libelle: 'Mise à jour seule' },
                ]}
                aide="En création seule, un produit déjà connu est laissé intact."
              />
            </div>

            <Liste
              label="Type de produit importé"
              value={famille}
              onChange={(evenement) => setFamille(evenement.target.value)}
              options={[
                { valeur: '', libelle: 'Déduire du fichier (colonne « Étiquettes »)' },
                ...FAMILLES.map((element) => ({
                  valeur: element.code,
                  libelle: `${element.label} — suivi ${LIBELLE_SUIVI[element.tracking]}`,
                })),
              ]}
              aide="Détermine la catégorie des produits créés et leur mode de suivi. Proposé d'après le nom de la feuille."
            />

            <Information>
              L'association a été proposée d'après les en-têtes du fichier. Vérifiez-la : c'est elle
              qui détermine ce qui sera écrit.
            </Information>

            <table className="tableau">
              <thead>
                <tr>
                  <th>Colonne du fichier</th>
                  <th>Exemple</th>
                  <th style={{ width: '18rem' }}>Champ de l'application</th>
                </tr>
              </thead>
              <tbody>
                {feuille.headers.map((entete, index) => (
                  <tr key={`${entete}-${index}`}>
                    <td className="font-medium">
                      {entete || <em className="text-encre-400">Sans titre</em>}
                    </td>
                    <td className="text-encre-600">{feuille.rows[0]?.[index] ?? ''}</td>
                    <td>
                      <select
                        value={mapping[index] ?? ''}
                        onChange={(evenement) =>
                          setMapping((precedent) => {
                            const suite = { ...precedent };
                            if (evenement.target.value === '') delete suite[index];
                            else suite[index] = evenement.target.value;
                            return suite;
                          })
                        }
                        className="h-8 w-full rounded-md border border-encre-300 bg-white px-2 text-sm"
                      >
                        <option value="">— Ignorer cette colonne —</option>
                        {IMPORT_FIELDS.map((champ) => (
                          <option key={champ.key} value={champ.key}>
                            {champ.label}
                            {champ.required ? ' *' : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {feuilles.length > 1 ? (
              <Case
                label={`Importer les ${feuilles.length} feuilles du classeur`}
                aide="Chaque feuille est analysée avec sa propre association de colonnes. Sans vérification préalable feuille par feuille."
                checked={toutesFeuilles}
                onChange={(evenement) => setToutesFeuilles(evenement.target.checked)}
              />
            ) : null}

            <div className="flex items-center justify-end gap-2">
              {avancement ? <span className="text-sm text-encre-500">{avancement}</span> : null}
              {toutesFeuilles ? (
                <Bouton
                  variante="principal"
                  icone="import"
                  occupe={occupe}
                  onClick={() => void importerTout()}
                >
                  Importer les {feuilles.length} feuilles
                </Bouton>
              ) : (
                <Bouton variante="principal" occupe={occupe} onClick={() => void analyser()}>
                  Analyser la feuille
                </Bouton>
              )}
            </div>
          </div>
        </Carte>
      ) : null}

      {etape === 'apercu' && plan ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CarteChiffre libelle="À créer" valeur={plan.report.counts.CREATE} ton="succes" />
            <CarteChiffre libelle="À mettre à jour" valeur={plan.report.counts.UPDATE} />
            <CarteChiffre libelle="Ignorées" valeur={plan.report.counts.SKIP} />
            <CarteChiffre
              libelle="En erreur"
              valeur={plan.report.counts.ERROR}
              ton={plan.report.counts.ERROR > 0 ? 'danger' : 'neutre'}
            />
          </div>

          {plan.report.missingFields.length > 0 ? (
            <Erreur
              message={`Champs obligatoires non associés : ${plan.report.missingFields.join(', ')}. Revenez à l'étape précédente.`}
            />
          ) : null}

          {plan.report.counts.ERROR > 0 ? (
            <Avertissement>
              Les lignes en erreur seront ignorées, les autres seront importées. Le rapport final
              nommera chaque ligne écartée avec son motif : vous pourrez corriger le fichier et
              relancer un import sur les seules lignes manquantes.
            </Avertissement>
          ) : null}

          <Carte titre="Prévisualisation" compact>
            <div className="max-h-[50vh] overflow-auto">
              <table className="tableau">
                <thead>
                  <tr>
                    <th>Ligne</th>
                    <th>Sort</th>
                    <th>SKU</th>
                    <th>Désignation</th>
                    <th>Identifiant</th>
                    <th className="num">Prix de vente</th>
                    <th>Problème</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.report.rows.slice(0, 500).map((ligne) => (
                    <tr key={ligne.rowNumber}>
                      <td className="num">{ligne.rowNumber}</td>
                      <td>
                        <Badge
                          ton={
                            ligne.outcome === 'ERROR'
                              ? 'danger'
                              : ligne.outcome === 'SKIP'
                                ? 'neutre'
                                : ligne.outcome === 'UPDATE'
                                  ? 'attente'
                                  : 'succes'
                          }
                        >
                          {ligne.outcome === 'CREATE'
                            ? 'Création'
                            : ligne.outcome === 'UPDATE'
                              ? 'Mise à jour'
                              : ligne.outcome === 'SKIP'
                                ? 'Ignorée'
                                : 'Erreur'}
                        </Badge>
                      </td>
                      <td className="mono">
                        {ligne.product?.sku ?? ligne.values['sku'] ?? ''}
                        {ligne.skuDerived ? (
                          <span className="ml-1 text-[10px] font-medium text-alerte-700">
                            dérivée
                          </span>
                        ) : null}
                      </td>
                      <td>{ligne.values['name'] ?? ''}</td>
                      <td className="mono">{ligne.unit?.imei1 ?? ligne.unit?.serial ?? ''}</td>
                      <td className="num">{ligne.values['salePrice'] ?? ''}</td>
                      <td className="text-xs">
                        {ligne.problems.length > 0 ? (
                          <span className="text-danger-700">{ligne.problems.join(' ')}</span>
                        ) : null}
                        {ligne.warnings.length > 0 ? (
                          <span className="text-alerte-700"> {ligne.warnings.join(' ')}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Carte>

          <div className="flex justify-end gap-2">
            <Bouton onClick={() => setEtape('mapping')}>Revenir à l'association</Bouton>
            <Bouton
              variante="principal"
              icone="import"
              occupe={occupe}
              disabled={plan.report.missingFields.length > 0}
              onClick={() => void importer()}
            >
              Importer {plan.report.counts.CREATE + plan.report.counts.UPDATE} ligne(s)
            </Bouton>
          </div>
        </>
      ) : null}

      {etape === 'rapport' && resultat ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <CarteChiffre libelle="Produits créés" valeur={resultat.created} ton="succes" />
            <CarteChiffre libelle="Produits mis à jour" valeur={resultat.updated} />
            <CarteChiffre libelle="Appareils créés" valeur={resultat.unitsCreated} ton="succes" />
            <CarteChiffre
              libelle="Catégories créées"
              valeur={resultat.categoriesCreated}
              detail={`${resultat.suppliersCreated} fournisseur(s)`}
            />
            <CarteChiffre libelle="Lignes ignorées" valeur={resultat.skipped} />
            <CarteChiffre
              libelle="Erreurs"
              valeur={resultat.errors}
              ton={resultat.errors > 0 ? 'danger' : 'neutre'}
            />
          </div>
          <LignesEnErreur batchId={resultat.batchId} />
        </>
      ) : null}

      <Carte titre="Journal des imports" compact>
        {historique.chargement ? (
          <Chargement />
        ) : (
          <Tableau
            lignes={historique.donnees ?? []}
            cleDe={(ligne) => ligne.id}
            vide={{ icone: 'import', titre: 'Aucun import' }}
            colonnes={[
              { cle: 'fichier', titre: 'Fichier', rendu: (l) => l.fileName },
              { cle: 'feuille', titre: 'Feuille', rendu: (l) => l.sheetName ?? '—' },
              { cle: 'date', titre: 'Date', rendu: (l) => formaterDate(l.startedAt, true) },
              { cle: 'par', titre: 'Par', rendu: (l) => l.userLabel },
              {
                cle: 'resultat',
                titre: 'Résultat',
                rendu: (l) => (
                  <span className="flex gap-1.5">
                    <Badge ton="succes">{l.totals.created} créé(s)</Badge>
                    {l.totals.updated > 0 ? (
                      <Badge ton="attente">{l.totals.updated} modifié(s)</Badge>
                    ) : null}
                    {l.totals.errors > 0 ? (
                      <Badge ton="danger">{l.totals.errors} erreur(s)</Badge>
                    ) : null}
                  </span>
                ),
              },
              {
                cle: 'statut',
                titre: 'Statut',
                rendu: (l) => (
                  <Badge ton={l.status === 'ROLLED_BACK' ? 'neutre' : 'info'}>
                    {l.status === 'APPLIED'
                      ? 'Appliqué'
                      : l.status === 'ROLLED_BACK'
                        ? 'Annulé'
                        : l.status}
                  </Badge>
                ),
              },
              {
                cle: 'actions',
                titre: '',
                rendu: (l) =>
                  l.status === 'APPLIED' ? (
                    <Bouton
                      taille="petit"
                      variante="danger"
                      onClick={(evenement) => {
                        evenement.stopPropagation();
                        setAnnulation(l.id);
                      }}
                    >
                      Annuler l'import
                    </Bouton>
                  ) : null,
              },
            ]}
          />
        )}
      </Carte>

      <Confirmation
        ouvert={annulation !== null}
        titre="Annuler cet import"
        libelleAction="Annuler l'import"
        danger
        occupe={occupe}
        onConfirmer={async () => {
          if (!annulation) return;
          setOccupe(true);
          try {
            const sortie = await service.rollback(annulation);
            notifier(
              sortie.kept > 0
                ? `${sortie.removed} appareil(s) retiré(s), ${sortie.kept} conservé(s) car déjà utilisés.`
                : `${sortie.removed} appareil(s) retiré(s).`,
            );
            setAnnulation(null);
            historique.recharger();
          } catch (cause) {
            notifier(messageDe(cause), 'erreur');
          } finally {
            setOccupe(false);
          }
        }}
        onFermer={() => setAnnulation(null)}
        message="Seuls les appareils créés par cet import et qui n'ont pas bougé depuis seront retirés. Ceux qui ont été vendus, transférés ou modifiés sont conservés, et vous serez informé de la liste. Les produits créés ne sont pas supprimés."
      />
    </div>
  );
}

function LignesEnErreur({ batchId }: { batchId: string }) {
  const contexte = useContexte();
  const etat = useChargement(
    async () => new ImportService(contexte).rowsOf(batchId, 'ERROR'),
    [contexte.db, batchId],
  );

  if (etat.chargement) return <Chargement />;
  if ((etat.donnees ?? []).length === 0) {
    return (
      <Carte>
        <Vide icone="check" titre="Aucune ligne en erreur" detail="Tout le fichier a été traité." />
      </Carte>
    );
  }

  return (
    <Carte titre="Lignes écartées" compact>
      <table className="tableau">
        <thead>
          <tr>
            <th style={{ width: '6rem' }}>Ligne</th>
            <th>Motif</th>
          </tr>
        </thead>
        <tbody>
          {(etat.donnees ?? []).map((ligne) => (
            <tr key={ligne.rowNumber}>
              <td className="num">{ligne.rowNumber}</td>
              <td className="text-danger-700">{ligne.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Carte>
  );
}

/** Fil d'étapes : on doit toujours savoir où l'on en est et ce qui reste. */
function Fil({ etape }: { etape: Etape }) {
  const etapes: { cle: Etape; libelle: string }[] = [
    { cle: 'fichier', libelle: '1. Fichier' },
    { cle: 'mapping', libelle: '2. Association des colonnes' },
    { cle: 'apercu', libelle: '3. Vérification' },
    { cle: 'rapport', libelle: '4. Rapport' },
  ];
  const position = etapes.findIndex((element) => element.cle === etape);

  return (
    <div className="flex items-center gap-2 text-sm">
      {etapes.map((element, index) => (
        <div key={element.cle} className="flex items-center gap-2">
          <span
            className={
              index === position
                ? 'font-medium text-marque-700'
                : index < position
                  ? 'text-encre-600'
                  : 'text-encre-400'
            }
          >
            {element.libelle}
          </span>
          {index < etapes.length - 1 ? <span className="text-encre-300">›</span> : null}
        </div>
      ))}
    </div>
  );
}

const LIBELLE_SUIVI: Record<string, string> = {
  IMEI: 'par IMEI',
  SERIAL: 'par numéro de série',
  QUANTITY: 'par quantité',
};

/**
 * Valeur de la colonne « Étiquettes » sur la première ligne remplie.
 *
 * C'est le meilleur indice de famille dont on dispose quand le nom de la
 * feuille est générique (« Feuil1 ») : le client y écrit déjà « Boitiers » ou
 * « Cache-écrans ».
 */
function etiquetteDe(donnees: SheetData): string {
  const colonne = donnees.headers.findIndex((entete) =>
    entete
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .includes('etiquette'),
  );
  if (colonne < 0) return '';
  for (const ligne of donnees.rows) {
    const valeur = ligne[colonne]?.trim();
    if (valeur) return valeur;
  }
  return '';
}
