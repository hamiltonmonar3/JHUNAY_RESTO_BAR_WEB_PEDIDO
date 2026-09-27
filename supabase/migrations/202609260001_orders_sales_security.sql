ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS username varchar(50);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key
  ON public.users (username)
  WHERE username IS NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_key
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

UPDATE public.users AS staff
SET auth_user_id = auth_user.id
FROM auth.users AS auth_user
WHERE staff.auth_user_id IS NULL
  AND auth_user.email_confirmed_at IS NOT NULL
  AND lower(staff.email) = lower(auth_user.email);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

UPDATE public.orders
SET paid_at = updated_at
WHERE status = 'pagado' AND paid_at IS NULL;

CREATE OR REPLACE FUNCTION public.current_staff_id()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT staff.id
  FROM public.users AS staff
  WHERE staff.auth_user_id = auth.uid()
    AND staff.is_active IS TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_staff_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT role.name
  FROM public.users AS staff
  JOIN public.roles AS role ON role.id = staff.role_id
  WHERE staff.auth_user_id = auth.uid()
    AND staff.is_active IS TRUE
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.current_staff_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_staff_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_staff_role() TO authenticated;

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.categories, public.products TO anon, authenticated;
GRANT SELECT ON public.roles, public.restaurant_tables,
  public.inventory_movements, public.orders, public.order_items TO authenticated;
REVOKE ALL ON TABLE public.users FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, role_id, full_name, email, is_active, auth_user_id, username)
  ON TABLE public.users TO authenticated;

DROP POLICY IF EXISTS categories_public_read ON public.categories;
CREATE POLICY categories_public_read
  ON public.categories FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS products_public_read ON public.products;
CREATE POLICY products_public_read
  ON public.products FOR SELECT TO anon
  USING (is_available IS TRUE);

DROP POLICY IF EXISTS products_staff_read ON public.products;
CREATE POLICY products_staff_read
  ON public.products FOR SELECT TO authenticated
  USING (is_available IS TRUE OR public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS roles_staff_read ON public.roles;
CREATE POLICY roles_staff_read
  ON public.roles FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('admin', 'caja', 'cajero', 'mesero'));

DROP POLICY IF EXISTS users_self_or_admin_read ON public.users;
CREATE POLICY users_self_or_admin_read
  ON public.users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS tables_staff_read ON public.restaurant_tables;
CREATE POLICY tables_staff_read
  ON public.restaurant_tables FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('admin', 'caja', 'cajero', 'mesero'));

DROP POLICY IF EXISTS inventory_admin_read ON public.inventory_movements;
CREATE POLICY inventory_admin_read
  ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS orders_staff_read ON public.orders;
CREATE POLICY orders_staff_read
  ON public.orders FOR SELECT TO authenticated
  USING (
    public.current_staff_role() IN ('admin', 'caja', 'cajero')
    OR (
      public.current_staff_role() = 'mesero'
      AND user_id = public.current_staff_id()
    )
  );

DROP POLICY IF EXISTS order_items_staff_read ON public.order_items;
CREATE POLICY order_items_staff_read
  ON public.order_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.orders AS parent_order
      WHERE parent_order.id = order_id
    )
  );

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
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('admin', 'caja', 'cajero', 'mesero') THEN
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
  v_order_user_id integer;
  v_order_status text;
BEGIN
  v_staff_id := public.current_staff_id();
  v_staff_role := public.current_staff_role();
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('admin', 'caja', 'cajero', 'mesero') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;

  SELECT status, user_id INTO v_order_status, v_order_user_id
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_staff_role = 'mesero' AND v_order_user_id IS DISTINCT FROM v_staff_id THEN
    RAISE EXCEPTION 'A waiter can only update their own orders' USING ERRCODE = '42501';
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
  IF COALESCE(v_staff_role, '') NOT IN ('admin', 'caja', 'cajero') THEN
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

REVOKE ALL ON FUNCTION public.create_order(integer, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.advance_order_status(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_order_payment(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order(integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_order_status(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_payment(integer, text) TO authenticated;