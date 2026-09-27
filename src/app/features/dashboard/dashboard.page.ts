import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, StaffProfile } from '../../core/auth/auth.service';
import { SupabaseService } from '../../core/supabase/supabase.service';
import { OrdersService, OrderStatus, OrderSummary } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { SalesService } from '../sales/sales.service';
import { TablesService } from '../tables/tables.service';

type DatabaseStatus = 'not-configured' | 'checking' | 'connected' | 'error';

@Component({
  imports: [RouterLink],
  selector: 'app-dashboard-page',
  styleUrl: './dashboard.page.scss',
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  protected readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly products = inject(ProductsService);
  private readonly orders = inject(OrdersService);
  private readonly sales = inject(SalesService);
  private readonly tables = inject(TablesService);
  protected readonly profile = signal<StaffProfile | null>(null);
  protected readonly databaseStatus = signal<DatabaseStatus>(
    this.supabase.isConfigured ? 'checking' : 'not-configured',
  );
  protected readonly availableProductCount = signal<number | null>(null);
  protected readonly activeOrderCount = signal<number | null>(null);
  protected readonly todaySalesTotal = signal<number | null>(null);
  protected readonly todaySalesCount = signal<number | null>(null);
  protected readonly occupiedTableCount = signal<number | null>(null);
  protected readonly recentOrders = signal<OrderSummary[]>([]);
  protected readonly databaseError = signal('');
  protected readonly today = new Intl.DateTimeFormat('es-EC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  ngOnInit(): void {
    if (this.supabase.isConfigured) void this.loadDashboard();
  }

  protected formatCurrency(value: number): string {
    return new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value);
  }

  protected orderStatusLabel(status: OrderStatus): string {
    const labels: Record<OrderStatus, string> = {
      armado: 'Armado',
      en_preparacion: 'En cocina',
      servido: 'Servido',
      pagado: 'Pagado',
      cancelado: 'Cancelado',
    };
    return labels[status];
  }

  protected orderLocation(order: OrderSummary): string {
    const relation = Array.isArray(order.restaurant_tables) ? order.restaurant_tables[0] : order.restaurant_tables;
    return relation ? `Mesa ${relation.table_number}` : order.customer_name || 'Para llevar';
  }

  private async loadDashboard(): Promise<void> {
    try {
      const profile = await this.auth.getActiveStaffProfile();
      this.profile.set(profile);
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const [products, activeOrders, recentOrders, sales, tables] = await Promise.all([
        this.products.listAvailable(),
        this.orders.countActive(),
        this.orders.listRecent(),
        this.sales.listPaidOrders(start, end),
        this.tables.listAll(),
      ]);
      this.availableProductCount.set(products.length);
      this.activeOrderCount.set(activeOrders);
      this.recentOrders.set(recentOrders.slice(0, 5));
      this.todaySalesTotal.set(sales.reduce((total, sale) => total + sale.total_amount, 0));
      this.todaySalesCount.set(sales.length);
      this.occupiedTableCount.set(tables.filter((table) => table.status === 'ocupada').length);
      this.databaseStatus.set('connected');
    } catch (error) {
      this.databaseError.set(error instanceof Error ? error.message : 'No se pudo consultar products.');
      this.databaseStatus.set('error');
    }
  }
}