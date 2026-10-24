-- Consolida el modelo de roles a únicamente 2 roles operativos:
--   - Administrador: control total del sistema, usuarios, reportes y configuración.
--   - Operador: gestión de mesas, toma de pedidos, registro de cobros y caja diaria.
--
-- Fusiona cualquier rol heredado ('admin', 'caja', 'cajero', 'mesero', etc.) en estos
-- dos roles, reasignando al personal existente, y actualiza todas las políticas RLS
-- y funciones de seguridad para usar únicamente 'Administrador' / 'Operador'.
-- A partir de este cambio, el rol "Operador" puede ver y editar TODOS los pedidos
-- (ya no existe la restricción de "solo mis propios pedidos" que tenía el mesero).

-- =====================================================================
-- 1) Migración de datos: fusionar roles existentes en los 2 definitivos
-- =====================================================================
DO $$
DECLARE
  v_admin_id integer;
  v_operador_id integer;
  v_legacy_id integer;
BEGIN
  -- Rol Administrador: reutiliza uno existente ('admin'/'administrador') o lo crea
  SELECT id INTO v_admin_id
  FROM public.roles
  WHERE lower(name) IN ('admin', 'administrador')
  ORDER BY id
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    INSERT INTO public.roles (name, description)
    VALUES ('Administrador', 'Control total del sistema, gestión de usuarios, reportes y configuración.')
    RETURNING id INTO v_admin_id;
  ELSE
    UPDATE public.roles
    SET name = 'Administrador',
        description = 'Control total del sistema, gestión de usuarios, reportes y configuración.'
    WHERE id = v_admin_id;
  END IF;

  -- Rol Operador: reutiliza uno de los roles operativos existentes o lo crea
  SELECT id INTO v_operador_id
  FROM public.roles
  WHERE lower(name) IN ('mesero', 'cajero', 'caja', 'operador')
    AND id <> v_admin_id
  ORDER BY id
  LIMIT 1;

  IF v_operador_id IS NULL THEN
    INSERT INTO public.roles (name, description)
    VALUES ('Operador', 'Gestión de mesas, toma de pedidos, registro de cobros y caja diaria.')
    RETURNING id INTO v_operador_id;
  ELSE
    UPDATE public.roles
    SET name = 'Operador',
        description = 'Gestión de mesas, toma de pedidos, registro de cobros y caja diaria.'
    WHERE id = v_operador_id;
  END IF;

  -- Reasigna el personal de cualquier otro rol heredado ('caja', 'cajero', 'mesero', etc.)
  -- hacia el rol Operador definitivo, y elimina esos roles sobrantes.
  FOR v_legacy_id IN
    SELECT id FROM public.roles
    WHERE id NOT IN (v_admin_id, v_operador_id)
  LOOP
    UPDATE public.users SET role_id = v_operador_id WHERE role_id = v_legacy_id;
  END LOOP;

  DELETE FROM public.roles WHERE id NOT IN (v_admin_id, v_operador_id);
END $$;

-- =====================================================================
-- 2) Políticas RLS: reemplazar los chequeos de rol heredados
-- =====================================================================
DROP POLICY IF EXISTS products_staff_read ON public.products;
CREATE POLICY products_staff_read
  ON public.products FOR SELECT TO authenticated
  USING (is_available IS TRUE OR public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS roles_staff_read ON public.roles;
CREATE POLICY roles_staff_read
  ON public.roles FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

DROP POLICY IF EXISTS users_self_or_admin_read ON public.users;
CREATE POLICY users_self_or_admin_read
  ON public.users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS tables_staff_read ON public.restaurant_tables;
CREATE POLICY tables_staff_read
  ON public.restaurant_tables FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

DROP POLICY IF EXISTS inventory_admin_read ON public.inventory_movements;
CREATE POLICY inventory_admin_read
  ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS orders_staff_read ON public.orders;
CREATE POLICY orders_staff_read
  ON public.orders FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

DROP POLICY IF EXISTS categories_admin_manage ON public.categories;
CREATE POLICY categories_admin_manage
  ON public.categories FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS products_admin_manage ON public.products;
CREATE POLICY products_admin_manage
  ON public.products FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS tables_admin_manage ON public.restaurant_tables;
CREATE POLICY tables_admin_manage
  ON public.restaurant_tables FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS roles_admin_manage ON public.roles;
CREATE POLICY roles_admin_manage
  ON public.roles FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS users_admin_manage ON public.users;
CREATE POLICY users_admin_manage
  ON public.users FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

-- =====================================================================
-- 3) Funciones SECURITY DEFINER: actualizar chequeos de rol
-- =====================================================================
CREATE OR REPLACE FUNCTION public.create_order(
  p_table_id integer,
  p_customer_name text,
  p_items jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_order_id integer;
  v_item jsonb;
  v_product_id integer;
  v_quantity integer;
  v_product record;
  v_subtotal numeric(10, 2);
  v_total numeric(10, 2) := 0;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'An order must contain at least one item';
  END IF;

  IF p_table_id IS NOT NULL THEN
    PERFORM 1
    FROM public.restaurant_tables
    WHERE id = p_table_id AND status <> 'reservada'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected table is unavailable';
    END IF;
  END IF;

  INSERT INTO public.orders (table_id, user_id, status, total_amount, customer_name)
  VALUES (p_table_id, v_staff_id, 'armado', 0, NULLIF(btrim(p_customer_name), ''))
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS items(value)
  LOOP
    v_product_id := (v_item ->> 'product_id')::integer;
    v_quantity := (v_item ->> 'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;

    SELECT price, is_available, track_stock, current_stock
    INTO v_product
    FROM public.products
    WHERE id = v_product_id
    FOR UPDATE;

    IF NOT FOUND OR v_product.is_available IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'A selected product is unavailable';
    END IF;
    IF COALESCE(v_product.track_stock, false)
      AND COALESCE(v_product.current_stock, 0) < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for product %', v_product_id;
    END IF;

    v_subtotal := v_product.price * v_quantity;
    INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, subtotal, notes)
    VALUES (
      v_order_id,
      v_product_id,
      v_quantity,
      v_product.price,
      v_subtotal,
      NULLIF(btrim(v_item ->> 'notes'), '')
    );
    v_total := v_total + v_subtotal;

    IF COALESCE(v_product.track_stock, false) THEN
      UPDATE public.products
      SET current_stock = current_stock - v_quantity
      WHERE id = v_product_id;

      INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
      VALUES (v_product_id, v_staff_id, 'salida', v_quantity, 'Venta - pedido ' || v_order_id);
    END IF;
  END LOOP;

  UPDATE public.orders
  SET total_amount = v_total, updated_at = CURRENT_TIMESTAMP
  WHERE id = v_order_id;

  IF p_table_id IS NOT NULL THEN
    UPDATE public.restaurant_tables
    SET status = 'ocupada'
    WHERE id = p_table_id;
  END IF;

  RETURN v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_order_status(
  p_order_id integer,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_staff_role text;
  v_order_status text;
BEGIN
  v_staff_id := public.current_staff_id();
  v_staff_role := public.current_staff_role();
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_order_status
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF NOT (
    (v_order_status = 'armado' AND p_status = 'en_preparacion')
    OR (v_order_status = 'en_preparacion' AND p_status = 'servido')
  ) THEN
    RAISE EXCEPTION 'Invalid order status transition';
  END IF;

  UPDATE public.orders
  SET status = p_status, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_payment(
  p_order_id integer,
  p_payment_method text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_role text;
  v_table_id integer;
BEGIN
  v_staff_role := public.current_staff_role();
  IF COALESCE(v_staff_role, '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Cashier or administrator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
    RAISE EXCEPTION 'Unsupported payment method';
  END IF;

  SELECT table_id INTO v_table_id
  FROM public.orders
  WHERE id = p_order_id AND status = 'servido'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only served orders can be paid';
  END IF;

  UPDATE public.orders
  SET status = 'pagado',
      payment_method = p_payment_method,
      paid_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_order_id;

  IF v_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE table_id = v_table_id AND status IN ('armado', 'en_preparacion', 'servido')
  ) THEN
    UPDATE public.restaurant_tables
    SET status = 'disponible'
    WHERE id = v_table_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_inventory_movement(
  p_product_id integer,
  p_movement_type text,
  p_quantity integer,
  p_reason text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_current_stock integer;
  v_new_stock integer;
  v_movement_quantity integer;
  v_movement_id integer;
BEGIN
  IF public.current_staff_role() IS DISTINCT FROM 'Administrador' THEN
    RAISE EXCEPTION 'Administrator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_movement_type IS NULL OR p_movement_type NOT IN ('entrada', 'salida', 'ajuste') THEN
    RAISE EXCEPTION 'Unsupported inventory movement type';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 0
    OR (p_movement_type IN ('entrada', 'salida') AND p_quantity = 0) THEN
    RAISE EXCEPTION 'Invalid inventory quantity';
  END IF;

  v_staff_id := public.current_staff_id();
  SELECT COALESCE(current_stock, 0) INTO v_current_stock
  FROM public.products
  WHERE id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  IF p_movement_type = 'entrada' THEN
    v_new_stock := v_current_stock + p_quantity;
    v_movement_quantity := p_quantity;
  ELSIF p_movement_type = 'salida' THEN
    IF p_quantity > v_current_stock THEN
      RAISE EXCEPTION 'Insufficient stock';
    END IF;
    v_new_stock := v_current_stock - p_quantity;
    v_movement_quantity := p_quantity;
  ELSE
    v_new_stock := p_quantity;
    v_movement_quantity := abs(p_quantity - v_current_stock);
  END IF;

  UPDATE public.products SET current_stock = v_new_stock WHERE id = p_product_id;
  INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
  VALUES (p_product_id, v_staff_id, p_movement_type, v_movement_quantity, NULLIF(btrim(p_reason), ''))
  RETURNING id INTO v_movement_id;

  RETURN v_movement_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_order_item(
  p_order_id integer,
  p_product_id integer,
  p_quantity integer,
  p_notes text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_staff_role text;
  v_order record;
  v_product record;
  v_subtotal numeric(10, 2);
  v_item_id integer;
BEGIN
  v_staff_id := public.current_staff_id();
  v_staff_role := public.current_staff_role();
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Item quantity must be greater than zero';
  END IF;

  SELECT id, status, user_id INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status IN ('pagado', 'cancelado') THEN
    RAISE EXCEPTION 'Paid or cancelled orders cannot be modified';
  END IF;

  SELECT price, is_available, track_stock, current_stock
  INTO v_product
  FROM public.products
  WHERE id = p_product_id
  FOR UPDATE;
  IF NOT FOUND OR v_product.is_available IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'A selected product is unavailable';
  END IF;
  IF COALESCE(v_product.track_stock, false)
    AND COALESCE(v_product.current_stock, 0) < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock for product %', p_product_id;
  END IF;

  v_subtotal := v_product.price * p_quantity;

  INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, subtotal, notes)
  VALUES (p_order_id, p_product_id, p_quantity, v_product.price, v_subtotal, NULLIF(btrim(p_notes), ''))
  RETURNING id INTO v_item_id;

  IF COALESCE(v_product.track_stock, false) THEN
    UPDATE public.products
    SET current_stock = current_stock - p_quantity
    WHERE id = p_product_id;

    INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
    VALUES (p_product_id, v_staff_id, 'salida', p_quantity, 'Venta - pedido ' || p_order_id);
  END IF;

  UPDATE public.orders
  SET total_amount = total_amount + v_subtotal, updated_at = CURRENT_TIMESTAMP
  WHERE id = p_order_id;

  RETURN v_item_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_order_item_quantity(
  p_order_item_id integer,
  p_quantity integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_staff_role text;
  v_item record;
  v_order record;
  v_product record;
  v_delta integer;
  v_new_subtotal numeric(10, 2);
BEGIN
  v_staff_id := public.current_staff_id();
  v_staff_role := public.current_staff_role();
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Item quantity must be greater than zero';
  END IF;

  SELECT id, order_id, product_id, quantity, unit_price INTO v_item
  FROM public.order_items
  WHERE id = p_order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item not found';
  END IF;

  SELECT id, status, user_id INTO v_order
  FROM public.orders
  WHERE id = v_item.order_id
  FOR UPDATE;
  IF v_order.status IN ('pagado', 'cancelado') THEN
    RAISE EXCEPTION 'Paid or cancelled orders cannot be modified';
  END IF;

  v_delta := p_quantity - v_item.quantity;
  IF v_delta <> 0 THEN
    SELECT track_stock, current_stock INTO v_product
    FROM public.products
    WHERE id = v_item.product_id
    FOR UPDATE;

    IF v_delta > 0 AND COALESCE(v_product.track_stock, false)
      AND COALESCE(v_product.current_stock, 0) < v_delta THEN
      RAISE EXCEPTION 'Insufficient stock for product %', v_item.product_id;
    END IF;

    IF COALESCE(v_product.track_stock, false) THEN
      UPDATE public.products
      SET current_stock = current_stock - v_delta
      WHERE id = v_item.product_id;

      INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
      VALUES (
        v_item.product_id,
        v_staff_id,
        CASE WHEN v_delta > 0 THEN 'salida' ELSE 'entrada' END,
        abs(v_delta),
        'Ajuste de pedido ' || v_item.order_id
      );
    END IF;
  END IF;

  v_new_subtotal := v_item.unit_price * p_quantity;

  UPDATE public.order_items
  SET quantity = p_quantity, subtotal = v_new_subtotal
  WHERE id = p_order_item_id;

  UPDATE public.orders
  SET total_amount = total_amount - (v_item.unit_price * v_item.quantity) + v_new_subtotal,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = v_item.order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_order_item(
  p_order_item_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_staff_role text;
  v_item record;
  v_order record;
  v_track_stock boolean;
BEGIN
  v_staff_id := public.current_staff_id();
  v_staff_role := public.current_staff_role();
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  SELECT id, order_id, product_id, quantity, subtotal INTO v_item
  FROM public.order_items
  WHERE id = p_order_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item not found';
  END IF;

  SELECT id, status, user_id INTO v_order
  FROM public.orders
  WHERE id = v_item.order_id
  FOR UPDATE;
  IF v_order.status IN ('pagado', 'cancelado') THEN
    RAISE EXCEPTION 'Paid or cancelled orders cannot be modified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.order_items WHERE order_id = v_item.order_id AND id <> p_order_item_id
  ) THEN
    RAISE EXCEPTION 'An order must contain at least one item';
  END IF;

  SELECT track_stock INTO v_track_stock
  FROM public.products
  WHERE id = v_item.product_id
  FOR UPDATE;

  DELETE FROM public.order_items WHERE id = p_order_item_id;

  IF COALESCE(v_track_stock, false) THEN
    UPDATE public.products
    SET current_stock = current_stock + v_item.quantity
    WHERE id = v_item.product_id;

    INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
    VALUES (v_item.product_id, v_staff_id, 'entrada', v_item.quantity, 'Eliminación de ítem - pedido ' || v_item.order_id);
  END IF;

  UPDATE public.orders
  SET total_amount = total_amount - v_item.subtotal, updated_at = CURRENT_TIMESTAMP
  WHERE id = v_item.order_id;
END;
$$;
