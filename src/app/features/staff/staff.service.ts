import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../../core/supabase/supabase.service';

export interface StaffRole {
  id: number;
  name: string;
  description: string | null;
}

export interface StaffRecord {
  id: number;
  role_id: number;
  full_name: string;
  email: string;
  username: string;
  is_active: boolean;
  auth_user_id: string | null;
  roles: { name: string } | { name: string }[] | null;
}

@Injectable({ providedIn: 'root' })
export class StaffService {
  private readonly supabase = inject(SupabaseService);

  async listRoles(): Promise<StaffRole[]> {
    const { data, error } = await this.requireClient().from('roles').select('id, name, description').order('name');
    if (error) throw error;
    return data as unknown as StaffRole[];
  }

  async listStaff(): Promise<StaffRecord[]> {
    const { data, error } = await this.requireClient()
      .from('users')
      .select('id, role_id, full_name, email, username, is_active, auth_user_id, roles(name)')
      .order('full_name');
    if (error) throw error;
    return data as unknown as StaffRecord[];
  }

  async saveStaff(input: {
    id: number | null;
    role_id: number;
    full_name: string;
    email: string;
    username: string;
    is_active: boolean;
  }): Promise<void> {
    const client = this.requireClient();
    const values = {
      role_id: input.role_id,
      full_name: input.full_name.trim(),
      email: input.email.trim().toLowerCase(),
      username: input.username.trim(),
      is_active: input.is_active,
    };
    const { error } = input.id
      ? await client.from('users').update(values).eq('id', input.id)
      : await client.from('users').insert(values);
    if (error) throw error;
  }

  async saveRole(input: { id: number | null; name: string; description: string }): Promise<void> {
    const client = this.requireClient();
    const values = { name: input.name.trim().toLowerCase(), description: input.description.trim() || null };
    const { error } = input.id
      ? await client.from('roles').update(values).eq('id', input.id)
      : await client.from('roles').insert(values);
    if (error) throw error;
  }

  async deleteRole(id: number): Promise<void> {
    const { error } = await this.requireClient().from('roles').delete().eq('id', id);
    if (error) throw error;
  }

  private requireClient() {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura Supabase para administrar el personal.');
    return client;
  }
}