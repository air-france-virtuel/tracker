-- Programme des vols Les Ailes Tricolores : lu par tous les pilotes, modifié uniquement par la direction.
-- À coller une seule fois dans Supabase > SQL Editor > Run (après chat.sql), puis coller vols-programme.sql.
create table if not exists public.company_flights (
  number text primary key check (number ~ '^LAT[0-9]{2,4}[A-Z]?$'),
  dep_airport text not null check (dep_airport ~ '^[A-Z0-9]{4}$'),
  arr_airport text not null check (arr_airport ~ '^[A-Z0-9]{4}$' and arr_airport <> dep_airport),
  dep_utc text not null check (dep_utc ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  block_min integer not null check (block_min between 20 and 1200),
  aircraft_type text not null check (aircraft_type in ('A320', 'B77W')),
  days smallint[] not null default '{1,2,3,4,5,6,7}',  -- 1 = lundi … 7 = dimanche
  active boolean not null default true,
  note text check (note is null or char_length(note) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.company_flights enable row level security;
revoke all on public.company_flights from anon, authenticated;
grant select, insert, update, delete on public.company_flights to authenticated;

drop policy if exists flights_read on public.company_flights;
create policy flights_read on public.company_flights for select to authenticated using (true);
drop policy if exists flights_admin_insert on public.company_flights;
create policy flights_admin_insert on public.company_flights for insert to authenticated with check (public.is_admin());
drop policy if exists flights_admin_update on public.company_flights;
create policy flights_admin_update on public.company_flights for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists flights_admin_delete on public.company_flights;
create policy flights_admin_delete on public.company_flights for delete to authenticated using (public.is_admin());

create or replace function public.company_flights_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists company_flights_touch on public.company_flights;
create trigger company_flights_touch before insert or update on public.company_flights
  for each row execute function public.company_flights_touch();
