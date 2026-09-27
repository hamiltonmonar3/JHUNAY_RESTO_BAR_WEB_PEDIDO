import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface RestaurantTable {
  id: number;
  table_number: number;
  capacity: number;
  status: string;
}

@Injectable({ providedIn: 'root' })
export class TablesService {
  private readonly supabase = inject(SupabaseService);

  async listOrderable(): Promise<RestaurantTable[]> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de consultar las mesas.');

    const { data, error } = await client
      .from('restaurant_tables')
      .select('id, table_number, capacity, status')
      .neq('status', 'reservada')
      .order('table_number');

    if (error) throw error;
    return data as unknown as RestaurantTable[];
  }

  async listAll(): Promise<RestaurantTable[]> {
    const client = this.requireClient();
    const { data, error } = await client
      .from('restaurant_tables')
      .select('id, table_number, capacity, status')
      .order('table_number');
    if (error) throw error;
    return data as unknown as RestaurantTable[];
  }

  async saveTable(input: { id: number | null; table_number: number; capacity: number; status: string }): Promise<void> {
    const client = this.requireClient();
    const values = { table_number: input.table_number, capacity: input.capacity, status: input.status };
    const { error } = input.id
      ? await client.from('restaurant_tables').update(values).eq('id', input.id)
      : await client.from('restaurant_tables').insert(values);
    if (error) throw error;
  }

  async deleteTable(id: number): Promise<void> {
    const { error } = await this.requireClient().from('restaurant_tables').delete().eq('id', id);
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase antes de administrar mesas.');
    return client;
  }
}