import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, StaffProfile } from '../../core/auth/auth.service';
import { SupabaseService } from '../../core/supabase/supabase.service';
import {
  OrdersService,
  OrderStatus,
  OrderSummary,
  ProductSalesSummary,
} from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { ExpenseRecord, SaleRecord, SalesService, SplitTenderSale } from '../sales/sales.service';
import { TablesService } from '../tables/tables.service';
import { TablePaginationComponent, TablePaginationState } from '../../shared/table-pagination';
import { roundCurrencyForDisplay } from '../../shared/currency';

type DatabaseStatus = 'not-configured' | 'checking' | 'connected' | 'error';
type DashboardPeriod = 'day' | 'week' | 'month' | 'custom';
type DashboardPaymentMethod = 'efectivo' | 'transferencia';

interface DateRange {
  start: Date;
  end: Date;
}

interface ChartBucket {
  key: string;
  label: string;
  sales: number;
  expenses: number;
}

interface ChartPoint extends ChartBucket {
  x: number;
  salesY: number;
  expensesY: number;
  showLabel: boolean;
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateValue(date) === value ? date : null;
}

function firstRelation<T>(relation: T | T[] | null | undefined): T | null {
  return Array.isArray(relation) ? (relation[0] ?? null) : (relation ?? null);
}

function isDashboardPaymentMethod(method: string | null): method is DashboardPaymentMethod {
  return method === 'efectivo' || method === 'transferencia';
}

@Component({
  imports: [RouterLink, TablePaginationComponent],
  selector: 'app-dashboard-page',
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  protected readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly products = inject(ProductsService);
  private readonly orders = inject(OrdersService);
  private readonly sales = inject(SalesService);
  private readonly tables = inject(TablesService);
  private periodRequestId = 0;
  private readonly currency = new Intl.NumberFormat('es-EC', {
    style: 'currency',
    currency: 'USD',
  });
  private readonly compactDate = new Intl.DateTimeFormat('es-EC', {
    day: '2-digit',
    month: 'short',
  });
  private readonly shortWeekday = new Intl.DateTimeFormat('es-EC', { weekday: 'short' });
  private readonly orderDateTime = new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  protected readonly profile = signal<StaffProfile | null>(null);
  protected readonly databaseStatus = signal<DatabaseStatus>(
    this.supabase.isConfigured ? 'checking' : 'not-configured',
  );
  protected readonly availableProductCount = signal<number | null>(null);
  protected readonly activeOrderCount = signal<number | null>(null);
  protected readonly occupiedTableCount = signal<number | null>(null);
  protected readonly recentOrders = signal<OrderSummary[]>([]);
  protected readonly paidOrders = signal<SaleRecord[]>([]);
  protected readonly paidOrdersPagination = new TablePaginationState();
  protected readonly expenses = signal<ExpenseRecord[]>([]);
  protected readonly splitTenders = signal<SplitTenderSale[]>([]);
  protected readonly topProducts = signal<ProductSalesSummary[]>([]);
  protected readonly databaseError = signal('');
  protected readonly periodError = signal('');
  protected readonly loadingPeriod = signal(false);
  protected readonly selectedPeriod = signal<DashboardPeriod>('month');
  protected readonly customStart = signal(
    localDateValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  );
  protected readonly customEnd = signal(localDateValue(new Date()));
  protected readonly periodRange = signal<DateRange>(this.defaultRange('month'));
  protected readonly today = new Intl.DateTimeFormat('es-EC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  protected readonly totalSales = computed(() =>
    this.paidOrders().reduce((total, sale) => total + sale.total_amount, 0),
  );
  protected readonly totalExpenses = computed(() =>
    this.expenses().reduce((total, expense) => total + expense.amount, 0),
  );
  protected readonly netBalance = computed(() => this.totalSales() - this.totalExpenses());
  protected readonly averageTicket = computed(() =>
    this.paidOrders().length ? this.totalSales() / this.paidOrders().length : 0,
  );
  protected readonly profitMargin = computed(() =>
    this.totalSales() ? (this.netBalance() / this.totalSales()) * 100 : 0,
  );
  protected readonly paymentBreakdown = computed(() => {
    const groups = new Map<DashboardPaymentMethod, { orderIds: Set<number>; total: number }>();
    for (const sale of this.paidOrders()) {
      if (!isDashboardPaymentMethod(sale.payment_method)) continue;
      const method = sale.payment_method;
      const group = groups.get(method) ?? { orderIds: new Set<number>(), total: 0 };
      group.orderIds.add(sale.id);
      group.total += sale.total_amount;
      groups.set(method, group);
    }
    for (const tender of this.splitTenders()) {
      if (!isDashboardPaymentMethod(tender.payment_method)) continue;
      const group = groups.get(tender.payment_method) ?? { orderIds: new Set<number>(), total: 0 };
      group.orderIds.add(tender.order_id);
      group.total += tender.amount;
      groups.set(tender.payment_method, group);
    }

    return [...groups.entries()]
      .map(([method, values]) => ({
        method,
        count: values.orderIds.size,
        total: values.total,
        percent: this.totalSales() ? (values.total / this.totalSales()) * 100 : 0,
      }))
      .sort((first, second) => second.total - first.total);
  });
  protected readonly chartBuckets = computed(() => this.buildChartBuckets());
  protected readonly chartPoints = computed<ChartPoint[]>(() => {
    const buckets = this.chartBuckets();
    const maxValue = Math.max(1, ...buckets.flatMap((bucket) => [bucket.sales, bucket.expenses]));
    const labelInterval = Math.max(1, Math.ceil(buckets.length / 8));
    return buckets.map((bucket, index) => ({
      ...bucket,
      x: buckets.length === 1 ? 500 : 42 + (index / (buckets.length - 1)) * 916,
      salesY: 218 - (bucket.sales / maxValue) * 178,
      expensesY: 218 - (bucket.expenses / maxValue) * 178,
      showLabel: index % labelInterval === 0 || index === buckets.length - 1,
    }));
  });
  protected readonly salesPath = computed(() =>
    this.chartPoints()
      .map((point) => `${point.x},${point.salesY}`)
      .join(' '),
  );
  protected readonly expensesPath = computed(() =>
    this.chartPoints()
      .map((point) => `${point.x},${point.expensesY}`)
      .join(' '),
  );
  protected readonly salesAreaPath = computed(() => {
    const points = this.chartPoints();
    if (!points.length) return '';
    return `M ${points[0].x},218 L ${points.map((point) => `${point.x},${point.salesY}`).join(' L ')} L ${points[points.length - 1].x},218 Z`;
  });
  protected readonly chartMaximum = computed(() =>
    Math.max(1, ...this.chartBuckets().flatMap((bucket) => [bucket.sales, bucket.expenses])),
  );
  protected readonly periodLabel = computed(() => {
    const range = this.periodRange();
    if (this.selectedPeriod() === 'day') return this.compactDate.format(range.start);
    const lastDay = new Date(range.end);
    lastDay.setDate(lastDay.getDate() - 1);
    return `${this.compactDate.format(range.start)} – ${this.compactDate.format(lastDay)}`;
  });

  ngOnInit(): void {
    if (this.supabase.isConfigured) void this.loadDashboard();
  }

  protected formatCurrency(value: number): string {
    return this.currency.format(roundCurrencyForDisplay(value));
  }

  protected formatPercent(value: number): string {
    return `${new Intl.NumberFormat('es-EC', { maximumFractionDigits: 1 }).format(value)}%`;
  }

  protected formatDate(value: string): string {
    return this.orderDateTime.format(new Date(value));
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

  protected paymentMethodLabel(method: DashboardPaymentMethod): string {
    const labels: Record<DashboardPaymentMethod, string> = {
      efectivo: 'Efectivo',
      transferencia: 'Transferencia / Deuna',
    };
    return labels[method];
  }

  protected orderLocation(order: OrderSummary | SaleRecord): string {
    const relation = firstRelation(order.restaurant_tables);
    return relation
      ? `Mesa ${relation.table_number}`
      : ('customer_name' in order ? order.customer_name : null) || 'Para llevar';
  }

  protected orderWaiter(order: SaleRecord): string {
    return firstRelation(order.users)?.full_name || 'No registrado';
  }

  protected selectPeriod(period: DashboardPeriod): void {
    this.selectedPeriod.set(period);
    if (period === 'custom') {
      this.customStart.set(
        localDateValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
      );
      this.customEnd.set(localDateValue(new Date()));
    }
    void this.loadPeriodData();
  }

  protected updateCustomDate(which: 'start' | 'end', event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (which === 'start') this.customStart.set(target.value);
    else this.customEnd.set(target.value);
    this.selectedPeriod.set('custom');
    void this.loadPeriodData();
  }

  protected async refresh(): Promise<void> {
    await this.loadDashboard();
  }

  private defaultRange(period: DashboardPeriod): DateRange {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (period === 'day')
      start.setTime(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime());
    return { start, end };
  }

  private getSelectedRange(): DateRange | null {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (this.selectedPeriod()) {
      case 'day':
        return {
          start: today,
          end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
        };
      case 'week': {
        const start = new Date(today);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        return { start, end };
      }
      case 'month':
        return {
          start: new Date(today.getFullYear(), today.getMonth(), 1),
          end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
        };
      case 'custom': {
        const start = dateFromValue(this.customStart());
        const lastDay = dateFromValue(this.customEnd());
        if (!start || !lastDay) {
          this.periodError.set('Selecciona fechas válidas para consultar el período.');
          return null;
        }
        if (start > lastDay) {
          this.periodError.set('La fecha inicial no puede ser posterior a la fecha final.');
          return null;
        }
        const end = new Date(lastDay);
        end.setDate(end.getDate() + 1);
        return { start, end };
      }
    }
  }

  private async loadDashboard(): Promise<void> {
    try {
      const profile = await this.auth.getActiveStaffProfile();
      this.profile.set(profile);
      if (profile?.role === 'Auditor') {
        await this.loadPeriodData();
        return;
      }
      const [products, activeOrders, recentOrders, tables] = await Promise.all([
        this.products.listAvailable(),
        this.orders.countActive(),
        this.orders.listRecent(),
        this.tables.listAll(),
      ]);
      this.availableProductCount.set(products.length);
      this.activeOrderCount.set(activeOrders);
      this.recentOrders.set(recentOrders.slice(0, 5));
      this.occupiedTableCount.set(tables.filter((table) => table.status === 'ocupada').length);
      await this.loadPeriodData();
    } catch (error) {
      this.databaseError.set(
        error instanceof Error ? error.message : 'No se pudo consultar el resumen.',
      );
      this.databaseStatus.set('error');
    }
  }

  private async loadPeriodData(): Promise<void> {
    const requestId = ++this.periodRequestId;
    const range = this.getSelectedRange();
    if (!range) {
      this.paidOrders.set([]);
      this.expenses.set([]);
      this.splitTenders.set([]);
      this.topProducts.set([]);
      this.loadingPeriod.set(false);
      return;
    }
    this.periodRange.set(range);
    this.periodError.set('');
    this.loadingPeriod.set(true);
    this.databaseError.set('');
    this.paidOrders.set([]);
    this.expenses.set([]);
    this.splitTenders.set([]);
    this.topProducts.set([]);
    if (this.supabase.isConfigured) this.databaseStatus.set('checking');

    try {
      const start = range.start.toISOString();
      const end = range.end.toISOString();
      const expensePeriods: ExpenseRecord['expense_period'][] =
        this.selectedPeriod() === 'day'
          ? ['day']
          : this.selectedPeriod() === 'week'
            ? ['day', 'week']
            : ['day', 'week', 'month'];
      const [paidOrders, expenses, splitTenders, topProducts] = await Promise.all([
        this.sales.listPaidOrders(start, end),
        this.sales.listExpenses(start, end, expensePeriods),
        this.sales.listSplitPaymentTenders(start, end),
        this.orders.listTopProducts(start, end),
      ]);
      if (requestId !== this.periodRequestId) return;
      this.paidOrders.set(paidOrders);
      this.expenses.set(expenses);
      this.splitTenders.set(splitTenders);
      this.topProducts.set(topProducts);
      this.databaseStatus.set('connected');
    } catch (error) {
      if (requestId !== this.periodRequestId) return;
      this.databaseError.set(
        error instanceof Error
          ? error.message
          : 'No se pudo consultar ventas, egresos y productos.',
      );
      this.databaseStatus.set('error');
    } finally {
      if (requestId === this.periodRequestId) this.loadingPeriod.set(false);
    }
  }

  private buildChartBuckets(): ChartBucket[] {
    const { start, end } = this.periodRange();
    const isDay = this.selectedPeriod() === 'day';
    const salesByBucket = new Map<string, number>();
    const expensesByBucket = new Map<string, number>();
    const bucketKey = (date: Date): string =>
      isDay
        ? `${localDateValue(date)}T${String(date.getHours()).padStart(2, '0')}`
        : localDateValue(date);

    for (const sale of this.paidOrders()) {
      const date = new Date(sale.paid_at);
      const key = bucketKey(date);
      salesByBucket.set(key, (salesByBucket.get(key) ?? 0) + sale.total_amount);
    }
    for (const expense of this.expenses()) {
      const date = new Date(expense.created_at);
      const key = bucketKey(date);
      expensesByBucket.set(key, (expensesByBucket.get(key) ?? 0) + expense.amount);
    }

    const buckets: ChartBucket[] = [];
    if (isDay) {
      for (let hour = 0; hour < 24; hour++) {
        const key = `${localDateValue(start)}T${String(hour).padStart(2, '0')}`;
        buckets.push({
          key,
          label: `${String(hour).padStart(2, '0')}:00`,
          sales: salesByBucket.get(key) ?? 0,
          expenses: expensesByBucket.get(key) ?? 0,
        });
      }
      return buckets;
    }

    for (const date = new Date(start); date < end; date.setDate(date.getDate() + 1)) {
      const key = localDateValue(date);
      const label =
        this.selectedPeriod() === 'week'
          ? this.shortWeekday.format(date).replace('.', '')
          : this.compactDate.format(date).replace('.', '');
      buckets.push({
        key,
        label,
        sales: salesByBucket.get(key) ?? 0,
        expenses: expensesByBucket.get(key) ?? 0,
      });
    }
    return buckets;
  }
}
