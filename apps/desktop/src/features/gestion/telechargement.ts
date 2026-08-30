import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/core/db/client';

/**
 * Enregistrement d'un export sur le disque.
 *
 * Le chemin est CHOISI par l'utilisateur dans la boîte de dialogue du système ;
 * c'est ce choix explicite qui tient lieu d'autorisation, la portée fixe du
 * plugin `fs` ne pouvant pas connaître à l'avance le dossier voulu.
 *
 * Hors Tauri (développement dans un navigateur), on retombe sur un lien de
 * téléchargement : l'écran reste utilisable sans lancer l'application complète.
 */
export async function telecharger(nomFichier: string, contenu: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    const lien = document.createElement('a');
    const blob = new Blob([contenu], { type: 'text/csv;charset=utf-8' });
    lien.href = URL.createObjectURL(blob);
    lien.download = nomFichier;
    lien.click();
    URL.revokeObjectURL(lien.href);
    return nomFichier;
  }

  const chemin = await save({
    defaultPath: nomFichier,
    filters: [{ name: 'Fichier CSV', extensions: ['csv'] }],
  });
  if (!chemin) return null;

  const octets = Array.from(new TextEncoder().encode(contenu));
  await invoke('write_export', { path: chemin, contents: octets });
  return chemin;
}
