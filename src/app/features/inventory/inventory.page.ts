import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryMovement, InventoryProduct, InventoryService } from './inventory.service';

@Component({
  imports: [FormsModule],
  selector: 'app-inventory-page',
  styleUrl: './inventory.page.scss',
  templateUrl: './inventory.page.html',
})
export class InventoryPage implements OnInit {
  private readonly inventoryService = inject(InventoryService);
  private readonly dateTime = new Intl.DateTimeFormat('es-EC', { dateStyle: 'short', timeStyle: 'short' });
  protected readonly products = signal<InventoryProduct[]>([]);
  protected readonly movements = signal<InventoryMovement[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly showForm = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly lowStockProducts = computed(() =>
    this.products().filter((product) => product.current_stock <= product.min_stock),
  );

  protected productId = '';
  protected movementType: InventoryMovement['movement_type'] = 'entrada';
  protected quantity = 1;
  protected reason = '';

  ngOnInit(): void {
    void this.loadInventory();
  }

  protected async loadInventory(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [products, movements] = await Promise.all([
        this.inventoryService.listProducts(),
        this.inventoryService.listMovements(),
      ]);
      this.products.set(products);
      this.movements.set(movements);
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected openMovement(product?: InventoryProduct): void {
    this.productId = product ? String(product.id) : '';
    this.movementType = 'entrada';
    this.quantity = 1;
    this.reason = '';
    this.errorMessage.set('');
    this.showForm.set(true);
  }

  protected async saveMovement(): Promise<void> {
    const amount = Number(this.quantity);
    if (!this.productId || !Number.isInteger(amount) || amount < 0 || (this.movementType !== 'ajuste' && amount === 0)) {
      this.errorMessage.set('Selecciona un producto e ingresa una cantidad válida.');
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.inventoryService.recordMovement({
        productId: Number(this.productId),
        movementType: this.movementType,
        quantity: amount,
        reason: this.reason,
      });
      this.showForm.set(false);
      await this.loadInventory();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected productName(productId: number): string {
    const product = this.products().find((item) => item.id === productId);
    if (product) return product.name;
    return 'Producto';
  }

  protected movementProductName(movement: InventoryMovement): string {
    const relation = Array.isArray(movement.products) ? movement.products[0] : movement.products;
    return relation?.name ?? this.productName(movement.product_id);
  }

  protected movementUserName(movement: InventoryMovement): string {
    const relation = Array.isArray(movement.users) ? movement.users[0] : movement.users;
    return relation?.full_name ?? '—';
  }

  protected movementLabel(type: InventoryMovement['movement_type']): string {
    return type === 'entrada' ? 'Entrada' : type === 'salida' ? 'Salida' : 'Ajuste';
  }

  protected formatDate(value: string): string {
    return this.dateTime.format(new Date(value));
  }

  protected closeForm(): void {
    if (!this.saving()) this.showForm.set(false);
  }

  private readableError(error: unknown): string {
    return error instanceof Error ? error.message : 'No se pudo guardar el movimiento.';
  }
}