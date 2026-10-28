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
import { CashClosure, CashClosureIncomeEntry, ExpenseRecord, SaleRecord, SalesService, SplitTenderSale } from '../sales/sales.service';
import { TablesService } from '../tables/tables.service';
import { roundCurrencyForDisplay } from '../../shared/currency';

type DatabaseStatus = 'not-configured' | 'checking' | 'connected' | 'error';
type DashboardPeriod = 'day' | 'week' | 'month' | 'custom';
type DashboardPaymentMethod = 'efectivo' | 'transferencia';
type MonthlyComparisonBucket = ChartBucket;

interface DateRange {
  start: Date;
  end: Date;
}

interface ChartBucket {
  key: string;
  label: string;
  sales: number;
  expenses: number;
  net: number;
}

interface ChartPoint extends ChartBucket {
  x: number;
  salesY: number;
  expensesY: number;
  netY: number;
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
  imports: [RouterLink],
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
  private monthlyComparisonRequestId = 0;
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
  protected readonly recentPaidOrders = computed(() => this.paidOrders().slice(0, 20));
  protected readonly additionalIncome = signal<CashClosureIncomeEntry[]>([]);
  private readonly chartCashClosure = signal<CashClosure | null>(null);
  protected readonly expenses = signal<ExpenseRecord[]>([]);
  protected readonly splitTenders = signal<SplitTenderSale[]>([]);
  protected readonly topProducts = signal<ProductSalesSummary[]>([]);
  protected readonly databaseError = signal('');
  protected readonly periodError = signal('');
  protected readonly loadingPeriod = signal(false);
  protected readonly showIncomeSeries = signal(true);
  protected readonly showExpenseSeries = signal(true);
  protected readonly showNetSeries = signal(true);
  protected readonly monthlyMonthsBack = signal(6);
  protected readonly monthlyComparison = signal<MonthlyComparisonBucket[]>([]);
  protected readonly monthlyComparisonLoading = signal(false);
  protected readonly monthlyComparisonError = signal('');
  protected readonly selectedPeriod = signal<DashboardPeriod>('day');
  protected readonly customStart = signal(
    localDateValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  );
  protected readonly customEnd = signal(localDateValue(new Date()));
  protected readonly periodRange = signal<DateRange>(this.defaultRange('day'));
  protected readonly today = new Intl.DateTimeFormat('es-EC', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  protected readonly totalSales = computed(() =>
    this.paidOrders().reduce((total, sale) => total + sale.total_amount, 0),
  );
  protected readonly totalAdditionalIncome = computed(() =>
    this.additionalIncome().reduce((total, entry) => total + entry.amount, 0),
  );
  protected readonly totalIncome = computed(() => this.totalSales() + this.totalAdditionalIncome());
  protected readonly totalExpenses = computed(() =>
    this.expenses().reduce((total, expense) => total + expense.amount, 0),
  );
  protected readonly netBalance = computed(() => this.totalIncome() - this.totalExpenses());
  protected readonly averageTicket = computed(() =>
    this.paidOrders().length ? this.totalSales() / this.paidOrders().length : 0,
  );
  protected readonly profitMargin = computed(() =>
    this.totalIncome() ? (this.netBalance() / this.totalIncome()) * 100 : 0,
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
  protected readonly chartValues = computed(() => {
    const values = this.chartBuckets().flatMap((bucket) => [
      ...(this.showIncomeSeries() ? [bucket.sales] : []),
      ...(this.showExpenseSeries() ? [bucket.expenses] : []),
      ...(this.showNetSeries() ? [bucket.net] : []),
    ]);
    return values;
  });
  protected readonly chartMaximum = computed(() => Math.max(1, ...this.chartValues()));
  protected readonly chartMinimum = computed(() => Math.min(0, ...this.chartValues()));
  protected readonly chartZeroY = computed(() => {
    const min = this.chartMinimum();
    const max = this.chartMaximum();
    return 218 - ((0 - min) / (max - min)) * 178;
  });
  protected readonly chartAxisLabels = computed(() => {
    const min = this.chartMinimum();
    const max = this.chartMaximum();
    return [max, min + (max - min) * (2 / 3), min + (max - min) / 3, min]
      .map((value, index) => ({ value, y: [40, 99, 159, 218][index] }));
  });
  protected readonly chartPoints = computed<ChartPoint[]>(() => {
    const buckets = this.chartBuckets();
    const maxValue = this.chartMaximum();
    const minValue = this.chartMinimum();
    const valueRange = maxValue - minValue;
    const labelInterval = Math.max(1, Math.ceil(buckets.length / 8));
    const yForValue = (value: number) => 218 - ((value - minValue) / valueRange) * 178;
    return buckets.map((bucket, index) => ({
      ...bucket,
      x: buckets.length === 1 ? 500 : 42 + (index / (buckets.length - 1)) * 916,
      salesY: yForValue(bucket.sales),
      expensesY: yForValue(bucket.expenses),
      netY: yForValue(bucket.net),
      showLabel: index % labelInterval === 0 || index === buckets.length - 1,
    }));
  });
  protected readonly monthlyChartValues = computed(() => this.monthlyComparison().flatMap((bucket) => [
    bucket.sales,
    bucket.expenses,
    bucket.net,
  ]));
  protected readonly monthlyChartMaximum = computed(() => Math.max(1, ...this.monthlyChartValues()));
  protected readonly monthlyChartMinimum = computed(() => Math.min(0, ...this.monthlyChartValues()));
  protected readonly monthlyChartZeroY = computed(() => {
    const min = this.monthlyChartMinimum();
    const max = this.monthlyChartMaximum();
    return 218 - ((0 - min) / (max - min)) * 178;
  });
  protected readonly monthlyChartAxisLabels = computed(() => {
    const min = this.monthlyChartMinimum();
    const max = this.monthlyChartMaximum();
    return [max, min + (max - min) * (2 / 3), min + (max - min) / 3, min]
      .map((value, index) => ({ value, y: [40, 99, 159, 218][index] }));
  });
  protected readonly monthlyChartPoints = computed<ChartPoint[]>(() => {
    const buckets = this.monthlyComparison();
    const minValue = this.monthlyChartMinimum();
    const valueRange = this.monthlyChartMaximum() - minValue;
    const labelInterval = Math.max(1, Math.ceil(buckets.length / 8));
    const yForValue = (value: number) => 218 - ((value - minValue) / valueRange) * 178;
    return buckets.map((bucket, index) => ({
      ...bucket,
      x: buckets.length === 1 ? 500 : 70 + (index / (buckets.length - 1)) * 888,
      salesY: yForValue(bucket.sales),
      expensesY: yForValue(bucket.expenses),
      netY: yForValue(bucket.net),
      showLabel: index % labelInterval === 0 || index === buckets.length - 1,
    }));
  });
  protected readonly monthlyIncomePath = computed(() =>
    this.monthlyChartPoints().map((point) => `${point.x},${point.salesY}`).join(' '),
  );
  protected readonly monthlyExpensesPath = computed(() =>
    this.monthlyChartPoints().map((point) => `${point.x},${point.expensesY}`).join(' '),
  );
  protected readonly monthlyNetPath = computed(() =>
    this.monthlyChartPoints().map((point) => `${point.x},${point.netY}`).join(' '),
  );
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
  protected readonly netPath = computed(() =>
    this.chartPoints()
      .map((point) => `${point.x},${point.netY}`)
      .join(' '),
  );
  protected readonly salesAreaPath = computed(() => {
    const points = this.chartPoints();
    if (!points.length) return '';
    const baseline = this.chartZeroY();
    return `M ${points[0].x},${baseline} L ${points.map((point) => `${point.x},${point.salesY}`).join(' L ')} L ${points[points.length - 1].x},${baseline} Z`;
  });
  protected readonly periodLabel = computed(() => {
    const range = this.periodRange();
    if (this.selectedPeriod() === 'day') return this.compactDate.format(range.start);
    const lastDay = new Date(range.end);
    lastDay.setDate(lastDay.getDate() - 1);
    return `${this.compactDate.format(range.start)} – ${this.compactDate.format(lastDay)}`;
  });

  ngOnInit(): void {
    if (this.supabase.isConfigured) {
      void this.loadDashboard();
      void this.loadMonthlyComparison();
    }
  }

  protected formatCurrency(value: number): string {
    return this.currency.format(roundCurrencyForDisplay(value));
  }

  protected formatPercent(value: number): string {
    return `${new Intl.NumberFormat('es-EC', { maximumFractionDigits: 1 }).format(value)}%`;
  }

  protected toggleChartSeries(series: 'income' | 'expenses' | 'net'): void {
    if (series === 'income') this.showIncomeSeries.update((visible) => !visible);
    else if (series === 'expenses') this.showExpenseSeries.update((visible) => !visible);
    else this.showNetSeries.update((visible) => !visible);
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
    await Promise.all([this.loadDashboard(), this.loadMonthlyComparison()]);
  }

  protected updateMonthlyMonthsBack(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const months = Number(target.value);
    if (!Number.isInteger(months) || months < 3 || months > 24) return;
    this.monthlyMonthsBack.set(months);
    void this.loadMonthlyComparison();
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
          end: new Date(today.getFullYear(), today.getMonth() + 1, 1),
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
      const periodDataPromise = this.loadPeriodData();
      if (profile?.role === 'Auditor') {
        await periodDataPromise;
        return;
      }
      const operationsDataPromise = Promise.all([
          this.products.listAvailable(),
          this.orders.countActive(),
          this.orders.listRecent(),
          this.tables.listAll(),
        ])
        .then(([products, activeOrders, recentOrders, tables]) => {
          this.availableProductCount.set(products.length);
          this.activeOrderCount.set(activeOrders);
          this.recentOrders.set(recentOrders.slice(0, 5));
          this.occupiedTableCount.set(tables.filter((table) => table.status === 'ocupada').length);
        });
      await Promise.all([periodDataPromise, operationsDataPromise]);
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
      this.additionalIncome.set([]);
      this.expenses.set([]);
      this.splitTenders.set([]);
      this.topProducts.set([]);
      this.chartCashClosure.set(null);
      this.loadingPeriod.set(false);
      return;
    }
    this.periodRange.set(range);
    this.periodError.set('');
    this.loadingPeriod.set(true);
    this.databaseError.set('');
    this.paidOrders.set([]);
    this.additionalIncome.set([]);
    this.expenses.set([]);
    this.splitTenders.set([]);
    this.topProducts.set([]);
    this.chartCashClosure.set(null);
    if (this.supabase.isConfigured) this.databaseStatus.set('checking');

    try {
      const start = range.start.toISOString();
      const end = range.end.toISOString();
      const selectedDate = new Date(range.start);
      const isLastDayOfMonth = selectedDate.getDate()
        === new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0).getDate();
      const expensePeriods: ExpenseRecord['expense_period'][] =
        this.selectedPeriod() === 'month' || this.selectedPeriod() === 'custom'
          ? ['day', 'week', 'month']
          : this.selectedPeriod() === 'week'
            ? ['day', 'week']
            : [
              'day',
              ...(selectedDate.getDay() === 0 ? ['week' as const] : []),
              ...(isLastDayOfMonth ? ['month' as const] : []),
            ];
      const additionalIncomePeriods: CashClosureIncomeEntry['expense_period'][] = expensePeriods;
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const rangeIncludesToday = range.start <= todayStart && range.end > todayStart;
      const [paidOrders, expenses, splitTenders, topProducts, openClosure] = await Promise.all([
        this.sales.listPaidOrders(start, end),
        this.sales.listExpenses(start, end, expensePeriods),
        this.sales.listSplitPaymentTenders(start, end),
        this.orders.listTopProducts(start, end),
        rangeIncludesToday ? this.sales.getOpenClosure() : Promise.resolve(null),
      ]);
      const additionalIncome = await this.sales.listAdditionalIncome(
        start,
        end,
        additionalIncomePeriods,
        this.selectedPeriod() === 'day' ? openClosure?.id : undefined,
      );
      if (requestId !== this.periodRequestId) return;
      this.paidOrders.set(paidOrders);
      this.additionalIncome.set(additionalIncome);
      this.chartCashClosure.set(openClosure);
      this.expenses.set(expenses);
      this.splitTenders.set(splitTenders);
      this.topProducts.set(topProducts);
      this.databaseStatus.set('connected');
    } catch (error) {
      if (requestId !== this.periodRequestId) return;
      this.databaseError.set(
        error instanceof Error
          ? error.message
          : 'No se pudo consultar ventas, ingresos adicionales, egresos y productos.',
      );
      this.databaseStatus.set('error');
    } finally {
      if (requestId === this.periodRequestId) this.loadingPeriod.set(false);
    }
  }

  private async loadMonthlyComparison(): Promise<void> {
    const requestId = ++this.monthlyComparisonRequestId;
    const months = this.monthlyMonthsBack();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    this.monthlyComparisonLoading.set(true);
    this.monthlyComparisonError.set('');
    this.monthlyComparison.set([]);

    try {
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const [sales, expenses, additionalIncome, openClosure] = await Promise.all([
        this.sales.listPaidOrders(startIso, endIso),
        this.sales.listExpenses(startIso, endIso, ['day', 'week', 'month']),
        this.sales.listAdditionalIncome(startIso, endIso, ['day', 'week', 'month']),
        this.sales.getOpenClosure(),
      ]);
      if (requestId !== this.monthlyComparisonRequestId) return;

      const todayKey = localDateValue(now);
      const currentDayClosure = openClosure && localDateValue(new Date(openClosure.opened_at)) === todayKey
        ? openClosure
        : null;
      const monthlyTotals = new Map<string, { income: number; expenses: number }>();
      for (let monthOffset = 0; monthOffset < months; monthOffset++) {
        const month = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
        const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
        monthlyTotals.set(key, { income: 0, expenses: 0 });
      }

      for (const sale of sales) {
        const paidAt = new Date(sale.paid_at);
        if (currentDayClosure && localDateValue(paidAt) === todayKey
          && paidAt < new Date(currentDayClosure.opened_at)) continue;
        const key = localDateValue(paidAt).slice(0, 7);
        const bucket = monthlyTotals.get(key);
        if (bucket) bucket.income += sale.total_amount;
      }
      for (const entry of additionalIncome) {
        const createdAt = new Date(entry.created_at);
        if (entry.expense_period === 'day' && currentDayClosure && localDateValue(createdAt) === todayKey
          && entry.cash_closure_id !== currentDayClosure.id) continue;
        const key = localDateValue(createdAt).slice(0, 7);
        const bucket = monthlyTotals.get(key);
        if (bucket) bucket.income += entry.amount;
      }
      for (const expense of expenses) {
        const key = localDateValue(new Date(expense.created_at)).slice(0, 7);
        const bucket = monthlyTotals.get(key);
        if (bucket) bucket.expenses += expense.amount;
      }

      const monthFormatter = new Intl.DateTimeFormat('es-EC', { month: 'short', year: '2-digit' });
      this.monthlyComparison.set([...monthlyTotals.entries()]
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, totals]) => {
          const [year, month] = key.split('-').map(Number);
          const income = totals.income;
          const expenseTotal = totals.expenses;
          return {
            key,
            label: monthFormatter.format(new Date(year, month - 1, 1)).replace('.', ''),
            sales: income,
            expenses: expenseTotal,
            net: income - expenseTotal,
          };
        }));
    } catch (error) {
      if (requestId !== this.monthlyComparisonRequestId) return;
      this.monthlyComparisonError.set(
        error instanceof Error ? error.message : 'No se pudo cargar la comparación mensual.',
      );
    } finally {
      if (requestId === this.monthlyComparisonRequestId) this.monthlyComparisonLoading.set(false);
    }
  }

  private buildChartBuckets(): ChartBucket[] {
    const { start, end } = this.periodRange();
    const isDay = this.selectedPeriod() === 'day';
    const salesByBucket = new Map<string, number>();
    const additionalIncomeByBucket = new Map<string, number>();
    const expensesByBucket = new Map<string, number>();
    const todayKey = localDateValue(new Date());
    const closure = this.chartCashClosure();
    const currentDayClosure = closure && localDateValue(new Date(closure.opened_at)) === todayKey
      ? closure
      : null;
    const bucketKey = (date: Date): string =>
      isDay
        ? `${localDateValue(date)}T${String(date.getHours()).padStart(2, '0')}`
        : localDateValue(date);

    for (const sale of this.paidOrders()) {
      const date = new Date(sale.paid_at);
      if (currentDayClosure && localDateValue(date) === todayKey
        && date < new Date(currentDayClosure.opened_at)) continue;
      const key = bucketKey(date);
      salesByBucket.set(key, (salesByBucket.get(key) ?? 0) + sale.total_amount);
    }
    for (const entry of this.additionalIncome()) {
      const date = new Date(entry.created_at);
      if (entry.expense_period === 'day' && currentDayClosure && localDateValue(date) === todayKey
        && entry.cash_closure_id !== currentDayClosure.id) continue;
      const key = bucketKey(date);
      additionalIncomeByBucket.set(key, (additionalIncomeByBucket.get(key) ?? 0) + entry.amount);
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
        const sales = (salesByBucket.get(key) ?? 0) + (additionalIncomeByBucket.get(key) ?? 0);
        const expenses = expensesByBucket.get(key) ?? 0;
        buckets.push({
          key,
          label: `${String(hour).padStart(2, '0')}:00`,
          sales,
          expenses,
          net: sales - expenses,
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
      const sales = (salesByBucket.get(key) ?? 0) + (additionalIncomeByBucket.get(key) ?? 0);
      const expenses = expensesByBucket.get(key) ?? 0;
      buckets.push({
        key,
        label,
        sales,
        expenses,
        net: sales - expenses,
      });
    }
    return buckets;
  }
}
