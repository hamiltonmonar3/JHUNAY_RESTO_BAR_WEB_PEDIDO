import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';
import { RestaurantTable } from '../tables/tables.service';

export interface RestaurantReservation {
  id: number;
  status: ReservationStatus;
  table_id: number | null;
  customer_name: string;
  phone: string | null;
  reservation_date: string;
  reservation_time: string;
  people_count: number;
  deposit: number;
  deposit_payment_method: 'efectivo' | 'transferencia' | null;
  notes: string | null;
}

export type ReservationStatus = 'pendiente' | 'realizada' | 'cancelada';

export interface ReservationInput {
  id: number | null;
  table_id: number;
  customer_name: string;
  phone: string | null;
  reservation_date: string;
  reservation_time: string;
  people_count: number;
  deposit: number;
  deposit_payment_method: 'efectivo' | 'transferencia' | null;
  notes: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReservationsService {
  private readonly supabase = inject(SupabaseService);

  async countToday(): Promise<number> {
    const today = new Date();
    const reservationDate = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    const { count, error } = await this.requireClient()
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .eq('reservation_date', reservationDate)
      .neq('status', 'cancelada');

    if (error) throw error;
    return count ?? 0;
  }

  async listAll(): Promise<RestaurantReservation[]> {
    const { data, error } = await this.requireClient()
      .from('reservations')
      .select('id, status, table_id, customer_name, phone, reservation_date, reservation_time, people_count, deposit, deposit_payment_method, notes')
      .order('reservation_date')
      .order('reservation_time');
    if (error) throw error;
    return (data ?? []) as unknown as RestaurantReservation[];
  }

  async updateStatus(id: number, status: ReservationStatus): Promise<void> {
    const { error } = await this.requireClient().rpc('set_reservation_status', {
      p_reservation_id: id,
      p_status: status,
    });
    if (error) throw error;
  }

  async listTables(): Promise<RestaurantTable[]> {
    const { data, error } = await this.requireClient()
      .from('restaurant_tables')
      .select('id, table_number, capacity, status')
      .order('table_number');
    if (error) throw error;
    return (data ?? []) as unknown as RestaurantTable[];
  }

  async saveReservation(input: ReservationInput): Promise<void> {
    const { error } = await this.requireClient().rpc('save_reservation', {
      p_reservation_id: input.id,
      p_table_id: input.table_id,
      p_customer_name: input.customer_name.trim(),
      p_phone: input.phone?.trim() || null,
      p_reservation_date: input.reservation_date,
      p_reservation_time: input.reservation_time,
      p_people_count: input.people_count,
      p_deposit: input.deposit,
      p_deposit_payment_method: input.deposit_payment_method,
      p_notes: input.notes?.trim() || null,
    });
    if (error) throw error;
  }

  async deleteReservation(id: number): Promise<void> {
    const { error } = await this.requireClient().rpc('delete_reservation', {
      p_reservation_id: id,
    });
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para administrar las reservas.');
    return client;
  }
}
