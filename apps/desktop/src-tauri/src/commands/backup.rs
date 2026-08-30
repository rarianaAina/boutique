use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool};

/// Sauvegarde et restauration de la base locale (§32).
///
/// POURQUOI : la boutique fonctionne hors ligne. Les ventes du jour, les
/// entrées d'IMEI et les réceptions n'existent NULLE PART ailleurs tant que la
/// synchronisation n'a pas eu lieu. Un disque qui lâche, c'est l'activité
/// perdue — pas seulement un désagrément.
///
/// La copie utilise `VACUUM INTO`, seule méthode sûre pour copier une base
/// SQLite EN COURS D'UTILISATION : recopier le fichier à la main pendant que le
/// mode WAL est actif produit une sauvegarde incohérente, donc inutilisable au
/// moment précis où l'on en aurait besoin.

#[derive(Serialize)]
pub struct BackupInfo {
    pub path: String,
    pub bytes: u64,
}

fn backup_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("dossier de configuration introuvable : {error}"))?
        .join("sauvegardes");
    std::fs::create_dir_all(&dir).map_err(|error| format!("dossier illisible : {error}"))?;
    Ok(dir)
}

#[tauri::command]
pub async fn backup_database<R: Runtime>(
    app: tauri::AppHandle<R>,
    instances: tauri::State<'_, DbInstances>,
    db: String,
    label: String,
    keep: Option<usize>,
) -> Result<BackupInfo, String> {
    let dir = backup_dir(&app)?;
    // Un libellé venu de l'interface ne doit jamais pouvoir sortir du dossier
    // de sauvegarde : on ne garde que des caractères sûrs.
    let safe_label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let target = dir.join(format!("boutique-{safe_label}.db"));

    {
        let pools = instances.0.read().await;
        let pool = pools
            .get(&db)
            .ok_or_else(|| format!("base « {db} » inconnue"))?;
        #[allow(irrefutable_let_patterns)]
        let DbPool::Sqlite(pool) = pool
        else {
            return Err("seule SQLite peut être sauvegardée".into());
        };

        // VACUUM INTO refuse d'écraser : on retire une copie du même horodatage.
        let _ = std::fs::remove_file(&target);
        let destination = target.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{destination}'"))
            .execute(&*pool)
            .await
            .map_err(|error| format!("sauvegarde impossible : {error}"))?;
    }

    let bytes = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    prune(&dir, keep.unwrap_or(14))?;

    Ok(BackupInfo {
        path: target.to_string_lossy().to_string(),
        bytes,
    })
}

#[tauri::command]
pub async fn list_backups<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<BackupInfo>, String> {
    let dir = backup_dir(&app)?;
    let mut entries: Vec<(PathBuf, u64)> = std::fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "db"))
        .filter_map(|entry| entry.metadata().ok().map(|meta| (entry.path(), meta.len())))
        .collect();

    // Les noms portent un horodatage : l'ordre alphabétique décroissant est
    // l'ordre chronologique inverse, sans lire les dates du système de fichiers.
    entries.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(entries
        .into_iter()
        .map(|(path, bytes)| BackupInfo {
            path: path.to_string_lossy().to_string(),
            bytes,
        })
        .collect())
}

/// Vérification d'intégrité (§32).
///
/// `PRAGMA integrity_check` relit toute la base et signale les pages
/// corrompues. C'est le seul moyen de découvrir une corruption AVANT qu'elle
/// n'empêche une vente ; l'interface le propose avant chaque restauration.
#[tauri::command]
pub async fn check_integrity(
    instances: tauri::State<'_, DbInstances>,
    db: String,
) -> Result<String, String> {
    let pools = instances.0.read().await;
    let pool = pools
        .get(&db)
        .ok_or_else(|| format!("base « {db} » inconnue"))?;
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = pool
    else {
        return Err("seule SQLite peut être vérifiée".into());
    };

    let row: (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(&*pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.0)
}

/// Restauration : la copie demandée devient la base ACTIVE au prochain
/// démarrage.
///
/// On ne remplace PAS le fichier ouvert — les connexions du pool le tiennent, et
/// écraser une base en cours d'utilisation la corromprait. La copie est déposée
/// à côté sous le nom `boutique.db.restore` ; au démarrage suivant, le front
/// constate sa présence et demande la permutation avant d'ouvrir la base.
/// L'ancienne base est conservée en `.remplacee`, jamais supprimée : une
/// restauration faite par erreur doit rester réversible.
#[tauri::command]
pub async fn restore_database<R: Runtime>(
    app: tauri::AppHandle<R>,
    source: String,
) -> Result<String, String> {
    let source_path = Path::new(&source);
    if !source_path.is_file() {
        return Err(format!("fichier de sauvegarde introuvable : {source}"));
    }

    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("dossier de configuration introuvable : {error}"))?;
    let staged = config.join("boutique.db.restore");
    std::fs::copy(source_path, &staged)
        .map_err(|error| format!("copie impossible : {error}"))?;

    Ok(staged.to_string_lossy().to_string())
}

/// Ne conserve que les `keep` copies les plus récentes : sans purge, un poste
/// de boutique finirait par saturer son disque — exactement la panne que la
/// sauvegarde devait éviter.
fn prune(dir: &PathBuf, keep: usize) -> Result<(), String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "db"))
        .collect();

    files.sort();
    while files.len() > keep {
        if let Some(oldest) = files.first().cloned() {
            let _ = std::fs::remove_file(&oldest);
            files.remove(0);
        }
    }
    Ok(())
}
