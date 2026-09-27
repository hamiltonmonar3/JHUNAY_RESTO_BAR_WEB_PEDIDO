import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

export interface StaffProfile {
  id: number;
  full_name: string;
  email: string;
  role: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseService);

  async getSession() {
    const client = this.supabase.client;
    if (!client) return null;

    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async getActiveStaffProfile(): Promise<StaffProfile | null> {
    const client = this.supabase.client;
    const session = await this.getSession();
    if (!client || !session) return null;

    const { data, error } = await client
      .from('users')
      .select('id, full_name, email, is_active, roles(name)')
      .eq('auth_user_id', session.user.id)
      .maybeSingle();

    if (error) {
      if (error.code === '42703') throw new Error('Ejecuta la migración de seguridad de Supabase antes de ingresar.');
      throw error;
    }
    const staff = data as unknown as {
      id: number;
      full_name: string;
      email: string;
      is_active: boolean;
      roles: { name: string } | { name: string }[] | null;
    } | null;
    if (!staff || staff.is_active !== true) return null;

    const role = Array.isArray(staff.roles) ? staff.roles[0]?.name : staff.roles?.name;
    if (!role) return null;

    return {
      id: staff.id,
      full_name: staff.full_name,
      email: staff.email,
      role,
    };
  }

  async signIn(username: string, pin: string): Promise<StaffProfile> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la clave pública de Supabase antes de ingresar.');
    if (!/^\d{6,12}$/.test(pin)) throw new Error('Usa un PIN numérico de 6 a 12 dígitos y no reutilices PIN de prueba.');

    const { data, error } = await client.functions.invoke('login-with-pin', {
      body: { username: username.trim(), pin },
    });
    if (error) {
      const context = (error as Error & { context?: Response }).context;
      const responseBody = context instanceof Response
        ? await context.clone().json().catch(() => null) as { error?: string } | null
        : null;

      if (context instanceof Response && context.status === 401) {
        throw new Error(
          'No se pudo iniciar sesión. Verifica que tu cuenta de Supabase Auth esté creada, confirmada y vinculada al perfil; si ya lo está, revisa el usuario y PIN.',
        );
      }
      if (responseBody?.error === 'Servicio de acceso no configurado.') {
        throw new Error('La función está desplegada, pero falta configurarla en Supabase. Revisa sus secretos y la migración.');
      }
      if (context instanceof Response && context.status === 404) {
        throw new Error('No se encontró login-with-pin. Despliega la función en el proyecto Supabase configurado.');
      }
      throw new Error(responseBody?.error || 'No se pudo conectar con el servicio de acceso. Revisa Supabase y vuelve a intentar.');
    }

    const sessionTokens = data as { access_token?: string; refresh_token?: string } | null;
    if (!sessionTokens?.access_token || !sessionTokens.refresh_token) {
      throw new Error('Usuario o PIN incorrectos.');
    }

    const { error: sessionError } = await client.auth.setSession({
      access_token: sessionTokens.access_token,
      refresh_token: sessionTokens.refresh_token,
    });
    if (sessionError) throw sessionError;

    try {
      const profile = await this.getActiveStaffProfile();
      if (!profile) throw new Error('La cuenta no está vinculada a un usuario activo del restaurante.');
      return profile;
    } catch (error) {
      await client.auth.signOut();
      throw error;
    }
  }

  async signOut(): Promise<void> {
    const client = this.supabase.client;
    if (!client) return;

    const { error } = await client.auth.signOut();
    if (error) throw error;
  }
}