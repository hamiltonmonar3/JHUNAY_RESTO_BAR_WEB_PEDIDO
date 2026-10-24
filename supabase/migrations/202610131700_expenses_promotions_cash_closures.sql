-- Habilita y conecta 3 módulos nuevos:
--   1) Egresos (expenses)       -> registro de gastos del día vía RPC.
--   2) Promociones (promotions) -> catálogo administrable que ADEMÁS se aplica
--                                  automáticamente como descuento al armar pedidos.
--   3) Cierre de caja (cash_closures) -> una sola caja compartida para todo el
--                                        restaurante (abrir / cerrar con cálculo automático).

-- =====================================================================
-- 1) EGRESOS
-- =====================================================================
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.expenses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.expenses TO authenticated;

DROP POLICY IF EXISTS expenses_staff_read ON public.expenses;
CREATE POLICY expenses_staff_read
  ON public.expenses FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

CREATE OR REPLACE FUNCTION public.record_expense(
  p_amount numeric,
  p_description text,
  p_category text DEFAULT 'general'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_expense_id integer;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Expense description is required';
  END IF;

  INSERT INTO public.expenses (user_id, amount, description, category)
  VALUES (v_staff_id, p_amount, btrim(p_description), COALESCE(NULLIF(btrim(p_category), ''), 'general'))
  RETURNING id INTO v_expense_id;

  RETURN v_expense_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_expense(
  p_expense_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.current_staff_role() IS DISTINCT FROM 'Administrador' THEN
    RAISE EXCEPTION 'Administrator role is required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense(numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_expense(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expense(integer) TO authenticated;

-- =====================================================================
-- 2) PROMOCIONES
-- =====================================================================
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.promotions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.promotions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.promotions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.promotions_id_seq TO authenticated;

DROP POLICY IF EXISTS promotions_public_read ON public.promotions;
CREATE POLICY promotions_public_read
  ON public.promotions FOR SELECT TO anon, authenticated
  USING (is_active IS TRUE OR public.current_staff_role() = 'Administrador');

DROP POLICY IF EXISTS promotions_admin_manage ON public.promotions;
CREATE POLICY promotions_admin_manage
  ON public.promotions FOR ALL TO authenticated
  USING (public.current_staff_role() = 'Administrador')
  WITH CHECK (public.current_staff_role() = 'Administrador');

-- Calcula el precio final de un producto aplicando la mejor promoción activa
-- (por producto o por categoría), si existe alguna vigente en este momento.
CREATE OR REPLACE FUNCTION public.compute_discounted_price(
  p_product_id integer,
  p_base_price numeric
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_category_id integer;
  v_best_price numeric(10, 2) := p_base_price;
  v_promo record;
  v_candidate numeric(10, 2);
BEGIN
  SELECT category_id INTO v_category_id FROM public.products WHERE id = p_product_id;

  FOR v_promo IN
    SELECT discount_type, discount_value
    FROM public.promotions
    WHERE is_active IS TRUE
      AND (product_id = p_product_id OR (category_id IS NOT NULL AND category_id = v_category_id))
      AND (start_date IS NULL OR start_date <= CURRENT_TIMESTAMP)
      AND (end_date IS NULL OR end_date >= CURRENT_TIMESTAMP)
  LOOP
    IF v_promo.discount_type = 'percentage' THEN
      v_candidate := p_base_price * (1 - (v_promo.discount_value / 100.0));
    ELSE
      v_candidate := p_base_price - v_promo.discount_value;
    END IF;
    IF v_candidate < 0 THEN
      v_candidate := 0;
    END IF;
    IF v_candidate < v_best_price THEN
      v_best_price := v_candidate;
    END IF;
  END LOOP;

  RETURN v_best_price;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_discounted_price(integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_discounted_price(integer, numeric) TO authenticated;

-- Redefine create_order y add_order_item para aplicar el descuento automáticamente
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
  v_unit_price numeric(10, 2);
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

    v_unit_price := public.compute_discounted_price(v_product_id, v_product.price);
    v_subtotal := v_unit_price * v_quantity;
    INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, subtotal, notes)
    VALUES (
      v_order_id,
      v_product_id,
      v_quantity,
      v_unit_price,
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
  v_unit_price numeric(10, 2);
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

  v_unit_price := public.compute_discounted_price(p_product_id, v_product.price);
  v_subtotal := v_unit_price * p_quantity;

  INSERT INTO public.order_items (order_id, product_id, quantity, unit_price, subtotal, notes)
  VALUES (p_order_id, p_product_id, p_quantity, v_unit_price, v_subtotal, NULLIF(btrim(p_notes), ''))
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

-- =====================================================================
-- 3) CIERRE DE CAJA (una sola caja compartida)
-- =====================================================================
ALTER TABLE public.cash_closures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cash_closures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cash_closures TO authenticated;

DROP POLICY IF EXISTS cash_closures_staff_read ON public.cash_closures;
CREATE POLICY cash_closures_staff_read
  ON public.cash_closures FOR SELECT TO authenticated
  USING (public.current_staff_role() IN ('Administrador', 'Operador'));

CREATE OR REPLACE FUNCTION public.open_cash_closure(
  p_opening_amount numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_closure_id integer;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_opening_amount IS NULL OR p_opening_amount < 0 THEN
    RAISE EXCEPTION 'Opening amount must be zero or greater';
  END IF;

  IF EXISTS (SELECT 1 FROM public.cash_closures WHERE status = 'abierta') THEN
    RAISE EXCEPTION 'There is already an open cash register';
  END IF;

  INSERT INTO public.cash_closures (user_id, opening_amount, status, opened_at)
  VALUES (v_staff_id, p_opening_amount, 'abierta', CURRENT_TIMESTAMP)
  RETURNING id INTO v_closure_id;

  RETURN v_closure_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_cash_closure(
  p_counted_cash numeric,
  p_notes text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_closure record;
  v_cash_sales numeric(10, 2) := 0;
  v_card_sales numeric(10, 2) := 0;
  v_other_sales numeric(10, 2) := 0;
  v_total_expenses numeric(10, 2) := 0;
  v_expected_cash numeric(10, 2);
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
    RAISE EXCEPTION 'Counted cash must be zero or greater';
  END IF;

  SELECT * INTO v_closure
  FROM public.cash_closures
  WHERE status = 'abierta'
  ORDER BY opened_at
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no open cash register';
  END IF;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_cash_sales
  FROM public.orders
  WHERE status = 'pagado' AND payment_method = 'efectivo'
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_card_sales
  FROM public.orders
  WHERE status = 'pagado' AND payment_method = 'tarjeta'
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_other_sales
  FROM public.orders
  WHERE status = 'pagado' AND payment_method NOT IN ('efectivo', 'tarjeta')
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_expenses
  FROM public.expenses
  WHERE created_at >= v_closure.opened_at AND created_at <= CURRENT_TIMESTAMP;

  v_expected_cash := v_closure.opening_amount + v_cash_sales - v_total_expenses;

  UPDATE public.cash_closures
  SET total_cash_sales = v_cash_sales,
      total_card_sales = v_card_sales,
      total_other_sales = v_other_sales,
      total_expenses = v_total_expenses,
      expected_cash = v_expected_cash,
      counted_cash = p_counted_cash,
      difference = p_counted_cash - v_expected_cash,
      notes = NULLIF(btrim(p_notes), ''),
      status = 'cerrada',
      closed_at = CURRENT_TIMESTAMP
  WHERE id = v_closure.id;

  RETURN v_closure.id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_cash_closure(numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_cash_closure(numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_cash_closure(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_closure(numeric, text) TO authenticated;
