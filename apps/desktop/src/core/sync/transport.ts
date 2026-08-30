import { SyncTransportError } from '@boutique/shared';
import type {
  ClaimRequest,
  ClaimResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
} from '@boutique/shared';

/**
 * Transport de la synchronisation.
 *
 * L'interface est séparée de son implémentation HTTP pour deux raisons : les
 * tests peuvent brancher le VRAI serveur en mémoire (et vérifier le
 * comportement réel de deux boutiques qui se synchronisent), et un autre
 * transport — un partage de fichiers, une clé USB entre deux boutiques sans
 * Internet — pourra être ajouté sans toucher au moteur.
 */
export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
  claim(request: ClaimRequest): Promise<ClaimResponse>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  /**
   * Délai maximal d'un appel.
   *
   * Court à dessein : la synchronisation est déclenchée à la main, souvent
   * avant de fermer la boutique. Attendre trente secondes sur une connexion
   * morte donne l'impression que le logiciel est planté.
   */
  timeoutMs?: number;
}

export class HttpSyncTransport implements SyncTransport {
  constructor(private readonly options: HttpTransportOptions) {}

  push(request: PushRequest): Promise<PushResponse> {
    return this.call<PushResponse>('/sync/push', request);
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.call<PullResponse>('/sync/pull', request);
  }

  claim(request: ClaimRequest): Promise<ClaimResponse> {
    return this.call<ClaimResponse>('/sync/claim', request);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new SyncTransportError(
          response.status === 401
            ? 'Le serveur a refusé le jeton de cette boutique. Vérifiez les paramètres de synchronisation.'
            : `Le serveur a répondu ${response.status}. ${detail.slice(0, 200)}`,
        );
      }
      return (await response.json()) as T;
    } catch (cause) {
      if (cause instanceof SyncTransportError) throw cause;
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new SyncTransportError(
        aborted
          ? 'Le serveur de synchronisation ne répond pas.'
          : 'Serveur injoignable : vérifiez la connexion Internet.',
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
