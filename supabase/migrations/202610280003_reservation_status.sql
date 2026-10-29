ALTER TABLE public.reservations
  ADD COLUMN status text NOT NULL DEFAULT 'pendiente'
    CONSTRAINT reservations_status_check
    CHECK (status IN ('pendiente', 'realizada', 'cancelada'));

CREATE INDEX reservations_pending_table_id_idx
  ON public.reservations (table_id)
  WHERE status = 'pendiente';

CREATE OR REPLACE FUNCTION public.save_reservation(
  p_reservation_id bigint,
  p_table_id integer,
  p_customer_name text,
  p_phone text,
  p_reservation_date date,
  p_reservation_time time,
  p_people_count integer,
  p_deposit numeric,
  p_deposit_payment_method text,
  p_notes text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_old_table_id integer;
  v_old_deposit numeric(10, 2);
  v_reservation_status text := 'pendiente';
  v_table_status text;
  v_closure_id integer;
  v_reservation_id bigint;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_table_id IS NULL OR p_customer_name IS NULL OR btrim(p_customer_name) = ''
    OR p_reservation_date IS NULL OR p_reservation_time IS NULL
    OR p_people_count IS NULL OR p_people_count < 1
    OR p_deposit IS NULL OR p_deposit < 0
    OR (p_reservation_id IS NULL AND p_deposit > 0 AND (p_deposit_payment_method IS NULL
      OR p_deposit_payment_method NOT IN ('efectivo', 'transferencia'))) THEN
    RAISE EXCEPTION 'Invalid reservation details';
  END IF;

  IF p_reservation_id IS NOT NULL THEN
    SELECT table_id, deposit, status
    INTO v_old_table_id, v_old_deposit, v_reservation_status
    FROM public.reservations
    WHERE id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reservation not found';
    END IF;
    IF p_deposit <> v_old_deposit THEN
      RAISE EXCEPTION 'A reservation deposit cannot be changed after it is recorded';
    END IF;
  END IF;

  SELECT status INTO v_table_status
  FROM public.restaurant_tables
  WHERE id = p_table_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table not found';
  END IF;

  IF v_reservation_status = 'pendiente' THEN
    IF v_table_status <> 'disponible'
      AND NOT (v_table_status = 'reservada' AND v_old_table_id = p_table_id) THEN
      RAISE EXCEPTION 'The selected table is not available';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.reservations
      WHERE table_id = p_table_id
        AND status = 'pendiente'
        AND id IS DISTINCT FROM p_reservation_id
    ) THEN
      RAISE EXCEPTION 'The selected table already has a reservation';
    END IF;
  END IF;

  IF p_reservation_id IS NULL THEN
    IF p_deposit > 0 THEN
      SELECT id INTO v_closure_id
      FROM public.cash_closures
      WHERE status = 'abierta'
      ORDER BY opened_at
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no open cash register to record the deposit';
      END IF;
    END IF;

    INSERT INTO public.reservations (
      table_id, customer_name, phone, reservation_date, reservation_time,
      people_count, deposit, deposit_payment_method, notes
    )
    VALUES (
      p_table_id, btrim(p_customer_name), NULLIF(btrim(p_phone), ''),
      p_reservation_date, p_reservation_time, p_people_count, p_deposit,
      CASE WHEN p_deposit > 0 THEN p_deposit_payment_method ELSE NULL END,
      NULLIF(btrim(p_notes), '')
    )
    RETURNING id INTO v_reservation_id;

    IF p_deposit > 0 THEN
      INSERT INTO public.cash_closure_income_entries (
        cash_closure_id, reservation_id, user_id, source, payment_method,
        amount, description
      )
      VALUES (
        v_closure_id, v_reservation_id, v_staff_id, 'reserva',
        p_deposit_payment_method, p_deposit,
        'Abono de reserva: ' || btrim(p_customer_name)
      );

      IF p_deposit_payment_method = 'efectivo' THEN
        UPDATE public.cash_closures
        SET additional_cash_income = additional_cash_income + p_deposit
        WHERE id = v_closure_id;
      ELSE
        UPDATE public.cash_closures
        SET additional_transfer_income = additional_transfer_income + p_deposit
        WHERE id = v_closure_id;
      END IF;
    END IF;
  ELSE
    UPDATE public.reservations
    SET table_id = p_table_id,
        customer_name = btrim(p_customer_name),
        phone = NULLIF(btrim(p_phone), ''),
        reservation_date = p_reservation_date,
        reservation_time = p_reservation_time,
        people_count = p_people_count,
        notes = NULLIF(btrim(p_notes), '')
    WHERE id = p_reservation_id
    RETURNING id INTO v_reservation_id;
  END IF;

  IF v_reservation_status = 'pendiente' THEN
    UPDATE public.restaurant_tables
    SET status = 'reservada'
    WHERE id = p_table_id;
  END IF;

  IF v_old_table_id IS NOT NULL
    AND (v_old_table_id <> p_table_id OR v_reservation_status <> 'pendiente') THEN
    UPDATE public.restaurant_tables
    SET status = 'disponible'
    WHERE id = v_old_table_id
      AND status = 'reservada'
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations
        WHERE table_id = v_old_table_id
          AND status = 'pendiente'
      );
  END IF;

  RETURN v_reservation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_reservation_status(
  p_reservation_id bigint,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_staff_id integer;
  v_table_id integer;
  v_current_status text;
  v_table_status text;
BEGIN
  v_staff_id := public.current_staff_id();
  IF v_staff_id IS NULL OR COALESCE(public.current_staff_role(), '') NOT IN ('Administrador', 'Operador') THEN
    RAISE EXCEPTION 'Active restaurant staff is required' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pendiente', 'realizada', 'cancelada') THEN
    RAISE EXCEPTION 'Invalid reservation status';
  END IF;

  SELECT table_id, status
  INTO v_table_id, v_current_status
  FROM public.reservations
  WHERE id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;
  IF v_current_status = p_status THEN
    RETURN;
  END IF;

  IF p_status = 'pendiente' THEN
    SELECT status INTO v_table_status
    FROM public.restaurant_tables
    WHERE id = v_table_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Table not found';
    END IF;
    IF v_table_status <> 'disponible' THEN
      RAISE EXCEPTION 'The selected table is not available';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.reservations
      WHERE table_id = v_table_id
        AND status = 'pendiente'
        AND id <> p_reservation_id
    ) THEN
      RAISE EXCEPTION 'The selected table already has a reservation';
    END IF;
  END IF;

  UPDATE public.reservations
  SET status = p_status
  WHERE id = p_reservation_id;

  IF p_status = 'pendiente' THEN
    UPDATE public.restaurant_tables
    SET status = 'reservada'
    WHERE id = v_table_id;
  ELSE
    UPDATE public.restaurant_tables
    SET status = 'disponible'
    WHERE id = v_table_id
      AND status = 'reservada'
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations
        WHERE table_id = v_table_id
          AND status = 'pendiente'
      );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_reservation_status(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_status(bigint, text) TO authenticated;
