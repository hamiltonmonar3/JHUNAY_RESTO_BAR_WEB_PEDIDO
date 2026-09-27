GRANT INSERT, UPDATE, DELETE ON public.categories, public.products,
  public.restaurant_tables, public.roles TO authenticated;
GRANT INSERT (role_id, full_name, email, is_active, username),
  UPDATE (role_id, full_name, email, is_active, username)
  ON public.users TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.categories_id_seq,
  public.products_id_seq, public.restaurant_tables_id_seq,
  public.roles_id_seq, public.users_id_seq TO authenticated;

DROP POLICY IF EXISTS categories_admin_manage ON public.categories;
CREATE POLICY categories_admin_manage
  ON public.categories FOR ALL TO authenticated
  USING (public.current_staff_role() = 'admin')
  WITH CHECK (public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS products_admin_manage ON public.products;
CREATE POLICY products_admin_manage
  ON public.products FOR ALL TO authenticated
  USING (public.current_staff_role() = 'admin')
  WITH CHECK (public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS tables_admin_manage ON public.restaurant_tables;
CREATE POLICY tables_admin_manage
  ON public.restaurant_tables FOR ALL TO authenticated
  USING (public.current_staff_role() = 'admin')
  WITH CHECK (public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS roles_admin_manage ON public.roles;
CREATE POLICY roles_admin_manage
  ON public.roles FOR ALL TO authenticated
  USING (public.current_staff_role() = 'admin')
  WITH CHECK (public.current_staff_role() = 'admin');

DROP POLICY IF EXISTS users_admin_manage ON public.users;
CREATE POLICY users_admin_manage
  ON public.users FOR ALL TO authenticated
  USING (public.current_staff_role() = 'admin')
  WITH CHECK (public.current_staff_role() = 'admin');

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
  IF public.current_staff_role() IS DISTINCT FROM 'admin' THEN
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

  UPDATE public.products
  SET current_stock = v_new_stock
  WHERE id = p_product_id;

  INSERT INTO public.inventory_movements (product_id, user_id, movement_type, quantity, reason)
  VALUES (p_product_id, v_staff_id, p_movement_type, v_movement_quantity, NULLIF(btrim(p_reason), ''))
  RETURNING id INTO v_movement_id;

  RETURN v_movement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inventory_movement(integer, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_inventory_movement(integer, text, integer, text) TO authenticated;