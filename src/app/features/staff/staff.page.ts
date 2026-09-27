import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StaffRecord, StaffRole, StaffService } from './staff.service';

type StaffTab = 'people' | 'roles';

@Component({
  imports: [FormsModule],
  selector: 'app-staff-page',
  styleUrl: './staff.page.scss',
  templateUrl: './staff.page.html',
})
export class StaffPage implements OnInit {
  private readonly staffService = inject(StaffService);
  protected readonly people = signal<StaffRecord[]>([]);
  protected readonly roles = signal<StaffRole[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly activeTab = signal<StaffTab>('people');
  protected readonly showPersonForm = signal(false);
  protected readonly showRoleForm = signal(false);
  protected personId: number | null = null;
  protected personName = '';
  protected personEmail = '';
  protected personUsername = '';
  protected personRoleId = '';
  protected personActive = true;
  protected roleId: number | null = null;
  protected roleName = '';
  protected roleDescription = '';

  ngOnInit(): void {
    void this.loadStaff();
  }

  protected async loadStaff(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');
    try {
      const [people, roles] = await Promise.all([
        this.staffService.listStaff(),
        this.staffService.listRoles(),
      ]);
      this.people.set(people);
      this.roles.set(roles);
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected roleNameFor(roleId: number): string {
    return this.roles().find((role) => role.id === roleId)?.name ?? 'Sin rol';
  }

  protected openPersonForm(person?: StaffRecord): void {
    this.personId = person?.id ?? null;
    this.personName = person?.full_name ?? '';
    this.personEmail = person?.email ?? '';
    this.personUsername = person?.username ?? '';
    this.personRoleId = person ? String(person.role_id) : '';
    this.personActive = person?.is_active ?? true;
    this.showPersonForm.set(true);
    this.errorMessage.set('');
  }

  protected async savePerson(): Promise<void> {
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.staffService.saveStaff({
        id: this.personId,
        role_id: Number(this.personRoleId),
        full_name: this.personName,
        email: this.personEmail,
        username: this.personUsername,
        is_active: this.personActive,
      });
      this.showPersonForm.set(false);
      await this.loadStaff();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected toggleActive(person: StaffRecord): void {
    void this.staffService.saveStaff({
      id: person.id,
      role_id: person.role_id,
      full_name: person.full_name,
      email: person.email,
      username: person.username,
      is_active: !person.is_active,
    }).then(() => this.loadStaff()).catch((error: unknown) => this.errorMessage.set(this.readableError(error)));
  }

  protected openRoleForm(role?: StaffRole): void {
    this.roleId = role?.id ?? null;
    this.roleName = role?.name ?? '';
    this.roleDescription = role?.description ?? '';
    this.showRoleForm.set(true);
    this.errorMessage.set('');
  }

  protected async saveRole(): Promise<void> {
    this.saving.set(true);
    this.errorMessage.set('');
    try {
      await this.staffService.saveRole({ id: this.roleId, name: this.roleName, description: this.roleDescription });
      this.showRoleForm.set(false);
      await this.loadStaff();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteRole(role: StaffRole): Promise<void> {
    if (!window.confirm(`¿Eliminar el rol “${role.name}”?`)) return;
    try {
      await this.staffService.deleteRole(role.id);
      await this.loadStaff();
    } catch (error) {
      this.errorMessage.set(this.readableError(error));
    }
  }

  protected closeForms(): void {
    if (this.saving()) return;
    this.showPersonForm.set(false);
    this.showRoleForm.set(false);
  }

  private readableError(error: unknown): string {
    return error instanceof Error ? error.message : 'No se pudo guardar el personal.';
  }
}