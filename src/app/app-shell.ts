import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';
import { AuthService, StaffProfile } from './core/auth/auth.service';
import { ThemeService } from './core/theme/theme.service';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-shell',
  styleUrl: './app.scss',
  templateUrl: './app-shell.html',
})
export class AppShell implements OnInit {
  private readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly supabaseConfigured = Boolean(environment.supabaseAnonKey);
  protected readonly profile = signal<StaffProfile | null>(null);
  private readonly navigation = [
    { label: 'Resumen', path: '/dashboard', adminOnly: false },
    { label: 'Pedidos', path: '/pedidos', adminOnly: false },
    { label: 'Ventas', path: '/ventas', adminOnly: false },
    { label: 'Menú', path: '/productos', adminOnly: true },
    { label: 'Mesas', path: '/mesas', adminOnly: true },
    { label: 'Inventario', path: '/inventario', adminOnly: true },
    { label: 'Personal', path: '/personal', adminOnly: true },
  ];
  protected readonly visibleNavigation = computed(() =>
    this.navigation.filter((item) => !item.adminOnly || this.profile()?.role === 'admin'),
  );
  protected readonly displayName = computed(() => this.profile()?.full_name || this.profile()?.email || 'Personal');
  protected readonly displayRole = computed(() => this.profile()?.role ?? '');
  protected readonly userInitials = computed(() =>
    this.displayName().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
  );

  ngOnInit(): void {
    void this.loadProfile();
  }

  private async loadProfile(): Promise<void> {
    try {
      this.profile.set(await this.auth.getActiveStaffProfile());
    } catch {
      this.profile.set(null);
    }
  }
}