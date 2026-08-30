import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
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

  it('chaque permission est libellée et rangée dans un groupe', () => {
    const grouped = new Set(PERMISSION_GROUPS.flatMap((group) => group.permissions));
    for (const permission of ALL_PERMISSIONS) {
      expect(PERMISSION_LABELS[permission], permission).toBeTruthy();
      expect(grouped.has(permission), permission).toBe(true);
    }
  });
});
