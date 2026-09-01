use std::io::Write;

/// Écriture d'un export sur le disque.
///
/// Le plugin `fs` sait déjà écrire, mais il impose une portée de chemins fixée
/// à la compilation. Un export part vers un dossier CHOISI par l'utilisateur
/// dans la boîte de dialogue système : le chemin n'est connu qu'à l'exécution,
/// et c'est ce choix explicite qui tient lieu d'autorisation.
#[tauri::command]
pub async fn write_export(path: String, contents: Vec<u8>) -> Result<u64, String> {
    let mut file = std::fs::File::create(&path)
        .map_err(|error| format!("écriture impossible dans {path} : {error}"))?;
    file.write_all(&contents)
        .map_err(|error| format!("écriture interrompue : {error}"))?;
    file.flush().map_err(|error| error.to_string())?;
    Ok(contents.len() as u64)
}

/// Lecture d'une archive choisie par l'utilisateur.
///
/// Le pendant de `write_export`, et pour la même raison : le fichier vit là où
/// son propriétaire l'a rangé — une clé USB, un dossier de téléchargements —
/// et la portée fixe du plugin `fs` ne peut pas le prévoir. Le choix explicite
/// dans la boîte de dialogue système tient lieu d'autorisation.
///
/// La taille est bornée : une archive de boutique se compte en dizaines de
/// mégaoctets, et charger un fichier de plusieurs gigaoctets par erreur
/// épuiserait la mémoire d'un poste modeste avant d'avoir pu refuser.
#[tauri::command]
pub async fn read_import(path: String) -> Result<Vec<u8>, String> {
    const TAILLE_MAX: u64 = 512 * 1024 * 1024;

    let taille = std::fs::metadata(&path)
        .map_err(|error| format!("lecture impossible de {path} : {error}"))?
        .len();
    if taille > TAILLE_MAX {
        return Err(format!(
            "Fichier de {} Mo : au-delà de {} Mo, ce n'est pas une archive de boutique.",
            taille / (1024 * 1024),
            TAILLE_MAX / (1024 * 1024)
        ));
    }

    std::fs::read(&path).map_err(|error| format!("lecture interrompue : {error}"))
}
