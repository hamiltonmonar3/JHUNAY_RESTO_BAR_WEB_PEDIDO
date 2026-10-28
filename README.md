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

1. En Supabase Auth, crea un usuario por cada empleado, usando el mismo correo que aparece en `public.users.email`. Configura una clave alfanumérica propia de 6 a 12 caracteres (solo letras y números) como contraseña de Auth y confirma la cuenta. No reutilices claves de prueba.
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
- `/ventas`: consulta y cobro de pedidos servidos; se puede pagar toda la cuenta o repartir productos/cantidades por persona, combinando efectivo, tarjeta y transferencia. El tab Ingresos adicionales permite registrar, editar y eliminar ingresos manuales en efectivo o transferencia, consultar el desglose por fecha, método y origen, y ver el número de movimientos en la pestaña.
- `/reservas`: registra y administra reservas con cliente, mesa, fecha, hora, número de personas y abono opcional en efectivo o transferencia. Los abonos se contabilizan como ingresos adicionales de la caja abierta; está disponible para Administrador y Operador.
- `/productos`: CRUD de productos, categorías y promociones, solo para `admin`. Las promociones se guardan como referencia y no se aplican a pedidos ni ventas.
- `/mesas`: CRUD de mesas y capacidades, solo para `admin`.
- `/inventario`: stock y registro auditable de entradas, salidas y ajustes; el historial no se elimina.
- `/personal`: perfiles y roles; los empleados se desactivan para conservar sus pedidos históricos.
- `/personas`: saldos por cobrar y por pagar, con cobros y pagos registrados como ingresos adicionales o egresos del día, según el método de pago y con caja abierta.

Las rutas administrativas están protegidas por un guard de rol y por políticas RLS. Cambiar existencias desde Menú no está permitido; usa los movimientos de Inventario.

La cabecera de acceso usa temporalmente una fotografía gastronómica remota y una composición naranja/negro. El banner exacto adjunto no está como archivo en el workspace; para usarlo, guárdalo como `public/jhunay-header.png` y reemplaza la imagen de `src/app/features/auth/login.page.html`.

Build: `npm run build`. Pruebas: `npm test -- --watch=false`.
