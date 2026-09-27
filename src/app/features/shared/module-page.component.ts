import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'app-module-page',
  template: `
    <section class="module-page">
      <p class="eyebrow">MÓDULO DEL SISTEMA</p>
      <h1>{{ title }}</h1>
      <p class="module-description">{{ description }}</p>
      <div class="module-status">
        <span class="status-mark" aria-hidden="true">{{ tableName }}</span>
        <div><strong>Área preparada</strong><p>La vista consultará las tablas <code>{{ tableName }}</code> de Supabase.</p></div>
      </div>
    </section>
  `,
  styles: `
    .module-page { max-width: 760px; }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: 1px; }
    h1 { margin: 0; font-family: 'Manrope', sans-serif; font-size: 30px; }
    .module-description { margin: 8px 0 28px; color: var(--muted); }
    .module-status { display: flex; align-items: center; gap: 15px; padding: 20px; border: 1px solid var(--line); background: var(--paper); }
    .status-mark { display: grid; width: 42px; height: 42px; flex: 0 0 42px; place-items: center; border-radius: 50%; background: #35190e; color: #ff9d5f; font-size: 10px; font-weight: 700; }
    .module-status strong { font-size: 13px; }
    .module-status p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
    code { color: var(--green-dark); }
  `,
})
export class ModulePage {
  private readonly route = inject(ActivatedRoute);
  protected readonly title = this.route.snapshot.data['title'] as string;
  protected readonly description = this.route.snapshot.data['description'] as string;
  protected readonly tableName = this.route.snapshot.data['table'] as string;
}