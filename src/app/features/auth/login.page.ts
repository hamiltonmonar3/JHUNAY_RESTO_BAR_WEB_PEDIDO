import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  imports: [FormsModule],
  selector: 'app-login-page',
  styleUrl: './login.page.scss',
  templateUrl: './login.page.html',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);
  protected readonly pending = signal(false);
  protected readonly errorMessage = signal('');
  protected username = '';
  protected pin = '';

  protected get setupMessage(): string {
    if (this.route.snapshot.queryParamMap.get('setup') === 'migration') {
      return 'Ejecuta la migración de seguridad en Supabase y vincula tu cuenta Auth con un usuario activo.';
    }
    if (this.route.snapshot.queryParamMap.get('setup') === 'staff') {
      return 'La cuenta autenticada no está vinculada a un usuario activo del restaurante.';
    }
    return '';
  }

  protected async submit(): Promise<void> {
    this.pending.set(true);
    this.errorMessage.set('');

    try {
      const profile = await this.auth.signIn(this.username.trim(), this.pin);
      const requestedUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      const returnUrl = requestedUrl?.startsWith('/') && !requestedUrl.startsWith('//') ? requestedUrl : null;
      await this.router.navigateByUrl(returnUrl ?? (profile.role === 'mesero' ? '/pedidos' : '/ventas'));
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo iniciar sesión.');
    } finally {
      this.pending.set(false);
    }
  }
}