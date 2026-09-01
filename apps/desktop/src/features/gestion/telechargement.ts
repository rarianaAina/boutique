import { open, save } from '@tauri-apps/plugin-dialog';
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
export async function telecharger(
  nomFichier: string,
  contenu: string,
  type: 'csv' | 'json' = 'csv',
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const lien = document.createElement('a');
    const blob = new Blob([contenu], {
      type: type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
    });
    lien.href = URL.createObjectURL(blob);
    lien.download = nomFichier;
    lien.click();
    URL.revokeObjectURL(lien.href);
    return nomFichier;
  }

  const chemin = await save({
    defaultPath: nomFichier,
    filters:
      type === 'json'
        ? [{ name: 'Archive de boutique', extensions: ['json'] }]
        : [{ name: 'Fichier CSV', extensions: ['csv'] }],
  });
  if (!chemin) return null;

  const octets = Array.from(new TextEncoder().encode(contenu));
  await invoke('write_export', { path: chemin, contents: octets });
  return chemin;
}

/**
 * Ouvre un fichier choisi par l'utilisateur et rend son contenu.
 *
 * Le choix explicite dans la boîte de dialogue du système tient lieu
 * d'autorisation, comme pour l'enregistrement. Hors Tauri, on retombe sur un
 * champ de fichier invisible : l'écran reste utilisable en développement.
 */
export async function lireFichier(extensions: string[], libelle: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return new Promise((resoudre) => {
      const champ = document.createElement('input');
      champ.type = 'file';
      champ.accept = extensions.map((extension) => `.${extension}`).join(',');
      champ.onchange = () => {
        const fichier = champ.files?.[0];
        if (!fichier) return resoudre(null);
        void fichier.text().then(resoudre);
      };
      champ.click();
    });
  }

  const chemin = await open({ multiple: false, filters: [{ name: libelle, extensions }] });
  if (typeof chemin !== 'string') return null;
  const octets = await invoke<number[]>('read_import', { path: chemin });
  return new TextDecoder().decode(new Uint8Array(octets));
}
