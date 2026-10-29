import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';
import { AuthService, StaffProfile } from './core/auth/auth.service';
import { ThemeService } from './core/theme/theme.service';
import { OrdersService } from './features/orders/orders.service';
import { ReservationsService } from './features/reservations/reservations.service';
import { SalesService } from './features/sales/sales.service';
import { TablesService } from './features/tables/tables.service';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-shell',
  styleUrl: './app.scss',
  templateUrl: './app-shell.html',
})
export class AppShell implements OnDestroy, OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly ordersService = inject(OrdersService);
  private readonly reservationsService = inject(ReservationsService);
  private readonly salesService = inject(SalesService);
  private readonly tablesService = inject(TablesService);
  protected readonly theme = inject(ThemeService);
  protected readonly supabaseConfigured = Boolean(environment.supabaseAnonKey);
  protected readonly profile = signal<StaffProfile | null>(null);
  protected readonly todayOrderCount = signal<number | null>(null);
  protected readonly todaySalesCount = signal<number | null>(null);
  protected readonly todayReservationCount = signal<number | null>(null);
  protected readonly freeTableCount = signal<number | null>(null);
  protected readonly navigationCountError = signal(false);
  protected readonly logoutError = signal('');
  protected readonly signingOut = signal(false);
  protected readonly homePath = computed(() =>
    this.profile()?.role === 'Operador' ? '/pedidos' : '/dashboard',
  );
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly navigation = [
    { label: 'Resumen', path: '/dashboard', adminOnly: false },
    { label: 'Pedidos', path: '/pedidos', adminOnly: false },
    { label: 'Ventas', path: '/ventas', adminOnly: false },
    { label: 'Menú', path: '/productos', adminOnly: true },
    { label: 'Mesas', path: '/mesas', adminOnly: true },
    { label: 'Inventario', path: '/inventario', adminOnly: true },
    { label: 'Usuarios', path: '/usuarios', adminOnly: true },
    { label: 'Personal', path: '/personal', adminOnly: true },
  ];
  protected readonly visibleNavigation = computed(() =>
    this.navigation.filter((item) => this.profile()?.role === 'Administrador'
      || (this.profile()?.role === 'Auditor' ? ['Resumen', 'Personal'].includes(item.label) : !item.adminOnly)),
  );
  protected readonly displayName = computed(() => this.profile()?.full_name || this.profile()?.email || 'Personal');
  protected readonly displayRole = computed(() => this.profile()?.role ?? '');
  protected readonly userInitials = computed(() =>
    this.displayName().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
  );

  ngOnInit(): void {
    void this.loadProfile();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  protected async signOut(): Promise<void> {
    if (this.signingOut()) return;

    this.signingOut.set(true);
    this.logoutError.set('');
    try {
      await this.auth.signOut();
      await this.router.navigateByUrl('/login');
    } catch (error) {
      this.logoutError.set('No se pudo cerrar la sesión. Inténtalo de nuevo.');
      console.error('No se pudo cerrar la sesión.', error);
    } finally {
      this.signingOut.set(false);
    }
  }

  private async loadProfile(): Promise<void> {
    try {
      this.profile.set(await this.auth.getActiveStaffProfile());
      if (this.profile()?.role !== 'Auditor') {
        void this.refreshNavigationCounts();
        this.refreshTimer = setInterval(() => void this.refreshNavigationCounts(), 30_000);
      }
    } catch {
      this.profile.set(null);
    }
  }

  private async refreshNavigationCounts(): Promise<void> {
    if (this.profile()?.role === 'Auditor') {
      this.todayOrderCount.set(null);
      this.todaySalesCount.set(null);
      this.todayReservationCount.set(null);
      this.freeTableCount.set(null);
      return;
    }
    try {
      const [todayOrders, todaySales, todayReservations, freeTables] = await Promise.all([
        this.ordersService.countToday(),
        this.salesService.countPaidToday(),
        this.reservationsService.countToday(),
        this.tablesService.countFree(),
      ]);
      this.todayOrderCount.set(todayOrders);
      this.todaySalesCount.set(todaySales);
      this.todayReservationCount.set(todayReservations);
      this.freeTableCount.set(freeTables);
      this.navigationCountError.set(false);
    } catch (error) {
      this.todayOrderCount.set(null);
      this.todaySalesCount.set(null);
      this.todayReservationCount.set(null);
      this.freeTableCount.set(null);
      this.navigationCountError.set(true);
      console.error('No se pudieron actualizar los contadores de navegación desde Supabase.', error);
    }
  }
}