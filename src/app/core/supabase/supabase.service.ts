import { Injectable } from '@angular/core';
import { createClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly client = environment.supabaseAnonKey
    ? createClient(environment.supabaseUrl, environment.supabaseAnonKey)
    : null;

  get isConfigured(): boolean {
    return this.client !== null;
  }
}