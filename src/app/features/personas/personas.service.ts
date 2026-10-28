import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export type PersonMovementType = 'por_cobrar' | 'por_pagar' | 'descuento' | 'cobrado' | 'pagado';
export type WritablePersonMovementType = Exclude<PersonMovementType, 'descuento'>;

export interface PersonRecord {
  id: number;
  full_name: string;
  identification: string | null;
  is_active: boolean;
  created_at: string;
}

export interface PersonMovement {
  id: number;
  persona_id: number;
  movement_type: PersonMovementType;
  amount: number;
  description: string;
  movement_date: string;
  payment_method: 'efectivo' | 'transferencia' | null;
  created_at: string;
  personas: { full_name: string } | { full_name: string }[] | null;
}

@Injectable({ providedIn: 'root' })
export class PersonasService {
  private readonly supabase = inject(SupabaseService);

  async listPeople(): Promise<PersonRecord[]> {
    const { data, error } = await this.requireClient()
      .from('personas')
      .select('id, full_name, identification, is_active, created_at')
      .order('full_name');
    if (error) throw error;
    return (data ?? []) as unknown as PersonRecord[];
  }

  async savePerson(input: {
    id: number | null;
    fullName: string;
    identification: string;
    isActive: boolean;
  }): Promise<void> {
    const { error } = await this.requireClient().rpc('save_persona', {
      p_persona_id: input.id,
      p_full_name: input.fullName.trim(),
      p_identification: input.identification.trim() || null,
      p_is_active: input.isActive,
    });
    if (error) throw error;
  }

  async deletePerson(id: number): Promise<void> {
    const { error } = await this.requireClient().rpc('delete_persona', { p_persona_id: id });
    if (error) throw error;
  }

  async listMovements(): Promise<PersonMovement[]> {
    const { data, error } = await this.requireClient()
      .from('persona_financial_movements')
      .select('id, persona_id, movement_type, amount, description, movement_date, payment_method, created_at, personas(full_name)')
      .order('movement_date', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    return ((data ?? []) as unknown as PersonMovement[]).map((movement) => ({
      ...movement,
      amount: Number(movement.amount),
    }));
  }

  async recordMovement(input: {
    personaId: number;
    type: WritablePersonMovementType;
    amount: number;
    description: string;
    date: string;
    paymentMethod: 'efectivo' | 'transferencia' | null;
  }): Promise<void> {
    const { error } = await this.requireClient().rpc('record_persona_financial_movement', {
      p_persona_id: input.personaId,
      p_movement_type: input.type,
      p_amount: input.amount,
      p_description: input.description.trim(),
      p_movement_date: input.date,
      p_payment_method: input.paymentMethod,
    });
    if (error) throw error;
  }

  async updateMovement(input: {
    id: number;
    type: WritablePersonMovementType;
    amount: number;
    description: string;
    date: string;
  }): Promise<void> {
    const { error } = await this.requireClient().rpc('update_persona_financial_movement', {
      p_movement_id: input.id,
      p_movement_type: input.type,
      p_amount: input.amount,
      p_description: input.description.trim(),
      p_movement_date: input.date,
    });
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para administrar personas y sus valores.');
    return client;
  }
}
