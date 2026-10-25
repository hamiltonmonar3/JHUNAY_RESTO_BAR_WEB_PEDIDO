ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS added_after_served boolean NOT NULL DEFAULT false;

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

  INSERT INTO public.order_items (
    order_id, product_id, quantity, unit_price, subtotal, notes, added_after_served
  )
  VALUES (
    p_order_id, p_product_id, p_quantity, v_unit_price, v_subtotal,
    NULLIF(btrim(p_notes), ''), v_order.status = 'servido'
  )
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

REVOKE ALL ON FUNCTION public.add_order_item(integer, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_order_item(integer, integer, integer, text) TO authenticated;
