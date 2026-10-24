import { ChangeDetectorRef, Component, computed, HostListener, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { ProductOption, ProductsService } from '../products/products.service';
import { NewOrderItem, OrderItemDetail, OrderStatus, OrderSummary, OrdersService } from './orders.service';
import { RestaurantTable, TablesService } from '../tables/tables.service';

interface CartLine {
    product: ProductOption;
    quantity: number;
    notes: string;
}

interface ProductRowDraft {
    quantity: string;
    notes: string;
}

type OrderFilter = OrderStatus;

function localDayRange(date: Date): { start: string; end: string } {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
}

@Component({
    standalone: true,
    imports: [FormsModule],
    selector: 'app-orders-page',
    styleUrl: './orders.page.scss',
    templateUrl: './orders.page.html',
})
export class OrdersPage implements OnInit {
    private readonly changeDetector = inject(ChangeDetectorRef);
    private readonly auth = inject(AuthService);
    private readonly ordersService = inject(OrdersService);
    private readonly productsService = inject(ProductsService);
    private readonly tablesService = inject(TablesService);
    private readonly money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
    private readonly dateTime = new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' });

    // Signals principales
    protected readonly orders = signal<OrderSummary[]>([]);
    protected readonly loading = signal(true);
    protected readonly saving = signal(false);
    protected readonly formLoading = signal(false);
    protected readonly errorMessage = signal('');
    protected readonly formError = signal('');
    protected readonly selectedFilter = signal<OrderFilter>('armado');
    protected readonly searchQuery = signal('');
    protected readonly showForm = signal(false);
    protected readonly products = signal<ProductOption[]>([]);
    protected readonly tables = signal<RestaurantTable[]>([]);
    protected readonly selectedOrder = signal<OrderSummary | null>(null);
    protected readonly detailItems = signal<OrderItemDetail[]>([]);
    protected readonly detailLoading = signal(false);
    protected readonly detailError = signal('');
    protected readonly tablePickerOpen = signal(false);
    protected readonly tableSearch = signal('');
    protected readonly productPickerOpen = signal(false);
    protected readonly productSearch = signal('');
    protected readonly productRowDrafts = signal<Record<number, ProductRowDraft>>({});
    protected readonly cart = signal<CartLine[]>([]);
    protected readonly editingCartNoteIndex = signal<number | null>(null);

    // Edición de productos dentro del detalle de un pedido (no pagado/cancelado)
    protected readonly detailProductPickerOpen = signal(false);
    protected readonly detailProductSearch = signal('');
    protected readonly detailProductRowDrafts = signal<Record<number, ProductRowDraft>>({});
    protected readonly addingItem = signal(false);
    protected readonly updatingItemId = signal<number | null>(null);
    protected readonly removingItemId = signal<number | null>(null);


    // Confirmación de cancelación
    protected readonly showCancelConfirm = signal(false);
    protected readonly orderToCancel = signal<OrderSummary | null>(null);
    protected readonly printJob = signal<{ order: OrderSummary; items: OrderItemDetail[] } | null>(null);
    protected readonly printingOrderId = signal<number | null>(null);

    // Computed
    protected readonly filteredProducts = computed(() => {
        const query = this.productSearch().trim().toLocaleLowerCase('es');
        if (!query) return this.products();
        return this.products().filter((product) =>
            `${product.name} ${product.description ?? ''}`.toLocaleLowerCase('es').includes(query),
        );
    });

    protected readonly filteredTables = computed(() => {
        const query = this.tableSearch().trim().toLocaleLowerCase('es');
        if (!query) return this.tables();
        return this.tables().filter((table) =>
            `mesa ${table.table_number} ${table.capacity} personas ${table.status}`.includes(query),
        );
    });

    protected readonly detailFilteredProducts = computed(() => {
        const query = this.detailProductSearch().trim().toLocaleLowerCase('es');
        if (!query) return this.products();
        return this.products().filter((product) =>
            `${product.name} ${product.description ?? ''}`.toLocaleLowerCase('es').includes(query),
        );
    });

    protected readonly filteredOrders = computed(() => {
        const filter = this.selectedFilter();
        const query = this.searchQuery().trim().toLocaleLowerCase('es');

        const todaysOrders = this.orders().filter((order) => this.isToday(order.created_at));
        const byStatus = todaysOrders.filter((order) => order.status === filter);

        if (!query) return byStatus;
        return byStatus.filter((order) => {
            const byOrderNumber = String(this.dailyOrderNumber(order)).includes(query)
                || String(order.id).includes(query);
            const byTable = this.locationLabel(order).toLocaleLowerCase('es').includes(query);
            const byCustomer = (order.customer_name ?? '').toLocaleLowerCase('es').includes(query);
            const byWaiter = (this.waiterName(order) ?? '').toLocaleLowerCase('es').includes(query);
            return byOrderNumber || byTable || byCustomer || byWaiter;
        });
    });

    private readonly dailyOrderNumbers = computed(() => {
        const todaysOrders = this.orders()
            .filter((order) => this.isToday(order.created_at))
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
        return new Map(todaysOrders.map((order, index) => [order.id, index + 1]));
    });

    protected readonly cartTotal = computed(() =>
        this.cart().reduce((total, line) => total + Number(line.product.price) * line.quantity, 0),
    );

    // Filtros visibles de pedidos por estado.
    protected readonly filters: { value: OrderFilter; label: string }[] = [
        { value: 'armado', label: '☰  Armados' },
        { value: 'en_preparacion', label: '🔥  En cocina' },
        { value: 'servido', label: '✅  Servidos' },
        { value: 'pagado', label: '💰  Pagados' },
    ];

    // Form state
    protected selectedTableId = '';
    protected customerName = '';

    ngOnInit(): void {
        void this.loadOrders();
    }

    protected async loadOrders(): Promise<void> {
        this.loading.set(true);
        this.errorMessage.set('');
        try {
            const { start, end } = localDayRange(new Date());
            this.orders.set(await this.ordersService.listForDay(start, end));
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
        } finally {
            this.loading.set(false);
        }
    }

    protected async openOrderForm(): Promise<void> {
        this.resetNewOrderDraft();
        this.showForm.set(true);
        this.formLoading.set(true);
        try {
            const [products, tables] = await Promise.all([
                this.productsService.listAvailable(),
                this.tablesService.listOrderable(),
            ]);
            this.products.set(products);
            this.tables.set(tables);
        } catch (error) {
            this.formError.set(this.readableError(error));
        } finally {
            this.formLoading.set(false);
        }
    }

    protected productDraft(productId: number): ProductRowDraft {
        return this.productRowDrafts()[productId] ?? { quantity: '1', notes: '' };
    }

    protected updateProductDraft(productId: number, field: keyof ProductRowDraft, value: string | number | null): void {
        this.formError.set('');
        this.productRowDrafts.update((drafts) => {
            const currentDraft = drafts[productId] ?? { quantity: '1', notes: '' };
            return { ...drafts, [productId]: { ...currentDraft, [field]: String(value ?? '') } };
        });
    }

    protected canAddProduct(productId: number): boolean {
        const quantity = Number(this.productDraft(productId).quantity);
        return Number.isInteger(quantity) && quantity > 0;
    }

    protected addProductToCart(product: ProductOption): void {
        const draft = this.productDraft(product.id);
        const quantity = Number(draft.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
            this.formError.set('Ingresa una cantidad válida para el producto.');
            return;
        }

        this.formError.set('');
        this.cart.update((lines) => [
            ...lines,
            { product, quantity, notes: draft.notes.trim() },
        ]);
        this.productRowDrafts.update((drafts) => {
            const nextDrafts = { ...drafts };
            delete nextDrafts[product.id];
            return nextDrafts;
        });
        this.productPickerOpen.set(false);
        this.productSearch.set('');
    }

    protected removeCartLine(index: number): void {
        this.cart.update((lines) => lines.filter((_, lineIndex) => lineIndex !== index));
        this.editingCartNoteIndex.set(null);
    }

    protected toggleCartNoteEditor(index: number): void {
        this.editingCartNoteIndex.update((currentIndex) => currentIndex === index ? null : index);
    }

    protected updateCartLineNote(index: number, notes: string): void {
        this.cart.update((lines) => lines.map((line, lineIndex) =>
            lineIndex === index ? { ...line, notes } : line,
        ));
    }

    private resetNewOrderDraft(): void {
        this.cart.set([]);
        this.productRowDrafts.set({});
        this.selectedTableId = '';
        this.customerName = '';
        this.editingCartNoteIndex.set(null);
        this.tablePickerOpen.set(false);
        this.tableSearch.set('');
        this.productPickerOpen.set(false);
        this.productSearch.set('');
        this.formError.set('');
    }

    protected selectedTable(): RestaurantTable | null {
        return this.tables().find((table) => table.id === Number(this.selectedTableId)) ?? null;
    }

    protected selectTable(table: RestaurantTable | null): void {
        if (table && table.status !== 'disponible') return;
        this.selectedTableId = table ? String(table.id) : '';
        this.tablePickerOpen.set(false);
        this.tableSearch.set('');
    }

    protected onModalContentClick(event: MouseEvent): void {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('.table-picker')) this.tablePickerOpen.set(false);
        if (!event.target.closest('.product-picker')) this.productPickerOpen.set(false);
    }

    protected detailProductDraft(productId: number): ProductRowDraft {
        return this.detailProductRowDrafts()[productId] ?? { quantity: '1', notes: '' };
    }

    protected updateDetailProductDraft(
        productId: number,
        field: keyof ProductRowDraft,
        value: string | number | null,
    ): void {
        this.detailError.set('');
        this.detailProductRowDrafts.update((drafts) => {
            const currentDraft = drafts[productId] ?? { quantity: '1', notes: '' };
            return { ...drafts, [productId]: { ...currentDraft, [field]: String(value ?? '') } };
        });
    }

    protected canAddDetailProduct(productId: number): boolean {
        const quantity = Number(this.detailProductDraft(productId).quantity);
        return !this.addingItem() && Number.isInteger(quantity) && quantity > 0;
    }

    protected onDetailModalClick(event: MouseEvent): void {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('.product-picker')) this.detailProductPickerOpen.set(false);
    }

    protected async createOrder(): Promise<void> {
        const selectedTable = this.selectedTable();
        if (selectedTable && selectedTable.status !== 'disponible') {
            this.formError.set('La mesa seleccionada ya no está disponible. Elige otra mesa.');
            return;
        }

        if (!this.cart().length) {
            this.formError.set('Agrega al menos un producto al pedido.');
            return;
        }

        this.saving.set(true);
        this.formError.set('');
        try {
            const items: NewOrderItem[] = this.cart().map((line) => ({
                product_id: line.product.id,
                quantity: line.quantity,
                notes: line.notes || null,
            }));
            await this.ordersService.createOrder({
                tableId: this.selectedTableId ? Number(this.selectedTableId) : null,
                customerName: this.customerName,
                items,
            });
            this.resetNewOrderDraft();
            this.showForm.set(false);
            await this.loadOrders();
        } catch (error) {
            this.formError.set(this.readableError(error));
        } finally {
            this.saving.set(false);
        }
    }

    protected async advanceOrder(order: OrderSummary): Promise<void> {
        const nextStatus = order.status === 'armado' ? 'en_preparacion' : 'servido';
        try {
            await this.ordersService.advanceStatus(order.id, nextStatus);
            await this.loadOrders();
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
        }
    }

    protected async openOrderDetails(order: OrderSummary): Promise<void> {
        this.selectedOrder.set(order);
        this.detailItems.set([]);
        this.detailError.set('');
        this.detailLoading.set(true);
        this.resetDetailItemForm();
        try {
            const editable = this.isOrderEditable(order);
            const [items] = await Promise.all([
                this.ordersService.listItems(order.id),
                editable && this.products().length === 0
                    ? this.productsService.listAvailable().then((products) => this.products.set(products))
                    : Promise.resolve(),
            ]);
            this.detailItems.set(items);
        } catch (error) {
            this.detailError.set(this.readableError(error));
        } finally {
            this.detailLoading.set(false);
        }
    }

    protected async printOrder(order: OrderSummary): Promise<void> {
        this.printingOrderId.set(order.id);
        this.errorMessage.set('');
        try {
            const items = await this.ordersService.listItems(order.id);
            if (items.length === 0) throw new Error('Este pedido no tiene productos para imprimir.');

            this.printJob.set({ order, items });
            this.changeDetector.detectChanges();
            window.print();
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
        } finally {
            this.printJob.set(null);
            this.printingOrderId.set(null);
        }
    }

    @HostListener('window:afterprint')
    protected onAfterPrint(): void {
        this.printJob.set(null);
        this.printingOrderId.set(null);
    }

    protected closeOrderDetails(): void {
        this.selectedOrder.set(null);
        this.detailItems.set([]);
        this.detailError.set('');
        this.resetDetailItemForm();
    }

    protected isOrderEditable(order: OrderSummary): boolean {
        return order.status !== 'pagado' && order.status !== 'cancelado';
    }

    protected async addDetailItem(order: OrderSummary, product: ProductOption): Promise<void> {
        const draft = this.detailProductDraft(product.id);
        const quantity = Number(draft.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
            this.detailError.set('Ingresa una cantidad válida para el producto.');
            return;
        }

        this.addingItem.set(true);
        this.detailError.set('');
        try {
            await this.ordersService.addItem(order.id, product.id, quantity, draft.notes.trim() || null);
            this.detailProductPickerOpen.set(false);
            this.detailProductSearch.set('');
            this.detailProductRowDrafts.update((drafts) => {
                const nextDrafts = { ...drafts };
                delete nextDrafts[product.id];
                return nextDrafts;
            });
            await this.refreshOrderDetails(order.id);
        } catch (error) {
            this.detailError.set(this.readableError(error));
        } finally {
            this.addingItem.set(false);
        }
    }

    protected async incrementItem(item: OrderItemDetail): Promise<void> {
        await this.changeItemQuantity(item, item.quantity + 1);
    }

    protected async decrementItem(item: OrderItemDetail): Promise<void> {
        if (item.quantity <= 1) {
            await this.deleteItem(item);
            return;
        }
        await this.changeItemQuantity(item, item.quantity - 1);
    }

    protected async deleteItem(item: OrderItemDetail): Promise<void> {
        const order = this.selectedOrder();
        if (!order) return;
        if (this.detailItems().length <= 1) {
            this.detailError.set('El pedido debe tener al menos un producto.');
            return;
        }

        this.removingItemId.set(item.id);
        this.detailError.set('');
        try {
            await this.ordersService.removeItem(item.id);
            await this.refreshOrderDetails(order.id);
        } catch (error) {
            this.detailError.set(this.readableError(error));
        } finally {
            this.removingItemId.set(null);
        }
    }

    private async changeItemQuantity(item: OrderItemDetail, quantity: number): Promise<void> {
        const order = this.selectedOrder();
        if (!order) return;

        this.updatingItemId.set(item.id);
        this.detailError.set('');
        try {
            await this.ordersService.updateItemQuantity(item.id, quantity);
            await this.refreshOrderDetails(order.id);
        } catch (error) {
            this.detailError.set(this.readableError(error));
        } finally {
            this.updatingItemId.set(null);
        }
    }

    private async refreshOrderDetails(orderId: number): Promise<void> {
        try {
            const { start, end } = localDayRange(new Date());
            this.orders.set(await this.ordersService.listForDay(start, end));
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
        }
        this.selectedOrder.set(this.orders().find((candidate) => candidate.id === orderId) ?? null);
        try {
            this.detailItems.set(await this.ordersService.listItems(orderId));
        } catch (error) {
            this.detailError.set(this.readableError(error));
        }
    }

    private resetDetailItemForm(): void {
        this.detailProductRowDrafts.set({});
        this.detailProductSearch.set('');
        this.detailProductPickerOpen.set(false);
    }

    protected nextStatusLabel(status: OrderStatus): string {
        return status === 'armado' ? 'Enviar a cocina' : 'Marcar servido';
    }

    protected statusLabel(status: OrderStatus): string {
        const labels: Record<OrderStatus, string> = {
            armado: 'Armado',
            en_preparacion: 'En cocina', // ← corregido
            servido: 'Servido',
            pagado: 'Pagado',
            cancelado: 'Cancelado',
        };
        return labels[status];
    }

    protected paymentMethodName(method: string): string {
        const labels: Record<string, string> = {
            efectivo: 'Efectivo',
            tarjeta: 'Tarjeta',
            transferencia: 'Transferencia',
            mixto: 'Dividido',
        };
        return labels[method] ?? method;
    }

    protected locationLabel(order: OrderSummary): string {
        const relation = Array.isArray(order.restaurant_tables)
            ? order.restaurant_tables[0]
            : order.restaurant_tables;
        if (relation) return `Mesa ${relation.table_number}`;
        return order.customer_name || 'Para llevar';
    }

    protected waiterName(order: OrderSummary): string | null {
        const relation = Array.isArray(order.users) ? order.users[0] : order.users;
        return relation?.full_name ?? null;
    }

    protected dailyOrderNumber(order: OrderSummary): number {
        return this.dailyOrderNumbers().get(order.id) ?? 0;
    }

    private isToday(value: string): boolean {
        const date = new Date(value);
        const now = new Date();
        return (
            date.getFullYear() === now.getFullYear() &&
            date.getMonth() === now.getMonth() &&
            date.getDate() === now.getDate()
        );
    }

    protected productName(item: OrderItemDetail): string {
        const relation = Array.isArray(item.products) ? item.products[0] : item.products;
        return relation?.name ?? `Producto #${item.product_id}`;
    }

    protected formatCurrency(value: number): string {
        return this.money.format(value);
    }

    protected lineTotal(line: CartLine): number {
        return line.product.price * line.quantity;
    }

    protected formatDate(value: string): string {
        return this.dateTime.format(new Date(value));
    }

    protected closeOrderForm(): void {
        if (this.saving()) return;
        this.showForm.set(false);
        this.resetNewOrderDraft();
    }

    // ========== CANCELACIÓN ==========
    protected requestCancelOrder(order: OrderSummary): void {
        if (order.status !== 'armado') {
            this.errorMessage.set('Solo se pueden cancelar pedidos que estén en estado Armado.');
            return;
        }
        this.orderToCancel.set(order);
        this.showCancelConfirm.set(true);
    }

    protected async confirmCancelOrder(): Promise<void> {
        const order = this.orderToCancel();
        if (!order) return;

        try {
            await this.ordersService.cancelOrder(order.id);
            this.showCancelConfirm.set(false);
            this.orderToCancel.set(null);
            await this.loadOrders();
            this.closeOrderDetails();
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
            this.showCancelConfirm.set(false);
        }
    }

    protected closeCancelConfirm(): void {
        this.showCancelConfirm.set(false);
        this.orderToCancel.set(null);
    }

    private readableError(error: unknown): string {
        return error instanceof Error ? error.message : 'Ocurrió un error al procesar el pedido.';
    }
}