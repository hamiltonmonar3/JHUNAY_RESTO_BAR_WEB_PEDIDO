DO $$
DECLARE
  v_auditor_id integer;
BEGIN
  SELECT id INTO v_auditor_id
  FROM public.roles
  WHERE name = 'Auditor'
  ORDER BY id
  LIMIT 1;

  IF v_auditor_id IS NULL THEN
    SELECT id INTO v_auditor_id
    FROM public.roles
    WHERE lower(name) = 'auditor'
    ORDER BY id
    LIMIT 1;

    IF v_auditor_id IS NOT NULL THEN
      UPDATE public.roles SET name = 'Auditor' WHERE id = v_auditor_id;
    END IF;
  END IF;

  IF v_auditor_id IS NOT NULL THEN
    UPDATE public.users
    SET role_id = v_auditor_id
    WHERE role_id IN (
      SELECT id
      FROM public.roles
      WHERE lower(name) = 'auditor' AND id <> v_auditor_id
    );

    DELETE FROM public.roles
    WHERE lower(name) = 'auditor' AND id <> v_auditor_id;
  END IF;
END;
$$;

DROP POLICY IF EXISTS roles_staff_read ON public.roles;
CREATE POLICY roles_staff_read
  ON public.roles FOR SELECT TO authenticated
  USING (
    public.current_staff_role() IN ('Administrador', 'Operador')
    OR (
      public.current_staff_role() = 'Auditor'
      AND name = 'Auditor'
    )
  );
