-- Выгрузка всего устройства базы «Бомбилы» одним текстом.
-- Supabase → SQL Editor → вставить → Run. Результат — одна ячейка: скопировать целиком
-- (или Download → CSV) и сохранить как current-schema.sql. Данные (люди, заказы) сюда не входят —
-- только таблицы, колонки, ограничения, индексы, права, политики, функции и триггеры.
with t as (
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
), cols as (
  select t.relname, string_agg(format('  %I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
           case when a.attnotnull then ' not null' else '' end,
           coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')), E',\n' order by a.attnum) as body
  from t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
  group by t.relname
)
select '-- устройство базы на ' || now()::date || E'\n\n' || string_agg(x, E'\n\n' order by ord, nm, x) from (
  select 0 ord, extname nm, format('create extension if not exists %I;', extname) x
    from pg_extension where extname not in ('plpgsql')
  union all
  select 0, sequencename, format('create sequence if not exists public.%I;', sequencename) from pg_sequences where schemaname = 'public'
  union all
  select 1, relname, format(E'create table if not exists public.%I (\n%s\n);', relname, body) from cols
  union all
  select case when contype = 'f' then 3 else 2 end, conrelid::regclass::text,
         format('alter table %s add constraint %I %s;', conrelid::regclass, conname, pg_get_constraintdef(oid))
    from pg_constraint where connamespace = 'public'::regnamespace and contype in ('p','u','c','f')
  union all
  select 4, tablename, indexdef || ';' from pg_indexes
   where schemaname = 'public' and indexname not in (select conname from pg_constraint where connamespace = 'public'::regnamespace)
  union all
  select 5, p.proname, pg_get_functiondef(p.oid) || ';'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'
  union all
  select 6, c.relname, pg_get_triggerdef(tg.oid) || ';'
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not tg.tgisinternal
  union all
  select 7, relname, format('alter table public.%I enable row level security;', relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  union all
  select 8, tablename, format('create policy %I on public.%I as %s for %s to %s%s%s;', policyname, tablename, permissive, cmd,
         array_to_string(roles, ', '), coalesce(' using (' || qual || ')', ''), coalesce(' with check (' || with_check || ')', ''))
    from pg_policies where schemaname = 'public'
  union all
  select 9, c.relname, format('revoke all on public.%I from anon, authenticated;', c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 10, table_name, format('grant %s on public.%I to %I;', string_agg(privilege_type, ', ' order by privilege_type), table_name, grantee)
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated') group by table_name, grantee
) s;
