/**
 * Validation.
 *
 * Les mêmes règles servent à l'interface (message sous le champ) et à la couche
 * métier (refus de l'écriture) : le cahier des charges exige les deux (§28), et
 * les dupliquer garantirait qu'elles finissent par diverger.
 */

export interface FieldIssue {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'ValidationError';
  }
}

/** Accumulateur d'anomalies, pour signaler TOUS les problèmes d'un coup. */
export class Validator {
  private readonly issues: FieldIssue[] = [];

  add(field: string, message: string): this {
    this.issues.push({ field, message });
    return this;
  }

  check(condition: boolean, field: string, message: string): this {
    if (!condition) this.add(field, message);
    return this;
  }

  required(value: unknown, field: string, label: string): this {
    const empty =
      value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    return this.check(!empty, field, `${label} est obligatoire.`);
  }

  positive(value: number, field: string, label: string): this {
    return this.check(Number.isFinite(value) && value > 0, field, `${label} doit être positif.`);
  }

  notNegative(value: number, field: string, label: string): this {
    return this.check(
      Number.isFinite(value) && value >= 0,
      field,
      `${label} ne peut pas être négatif.`,
    );
  }

  maxLength(value: string | null | undefined, max: number, field: string, label: string): this {
    return this.check(
      (value ?? '').length <= max,
      field,
      `${label} ne peut pas dépasser ${max} caractères.`,
    );
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  list(): FieldIssue[] {
    return [...this.issues];
  }

  /** Lève si au moins une anomalie a été relevée. */
  throwIfInvalid(): void {
    if (this.issues.length > 0) throw new ValidationError(this.list());
  }
}

/** Adresse électronique : contrôle volontairement permissif. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Téléphone : chiffres, espaces et quelques signes. Les formats varient trop. */
export function isPhone(value: string): boolean {
  const cleaned = value.replace(/[\s.\-()]/g, '');
  return /^\+?\d{6,20}$/.test(cleaned);
}
