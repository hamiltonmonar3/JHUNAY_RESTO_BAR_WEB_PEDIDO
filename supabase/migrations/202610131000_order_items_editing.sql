-- Permite agregar, actualizar cantidad y quitar productos de un pedido
-- mientras el pedido no esté pagado ni cancelado.

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
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('admin', 'caja', 'cajero', 'mesero') THEN
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
  IF v_staff_role = 'mesero' AND v_order.user_id IS DISTINCT FROM v_staff_id THEN
    RAISE EXCEPTION 'A waiter can only update their own orders' USING ERRCODE = '42501';
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
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('admin', 'caja', 'cajero', 'mesero') THEN
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
  IF v_staff_role = 'mesero' AND v_order.user_id IS DISTINCT FROM v_staff_id THEN
    RAISE EXCEPTION 'A waiter can only update their own orders' USING ERRCODE = '42501';
  END IF;
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
  IF v_staff_id IS NULL OR COALESCE(v_staff_role, '') NOT IN ('admin', 'caja', 'cajero', 'mesero') THEN
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
  IF v_staff_role = 'mesero' AND v_order.user_id IS DISTINCT FROM v_staff_id THEN
    RAISE EXCEPTION 'A waiter can only update their own orders' USING ERRCODE = '42501';
  END IF;
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

REVOKE ALL ON FUNCTION public.add_order_item(integer, integer, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_order_item_quantity(integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_order_item(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_order_item(integer, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_item_quantity(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_order_item(integer) TO authenticated;
