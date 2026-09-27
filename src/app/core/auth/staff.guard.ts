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

    if (await auth.getActiveStaffProfile()) return true;
    await auth.signOut();
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
    return profile?.role === 'admin' ? true : router.parseUrl('/dashboard');
  } catch {
    return router.parseUrl('/dashboard');
  }
};