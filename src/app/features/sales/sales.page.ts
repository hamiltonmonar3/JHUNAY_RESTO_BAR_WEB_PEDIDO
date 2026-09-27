import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, StaffProfile } from '../../core/auth/auth.service';
import { SalesService, SaleRecord, ServedOrder } from './sales.service';
import { OrderItemDetail, OrdersService } from '../orders/orders.service';

type PaymentMethod = 'efectivo' | 'tarjeta' | 'transferencia';

interface SaleDetailHeader {
  id: number;
  totalAmount: number;
  date: string;
  paymentMethod: string | null;
  status: 'Pagado' | 'Servido';
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDayRange(dateValue: string): { start: string; end: string } {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

@Component({
  imports: [FormsModule],
  selector: 'app-sales-page',
  styleUrl: './sales.page.scss',
  templateUrl: './sales.page.html',
})
export class SalesPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly salesService = inject(SalesService);
  private readonly ordersService = inject(OrdersService);
  private readonly money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
  private readonly dateTime = new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' });

  protected readonly profile = signal<StaffProfile | null>(null);
  protected readonly paidOrders = signal<SaleRecord[]>([]);
  protected readonly servedOrders = signal<ServedOrder[]>([]);
  protected readonly loading = signal(true);
  protected readonly payingOrderId = signal<number | null>(null);
  protected readonly errorMessage = signal('');
  protected readonly paymentMessage = signal('');
  protected readonly selectedDetail = signal<SaleDetailHeader | null>(null);
  protected readonly detailItems = signal<OrderItemDetail[]>([]);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal('');
  protected readonly selectedPaymentMethod = signal<PaymentMethod>('efectivo');
  protected readonly selectedDate = signal(localDateValue(new Date()));
  protected readonly totalSales = computed(() => this.paidOrders().reduce((total, sale) => total + sale.total_amount, 0));
  protected readonly averageSale = computed(() => {
    const sales = this.paidOrders();
    return sales.length ? this.totalSales() / sales.length : 0;
  });
  protected readonly paymentBreakdown = computed(() => {
    const groups = new Map<string, { count: number; total: number }>();
    for (const sale of this.paidOrders()) {
      const method = sale.payment_method || 'sin método';
      const group = groups.get(method) ?? { count: 0, total: 0 };
      group.count += 1;
      group.total += sale.total_amount;
      groups.set(method, group);
    }
    return [...groups.entries()].map(([method, values]) => ({ method, ...values }));
  });
  protected readonly canCollect = signal(false);

  ngOnInit(): void {
    void this.loadSales();
  }

  protected async loadSales(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const profile = await this.auth.getActiveStaffProfile();
      this.profile.set(profile);
      this.canCollect.set(profile?.role === 'admin' || profile?.role === 'caja' || profile?.role === 'cajero');
      const { start, end } = localDayRange(this.selectedDate());
      const [paidOrders, servedOrders] = await Promise.all([
        this.salesService.listPaidOrders(start, end),
        this.salesService.listServedOrders(),
      ]);
      this.paidOrders.set(paidOrders);
      this.servedOrders.set(servedOrders);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudieron cargar las ventas.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async collectPayment(order: ServedOrder): Promise<void> {
    this.payingOrderId.set(order.id);
    this.paymentMessage.set('');
    this.errorMessage.set('');
    try {
      await this.salesService.recordPayment(order.id, this.selectedPaymentMethod());
      this.paymentMessage.set(`Pedido #${order.id} cobrado correctamente.`);
      await this.loadSales();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo registrar el cobro.');
    } finally {
      this.payingOrderId.set(null);
    }
  }

  protected async showServedDetails(order: ServedOrder): Promise<void> {
    await this.loadDetails({
      id: order.id,
      totalAmount: order.total_amount,
      date: order.created_at,
      paymentMethod: null,
      status: 'Servido',
    });
  }

  protected async showSaleDetails(sale: SaleRecord): Promise<void> {
    await this.loadDetails({
      id: sale.id,
      totalAmount: sale.total_amount,
      date: sale.paid_at,
      paymentMethod: sale.payment_method,
      status: 'Pagado',
    });
  }

  protected closeDetails(): void {
    this.selectedDetail.set(null);
    this.detailItems.set([]);
    this.detailError.set('');
  }

  protected productName(item: OrderItemDetail): string {
    const relation = Array.isArray(item.products) ? item.products[0] : item.products;
    return relation?.name ?? `Producto #${item.product_id}`;
  }

  private async loadDetails(header: SaleDetailHeader): Promise<void> {
    this.selectedDetail.set(header);
    this.detailItems.set([]);
    this.detailError.set('');
    this.detailLoading.set(true);
    try {
      this.detailItems.set(await this.ordersService.listItems(header.id));
    } catch (error) {
      this.detailError.set(error instanceof Error ? error.message : 'No se pudo cargar el detalle.');
    } finally {
      this.detailLoading.set(false);
    }
  }

  protected formatCurrency(value: number): string {
    return this.money.format(value);
  }

  protected formatDate(value: string): string {
    return this.dateTime.format(new Date(value));
  }

  protected locationLabel(order: ServedOrder): string {
    const relation = Array.isArray(order.restaurant_tables) ? order.restaurant_tables[0] : order.restaurant_tables;
    return relation ? `Mesa ${relation.table_number}` : 'Para llevar';
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    window.location.assign('/login');
  }
}