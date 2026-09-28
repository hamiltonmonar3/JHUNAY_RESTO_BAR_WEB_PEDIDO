import { Component, computed, inject, OnInit, signal } from '@angular/core';
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

type OrderFilter = 'todos' | OrderStatus;

@Component({
    standalone: true,
    imports: [FormsModule],
    selector: 'app-orders-page',
    styleUrl: './orders.page.scss',
    templateUrl: './orders.page.html',
})
export class OrdersPage implements OnInit {
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
    protected readonly selectedFilter = signal<OrderFilter>('todos');
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
    protected readonly cart = signal<CartLine[]>([]);

    // Confirmación de cancelación
    protected readonly showCancelConfirm = signal(false);
    protected readonly orderToCancel = signal<OrderSummary | null>(null);

    // Computed
    protected readonly filteredProducts = computed(() => {
        const query = this.productSearch().trim().toLocaleLowerCase('es');
        if (!query) return this.products();
        return this.products().filter((product) =>
            product.name.toLocaleLowerCase('es').includes(query),
        );
    });

    protected readonly filteredTables = computed(() => {
        const query = this.tableSearch().trim().toLocaleLowerCase('es');
        if (!query) return this.tables();
        return this.tables().filter((table) =>
            `mesa ${table.table_number} ${table.capacity} personas ${table.status}`.includes(query),
        );
    });

    protected readonly filteredOrders = computed(() => {
        const filter = this.selectedFilter();
        const allOrders = this.orders();
        if (filter === 'todos') return allOrders;
        return allOrders.filter((order) => order.status === filter);
    });

    protected readonly cartTotal = computed(() =>
        this.cart().reduce((total, line) => total + Number(line.product.price) * line.quantity, 0),
    );

    // Filtros con iconos
    protected readonly filters: { value: OrderFilter; label: string }[] = [
        { value: 'todos', label: '☰  Todos' },
        { value: 'armado', label: '📦  Armados' },
        { value: 'en_preparacion', label: '🔥  En cocina' },
        { value: 'servido', label: '✅  Servidos' },
        { value: 'pagado', label: '💰  Pagados' },
        { value: 'cancelado', label: '❌  Cancelados' },
    ];

    // Form state
    protected selectedProductId = '';
    protected selectedTableId = '';
    protected quantity = 1;
    protected itemNotes = '';
    protected customerName = '';

    ngOnInit(): void {
        void this.loadOrders();
    }

    protected async loadOrders(): Promise<void> {
        this.loading.set(true);
        this.errorMessage.set('');
        try {
            this.orders.set(await this.ordersService.listRecent());
        } catch (error) {
            this.errorMessage.set(this.readableError(error));
        } finally {
            this.loading.set(false);
        }
    }

    protected async openOrderForm(): Promise<void> {
        this.showForm.set(true);
        this.formLoading.set(true);
        this.formError.set('');
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

    protected addCartLine(): void {
        const product = this.products().find((item) => item.id === Number(this.selectedProductId));
        const requestedQuantity = Math.trunc(Number(this.quantity));
        if (!product || !Number.isFinite(requestedQuantity) || requestedQuantity < 1) return;

        this.cart.update((lines) => [
            ...lines,
            {
                product,
                quantity: requestedQuantity,
                notes: this.itemNotes.trim(),
            },
        ]);
        this.selectedProductId = '';
        this.quantity = 1;
        this.itemNotes = '';
    }

    protected removeCartLine(index: number): void {
        this.cart.update((lines) => lines.filter((_, lineIndex) => lineIndex !== index));
    }

    protected selectedTable(): RestaurantTable | null {
        return this.tables().find((table) => table.id === Number(this.selectedTableId)) ?? null;
    }

    protected selectTable(table: RestaurantTable | null): void {
        this.selectedTableId = table ? String(table.id) : '';
        this.tablePickerOpen.set(false);
        this.tableSearch.set('');
    }

    protected selectedProduct(): ProductOption | null {
        return this.products().find((product) => product.id === Number(this.selectedProductId)) ?? null;
    }

    protected selectProduct(product: ProductOption): void {
        this.selectedProductId = String(product.id);
        this.productPickerOpen.set(false);
        this.productSearch.set('');
    }

    protected onModalContentClick(event: MouseEvent): void {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('.table-picker')) this.tablePickerOpen.set(false);
        if (!event.target.closest('.product-picker')) this.productPickerOpen.set(false);
    }

    protected async createOrder(): Promise<void> {
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
            this.showForm.set(false);
            this.cart.set([]);
            this.customerName = '';
            this.selectedTableId = '';
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
        try {
            this.detailItems.set(await this.ordersService.listItems(order.id));
        } catch (error) {
            this.detailError.set(this.readableError(error));
        } finally {
            this.detailLoading.set(false);
        }
    }

    protected closeOrderDetails(): void {
        this.selectedOrder.set(null);
        this.detailItems.set([]);
        this.detailError.set('');
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

    protected locationLabel(order: OrderSummary): string {
        const relation = Array.isArray(order.restaurant_tables)
            ? order.restaurant_tables[0]
            : order.restaurant_tables;
        if (relation) return `Mesa ${relation.table_number}`;
        return order.customer_name || 'Para llevar';
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
        this.formError.set('');
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