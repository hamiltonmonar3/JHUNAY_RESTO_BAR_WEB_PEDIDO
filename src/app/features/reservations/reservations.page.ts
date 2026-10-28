import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TablePaginationComponent, TablePaginationState } from '../../shared/table-pagination';
import { ReservationInput, ReservationsService, RestaurantReservation } from './reservations.service';
import { RestaurantTable } from '../tables/tables.service';

@Component({
  imports: [FormsModule, TablePaginationComponent],
  selector: 'app-reservations-page',
  styleUrl: './reservations.page.scss',
  templateUrl: './reservations.page.html',
})
export class ReservationsPage implements OnInit {
  private readonly reservationsService = inject(ReservationsService);
  private readonly dateFormatter = new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium' });
  private readonly currencyFormatter = new Intl.NumberFormat('es-EC', {
    style: 'currency',
    currency: 'USD',
  });
  protected readonly reservations = signal<RestaurantReservation[]>([]);
  protected readonly tables = signal<RestaurantTable[]>([]);
  protected readonly pagination = new TablePaginationState();
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly showForm = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly reservationToDelete = signal<RestaurantReservation | null>(null);
  protected readonly deleting = signal(false);

  protected reservationId: number | null = null;
  protected tableId: number | null = null;
  protected customerName = '';
  protected phone = '';
  protected reservationDate = '';
  protected reservationTime = '';
  protected peopleCount = 2;
  protected deposit: number | null = null;
  protected depositPaymentMethod: 'efectivo' | 'transferencia' | null = null;
  protected notes = '';

  ngOnInit(): void {
    void this.loadReservations();
  }

  protected async loadReservations(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [reservations, tables] = await Promise.all([
        this.reservationsService.listAll(),
        this.reservationsService.listTables(),
      ]);
      this.reservations.set(reservations);
      this.tables.set(tables);
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected openForm(reservation?: RestaurantReservation): void {
    this.reservationId = reservation?.id ?? null;
    this.tableId = reservation?.table_id ?? null;
    this.customerName = reservation?.customer_name ?? '';
    this.phone = reservation?.phone ?? '';
    this.reservationDate = reservation?.reservation_date ?? this.today();
    this.reservationTime = reservation?.reservation_time.slice(0, 5) ?? '';
    this.peopleCount = reservation?.people_count ?? 2;
    this.deposit = reservation && Number(reservation.deposit) > 0 ? Number(reservation.deposit) : null;
    this.depositPaymentMethod = reservation?.deposit_payment_method ?? null;
    this.notes = reservation?.notes ?? '';
    this.errorMessage.set('');
    this.showForm.set(true);
  }

  protected async saveReservation(): Promise<void> {
    const peopleCount = Number(this.peopleCount);
    const deposit = Number(this.deposit ?? 0);
    if (!this.customerName.trim() || this.tableId === null || !this.reservationDate || !this.reservationTime
      || !Number.isInteger(peopleCount) || peopleCount < 1
      || !Number.isFinite(deposit) || deposit < 0
      || (this.reservationId === null && deposit > 0 && !this.depositPaymentMethod)) {
      this.errorMessage.set(deposit > 0 && this.reservationId === null && !this.depositPaymentMethod
        ? 'Selecciona si el abono se recibió en efectivo o por transferencia.'
        : 'Completa los datos de la reserva e ingresa valores válidos.');
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    try {
      const input: ReservationInput = {
        id: this.reservationId,
        table_id: this.tableId,
        customer_name: this.customerName,
        phone: this.phone,
        reservation_date: this.reservationDate,
        reservation_time: this.reservationTime,
        people_count: peopleCount,
        deposit,
        deposit_payment_method: deposit > 0 ? this.depositPaymentMethod : null,
        notes: this.notes,
      };
      await this.reservationsService.saveReservation(input);
      this.showForm.set(false);
      await this.loadReservations();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected deleteReservation(reservation: RestaurantReservation): void {
    this.errorMessage.set('');
    this.reservationToDelete.set(reservation);
  }

  protected cancelDeleteReservation(): void {
    if (this.deleting()) return;
    this.reservationToDelete.set(null);
  }

  protected async confirmDeleteReservation(): Promise<void> {
    const reservation = this.reservationToDelete();
    if (!reservation || this.deleting()) return;
    this.deleting.set(true);
    this.errorMessage.set('');
    try {
      await this.reservationsService.deleteReservation(reservation.id);
      this.reservationToDelete.set(null);
      await this.loadReservations();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.deleting.set(false);
    }
  }

  protected closeForm(): void {
    if (!this.saving()) this.showForm.set(false);
  }

  protected formatDate(value: string): string {
    return this.dateFormatter.format(new Date(`${value}T12:00:00`));
  }

  protected formatTime(value: string): string {
    return value.slice(0, 5);
  }

  protected formatDeposit(value: number): string {
    return Number(value) > 0 ? this.currencyFormatter.format(Number(value)) : '—';
  }

  protected paymentMethodLabel(method: RestaurantReservation['deposit_payment_method']): string {
    return method === 'efectivo' ? 'Efectivo' : method === 'transferencia' ? 'Transferencia' : 'No registrado';
  }

  protected tableNumber(tableId: number | null): number | string {
    return this.tables().find((table) => table.id === tableId)?.table_number ?? '—';
  }

  protected availableTables(): RestaurantTable[] {
    return this.tables().filter((table) =>
      table.status === 'disponible' || table.id === this.tableId,
    );
  }

  private today(): string {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
    return localDate.toISOString().slice(0, 10);
  }

  private readableError(error: unknown): string {
    const message = error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        && typeof error.message === 'string'
        ? error.message
        : '';
    if (message.includes('There is no open cash register to record the deposit')) {
      return 'Abre la caja antes de registrar un abono.';
    }
    if (message.includes('A reservation deposit cannot be changed after it is recorded')) {
      return 'El abono ya registrado no se puede modificar desde la edición.';
    }
    if (message.includes('The selected table is not available')
      || message.includes('The selected table already has a reservation')) {
      return 'La mesa seleccionada ya no está disponible. Actualiza la lista y elige otra mesa.';
    }
    return message || 'No se pudo guardar la reserva.';
  }
}
