DROP FUNCTION IF EXISTS public.record_order_split_payment(integer, jsonb);

CREATE FUNCTION public.record_order_split_payment(
  p_order_id integer,
  p_groups jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_order record;
  v_group jsonb;
  v_item jsonb;
  v_tender jsonb;
  v_group_id bigint;
  v_order_item_id integer;
  v_quantity integer;
  v_item_quantity integer;
  v_unit_price numeric(10, 2);
  v_subtotal numeric(10, 2);
  v_group_total numeric(10, 2);
  v_tender_total numeric(10, 2);
  v_order_total numeric(10, 2);
  v_assigned_quantity integer;
  v_payment_method text;
  v_order_payment_method text;
  v_amount numeric(10, 2);
  v_seen_items integer[];
  v_seen_methods text[];
  v_distinct_methods integer;
  v_table_id integer;
  v_all_assigned boolean := true;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_groups) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Payment groups must be an array';
  END IF;
  IF jsonb_array_length(p_groups) = 0 THEN
    RAISE EXCEPTION 'At least one payment group is required';
  END IF;

  SELECT id, status, total_amount, table_id
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'servido' THEN
    RAISE EXCEPTION 'Only served orders can receive a partial payment';
  END IF;

  FOR v_group IN SELECT value FROM jsonb_array_elements(p_groups)
  LOOP
    IF jsonb_typeof(v_group) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Payment group must be an object';
    END IF;
    IF jsonb_typeof(v_group -> 'items') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_group -> 'tenders') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Each payment group needs items and payment methods';
    END IF;
    IF jsonb_array_length(v_group -> 'items') = 0
      OR jsonb_array_length(v_group -> 'tenders') = 0 THEN
      RAISE EXCEPTION 'Each payment group needs items and payment methods';
    END IF;

    v_group_total := 0;
    v_seen_items := ARRAY[]::integer[];
    INSERT INTO public.order_payment_groups (order_id, user_id, payer_name, group_amount)
    VALUES (p_order_id, v_staff_id, NULLIF(btrim(v_group ->> 'payer_name'), ''), 0)
    RETURNING id INTO v_group_id;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_group -> 'items')
    LOOP
      v_order_item_id := (v_item ->> 'order_item_id')::integer;
      v_quantity := (v_item ->> 'quantity')::integer;
      IF v_order_item_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
        RAISE EXCEPTION 'Invalid product quantity in payment group';
      END IF;
      IF v_order_item_id = ANY(v_seen_items) THEN
        RAISE EXCEPTION 'A product may appear only once in each payment group';
      END IF;
      v_seen_items := array_append(v_seen_items, v_order_item_id);

      SELECT quantity, unit_price
      INTO v_item_quantity, v_unit_price
      FROM public.order_items
      WHERE id = v_order_item_id AND order_id = p_order_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A selected product does not belong to this order';
      END IF;

      v_subtotal := round(v_unit_price * v_quantity, 2);
      v_group_total := v_group_total + v_subtotal;
      INSERT INTO public.order_payment_group_items
        (payment_group_id, order_item_id, quantity, unit_price, subtotal)
      VALUES
        (v_group_id, v_order_item_id, v_quantity, v_unit_price, v_subtotal);
    END LOOP;

    IF v_group_total <= 0 THEN
      RAISE EXCEPTION 'Payment group total must be greater than zero';
    END IF;

    v_tender_total := 0;
    v_seen_methods := ARRAY[]::text[];
    FOR v_tender IN SELECT value FROM jsonb_array_elements(v_group -> 'tenders')
    LOOP
      v_payment_method := v_tender ->> 'payment_method';
      v_amount := round((v_tender ->> 'amount')::numeric, 2);
      IF v_payment_method IS NULL OR v_payment_method NOT IN ('efectivo', 'transferencia')
        OR v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'Invalid payment method or amount';
      END IF;
      IF v_payment_method = ANY(v_seen_methods) THEN
        RAISE EXCEPTION 'Each payment method may appear only once per group';
      END IF;
      v_seen_methods := array_append(v_seen_methods, v_payment_method);
      v_tender_total := v_tender_total + v_amount;
      INSERT INTO public.order_payment_tenders (payment_group_id, payment_method, amount)
      VALUES (v_group_id, v_payment_method, v_amount);
    END LOOP;

    IF round(v_tender_total, 2) <> round(v_group_total, 2) THEN
      RAISE EXCEPTION 'Payment methods must add up exactly to each person''s share';
    END IF;

    UPDATE public.order_payment_groups
    SET group_amount = v_group_total
    WHERE id = v_group_id;
  END LOOP;

  FOR v_order_item_id, v_item_quantity IN
    SELECT id, quantity FROM public.order_items WHERE order_id = p_order_id
  LOOP
    SELECT COALESCE(SUM(group_item.quantity), 0)
    INTO v_assigned_quantity
    FROM public.order_payment_group_items AS group_item
    JOIN public.order_payment_groups AS payment_group
      ON payment_group.id = group_item.payment_group_id
    WHERE payment_group.order_id = p_order_id
      AND group_item.order_item_id = v_order_item_id;
    IF v_assigned_quantity > v_item_quantity THEN
      RAISE EXCEPTION 'Assigned product quantity exceeds the order quantity';
    END IF;
    IF v_assigned_quantity < v_item_quantity THEN
      v_all_assigned := false;
    END IF;
  END LOOP;

  IF NOT v_all_assigned THEN
    RETURN false;
  END IF;

  SELECT COALESCE(SUM(group_amount), 0)
  INTO v_order_total
  FROM public.order_payment_groups
  WHERE order_id = p_order_id;
  IF round(v_order_total, 2) <> round(v_order.total_amount, 2) THEN
    RAISE EXCEPTION 'Payment groups must add up exactly to the order total';
  END IF;

  SELECT count(DISTINCT payment_tender.payment_method), min(payment_tender.payment_method)
  INTO v_distinct_methods, v_order_payment_method
  FROM public.order_payment_tenders AS payment_tender
  JOIN public.order_payment_groups AS payment_group
    ON payment_group.id = payment_tender.payment_group_id
  WHERE payment_group.order_id = p_order_id;

  UPDATE public.orders
  SET status = 'pagado',
      payment_method = CASE
        WHEN v_distinct_methods = 1 THEN v_order_payment_method
        ELSE 'mixto'
      END,
      paid_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = p_order_id;

  v_table_id := v_order.table_id;
  IF v_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE table_id = v_table_id AND status IN ('armado', 'en_preparacion', 'servido')
  ) THEN
    UPDATE public.restaurant_tables SET status = 'disponible' WHERE id = v_table_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_order_split_payment(integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_order_split_payment(integer, jsonb) TO authenticated;
