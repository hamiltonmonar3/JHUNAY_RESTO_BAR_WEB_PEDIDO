import { Component, computed, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, StaffProfile } from '../../core/auth/auth.service';
import { CashClosure, ExpenseRecord, OrderPaymentGroup, SalePaymentMethod, SalesService, SaleRecord, ServedOrder, SplitPaymentInput, SplitTenderSale } from './sales.service';
import { OrderItemDetail, OrdersService } from '../orders/orders.service';

type SalesTab = 'ventas' | 'egresos' | 'apertura' | 'cierre';
type ExpensePeriod = 'day' | 'yesterday' | 'week' | 'month';
type ExpenseCategory = 'insumos' | 'personal' | 'otros' | 'servicios' | 'inmueble' | 'apertura_caja';

interface DraftTender {
  id: number;
  payment_method: SalePaymentMethod;
  amount: number;
}

interface DraftPaymentGroup {
  id: number;
  payer_name: string;
  quantities: Record<number, number>;
  tenders: DraftTender[];
}

interface SaleDetailHeader {
  id: number;
  totalAmount: number;
  date: string;
  paymentMethod: string | null;
  status: 'Pagado' | 'Servido';
  location: string;
  waiter: string;
}

function firstRelation<T>(relation: T | T[] | null): T | null {
  return Array.isArray(relation) ? relation[0] ?? null : relation;
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function businessDateValue(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values['year']}-${values['month']}-${values['day']}`;
}

function localDayRange(dateValue: string): { start: string; end: string } {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function localDateRange(start: Date, end: Date): { start: string; end: string } {
  return { start: start.toISOString(), end: end.toISOString() };
}

function paymentErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return 'No se pudo registrar el cobro.';

  const response = error as Record<string, unknown>;
  if (response['code'] === 'PGRST202' || response['code'] === '42883') {
    return 'La función de cobro dividido no está disponible en la base de datos. Aplica la migración 202610131900_split_order_payments.sql.';
  }

  return ['message', 'details', 'hint']
    .map((key) => response[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' — ') || 'No se pudo registrar el cobro.';
}

function cashOpeningErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      && typeof error.message === 'string'
      ? error.message
      : '';
  if (message.includes('Previous cash register must be closed')) {
    return 'Cierra la caja anterior antes de realizar la apertura de hoy.';
  }
  if (message.includes('Cash register has already been opened today')) {
    return 'La apertura de caja de hoy ya fue realizada.';
  }
  return message || 'No se pudo abrir la caja.';
}

@Component({
  imports: [FormsModule],
  selector: 'app-sales-page',
  styleUrl: './sales.page.scss',
  templateUrl: './sales.page.html',
})
export class SalesPage implements OnDestroy, OnInit {
  private readonly auth = inject(AuthService);
  private readonly salesService = inject(SalesService);
  private readonly ordersService = inject(OrdersService);
  private readonly money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
  private readonly dateTime = new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' });

  protected readonly profile = signal<StaffProfile | null>(null);
  protected readonly paidOrders = signal<SaleRecord[]>([]);
  protected readonly splitPaymentTenders = signal<SplitTenderSale[]>([]);
  protected readonly servedOrders = signal<ServedOrder[]>([]);
  protected readonly loading = signal(true);
  protected readonly refreshingServedOrders = signal(false);
  protected readonly payingOrderId = signal<number | null>(null);
  protected readonly errorMessage = signal('');
  protected readonly paymentMessage = signal('');
  protected readonly selectedDetail = signal<SaleDetailHeader | null>(null);
  protected readonly detailItems = signal<OrderItemDetail[]>([]);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal('');
  protected readonly paymentDetailError = signal('');
  protected readonly paymentMode = signal(false);
  protected readonly splitPaymentMode = signal(false);
  protected readonly splitPaymentNotice = signal('');
  protected readonly paymentGroups = signal<DraftPaymentGroup[]>([]);
  protected readonly openSplitItemPicker = signal<number | null>(null);
  protected readonly savedPaymentGroups = signal<OrderPaymentGroup[]>([]);
  protected readonly paymentSaving = signal(false);
  protected readonly paymentError = signal('');
  protected readonly selectedDate = signal(localDateValue(new Date()));
  protected readonly totalSales = computed(() => this.paidOrders().reduce((total, sale) => total + sale.total_amount, 0));
  protected readonly averageSale = computed(() => {
    const sales = this.paidOrders();
    return sales.length ? this.totalSales() / sales.length : 0;
  });
  protected readonly paymentBreakdown = computed(() => {
    const groups = new Map<string, { orderIds: Set<number>; total: number }>();
    for (const sale of this.paidOrders().filter((record) => record.payment_method !== 'mixto')) {
      const method = sale.payment_method || 'sin método';
      const group = groups.get(method) ?? { orderIds: new Set<number>(), total: 0 };
      group.orderIds.add(sale.id);
      group.total += sale.total_amount;
      groups.set(method, group);
    }
    for (const tender of this.splitPaymentTenders()) {
      const group = groups.get(tender.payment_method) ?? { orderIds: new Set<number>(), total: 0 };
      group.orderIds.add(tender.order_id);
      group.total += tender.amount;
      groups.set(tender.payment_method, group);
    }
    return [...groups.entries()].map(([method, values]) => ({
      method,
      count: values.orderIds.size,
      total: this.roundMoney(values.total),
    }));
  });
  protected readonly canCollect = signal(false);
  private nextPaymentGroupId = 1;
  private nextTenderId = 1;
  protected readonly isAdmin = computed(() => this.profile()?.role === 'Administrador');

  protected readonly activeTab = signal<SalesTab>('ventas');

  protected readonly expenses = signal<ExpenseRecord[]>([]);
  protected readonly expensesLoading = signal(false);
  protected readonly savingExpense = signal(false);
  protected readonly expenseError = signal('');
  protected readonly expenseDate = signal(localDateValue(new Date()));
  protected readonly expensePeriod = signal<ExpensePeriod>('day');
  protected expenseAmountValue = 0;
  protected expenseDescription = '';
  protected expenseCategory: ExpenseCategory = 'insumos';
  protected readonly totalExpenses = computed(() => this.expenses().reduce((total, expense) => total + expense.amount, 0));

  protected readonly openClosure = signal<CashClosure | null>(null);
  protected readonly closureHistory = signal<CashClosure[]>([]);
  protected readonly openingAlreadyDoneToday = computed(() => {
    const today = businessDateValue(new Date());
    return this.closureHistory().some((closure) => businessDateValue(new Date(closure.opened_at)) === today)
      || (!!this.openClosure()
        && businessDateValue(new Date(this.openClosure()!.opened_at)) === today);
  });
  protected readonly closurePaidOrders = signal<SaleRecord[]>([]);
  protected readonly closureSplitTenders = signal<SplitTenderSale[]>([]);
  protected readonly closureExpenses = signal<ExpenseRecord[]>([]);
  protected readonly closurePaymentSummary = computed(() => {
    const methods = new Map<string, { label: string; total: number; orderIds: Set<number> }>([
      ['efectivo', { label: 'Efectivo', total: 0, orderIds: new Set() }],
      ['transferencia', { label: 'Transferencia', total: 0, orderIds: new Set() }],
    ]);
    const splitOrderIds = new Set(
      this.closurePaidOrders().filter((order) => order.payment_method === 'mixto').map((order) => order.id),
    );
    for (const order of this.closurePaidOrders()) {
      if (order.payment_method !== 'efectivo' && order.payment_method !== 'transferencia') continue;
      const group = methods.get(order.payment_method)!;
      group.total += order.total_amount;
      group.orderIds.add(order.id);
    }
    for (const tender of this.closureSplitTenders()) {
      if (!splitOrderIds.has(tender.order_id)
        || (tender.payment_method !== 'efectivo' && tender.payment_method !== 'transferencia')) continue;
      const group = methods.get(tender.payment_method)!;
      group.total += tender.amount;
      group.orderIds.add(tender.order_id);
    }
    return [...methods.entries()].map(([method, value]) => ({
      method,
      label: value.label,
      total: this.roundMoney(value.total),
      count: value.orderIds.size,
    })).filter((method) => method.count > 0);
  });
  protected readonly closureCashSales = computed(() =>
    this.closurePaymentSummary().find((method) => method.method === 'efectivo')?.total ?? 0,
  );
  protected readonly closureExpenseTotal = computed(() =>
    this.closureExpenses().reduce((total, expense) => total + expense.amount, 0),
  );
  protected readonly expectedClosureCash = computed(() => {
    const openingAmount = this.openClosure()?.opening_amount ?? 0;
    return this.roundMoney(openingAmount + this.closureCashSales() - this.closureExpenseTotal());
  });
  protected readonly cashDifference = computed(() => this.countedCashValue() === null
    ? null
    : this.roundMoney(this.countedCashValue()! - this.expectedClosureCash()));
  protected readonly openingDifference = computed(() => this.openingCountedCashValue() === null
    ? null
    : this.roundMoney(this.openingCountedCashValue()! - this.openingAmountValue()));
  protected readonly closureLoading = signal(false);
  protected readonly closureBusy = signal(false);
  protected readonly closureError = signal('');
  protected readonly showCloseConfirm = signal(false);
  protected readonly openingAmountValue = signal(0);
  protected readonly openingCountedCashValue = signal<number | null>(null);
  protected readonly countedCashValue = signal<number | null>(null);
  protected closingNotes = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private paymentMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private servedOrdersRefreshInProgress = false;

  ngOnInit(): void {
    void this.loadSales();
    void this.loadCashRegister();
    this.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.refreshServedOrders();
    }, 20_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.paymentMessageTimer) clearTimeout(this.paymentMessageTimer);
  }

  @HostListener('window:focus')
  protected onWindowFocus(): void {
    void this.refreshServedOrders();
  }

  @HostListener('document:visibilitychange')
  protected onVisibilityChange(): void {
    if (document.visibilityState === 'visible') void this.refreshServedOrders();
  }

  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.split-item-picker')) {
      this.openSplitItemPicker.set(null);
    }
  }

  protected onDetailModalClick(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.split-item-picker')) {
      this.openSplitItemPicker.set(null);
    }
    event.stopPropagation();
  }

  protected async refreshServedOrders(): Promise<void> {
    if (this.servedOrdersRefreshInProgress) return;
    this.servedOrdersRefreshInProgress = true;
    this.refreshingServedOrders.set(true);
    try {
      this.servedOrders.set(await this.salesService.listServedOrders());
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudieron actualizar los pedidos por cobrar.');
    } finally {
      this.refreshingServedOrders.set(false);
      this.servedOrdersRefreshInProgress = false;
    }
  }

  protected async loadSales(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const profile = await this.auth.getActiveStaffProfile();
      this.profile.set(profile);
      this.canCollect.set(profile?.role === 'Administrador' || profile?.role === 'Operador');
      const { start, end } = localDayRange(this.selectedDate());
      const [paidOrders, servedOrders] = await Promise.all([
        this.salesService.listPaidOrders(start, end),
        this.salesService.listServedOrders(),
      ]);
      this.paidOrders.set(paidOrders);
      this.servedOrders.set(servedOrders);
      try {
        this.splitPaymentTenders.set(await this.salesService.listSplitPaymentTenders(start, end));
      } catch (error) {
        this.splitPaymentTenders.set([]);
        this.errorMessage.set(
          `Se cargaron los pedidos, pero no el detalle de pagos divididos. Verifica que esté aplicada la migración de pagos divididos en Supabase. ${error instanceof Error ? error.message : ''}`.trim(),
        );
      }
      await this.loadExpenses();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudieron cargar las ventas.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async openPayment(order: ServedOrder): Promise<void> {
    if (this.payingOrderId() !== null) return;
    this.payingOrderId.set(order.id);
    try {
      await this.showServedDetails(order);
    } finally {
      this.payingOrderId.set(null);
    }
  }

  protected startWholePayment(): void {
    this.startPaymentDraft(false);
  }

  protected startSplitPayment(): void {
    this.startPaymentDraft(true);
  }

  private startPaymentDraft(split: boolean): void {
    if (this.paymentDetailError()) {
      this.paymentError.set('No se puede iniciar el cobro sin consultar los pagos ya registrados.');
      return;
    }
    if (this.detailError() || this.detailItems().length === 0) {
      this.paymentError.set(this.detailError() || 'Este pedido no tiene productos para cobrar.');
      return;
    }

    this.clearPaymentMessageTimer();
    this.paymentMessage.set('');
    this.paymentError.set('');
    this.splitPaymentNotice.set('');
    this.paymentMode.set(true);
    this.splitPaymentMode.set(split);
    this.nextPaymentGroupId = 1;
    this.nextTenderId = 1;
    const quantities = Object.fromEntries(this.detailItems().map((item) => [
      item.id,
      split ? 0 : Math.max(item.quantity - this.savedItemQuantity(item.id), 0),
    ]));
    const total = this.orderItemsTotal(this.detailItems().map((item) => ({
      item,
      quantity: quantities[item.id] ?? 0,
    })));
    this.paymentGroups.set([{
      id: this.nextPaymentGroupId++,
      payer_name: '',
      quantities,
      tenders: [{ id: this.nextTenderId++, payment_method: 'efectivo', amount: split ? 0 : total }],
    }]);
  }

  protected addPaymentGroup(): void {
    const quantities = Object.fromEntries(this.detailItems().map((item) => [item.id, 0]));
    this.paymentGroups.update((groups) => [...groups, {
      id: this.nextPaymentGroupId++,
      payer_name: '',
      quantities,
      tenders: [{ id: this.nextTenderId++, payment_method: 'efectivo', amount: 0 }],
    }]);
  }

  protected removePaymentGroup(groupId: number): void {
    this.paymentGroups.update((groups) => groups.filter((group) => group.id !== groupId));
  }

  protected async paySplitGroup(groupId: number): Promise<void> {
    const order = this.selectedDetail();
    const group = this.paymentGroups().find((candidate) => candidate.id === groupId);
    const validation = group ? this.splitGroupValidation(group) : 'No se encontró la división que se va a cobrar.';
    if (!order || !group || validation) {
      this.paymentError.set(validation || 'No se encontró el pedido que se va a cobrar.');
      return;
    }

    this.paymentSaving.set(true);
    this.paymentError.set('');
    this.splitPaymentNotice.set('');
    try {
      const completed = await this.salesService.recordSplitPayment(order.id, [this.splitPaymentInput(group)]);
      if (completed) {
        this.showPaymentMessage(`Pedido #${order.id} cobrado correctamente.`);
        this.closeDetails();
        await Promise.all([this.loadSales(), this.loadCashRegister(), this.refreshServedOrders()]);
        return;
      }

      this.paymentGroups.update((groups) => groups.filter((candidate) => candidate.id !== groupId));
      this.splitPaymentNotice.set(`Pago de ${group.payer_name.trim() || 'esta persona'} registrado. Continúa con la siguiente división.`);
      try {
        this.savedPaymentGroups.set(await this.salesService.listPaymentGroups(order.id));
      } catch (error) {
        this.closeDetails();
        this.showPaymentMessage(`Pago parcial guardado, pero no se pudo actualizar el detalle: ${paymentErrorMessage(error)}`);
        await this.refreshServedOrders();
      }
    } catch (error) {
      this.paymentError.set(paymentErrorMessage(error));
    } finally {
      this.paymentSaving.set(false);
    }
  }

  protected setSplitQuantity(groupId: number, itemId: number, value: number | string): void {
    const item = this.detailItems().find((candidate) => candidate.id === itemId);
    const group = this.paymentGroups().find((candidate) => candidate.id === groupId);
    if (!item || !group) return;

    const alreadyPaid = this.savedItemQuantity(itemId);
    const remainingForOthers = item.quantity - alreadyPaid - this.paymentGroups()
      .filter((candidate) => candidate.id !== groupId)
      .reduce((total, candidate) => total + (candidate.quantities[itemId] ?? 0), 0);
    const quantity = Math.min(Math.max(Math.trunc(Number(value) || 0), 0), remainingForOthers);
    this.paymentGroups.update((groups) => groups.map((candidate) => {
      if (candidate.id !== groupId) return candidate;
      const updated = { ...candidate, quantities: { ...candidate.quantities, [itemId]: quantity } };
      return this.syncSingleTender(updated);
    }));
  }

  protected changeSplitQuantity(groupId: number, itemId: number, change: -1 | 1): void {
    const group = this.paymentGroups().find((candidate) => candidate.id === groupId);
    if (!group) return;
    this.setSplitQuantity(groupId, itemId, (group.quantities[itemId] ?? 0) + change);
  }

  protected toggleSplitItem(groupId: number, itemId: number, event: Event): void {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement)) return;
    this.setSplitQuantity(groupId, itemId, checkbox.checked ? 1 : 0);
  }

  protected toggleSplitItemPicker(groupId: number): void {
    this.openSplitItemPicker.update((openGroupId) => openGroupId === groupId ? null : groupId);
  }

  protected splitGroupSelectedItemCount(group: DraftPaymentGroup): number {
    return Object.values(group.quantities).filter((quantity) => quantity > 0).length;
  }

  protected availableSplitItems(group: DraftPaymentGroup): OrderItemDetail[] {
    return this.detailItems().filter((item) =>
      this.splitItemRemaining(item) > 0 || (group.quantities[item.id] ?? 0) > 0,
    );
  }

  protected addPaymentTender(groupId: number): void {
    this.paymentGroups.update((groups) => groups.map((group) => {
      if (group.id !== groupId || group.tenders.length >= 2) return group;
      const available = (['efectivo', 'transferencia'] as const)
        .find((method) => !group.tenders.some((tender) => tender.payment_method === method));
      return available
        ? { ...group, tenders: [...group.tenders, { id: this.nextTenderId++, payment_method: available, amount: this.paymentGroupRemaining(group) }] }
        : group;
    }));
  }

  protected removePaymentTender(groupId: number, tenderId: number): void {
    this.paymentGroups.update((groups) => groups.map((group) => {
      if (group.id !== groupId || group.tenders.length <= 1) return group;
      const updated = { ...group, tenders: group.tenders.filter((tender) => tender.id !== tenderId) };
      return this.syncSingleTender(updated);
    }));
  }

  protected updateTenderMethod(groupId: number, tenderId: number, method: SalePaymentMethod): void {
    this.paymentGroups.update((groups) => groups.map((group) => {
      if (group.id !== groupId) return group;
      const duplicate = group.tenders.some((tender) => tender.id !== tenderId && tender.payment_method === method);
      if (duplicate) return group;
      return {
        ...group,
        tenders: group.tenders.map((tender) =>
          tender.id === tenderId ? { ...tender, payment_method: method } : tender,
        ),
      };
    }));
  }

  protected updateTenderAmount(groupId: number, tenderId: number, amount: number | string): void {
    const parsedAmount = Number(amount);
    this.paymentGroups.update((groups) => groups.map((group) => {
      if (group.id !== groupId) return group;
      const updatedTenders = group.tenders.map((tender) => tender.id === tenderId
        ? { ...tender, amount: Number.isFinite(parsedAmount) && parsedAmount >= 0 ? this.roundMoney(parsedAmount) : 0 }
        : tender);
      const balanceTender = updatedTenders.at(-1);
      if (balanceTender && balanceTender.id !== tenderId) {
        const otherPayments = updatedTenders
          .filter((tender) => tender.id !== balanceTender.id)
          .reduce((total, tender) => total + tender.amount, 0);
        balanceTender.amount = this.roundMoney(Math.max(this.paymentGroupTotal(group) - otherPayments, 0));
      }
      return { ...group, tenders: updatedTenders };
    }));
  }

  protected paymentGroupTotal(group: DraftPaymentGroup): number {
    return this.orderItemsTotal(this.detailItems().map((item) => ({
      item,
      quantity: group.quantities[item.id] ?? 0,
    })));
  }

  protected paymentGroupTenderTotal(group: DraftPaymentGroup): number {
    const groupTotal = this.paymentGroupTotal(group);
    const nonCashTotal = group.tenders
      .filter((tender) => tender.payment_method !== 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    const cashReceived = group.tenders
      .filter((tender) => tender.payment_method === 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    return this.roundMoney(nonCashTotal + Math.min(cashReceived, Math.max(groupTotal - nonCashTotal, 0)));
  }

  protected paymentGroupRemaining(group: DraftPaymentGroup): number {
    return this.roundMoney(Math.max(this.paymentGroupTotal(group) - this.paymentGroupTenderTotal(group), 0));
  }

  protected paymentChange(group: DraftPaymentGroup): number {
    const groupTotal = this.paymentGroupTotal(group);
    const nonCashTotal = group.tenders
      .filter((tender) => tender.payment_method !== 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    const cashReceived = group.tenders
      .filter((tender) => tender.payment_method === 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    return this.roundMoney(Math.max(cashReceived - Math.max(groupTotal - nonCashTotal, 0), 0));
  }

  protected splitItemRemaining(item: OrderItemDetail): number {
    const paid = this.savedItemQuantity(item.id);
    const draft = this.paymentGroups().reduce((total, group) => total + (group.quantities[item.id] ?? 0), 0);
    const assigned = paid + draft;
    return item.quantity - assigned;
  }

  private savedItemQuantity(itemId: number): number {
    return this.savedPaymentGroups().reduce((total, group) => total
      + group.order_payment_group_items
        .filter((paidItem) => paidItem.order_item_id === itemId)
        .reduce((itemTotal, paidItem) => itemTotal + paidItem.quantity, 0), 0);
  }

  protected splitGroupValidation(group: DraftPaymentGroup): string {
    const groupTotal = this.paymentGroupTotal(group);
    if (groupTotal <= 0) return 'Asigna productos a este grupo.';
    if (group.tenders.length === 0 || group.tenders.some((tender) => tender.amount <= 0)) {
      return 'Cada forma de pago debe tener un monto mayor a cero.';
    }
    const nonCashTotal = group.tenders
      .filter((tender) => tender.payment_method !== 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    if (this.toCents(nonCashTotal) > this.toCents(groupTotal)) {
      return 'Los pagos que no son en efectivo superan el total de la cuenta.';
    }
    if (this.toCents(this.paymentGroupTenderTotal(group)) !== this.toCents(groupTotal)) {
      return `Falta cubrir ${this.formatCurrency(groupTotal - this.paymentGroupTenderTotal(group))}.`;
    }
    return '';
  }

  protected splitPaymentValidation(): string {
    if (this.paymentGroups().length === 0) return 'Agrega al menos un grupo de pago.';
    const unassigned = this.detailItems().find((item) => this.splitItemRemaining(item) !== 0);
    if (unassigned) {
      const remaining = this.splitItemRemaining(unassigned);
      return remaining > 0
        ? `Asigna las ${remaining} unidad(es) restantes de ${this.productName(unassigned)}.`
        : `La cantidad de ${this.productName(unassigned)} excede lo pedido.`;
    }
    return this.paymentGroups().map((group) => this.splitGroupValidation(group)).find(Boolean) ?? '';
  }

  protected async submitSplitPayment(): Promise<void> {
    const order = this.selectedDetail();
    const validation = this.splitPaymentValidation();
    if (!order || validation) {
      this.paymentError.set(validation || 'No se encontró el pedido que se va a cobrar.');
      return;
    }

    this.paymentSaving.set(true);
    this.paymentError.set('');
    try {
      await this.salesService.recordSplitPayment(order.id, this.paymentGroups().map((group) => this.splitPaymentInput(group)));
      this.showPaymentMessage(`Pedido #${order.id} cobrado correctamente.`);
      this.closeDetails();
      await Promise.all([this.loadSales(), this.loadCashRegister(), this.refreshServedOrders()]);
    } catch (error) {
      this.paymentError.set(paymentErrorMessage(error));
    } finally {
      this.paymentSaving.set(false);
    }
  }

  protected async loadExpenses(): Promise<void> {
    this.expensesLoading.set(true);
    this.expenseError.set('');
    try {
      const { start, end } = this.expenseDateRange();
      this.expenses.set(await this.salesService.listExpenses(start, end));
    } catch (error) {
      this.expenseError.set(error instanceof Error ? error.message : 'No se pudieron cargar los egresos.');
    } finally {
      this.expensesLoading.set(false);
    }
  }

  protected selectExpensePeriod(period: ExpensePeriod): void {
    const date = new Date();
    if (period === 'yesterday') date.setDate(date.getDate() - 1);
    this.expenseDate.set(localDateValue(date));
    this.expensePeriod.set(period);
    void this.loadExpenses();
  }

  protected onExpenseDateChange(date: string): void {
    this.expenseDate.set(date);
    this.expensePeriod.set('day');
    void this.loadExpenses();
  }

  protected expensePeriodLabel(): string {
    switch (this.expensePeriod()) {
      case 'yesterday': return 'Ayer';
      case 'week': return 'Esta semana';
      case 'month': return 'Este mes';
      default: return this.expenseDate() === localDateValue(new Date())
        ? 'Hoy'
        : this.formatDate(`${this.expenseDate()}T12:00:00`);
    }
  }

  protected isExpenseToday(): boolean {
    return this.expenseDate() === localDateValue(new Date());
  }

  private expenseDateRange(): { start: string; end: string } {
    const selectedDate = new Date(`${this.expenseDate()}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      throw new Error('Selecciona una fecha válida para consultar los egresos.');
    }

    const start = new Date(selectedDate);
    const end = new Date(selectedDate);

    if (this.expensePeriod() === 'month') {
      start.setDate(1);
      end.setMonth(end.getMonth() + 1, 1);
    } else if (this.expensePeriod() === 'week') {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 7);
    } else {
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 1);
    }

    return localDateRange(start, end);
  }

  protected expenseAuthorName(expense: ExpenseRecord): string {
    const relation = Array.isArray(expense.users) ? expense.users[0] : expense.users;
    return relation?.full_name ?? '—';
  }

  protected expenseCategoryName(category: string): string {
    return category === 'apertura_caja' ? 'Apertura de Caja' : category;
  }

  protected async recordExpense(): Promise<void> {
    if (!this.expenseDescription.trim() || this.expenseAmountValue <= 0) {
      this.expenseError.set('Ingresa un monto válido y una descripción para el egreso.');
      return;
    }
    this.savingExpense.set(true);
    this.expenseError.set('');
    try {
      await this.salesService.recordExpense(this.expenseAmountValue, this.expenseDescription, this.expenseCategory);
      this.expenseAmountValue = 0;
      this.expenseDescription = '';
      this.expenseCategory = 'insumos';
      await this.loadExpenses();
    } catch (error) {
      this.expenseError.set(error instanceof Error ? error.message : 'No se pudo registrar el egreso.');
    } finally {
      this.savingExpense.set(false);
    }
  }

  protected async deleteExpense(expense: ExpenseRecord): Promise<void> {
    if (!window.confirm(`¿Eliminar el egreso “${expense.description}”?`)) return;
    try {
      await this.salesService.deleteExpense(expense.id);
      await this.loadExpenses();
    } catch (error) {
      this.expenseError.set(error instanceof Error ? error.message : 'No se pudo eliminar el egreso.');
    }
  }

  protected async loadCashRegister(): Promise<void> {
    this.closureLoading.set(true);
    this.closureError.set('');
    try {
      const [open, history] = await Promise.all([
        this.salesService.getOpenClosure(),
        this.salesService.listClosureHistory(),
      ]);
      this.openClosure.set(open);
      this.closureHistory.set(history);
      if (!open) {
        this.closurePaidOrders.set([]);
        this.closureSplitTenders.set([]);
        this.closureExpenses.set([]);
        this.countedCashValue.set(null);
        return;
      }
      const now = new Date().toISOString();
      const [paidOrders, expenses, splitTenders] = await Promise.all([
        this.salesService.listPaidOrders(open.opened_at, now),
        this.salesService.listExpenses(open.opened_at, now),
        this.salesService.listSplitPaymentTenders(open.opened_at, now),
      ]);
      this.closurePaidOrders.set(paidOrders);
      this.closureExpenses.set(expenses);
      this.closureSplitTenders.set(splitTenders);
    } catch (error) {
      this.closureError.set(error instanceof Error ? error.message : 'No se pudo consultar la caja.');
    } finally {
      this.closureLoading.set(false);
    }
  }

  protected closureAuthorName(closure: CashClosure): string {
    const relation = Array.isArray(closure.users) ? closure.users[0] : closure.users;
    return relation?.full_name ?? '—';
  }

  protected updateOpeningAmount(event: Event): void {
    const amount = (event.target as HTMLInputElement).valueAsNumber;
    this.openingAmountValue.set(Number.isFinite(amount) ? amount : 0);
  }

  protected updateOpeningCountedCash(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.openingCountedCashValue.set(input.value === '' ? null : input.valueAsNumber);
  }

  protected updateCountedCash(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.countedCashValue.set(input.value === '' ? null : input.valueAsNumber);
  }

  protected async openRegister(): Promise<void> {
    if (this.openClosure()) {
      this.closureError.set('La caja anterior sigue abierta. Debes cerrarla antes de continuar.');
      return;
    }
    if (this.openingAlreadyDoneToday()) {
      this.closureError.set('La apertura de caja de hoy ya fue realizada.');
      return;
    }
    if (this.openingAmountValue() < 0) {
      this.closureError.set('El monto de apertura no puede ser negativo.');
      return;
    }
    if (this.openingCountedCashValue() === null || !Number.isFinite(this.openingCountedCashValue())) {
      this.closureError.set('Ingresa el efectivo contado para verificar el fondo de apertura.');
      return;
    }
    if (this.openingDifference() !== 0) {
      this.closureError.set('El efectivo contado debe coincidir con el fondo de apertura.');
      return;
    }
    this.closureBusy.set(true);
    this.closureError.set('');
    try {
      await this.salesService.openClosure(this.openingAmountValue());
      this.openingAmountValue.set(0);
      this.openingCountedCashValue.set(null);
      this.countedCashValue.set(null);
      await this.loadCashRegister();
    } catch (error) {
      this.closureError.set(cashOpeningErrorMessage(error));
    } finally {
      this.closureBusy.set(false);
    }
  }

  protected async closeRegister(): Promise<void> {
    if (this.countedCashValue() === null || !Number.isFinite(this.countedCashValue())) {
      this.closureError.set('Ingresa el efectivo contado para cerrar la caja.');
      return;
    }
    if (this.countedCashValue()! < 0) {
      this.closureError.set('El monto contado no puede ser negativo.');
      return;
    }
    this.closureError.set('');
    this.showCloseConfirm.set(true);
  }

  protected cancelCloseRegister(): void {
    if (this.closureBusy()) return;
    this.showCloseConfirm.set(false);
  }

  protected async confirmCloseRegister(): Promise<void> {
    if (this.countedCashValue() === null || !Number.isFinite(this.countedCashValue())
      || this.countedCashValue()! < 0) {
      this.showCloseConfirm.set(false);
      this.closureError.set('Ingresa un monto válido de efectivo contado antes de cerrar la caja.');
      return;
    }
    this.closureBusy.set(true);
    this.closureError.set('');
    try {
      await this.salesService.closeClosure(this.countedCashValue()!, this.closingNotes.trim() || null);
      this.showCloseConfirm.set(false);
      this.countedCashValue.set(null);
      this.closingNotes = '';
      await this.loadCashRegister();
    } catch (error) {
      this.closureError.set(error instanceof Error ? error.message : 'No se pudo cerrar la caja.');
    } finally {
      this.closureBusy.set(false);
    }
  }

  protected async showServedDetails(order: ServedOrder): Promise<void> {
    const table = firstRelation(order.restaurant_tables);
    const user = firstRelation(order.users);
    await this.loadDetails({
      id: order.id,
      totalAmount: order.total_amount,
      date: order.created_at,
      paymentMethod: null,
      status: 'Servido',
      location: table ? `Mesa ${table.table_number}` : 'Para llevar',
      waiter: user?.full_name ?? 'Sin asignar',
    });
  }

  protected async showSaleDetails(sale: SaleRecord): Promise<void> {
    const table = firstRelation(sale.restaurant_tables);
    const user = firstRelation(sale.users);
    await this.loadDetails({
      id: sale.id,
      totalAmount: sale.total_amount,
      date: sale.paid_at,
      paymentMethod: sale.payment_method,
      status: 'Pagado',
      location: table ? `Mesa ${table.table_number}` : 'Para llevar',
      waiter: user?.full_name ?? 'Sin asignar',
    });
  }

  protected closeDetails(): void {
    this.selectedDetail.set(null);
    this.detailItems.set([]);
    this.detailError.set('');
    this.paymentDetailError.set('');
    this.paymentMode.set(false);
    this.splitPaymentMode.set(false);
    this.splitPaymentNotice.set('');
    this.paymentGroups.set([]);
    this.savedPaymentGroups.set([]);
    this.paymentError.set('');
  }

  protected productName(item: OrderItemDetail): string {
    const relation = Array.isArray(item.products) ? item.products[0] : item.products;
    return relation?.name ?? `Producto #${item.product_id}`;
  }

  private async loadDetails(header: SaleDetailHeader): Promise<void> {
    this.selectedDetail.set(header);
    this.detailItems.set([]);
    this.detailError.set('');
    this.paymentDetailError.set('');
    this.paymentMode.set(false);
    this.splitPaymentMode.set(false);
    this.splitPaymentNotice.set('');
    this.paymentGroups.set([]);
    this.paymentError.set('');
    this.savedPaymentGroups.set([]);
    this.detailLoading.set(true);
    try {
      const items = await this.ordersService.listItems(header.id);
      this.detailItems.set(items);
    } catch (error) {
      this.detailError.set(error instanceof Error ? error.message : 'No se pudo cargar el detalle.');
    } finally {
      this.detailLoading.set(false);
    }

    if (this.detailError()) return;

    try {
      this.savedPaymentGroups.set(await this.salesService.listPaymentGroups(header.id));
    } catch (error) {
      this.paymentDetailError.set(
        error instanceof Error
          ? `No se pudo cargar el detalle de pagos divididos. Verifica que la migración de pagos divididos esté aplicada. ${error.message}`
          : 'No se pudo cargar el detalle de pagos divididos.',
      );
    }
  }

  protected paymentMethodLabel(method: SalePaymentMethod): string {
    const labels: Record<SalePaymentMethod, string> = {
      efectivo: 'Efectivo',
      tarjeta: 'Tarjeta',
      transferencia: 'Transferencia',
    };
    return labels[method];
  }

  protected salePaymentMethodLabel(method: string | null): string {
    if (method === 'mixto') return 'Dividido';
    if (method === 'efectivo' || method === 'tarjeta' || method === 'transferencia') {
      return this.paymentMethodLabel(method);
    }
    return method ?? '—';
  }

  protected paymentMethodIcon(method: string): string {
    switch (method) {
      case 'efectivo': return '💵';
      case 'transferencia': return '🏦';
      case 'tarjeta': return '💳';
      case 'mixto': return '▤';
      default: return '◈';
    }
  }

  protected paymentBreakdownPercentage(total: number): number {
    const salesTotal = this.totalSales();
    return salesTotal > 0 ? Math.min(100, (total / salesTotal) * 100) : 0;
  }

  protected savedGroupItemName(item: OrderPaymentGroup['order_payment_group_items'][number]): string {
    const groupRelation = Array.isArray(item.order_items) ? item.order_items[0] : item.order_items;
    const productRelation = groupRelation
      ? Array.isArray(groupRelation.products) ? groupRelation.products[0] : groupRelation.products
      : null;
    return productRelation?.name ?? 'Producto';
  }

  protected savedPaymentTotal(): number {
    return this.roundMoney(this.savedPaymentGroups().reduce((total, group) => total + group.group_amount, 0));
  }

  protected remainingPaymentTotal(): number {
    return this.roundMoney(Math.max((this.selectedDetail()?.totalAmount ?? 0) - this.savedPaymentTotal(), 0));
  }

  protected paymentProgressPercentage(): number {
    const total = this.selectedDetail()?.totalAmount ?? 0;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, (this.savedPaymentTotal() / total) * 100));
  }

  private splitPaymentInput(group: DraftPaymentGroup): SplitPaymentInput {
    return {
      payer_name: group.payer_name.trim() || null,
      items: this.detailItems()
        .map((item) => ({ order_item_id: item.id, quantity: group.quantities[item.id] ?? 0 }))
        .filter((item) => item.quantity > 0),
      tenders: this.paymentTenderAmounts(group),
    };
  }

  private syncSingleTender(group: DraftPaymentGroup): DraftPaymentGroup {
    if (group.tenders.length !== 1) return group;
    return {
      ...group,
      tenders: [{ ...group.tenders[0], amount: this.paymentGroupTotal(group) }],
    };
  }

  private paymentTenderAmounts(group: DraftPaymentGroup): { payment_method: SalePaymentMethod; amount: number }[] {
    const groupTotal = this.paymentGroupTotal(group);
    const nonCashTotal = group.tenders
      .filter((tender) => tender.payment_method !== 'efectivo')
      .reduce((total, tender) => total + tender.amount, 0);
    let cashRemaining = Math.max(groupTotal - nonCashTotal, 0);
    return group.tenders
      .map((tender) => {
        const amount = tender.payment_method === 'efectivo'
          ? Math.min(tender.amount, cashRemaining)
          : tender.amount;
        if (tender.payment_method === 'efectivo') cashRemaining = this.roundMoney(cashRemaining - amount);
        return { payment_method: tender.payment_method, amount: this.roundMoney(amount) };
      })
      .filter((tender) => tender.amount > 0);
  }

  private showPaymentMessage(message: string): void {
    this.clearPaymentMessageTimer();
    this.paymentMessage.set(message);
    this.paymentMessageTimer = setTimeout(() => {
      this.paymentMessage.set('');
      this.paymentMessageTimer = null;
    }, 10_000);
  }

  private clearPaymentMessageTimer(): void {
    if (!this.paymentMessageTimer) return;
    clearTimeout(this.paymentMessageTimer);
    this.paymentMessageTimer = null;
  }

  private orderItemsTotal(lines: { item: OrderItemDetail; quantity: number }[]): number {
    return this.roundMoney(lines.reduce((total, line) => total + line.item.unit_price * line.quantity, 0));
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private toCents(value: number): number {
    return Math.round((value + Number.EPSILON) * 100);
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

}