mod commands;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Migrations de la base locale.
///
/// Elles sont embarquées dans le binaire (`include_str!`) et appliquées par
/// tauri-plugin-sql à l'ouverture de la base, AVANT que le front n'y accède :
/// aucun écran ne peut donc tomber sur un schéma incomplet, et il n'y a rien à
/// déployer à côté de l'exécutable.
///
/// Règle : une migration publiée n'est JAMAIS modifiée — on en ajoute une.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "schéma initial : boutiques, catalogue, unités/IMEI, stock, achats, ventes, transferts, synchro",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "variantes de produit : couleur, capacité et regroupement par modèle",
            sql: include_str!("../migrations/0002_variantes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "historique des prix : décisions commerciales et cours constatés",
            sql: include_str!("../migrations/0003_historique_prix.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                // Chemin relatif : le plugin le résout dans le dossier de
                // CONFIGURATION de l'application (%APPDATA%\<identifier> sous
                // Windows, ~/.config/<identifier> sous Linux).
                .add_migrations("sqlite:boutique.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::db::execute_batch,
            commands::backup::backup_database,
            commands::backup::list_backups,
            commands::backup::restore_database,
            commands::backup::check_integrity,
            commands::files::write_export,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de l'application Tauri");
}
