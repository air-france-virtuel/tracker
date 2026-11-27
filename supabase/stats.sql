-- Statistiques de la compagnie Les Ailes Tricolores : journal des vols terminés de tous les pilotes
-- (envoyé par le tracker à la fin de chaque vol, hors démo) et fonction company_stats() pour l'écran « Statistiques ».

create table if not exists public.company_flight_log (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references public.pilots(id) on delete cascade,
  pseudo text not null default '',
  flight_number text not null default '' check (char_length(flight_number) <= 10),
  dep text not null check (dep ~ '^[A-Z0-9]{3,4}$'),
  arr text not null check (arr ~ '^[A-Z0-9]{3,4}$'),
  aircraft_type text not null default '' check (char_length(aircraft_type) <= 12),
  block_min integer check (block_min between 0 and 1440),
  flight_min integer check (flight_min between 0 and 1440),
  landing_rate integer check (landing_rate between -3000 and 3000),
  on_time boolean,
  delay_min integer check (delay_min between -720 and 1440),
  flown_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists company_flight_log_flown on public.company_flight_log (flown_at desc);
create index if not exists company_flight_log_user on public.company_flight_log (user_id);

alter table public.company_flight_log enable row level security;
drop policy if exists cfl_read on public.company_flight_log;
create policy cfl_read on public.company_flight_log for select to authenticated using (true);
drop policy if exists cfl_insert on public.company_flight_log;
create policy cfl_insert on public.company_flight_log for insert to authenticated
  with check (user_id = auth.uid() and not coalesce((select banned from public.pilots where id = auth.uid()), true));
drop policy if exists cfl_delete on public.company_flight_log;
create policy cfl_delete on public.company_flight_log for delete to authenticated using (public.is_admin());

-- pseudo pris dans la fiche pilote (pas d'usurpation), date de vol plausible, anti-rafale (1 vol / 3 min)
create or replace function public.cfl_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.pilots;
begin
  select * into p from public.pilots where id = auth.uid();
  if p.id is null or p.banned then raise exception 'pilote inconnu'; end if;
  new.user_id := auth.uid();
  new.pseudo := p.pseudo;
  new.created_at := now();
  if new.flown_at > now() + interval '5 minutes' or new.flown_at < now() - interval '2 days' then new.flown_at := now(); end if;
  if exists (select 1 from public.company_flight_log where user_id = auth.uid() and created_at > now() - interval '3 minutes') then
    raise exception 'trop de vols envoyés';
  end if;
  return new;
end $$;
drop trigger if exists cfl_before_insert on public.company_flight_log;
create trigger cfl_before_insert before insert on public.company_flight_log for each row execute function public.cfl_before_insert();

create or replace function public.company_stats() returns json
language sql stable security definer set search_path = public as $$
  with l as (select * from public.company_flight_log),
  m as (select * from l where flown_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'),
  w as (select * from l where flown_at >= now() - interval '7 days')
  select json_build_object(
    'generated_at', now(),
    'month', json_build_object(
      'flights', (select count(*) from m),
      'block_min', (select coalesce(sum(block_min), 0) from m),
      'pilots', (select count(distinct user_id) from m),
      'on_time', (select count(*) filter (where on_time) from m),
      'rated', (select count(*) filter (where on_time is not null) from m),
      'avg_landing', (select round(avg(abs(landing_rate))) from m where landing_rate is not null)
    ),
    'all', json_build_object(
      'flights', (select count(*) from l),
      'block_min', (select coalesce(sum(block_min), 0) from l),
      'pilots', (select count(distinct user_id) from l),
      'on_time', (select count(*) filter (where on_time) from l),
      'rated', (select count(*) filter (where on_time is not null) from l),
      'avg_landing', (select round(avg(abs(landing_rate))) from l where landing_rate is not null),
      'since', (select min(flown_at) from l)
    ),
    'top_pilots', (select coalesce(json_agg(t), '[]') from (
      select pseudo, count(*) as flights, coalesce(sum(block_min), 0) as block_min from m group by user_id, pseudo order by 3 desc, 2 desc limit 10) t),
    'top_dest', (select coalesce(json_agg(t), '[]') from (
      select arr as icao, count(*) as flights from l group by arr order by 2 desc limit 8) t),
    'top_routes', (select coalesce(json_agg(t), '[]') from (
      select dep, arr, count(*) as flights from l group by dep, arr order by 3 desc limit 6) t),
    'types', (select coalesce(json_agg(t), '[]') from (
      select coalesce(nullif(aircraft_type, ''), '?') as type, count(*) as flights, coalesce(sum(block_min), 0) as block_min from l group by 1 order by 2 desc) t),
    'best_landing', (select row_to_json(t) from (
      select pseudo, flight_number, dep, arr, landing_rate, flown_at from w
      where landing_rate is not null and landing_rate <= -20 and landing_rate >= -600 order by abs(landing_rate) asc limit 1) t),
    'punctual_pilots', (select coalesce(json_agg(t), '[]') from (
      select pseudo, count(*) filter (where on_time) as on_time, count(*) as rated from m where on_time is not null
      group by user_id, pseudo having count(*) >= 3 order by (count(*) filter (where on_time))::float / count(*) desc, count(*) desc limit 5) t),
    'days', (select coalesce(json_agg(t order by t.d), '[]') from (
      select to_char(g.d, 'YYYY-MM-DD') as d, (select count(*) from l where flown_at >= g.d and flown_at < g.d + interval '1 day') as flights
      from generate_series(date_trunc('day', now() at time zone 'utc') - interval '13 days', date_trunc('day', now() at time zone 'utc'), interval '1 day') as g(d)) t),
    'recent', (select coalesce(json_agg(t), '[]') from (
      select pseudo, flight_number, dep, arr, aircraft_type, block_min, landing_rate, on_time, delay_min, flown_at from l order by flown_at desc limit 8) t)
  )
$$;
grant execute on function public.company_stats() to authenticated;
