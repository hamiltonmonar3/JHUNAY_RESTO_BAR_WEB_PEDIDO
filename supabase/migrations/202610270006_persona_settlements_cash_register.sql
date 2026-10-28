ALTER TABLE public.persona_financial_movements
  ADD COLUMN payment_method text
    CHECK (payment_method IN ('efectivo', 'transferencia'));

ALTER TABLE public.cash_closure_income_entries
  DROP CONSTRAINT cash_closure_income_entries_source_check,
  ADD CONSTRAINT cash_closure_income_entries_source_check
    CHECK (source IN ('manual', 'reserva', 'cobro_persona')),
  ADD COLUMN persona_movement_id bigint
    REFERENCES public.persona_financial_movements(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX cash_closure_income_entries_persona_movement_idx
  ON public.cash_closure_income_entries (persona_movement_id)
  WHERE persona_movement_id IS NOT NULL;

ALTER TABLE public.expenses
  ADD COLUMN payment_method text NOT NULL DEFAULT 'efectivo'
    CHECK (payment_method IN ('efectivo', 'transferencia')),
  ADD COLUMN persona_movement_id bigint
    REFERENCES public.persona_financial_movements(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX expenses_persona_movement_idx
  ON public.expenses (persona_movement_id)
  WHERE persona_movement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_persona_payment_expense_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.persona_movement_id IS NOT NULL OR OLD.category = 'pago_persona' THEN
    RAISE EXCEPTION 'Person settlement expenses cannot be edited or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expenses_persona_payment_immutable
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_persona_payment_expense_mutation();

DROP FUNCTION public.record_persona_financial_movement(integer, text, numeric, text, date);

CREATE OR REPLACE FUNCTION public.record_persona_financial_movement(
  p_persona_id integer,
  p_movement_type text,
  p_amount numeric,
  p_description text,
  p_movement_date date,
  p_payment_method text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_created_by integer;
  v_movement_id bigint;
  v_is_active boolean;
  v_person_name text;
  v_receivable numeric(10, 2);
  v_payable numeric(10, 2);
  v_discounts numeric(10, 2);
  v_collected numeric(10, 2);
  v_paid numeric(10, 2);
  v_available numeric(10, 2);
  v_business_date date;
  v_closure_id integer;
  v_transaction_time timestamptz;
  v_full_description text;
BEGIN
  IF public.current_staff_role() IS DISTINCT FROM 'Administrador' THEN
    RAISE EXCEPTION 'Administrator role is required' USING ERRCODE = '42501';
  END IF;
  IF p_persona_id IS NULL THEN
    RAISE EXCEPTION 'Active person not found';
  END IF;

  SELECT is_active, full_name INTO v_is_active, v_person_name
  FROM public.personas
  WHERE id = p_persona_id
  FOR UPDATE;
  IF NOT FOUND OR NOT v_is_active THEN
    RAISE EXCEPTION 'Active person not found';
  END IF;

  IF p_movement_type IS NULL OR p_movement_type NOT IN ('por_cobrar', 'por_pagar', 'descuento', 'cobrado', 'pagado') THEN
    RAISE EXCEPTION 'Unsupported person financial movement type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Movement amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Movement description is required';
  END IF;
  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'Movement date is required';
  END IF;
  IF p_movement_type IN ('cobrado', 'pagado') THEN
    IF p_payment_method IS NULL OR p_payment_method NOT IN ('efectivo', 'transferencia') THEN
      RAISE EXCEPTION 'Select cash or transfer for the settlement';
    END IF;
    v_business_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Guayaquil')::date;
    IF p_movement_date <> v_business_date THEN
      RAISE EXCEPTION 'Settlements must be recorded for today';
    END IF;
    SELECT id INTO v_closure_id
    FROM public.cash_closures
    WHERE status = 'abierta'
      AND (opened_at AT TIME ZONE 'America/Guayaquil')::date = v_business_date
    ORDER BY opened_at
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'There is no open cash register for today';
    END IF;
    v_transaction_time := CURRENT_TIMESTAMP;
  ELSIF p_payment_method IS NOT NULL THEN
    RAISE EXCEPTION 'Payment method is only valid for a settlement';
  END IF;

  IF p_movement_type IN ('cobrado', 'pagado') THEN
    SELECT
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_cobrar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'por_pagar'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'descuento'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'cobrado'), 0),
      COALESCE(sum(amount) FILTER (WHERE movement_type = 'pagado'), 0)
    INTO v_receivable, v_payable, v_discounts, v_collected, v_paid
    FROM public.persona_financial_movements
    WHERE persona_id = p_persona_id;

    v_available := CASE
      WHEN p_movement_type = 'cobrado' THEN v_receivable - v_collected
      ELSE v_payable - v_paid - v_discounts - v_receivable + v_collected
    END;
    IF p_amount > v_available THEN
      RAISE EXCEPTION 'Movement amount exceeds the pending balance of %', greatest(v_available, 0);
    END IF;
  END IF;

  v_created_by := public.current_staff_id();
  INSERT INTO public.persona_financial_movements (
    persona_id, movement_type, amount, description, movement_date, payment_method, created_by
  )
  VALUES (
    p_persona_id, p_movement_type, p_amount, btrim(p_description),
    CASE WHEN p_movement_type IN ('cobrado', 'pagado') THEN v_business_date ELSE p_movement_date END,
    p_payment_method, v_created_by
  )
  RETURNING id INTO v_movement_id;

  IF p_movement_type = 'cobrado' THEN
    v_full_description := 'Cobro de saldo: ' || v_person_name || ' - ' || btrim(p_description);
    INSERT INTO public.cash_closure_income_entries (
      cash_closure_id, persona_movement_id, user_id, source, payment_method,
      expense_period, amount, description, created_at
    )
    VALUES (
      v_closure_id, v_movement_id, v_created_by, 'cobro_persona', p_payment_method,
      'day', p_amount, v_full_description, v_transaction_time
    );

    UPDATE public.cash_closures
    SET additional_cash_income = additional_cash_income
          + CASE WHEN p_payment_method = 'efectivo' THEN p_amount ELSE 0 END,
        additional_transfer_income = additional_transfer_income
          + CASE WHEN p_payment_method = 'transferencia' THEN p_amount ELSE 0 END
    WHERE id = v_closure_id;
  ELSIF p_movement_type = 'pagado' THEN
    v_full_description := 'Pago a persona: ' || v_person_name || ' - ' || btrim(p_description);
    INSERT INTO public.expenses (
      user_id, amount, description, category, created_at, expense_period,
      payment_method, persona_movement_id
    )
    VALUES (
      v_created_by, p_amount, v_full_description, 'pago_persona',
      v_transaction_time, 'day', p_payment_method, v_movement_id
    );
  END IF;

  RETURN v_movement_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_persona_financial_movement(
  p_movement_id bigint,
  p_movement_type text,
  p_amount numeric,
  p_description text,
  p_movement_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_persona_id integer;
  v_original_type text;
  v_receivable numeric(10, 2);
  v_payable numeric(10, 2);
  v_discounts numeric(10, 2);
  v_collected numeric(10, 2);
  v_paid numeric(10, 2);
  v_available numeric(10, 2);
BEGIN
  IF COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Auditor') THEN
    RAISE EXCEPTION 'Administrator or Auditor role is required' USING ERRCODE = '42501';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'Movement ID is required';
  END IF;
  IF p_movement_type IS NULL OR p_movement_type NOT IN ('por_cobrar', 'por_pagar', 'descuento', 'cobrado', 'pagado') THEN
    RAISE EXCEPTION 'Unsupported person financial movement type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Movement amount must be greater than zero';
  END IF;
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'Movement description is required';
  END IF;
  IF p_movement_date IS NULL THEN
    RAISE EXCEPTION 'Movement date is required';
  END IF;

  SELECT persona_id, movement_type INTO v_persona_id, v_original_type
  FROM public.persona_financial_movements
  WHERE id = p_movement_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial movement not found';
  END IF;
  IF v_original_type IN ('cobrado', 'pagado') OR p_movement_type IN ('cobrado', 'pagado') THEN
    RAISE EXCEPTION 'Settlements are linked to cash accounting and cannot be edited';
  END IF;

  PERFORM 1 FROM public.personas WHERE id = v_persona_id FOR UPDATE;

  UPDATE public.persona_financial_movements
  SET movement_type = p_movement_type,
      amount = p_amount,
      description = btrim(p_description),
      movement_date = p_movement_date
  WHERE id = p_movement_id;
END;
$$;

DROP FUNCTION public.close_cash_closure(numeric, text, numeric, numeric);

CREATE OR REPLACE FUNCTION public.close_cash_closure(
  p_counted_cash numeric,
  p_notes text DEFAULT NULL,
  p_additional_cash_income numeric DEFAULT 0,
  p_additional_transfer_income numeric DEFAULT 0
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
  v_mixed_cash_sales numeric(10, 2) := 0;
  v_mixed_card_sales numeric(10, 2) := 0;
  v_mixed_other_sales numeric(10, 2) := 0;
  v_total_expenses numeric(10, 2) := 0;
  v_cash_expenses numeric(10, 2) := 0;
  v_transfer_expenses numeric(10, 2) := 0;
  v_total_additional_cash numeric(10, 2);
  v_total_additional_transfer numeric(10, 2);
  v_expected_cash numeric(10, 2);
  v_business_day_start timestamptz;
  v_business_day_end timestamptz;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
    RAISE EXCEPTION 'Counted cash must be zero or greater';
  END IF;
  IF p_additional_cash_income IS NULL OR p_additional_cash_income < 0
    OR p_additional_transfer_income IS NULL OR p_additional_transfer_income < 0 THEN
    RAISE EXCEPTION 'Additional income must be zero or greater';
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

  v_business_day_start :=
    (((v_closure.opened_at AT TIME ZONE 'America/Guayaquil')::date)::timestamp
      AT TIME ZONE 'America/Guayaquil');
  v_business_day_end :=
    ((((v_closure.opened_at AT TIME ZONE 'America/Guayaquil')::date + 1)::timestamp)
      AT TIME ZONE 'America/Guayaquil');

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
  WHERE status = 'pagado'
    AND payment_method NOT IN ('efectivo', 'tarjeta', 'mixto')
    AND paid_at >= v_closure.opened_at AND paid_at <= CURRENT_TIMESTAMP;

  SELECT
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'efectivo'), 0),
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'tarjeta'), 0),
    COALESCE(SUM(payment_tender.amount) FILTER (WHERE payment_tender.payment_method = 'transferencia'), 0)
  INTO v_mixed_cash_sales, v_mixed_card_sales, v_mixed_other_sales
  FROM public.order_payment_tenders AS payment_tender
  JOIN public.order_payment_groups AS payment_group
    ON payment_group.id = payment_tender.payment_group_id
  JOIN public.orders AS payment_order
    ON payment_order.id = payment_group.order_id
  WHERE payment_order.status = 'pagado'
    AND payment_order.payment_method = 'mixto'
    AND payment_order.paid_at >= v_closure.opened_at
    AND payment_order.paid_at <= CURRENT_TIMESTAMP;

  v_cash_sales := v_cash_sales + v_mixed_cash_sales;
  v_card_sales := v_card_sales + v_mixed_card_sales;
  v_other_sales := v_other_sales + v_mixed_other_sales;

  SELECT
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(amount) FILTER (WHERE payment_method = 'efectivo'), 0),
    COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transferencia'), 0)
  INTO v_total_expenses, v_cash_expenses, v_transfer_expenses
  FROM public.expenses
  WHERE expense_period = 'day'
    AND created_at >= v_business_day_start
    AND created_at < v_business_day_end;

  v_total_additional_cash := v_closure.additional_cash_income + p_additional_cash_income;
  v_total_additional_transfer := v_closure.additional_transfer_income + p_additional_transfer_income;
  v_expected_cash := v_closure.opening_amount + v_cash_sales
    + v_total_additional_cash - v_cash_expenses;

  UPDATE public.cash_closures
  SET total_cash_sales = v_cash_sales,
      total_card_sales = v_card_sales,
      total_other_sales = v_other_sales + v_total_additional_transfer - v_transfer_expenses,
      total_expenses = v_total_expenses,
      additional_cash_income = v_total_additional_cash,
      additional_transfer_income = v_total_additional_transfer,
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

REVOKE ALL ON FUNCTION public.record_persona_financial_movement(integer, text, numeric, text, date, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_persona_financial_movement(integer, text, numeric, text, date, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_persona_financial_movement(bigint, text, numeric, text, date)
  TO authenticated;

REVOKE ALL ON FUNCTION public.close_cash_closure(numeric, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_cash_closure(numeric, text, numeric, numeric) TO authenticated;
