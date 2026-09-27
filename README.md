# Jhunay Resto Bar

Aplicación Angular para pedidos y ventas. La raíz abre un login independiente y el panel solo aparece con sesión de personal activa. Angular consume Supabase mediante su API HTTPS; no abre conexiones PostgreSQL desde el navegador.

## Inicio local

```bash
npm install
npm start
```

Abre `http://localhost:4200/`.

## Preparar Supabase

La URL y la clave pública están en `src/environments/environment.ts`. En el frontend solo debe usarse la publishable key o la clave `anon`; nunca añadas `service_role` ni credenciales PostgreSQL.

1. En Supabase Auth, crea un usuario por cada empleado, usando el mismo correo que aparece en `public.users.email`. Configura un PIN numérico propio de 6 a 12 dígitos como contraseña de Auth y confirma la cuenta. No reutilices PIN de prueba.
2. Aplica las migraciones del proyecto con `npx supabase db push`. La primera agrega `username`, el vínculo con Auth, RLS y las funciones transaccionales; las siguientes habilitan las escrituras de administración y la RPC auditada de inventario.
3. Instala y autentica Supabase CLI, enlaza el proyecto y despliega la función. `supabase login` solicitará un Access Token creado en el dashboard; introdúcelo directamente en el terminal, nunca en el código ni en el chat:

```bash
npm install --save-dev supabase
npx supabase login
npx supabase link --project-ref nzqluplbbpwqzgcsriex
npx supabase functions deploy login-with-pin
```

La función usa `SUPABASE_SERVICE_ROLE_KEY` únicamente en el entorno servidor de Supabase. No la copies a Angular ni a `environment.ts`. El endpoint entrega errores genéricos y delega la comprobación del PIN a Supabase Auth; el campo `users.password` no se consulta.

Para el primer administrador, usa un perfil existente en `public.users` y crea su cuenta Auth con el mismo email. Para nuevos empleados, crea primero el perfil desde **Personal** y luego la cuenta confirmada en Auth con el mismo correo; el trigger la vincula al perfil. El formulario de Personal no guarda PIN.

La migración revoca a `anon` y `authenticated` el acceso directo a `users.password`, pero no borra los valores preexistentes. Después de crear y probar las cuentas Auth, elimina los PIN en texto plano ejecutando en SQL Editor:

```sql
UPDATE public.users SET password = NULL;
```

Los roles `admin` y `caja`/`cajero` pueden consultar todos los pedidos; `mesero` solo los propios. Solo administración y caja pueden cobrar. Productos disponibles y categorías tienen lectura pública; las operaciones de pedido, pago e inventario pasan por funciones SQL transaccionales.

## Interfaz

- `/login`: acceso independiente con usuario y PIN.
- `/pedidos`: carrito, selección de mesa y estados de cocina.
- `/ventas`: cobro, consulta por fecha de pago e informe por método.
- `/productos`: CRUD de productos y categorías, solo para `admin`.
- `/mesas`: CRUD de mesas y capacidades, solo para `admin`.
- `/inventario`: stock y registro auditable de entradas, salidas y ajustes; el historial no se elimina.
- `/personal`: perfiles y roles; los empleados se desactivan para conservar sus pedidos históricos.

Las rutas administrativas están protegidas por un guard de rol y por políticas RLS. Cambiar existencias desde Menú no está permitido; usa los movimientos de Inventario.

La cabecera de acceso usa temporalmente una fotografía gastronómica remota y una composición naranja/negro. El banner exacto adjunto no está como archivo en el workspace; para usarlo, guárdalo como `public/jhunay-header.png` y reemplaza la imagen de `src/app/features/auth/login.page.html`.

Build: `npm run build`. Pruebas: `npm test -- --watch=false`.

