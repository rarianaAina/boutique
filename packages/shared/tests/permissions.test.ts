import { describe, expect, it } from 'vitest';
import {
  ACTION_PERMISSIONS,
  ALL_PAGE_PERMISSIONS,
  ALL_PERMISSIONS,
  PAGE_GROUPS,
  PAGE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  PermissionDeniedError,
  ROLE_PRESETS,
  can,
  requirePermission,
  type Principal,
} from '../src';

const seller: Principal = {
  userId: 'u1',
  shopId: 's1',
  roleCode: 'SELLER',
  permissions: ROLE_PRESETS.find((role) => role.code === 'SELLER')?.permissions ?? [],
};

describe('permissions', () => {
  it('un vendeur encaisse mais ne voit pas les coûts', () => {
    expect(can(seller, PERMISSIONS.saleCreate)).toBe(true);
    expect(can(seller, PERMISSIONS.costView)).toBe(false);
  });

  it('refuse tout à une session absente', () => {
    expect(can(null, PERMISSIONS.productView)).toBe(false);
  });

  it('lève une erreur nommée quand la permission manque', () => {
    expect(() => requirePermission(seller, PERMISSIONS.userManage)).toThrow(PermissionDeniedError);
  });

  it("l'administrateur a tout", () => {
    const admin = ROLE_PRESETS.find((role) => role.code === 'ADMIN');
    expect(admin?.permissions).toHaveLength(ALL_PERMISSIONS.length);
  });

  it('chaque permission est libellée', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(PERMISSION_LABELS[permission], permission).toBeTruthy();
    }
  });

  it("chaque permission d'ACTION est rangée dans un groupe", () => {
    const grouped = new Set(PERMISSION_GROUPS.flatMap((group) => group.permissions));
    for (const permission of ACTION_PERMISSIONS) {
      expect(grouped.has(permission), permission).toBe(true);
    }
  });

  it('chaque page est rangée dans un groupe de pages', () => {
    const grouped = new Set(PAGE_GROUPS.flatMap((group) => group.pages));
    for (const page of ALL_PAGE_PERMISSIONS) {
      expect(grouped.has(page), page).toBe(true);
    }
  });

  it("l'accès à une page et le droit d'agir sont deux choses distinctes", () => {
    // Un comptable ouvre la page des achats sans pouvoir réceptionner : c'est
    // exactement ce qu'une permission unique par domaine rendrait impossible.
    const comptable = ROLE_PRESETS.find((role) => role.code === 'ACCOUNTANT');
    const principal = {
      userId: 'u',
      shopId: 's',
      roleCode: 'ACCOUNTANT',
      permissions: comptable?.permissions ?? [],
    };
    expect(can(principal, PAGE_PERMISSIONS.achats)).toBe(true);
    expect(can(principal, PERMISSIONS.purchaseReceive)).toBe(false);
  });

  it("un vendeur n'atteint ni les utilisateurs ni les paramètres", () => {
    const principal = { ...seller };
    expect(can(principal, PAGE_PERMISSIONS.utilisateurs)).toBe(false);
    expect(can(principal, PAGE_PERMISSIONS.parametres)).toBe(false);
    expect(can(principal, PAGE_PERMISSIONS.caisse)).toBe(true);
  });

  it('un gérant pilote sa boutique sans toucher au réseau ni aux comptes', () => {
    const gerant = ROLE_PRESETS.find((role) => role.code === 'MANAGER');
    const principal = {
      userId: 'u',
      shopId: 's',
      roleCode: 'MANAGER',
      permissions: gerant?.permissions ?? [],
    };
    expect(can(principal, PAGE_PERMISSIONS.transferts)).toBe(true);
    expect(can(principal, PAGE_PERMISSIONS.boutiques)).toBe(false);
    expect(can(principal, PAGE_PERMISSIONS.utilisateurs)).toBe(false);
  });
});
