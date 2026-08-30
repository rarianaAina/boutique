/**
 * Point d'entrée du paquet partagé.
 *
 * Il est consommé par l'application de bureau ET par le serveur de
 * synchronisation : tout ce qui est exporté ici doit donc rester exempt de
 * dépendance à Tauri, au DOM et à Node.
 */

/**
 * Les licences viennent du dépôt commun à tous les logiciels de l'éditeur.
 *
 * Réexportées ici pour que l'application n'ait qu'un seul paquet à connaître,
 * et pour que le descripteur de la boutique voyage avec le reste du domaine.
 */
export * from '@licence/noyau';

export * from './enums';
export * from './ids';
export * from './money';
export * from './numbering';
export * from './permissions';
export * from './sku';
export * from './sync/protocol';
export * from './text';
export * from './time';
export * from './types';
export * from './validation/imei';
export * from './validation/result';
