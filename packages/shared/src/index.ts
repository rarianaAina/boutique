/**
 * Point d'entrée du paquet partagé.
 *
 * Il est consommé par l'application de bureau ET par le serveur de
 * synchronisation : tout ce qui est exporté ici doit donc rester exempt de
 * dépendance à Tauri, au DOM et à Node.
 */

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
