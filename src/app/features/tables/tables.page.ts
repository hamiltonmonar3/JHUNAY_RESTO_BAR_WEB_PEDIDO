import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RestaurantTable, TablesService } from './tables.service';

@Component({
  imports: [FormsModule],
  selector: 'app-tables-page',
  styleUrl: './tables.page.scss',
  templateUrl: './tables.page.html',
})
export class TablesPage implements OnInit {
  private readonly tablesService = inject(TablesService);
  protected readonly tables = signal<RestaurantTable[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly showForm = signal(false);
  protected tableId: number | null = null;
  protected tableNumber = 1;
  protected capacity = 4;
  protected status = 'disponible';
  protected readonly statuses = ['disponible', 'ocupada', 'reservada'];

  ngOnInit(): void {
    void this.loadTables();
  }

  protected async loadTables(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      this.tables.set(await this.tablesService.listAll());
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected openForm(table?: RestaurantTable): void {
    this.tableId = table?.id ?? null;
    this.tableNumber = table?.table_number ?? this.nextTableNumber();
    this.capacity = table?.capacity ?? 4;
    this.status = table?.status ?? 'disponible';
    this.showForm.set(true);
    this.errorMessage.set('');
  }

  protected async saveTable(): Promise<void> {
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.tablesService.saveTable({
        id: this.tableId,
        table_number: Number(this.tableNumber),
        capacity: Number(this.capacity),
        status: this.status,
      });
      this.showForm.set(false);
      await this.loadTables();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteTable(table: RestaurantTable): Promise<void> {
    if (!window.confirm(`¿Eliminar Mesa ${table.table_number}?`)) return;
    try {
      await this.tablesService.deleteTable(table.id);
      await this.loadTables();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    }
  }

  protected closeForm(): void {
    if (!this.saving()) this.showForm.set(false);
  }

  private nextTableNumber(): number {
    return this.tables().reduce((highest, table) => Math.max(highest, table.table_number), 0) + 1;
  }

  private readableError(error: unknown): string {
    return error instanceof Error ? error.message : 'No se pudo guardar la mesa.';
  }
}