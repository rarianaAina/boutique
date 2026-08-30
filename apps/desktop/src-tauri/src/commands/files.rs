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
