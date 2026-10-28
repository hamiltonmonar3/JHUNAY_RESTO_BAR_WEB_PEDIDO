import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const staffGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  try {
    const session = await auth.getSession();
    if (!session) {
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }

    const profile = await auth.getActiveStaffProfile();
    if (profile) return true;

    // NO llamamos a auth.signOut() aquí para evitar destruir la sesión por un falso positivo
    return router.createUrlTree(['/login'], { queryParams: { setup: 'staff' } });
  } catch {
    return router.createUrlTree(['/login'], { queryParams: { setup: 'migration' } });
  }
};

export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  try {
    const profile = await auth.getActiveStaffProfile();
    return profile?.role === 'Administrador' ? true : router.parseUrl('/dashboard');
  } catch {
    return router.parseUrl('/dashboard');
  }
};

export const adminOrOperatorGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  try {
    const profile = await auth.getActiveStaffProfile();
    return profile?.role === 'Administrador' || profile?.role === 'Operador'
      ? true
      : router.parseUrl('/dashboard');
  } catch {
    return router.parseUrl('/dashboard');
  }
};

export const adminOrAuditorGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  try {
    const profile = await auth.getActiveStaffProfile();
    return profile?.role === 'Administrador' || profile?.role === 'Auditor'
      ? true
      : router.parseUrl('/dashboard');
  } catch {
    return router.parseUrl('/dashboard');
  }
};

export const nonAuditorGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  try {
    const profile = await auth.getActiveStaffProfile();
    return profile?.role === 'Auditor' ? router.parseUrl('/dashboard') : true;
  } catch {
    return router.parseUrl('/dashboard');
  }
};
