import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TablePaginationComponent, TablePaginationState } from '../../shared/table-pagination';
import { PersonMovement, PersonMovementType, PersonRecord, PersonasService, WritablePersonMovementType } from './personas.service';

const movementLabels: Record<PersonMovementType, string> = {
  por_cobrar: 'Por cobrar',
  por_pagar: 'Por pagar',
  descuento: 'Descuento (histórico)',
  cobrado: 'Cobrado',
  pagado: 'Pagado',
};

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

@Component({
  imports: [FormsModule, TablePaginationComponent],
  selector: 'app-personas-page',
  styleUrl: './personas.page.scss',
  templateUrl: './personas.page.html',
})
export class PersonasPage implements OnInit {
  private readonly financeService = inject(PersonasService);
  protected readonly people = signal<PersonRecord[]>([]);
  protected readonly searchQuery = signal('');
  protected readonly movementHistorySearch = signal('');
  protected readonly movementHistorySort = signal<{ key: 'date' | 'amount'; direction: 'asc' | 'desc' }>({
    key: 'date',
    direction: 'desc',
  });
  protected readonly movements = signal<PersonMovement[]>([]);
  protected readonly pagination = new TablePaginationState();
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly showMovementForm = signal(false);
  protected readonly showPersonForm = signal(false);
  protected readonly movementFormError = signal('');
  protected readonly personToDelete = signal<PersonRecord | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal('');
  protected readonly movementTypes: PersonMovementType[] = ['por_cobrar', 'por_pagar', 'cobrado', 'pagado'];
  protected readonly labels = movementLabels;
  protected personId: number | null = null;
  protected personFullName = '';
  protected personIdentification = '';
  protected personActive = true;
  protected selectedPersonId = '';
  protected movementId: number | null = null;
  protected movementType: PersonMovementType = 'por_pagar';
  protected movementAmount = 0;
  protected movementDescription = '';
  protected movementDate = localDateValue(new Date());

  protected readonly filteredPeople = computed(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase('es');
    if (!query) return this.people();
    return this.people().filter((person) =>
      `${person.full_name} ${person.identification ?? ''}`.toLocaleLowerCase('es').includes(query),
    );
  });
  protected readonly filteredSortedMovements = computed(() => {
    const query = this.movementHistorySearch().trim().toLocaleLowerCase('es');
    const sort = this.movementHistorySort();
    return this.movements()
      .filter((movement) => {
        if (!query) return true;
        const searchableText = [
          movement.movement_date,
          this.formatDate(movement.movement_date),
          this.movementPerson(movement),
          this.labels[movement.movement_type],
          this.movementStatus(movement.movement_type),
          movement.description,
          movement.amount.toFixed(2),
          this.formatCurrency(movement.amount),
        ].join(' ').toLocaleLowerCase('es');
        return searchableText.includes(query);
      })
      .sort((left, right) => {
        const comparison = sort.key === 'date'
          ? left.movement_date.localeCompare(right.movement_date) || left.id - right.id
          : left.amount - right.amount || left.id - right.id;
        return sort.direction === 'asc' ? comparison : -comparison;
      });
  });
  protected readonly personLifetimeTotals = computed(() => {
    const totals = new Map<number, { receivable: number; payable: number; collected: number; paid: number }>();
    for (const person of this.people()) totals.set(person.id, { receivable: 0, payable: 0, collected: 0, paid: 0 });
    for (const movement of this.movements()) {
      const total = totals.get(movement.persona_id);
      if (!total) continue;
      if (movement.movement_type === 'por_cobrar') total.receivable += movement.amount;
      else if (movement.movement_type === 'por_pagar') total.payable += movement.amount;
      else if (movement.movement_type === 'cobrado') total.collected += movement.amount;
      else if (movement.movement_type === 'pagado') total.paid += movement.amount;
    }
    return totals;
  });
  protected readonly summaryTotals = computed(() => {
    let receivable = 0;
    let payable = 0;
    let netPayable = 0;
    for (const person of this.people()) {
      const totals = this.personTotals(person);
      receivable += totals.receivable;
      payable += Math.max(totals.netPayable, 0);
      netPayable += totals.netPayable;
    }
    return { receivable, payable, netPayable };
  });

  ngOnInit(): void {
    void this.loadData();
  }

  protected async loadData(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [people, movements] = await Promise.all([
        this.financeService.listPeople(),
        this.financeService.listMovements(),
      ]);
      this.people.set(people);
      this.movements.set(movements);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudieron cargar personas y movimientos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  protected onMovementHistorySearchChange(value: string): void {
    this.movementHistorySearch.set(value);
    this.pagination.setPage(1, this.filteredSortedMovements().length);
  }

  protected toggleMovementHistorySort(key: 'date' | 'amount'): void {
    const current = this.movementHistorySort();
    this.movementHistorySort.set({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    });
    this.pagination.setPage(1, this.filteredSortedMovements().length);
  }

  protected movementHistorySortIndicator(key: 'date' | 'amount'): string {
    const sort = this.movementHistorySort();
    if (sort.key !== key) return '↕';
    return sort.direction === 'asc' ? '↑' : '↓';
  }

  protected movementHistorySortAria(key: 'date' | 'amount'): string {
    const sort = this.movementHistorySort();
    return sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  }

  protected personTotals(person: PersonRecord): { receivable: number; payable: number; netPayable: number } {
    const total = this.personLifetimeTotals().get(person.id) ?? { receivable: 0, payable: 0, collected: 0, paid: 0 };
    const receivable = total.receivable - total.collected;
    const payable = total.payable - total.paid;
    return { receivable, payable, netPayable: payable - receivable };
  }

  protected movementStatus(type: PersonMovementType): string {
    if (type === 'por_cobrar' || type === 'por_pagar') return 'Registrado';
    if (type === 'descuento') return 'Histórico';
    return this.labels[type];
  }

  protected openSettlementForm(person: PersonRecord, type: 'cobrado' | 'pagado'): void {
    this.openMovementForm(type);
    this.selectedPersonId = String(person.id);
    const totals = this.personTotals(person);
    this.movementAmount = type === 'cobrado' ? totals.receivable : Math.max(0, totals.netPayable);
    this.movementDescription = type === 'cobrado' ? 'Cobro de saldo pendiente' : 'Pago de saldo pendiente';
  }

  protected settlementLimit(): number {
    const person = this.people().find((item) => item.id === Number(this.selectedPersonId));
    if (!person) return 0;
    const totals = this.personTotals(person);
    return this.movementType === 'cobrado' ? totals.receivable
      : this.movementType === 'pagado' ? Math.max(0, totals.netPayable)
        : 0;
  }

  protected movementPerson(movement: PersonMovement): string {
    const relation = Array.isArray(movement.personas) ? movement.personas[0] : movement.personas;
    return relation?.full_name ?? this.people().find((person) => person.id === movement.persona_id)?.full_name ?? `Persona #${movement.persona_id}`;
  }

  protected movementPersonById(id: number): string {
    const movement = this.movements().find((item) => item.id === id);
    return movement ? this.movementPerson(movement) : 'Persona';
  }

  protected openPersonForm(person?: PersonRecord): void {
    this.personId = person?.id ?? null;
    this.personFullName = person?.full_name ?? '';
    this.personIdentification = person?.identification ?? '';
    this.personActive = person?.is_active ?? true;
    this.errorMessage.set('');
    this.showPersonForm.set(true);
  }

  protected async savePerson(): Promise<void> {
    if (!this.personFullName.trim()) {
      this.errorMessage.set('Ingresa el nombre de la persona.');
      return;
    }
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.financeService.savePerson({
        id: this.personId,
        fullName: this.personFullName,
        identification: this.personIdentification,
        isActive: this.personActive,
      });
      this.showPersonForm.set(false);
      await this.loadData();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo guardar la persona.');
    } finally {
      this.saving.set(false);
    }
  }

  protected requestDeletePerson(person: PersonRecord): void {
    this.deleteError.set('');
    this.personToDelete.set(person);
  }

  protected cancelDeletePerson(): void {
    if (!this.deleting()) this.personToDelete.set(null);
  }

  protected async confirmDeletePerson(): Promise<void> {
    const person = this.personToDelete();
    if (!person || this.deleting()) return;

    this.deleting.set(true);
    this.deleteError.set('');
    this.errorMessage.set('');
    try {
      await this.financeService.deletePerson(person.id);
      this.personToDelete.set(null);
      await this.loadData();
    } catch (error) {
      this.deleteError.set(error instanceof Error ? error.message : 'No se pudo eliminar la persona.');
    } finally {
      this.deleting.set(false);
    }
  }

  protected openMovementForm(type: WritablePersonMovementType = 'por_pagar'): void {
    this.movementId = null;
    this.selectedPersonId = this.people().find((person) => person.is_active)?.id.toString() ?? '';
    this.movementType = type;
    this.movementAmount = 0;
    this.movementDescription = '';
    this.movementDate = localDateValue(new Date());
    this.movementFormError.set('');
    this.showMovementForm.set(true);
  }

  protected openEditMovement(movement: PersonMovement): void {
    this.movementId = movement.id;
    this.selectedPersonId = String(movement.persona_id);
    this.movementType = movement.movement_type;
    this.movementAmount = movement.amount;
    this.movementDescription = movement.description;
    this.movementDate = movement.movement_date;
    this.movementFormError.set('');
    this.showMovementForm.set(true);
  }

  protected closeMovementForm(): void {
    if (!this.saving()) this.showMovementForm.set(false);
  }

  protected async saveMovement(): Promise<void> {
    const amount = Number(this.movementAmount);
    if (this.movementType === 'descuento') {
      this.movementFormError.set('Los descuentos ya no se pueden registrar.');
      return;
    }
    if ((!this.movementId && !this.selectedPersonId) || !this.movementDescription.trim() || !Number.isFinite(amount) || amount <= 0 || !this.movementDate) {
      this.movementFormError.set('Selecciona una persona e ingresa fecha, descripción y un monto mayor que cero.');
      return;
    }
    if (!this.movementId && (this.movementType === 'cobrado' || this.movementType === 'pagado') && amount > this.settlementLimit()) {
      this.movementFormError.set(`El monto no puede superar el saldo pendiente de ${this.formatCurrency(this.settlementLimit())}.`);
      return;
    }
    this.saving.set(true);
    this.movementFormError.set('');
    try {
      const values = {
        type: this.movementType,
        amount,
        description: this.movementDescription,
        date: this.movementDate,
      };
      if (this.movementId) {
        await this.financeService.updateMovement({ id: this.movementId, ...values });
      } else {
        await this.financeService.recordMovement({
          personaId: Number(this.selectedPersonId),
          ...values,
        });
      }
      this.showMovementForm.set(false);
      await this.loadData();
    } catch (error) {
      this.movementFormError.set(error instanceof Error ? error.message : 'No se pudo guardar el movimiento.');
    } finally {
      this.saving.set(false);
    }
  }

  protected formatCurrency(value: number): string {
    return new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value);
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-EC', { dateStyle: 'short' }).format(new Date(`${value}T12:00:00`));
  }
}
