import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Método no permitido.' }, 405);

  const input = await request.json().catch(() => null);
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  const pin = typeof input?.pin === 'string' ? input.pin : '';
  if (!username || !/^[A-Za-z0-9]{6,12}$/.test(pin)) {
    return respond({ error: 'Usuario o PIN incorrectos.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return respond({ error: 'Servicio de acceso no configurado.' }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: staff, error: staffError } = await adminClient
    .from('users')
    .select('id, full_name, email, auth_user_id, is_active, roles(name)')
    .eq('username', username)
    .maybeSingle();

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const candidateEmail = !staffError && staff?.is_active && staff?.auth_user_id
    ? staff.email
    : 'invalid-login@invalid.invalid';
  const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
    email: candidateEmail,
    password: pin,
  });

  if (
    staffError
    || !staff?.is_active
    || !staff.auth_user_id
    || authError
    || !authData.session
    || !authData.user
    || authData.user.id !== staff.auth_user_id
  ) {
    return respond({ error: 'Usuario o PIN incorrectos.' }, 401);
  }

  const roleRelation = Array.isArray(staff.roles) ? staff.roles[0] : staff.roles;
  const role = roleRelation?.name;
  if (!role) return respond({ error: 'La cuenta no tiene un rol asignado.' }, 401);

  return new Response(JSON.stringify({
    access_token: authData.session.access_token,
    refresh_token: authData.session.refresh_token,
    staff: {
      id: staff.id,
      full_name: staff.full_name,
      email: staff.email,
      role,
    },
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});