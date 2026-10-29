import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

export interface StaffProfile {
  id: number;
  full_name: string;
  email: string;
  role: string;
}

interface LoginResponse {
  access_token?: string;
  refresh_token?: string;
  staff?: StaffProfile;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseService);
  private readonly profileCacheDurationMs = 30_000;
  private cachedProfileUserId: string | null = null;
  private cachedProfile: StaffProfile | null = null;
  private cachedProfileAt = 0;

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
    if (!client || !session) {
      this.clearCachedProfile();
      return null;
    }
    if (this.cachedProfileUserId === session.user.id
      && this.cachedProfile
      && Date.now() - this.cachedProfileAt < this.profileCacheDurationMs) {
      return this.cachedProfile;
    }

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
    if (!staff || staff.is_active !== true) {
      this.clearCachedProfile();
      return null;
    }

    const role = Array.isArray(staff.roles) ? staff.roles[0]?.name : staff.roles?.name;
    if (!role) {
      this.clearCachedProfile();
      return null;
    }

    const profile = {
      id: staff.id,
      full_name: staff.full_name,
      email: staff.email,
      role,
    };
    this.cachedProfileUserId = session.user.id;
    this.cachedProfile = profile;
    this.cachedProfileAt = Date.now();
    return profile;
  }

  async signIn(username: string, pin: string): Promise<StaffProfile> {
    const client = this.supabase.client;
    if (!client) throw new Error('Configura la clave pública de Supabase antes de ingresar.');
    if (!/^[A-Za-z0-9]{6,12}$/.test(pin)) throw new Error('Usa una clave alfanumérica de 6 a 12 caracteres y no reutilices una clave de prueba.');
    this.clearCachedProfile();

    const { data, error } = await client.functions.invoke('login-with-pin', {
      body: { username: username.trim(), pin },
      timeout: 20_000,
    });
    if (error) {
      const context = (error as Error & { context?: unknown }).context;
      if (context instanceof Error && context.name === 'AbortError') {
        throw new Error('El servicio de acceso tardó demasiado en responder. Revisa tu conexión e inténtalo de nuevo.');
      }
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

    const sessionTokens = data as LoginResponse | null;
    if (!sessionTokens?.access_token || !sessionTokens.refresh_token) {
      throw new Error('Usuario o PIN incorrectos.');
    }

    const { data: sessionData, error: sessionError } = await client.auth.setSession({
      access_token: sessionTokens.access_token,
      refresh_token: sessionTokens.refresh_token,
    });
    if (sessionError) throw sessionError;

    try {
      const sessionUserId = sessionData.session?.user.id;
      if (!sessionUserId) throw new Error('No se pudo confirmar la sesión autenticada.');
      const returnedProfile = sessionTokens.staff;
      const profile = returnedProfile
        && Number.isInteger(returnedProfile.id)
        && typeof returnedProfile.full_name === 'string'
        && typeof returnedProfile.email === 'string'
        && typeof returnedProfile.role === 'string'
        ? returnedProfile
        : await this.getActiveStaffProfile();
      if (!profile) throw new Error('La cuenta no está vinculada a un usuario activo del restaurante.');
      this.cachedProfileUserId = sessionUserId;
      this.cachedProfile = profile;
      this.cachedProfileAt = Date.now();
      return profile;
    } catch (error) {
      this.clearCachedProfile();
      await client.auth.signOut();
      throw error;
    }
  }

  async signOut(): Promise<void> {
    const client = this.supabase.client;
    this.clearCachedProfile();
    if (!client) return;

    const { error } = await client.auth.signOut();
    if (error) throw error;
  }

  private clearCachedProfile(): void {
    this.cachedProfileUserId = null;
    this.cachedProfile = null;
    this.cachedProfileAt = 0;
  }
}