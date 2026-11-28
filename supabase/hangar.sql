-- Hangar de la compagnie : état de chaque avion (aéroport, usure, heures, vols), historique des vols et des maintenances.
-- À lancer dans Supabase > SQL Editor > Run, après chat.sql et avions.sql. On peut le relancer sans risque.
-- Toutes les règles sont appliquées ici, côté serveur : un tracker modifié ne peut pas tricher.
--
-- Règles :
--   après chaque vol, maintenance de 30 min + 10 min par heure de vol ; atterrissage dur (plus de 600 ft/min) : +30 min ;
--   usure : 1 % par heure de vol (1 % au moins), 5 % de plus après un atterrissage dur ; chaque maintenance rend 8 % ;
--   état sous 60 % : avion cloué au sol, maintenance de 3 h qui le remet à 85 % ;
--   grande visite toutes les 150 h de vol : 3 h, l'avion revient à 100 %.

create table if not exists public.aircraft_state (
  reg text primary key check (reg ~ '^[A-Z0-9-]{3,10}$'),
  type text not null default 'A320',
  label text not null default '',
  engine text not null default '',
  sim text not null default '',
  location text not null default 'LFPG',
  condition numeric not null default 100 check (condition between 0 and 100),
  minutes int not null default 0,          -- temps de vol total
  cycles int not null default 0,           -- nombre de vols
  since_check int not null default 0,      -- minutes depuis la dernière grande visite
  pending_maint int not null default 0,    -- maintenance due (vols enchaînés sans rentrer au hangar)
  pending_hard boolean not null default false,
  last_flight jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.aircraft_log (
  id bigserial primary key,
  reg text not null,
  kind text not null check (kind in ('vol', 'maintenance', 'direction')),
  at timestamptz not null default now(),
  user_id uuid,
  pilot text not null default '',
  callsign text not null default '',
  dep text not null default '',
  arr text not null default '',
  minutes int not null default 0,
  rate int,
  cond_before numeric,
  cond_after numeric,
  note text not null default ''
);
create index if not exists aircraft_log_reg_at on public.aircraft_log (reg, at desc);

alter table public.aircraft_state enable row level security;
alter table public.aircraft_log enable row level security;
grant select on public.aircraft_state, public.aircraft_log to authenticated;
drop policy if exists state_read on public.aircraft_state;
create policy state_read on public.aircraft_state for select to authenticated using (true);
drop policy if exists log_read on public.aircraft_log;
create policy log_read on public.aircraft_log for select to authenticated using (true);
-- aucune écriture directe : uniquement par les fonctions ci-dessous

-- la flotte de départ (ne change rien si les avions existent déjà)
insert into public.aircraft_state (reg, type, label, engine, sim, location) values
  ('F-HLAT', 'A320', 'Airbus A320', 'IAE V2500', 'Fenix', 'LFPG'),
  ('F-HLAU', 'B77W', 'Boeing 777-300ER', 'GE90', 'PMDG', 'LFPG')
on conflict (reg) do nothing;

-- Fin d'un vol avec un avion de la compagnie (seulement par le pilote qui l'a pris).
-- p_keep = true : le pilote enchaîne un autre vol avec cet avion, la maintenance est gardée pour plus tard.
-- Renvoie l'état de l'avion et, s'il rentre au hangar, la maintenance (raison et fin).
create or replace function public.finish_flight(p_reg text, p_callsign text, p_dep text, p_arr text, p_minutes int, p_rate int, p_keep boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.pilots; s public.aircraft_state; b public.aircraft_bookings;
  m int := greatest(0, least(coalesce(p_minutes, 0), 24 * 60));
  hard boolean := abs(coalesce(p_rate, 0)) > 600;
  wear numeric; c0 numeric; c1 numeric; dur int; why text; big boolean := false;
begin
  select * into p from public.pilots where id = auth.uid();
  if not found or p.banned then raise exception 'PILOTE_INCONNU'; end if;
  select * into b from public.aircraft_bookings where reg = upper(p_reg) and kind = 'vol' and user_id = p.id and until > now() - interval '6 hours';
  if not found then raise exception 'AVION_PAS_A_TOI'; end if;
  select * into s from public.aircraft_state where reg = upper(p_reg) for update;
  if not found then raise exception 'AVION_INCONNU'; end if;

  c0 := s.condition;
  wear := greatest(1, m / 60.0) + case when hard then 5 else 0 end;
  c1 := greatest(0, round(c0 - wear, 1));
  insert into public.aircraft_log (reg, kind, user_id, pilot, callsign, dep, arr, minutes, rate, cond_before, cond_after, note)
    values (s.reg, 'vol', p.id, p.pseudo, left(coalesce(p_callsign, ''), 12), upper(left(coalesce(p_dep, ''), 4)), upper(left(coalesce(p_arr, ''), 4)), m, p_rate, c0, c1,
            case when hard then 'atterrissage dur' else '' end);
  update public.aircraft_state set condition = c1, minutes = minutes + m, cycles = cycles + 1, since_check = since_check + m,
    location = coalesce(nullif(upper(left(coalesce(p_arr, ''), 4)), ''), location),
    pending_maint = pending_maint + 10 * round(m / 60.0) + case when hard then 30 else 0 end,
    pending_hard = pending_hard or hard,
    last_flight = jsonb_build_object('callsign', p_callsign, 'dep', upper(p_dep), 'arr', upper(p_arr), 'pilot', p.pseudo, 'at', now(), 'minutes', m, 'rate', p_rate),
    updated_at = now()
    where reg = s.reg returning * into s;

  if coalesce(p_keep, false) and s.condition >= 60 and s.since_check < 150 * 60 then
    return jsonb_build_object('state', to_jsonb(s), 'kept', true);
  end if;

  -- retour au hangar : maintenance
  if s.since_check >= 150 * 60 then
    dur := 180; big := true; why := 'Grande visite (150 h de vol)';
  elsif s.condition < 60 then
    dur := 180; why := 'Avion cloué au sol : état ' || round(s.condition) || ' %, remise en état';
  else
    dur := 30 + s.pending_maint;
    why := 'Visite après vol' || case when s.pending_hard then ' + contrôle du train (atterrissage dur)' else '' end;
  end if;
  dur := least(greatest(dur, 15), 360);
  c0 := s.condition;
  c1 := case when big then 100 when s.condition < 60 then 85 else least(100, s.condition + 8) end;
  update public.aircraft_bookings set kind = 'maintenance', taken_at = now(), until = now() + make_interval(mins => dur) where reg = s.reg returning * into b;
  insert into public.aircraft_log (reg, kind, pilot, dep, minutes, cond_before, cond_after, note)
    values (s.reg, 'maintenance', 'Hangar ' || s.location, s.location, dur, c0, c1, why);
  update public.aircraft_state set condition = c1, pending_maint = 0, pending_hard = false,
    since_check = case when big then 0 else since_check end, updated_at = now() where reg = s.reg returning * into s;
  return jsonb_build_object('state', to_jsonb(s), 'kept', false, 'maintenance', jsonb_build_object('minutes', dur, 'until', b.until, 'reason', why));
end $$;

-- Prendre un avion : en plus des règles d'avions.sql, il doit être dans la flotte et pas cloué au sol.
create or replace function public.take_aircraft(p_reg text, p_until timestamptz)
returns public.aircraft_bookings
language plpgsql security definer set search_path = public as $$
declare p public.pilots; r public.aircraft_bookings; u timestamptz; s public.aircraft_state;
begin
  select * into p from public.pilots where id = auth.uid();
  if not found or p.banned then raise exception 'PILOTE_INCONNU'; end if;
  select * into s from public.aircraft_state where reg = upper(p_reg);
  if found and not s.active then raise exception 'AVION_RETIRE'; end if;
  if found and s.condition < 60 then raise exception 'AVION_CLOUE'; end if;
  u := least(greatest(coalesce(p_until, now() + interval '12 hours'), now() + interval '30 minutes'), now() + interval '24 hours');
  delete from public.aircraft_bookings where user_id = p.id and reg <> upper(p_reg) and kind = 'vol';
  if exists (select 1 from public.aircraft_bookings where reg = upper(p_reg) and kind = 'maintenance' and until > now()) then
    raise exception 'AVION_MAINTENANCE';
  end if;
  insert into public.aircraft_bookings as b (reg, user_id, pseudo, taken_at, until, kind)
    values (upper(p_reg), p.id, p.pseudo, now(), u, 'vol')
  on conflict (reg) do update set user_id = excluded.user_id, pseudo = excluded.pseudo,
    taken_at = case when b.user_id = excluded.user_id and b.kind = 'vol' then b.taken_at else now() end, until = excluded.until, kind = 'vol'
    where (b.user_id = excluded.user_id and b.kind = 'vol') or b.until < now()
  returning * into r;
  if r.reg is null then raise exception 'AVION_PRIS'; end if;
  return r;
end $$;

-- Rendre l'avion : si des vols ont été faits sans rentrer au hangar (vols enchaînés), il part en maintenance.
create or replace function public.release_aircraft(p_reg text, p_maint_minutes int default 0) returns public.aircraft_bookings
language plpgsql security definer set search_path = public as $$
declare r public.aircraft_bookings; s public.aircraft_state; dur int; c1 numeric;
begin
  select * into s from public.aircraft_state where reg = upper(p_reg);
  if found and s.pending_maint > 0 and exists (select 1 from public.aircraft_bookings where reg = s.reg and kind = 'vol' and (user_id = auth.uid() or public.is_admin())) then
    dur := least(greatest(30 + s.pending_maint, 15), 360);
    c1 := least(100, s.condition + 8);
    update public.aircraft_bookings set kind = 'maintenance', taken_at = now(), until = now() + make_interval(mins => dur) where reg = s.reg returning * into r;
    insert into public.aircraft_log (reg, kind, pilot, dep, minutes, cond_before, cond_after, note)
      values (s.reg, 'maintenance', 'Hangar ' || s.location, s.location, dur, s.condition, c1, 'Visite après vol' || case when s.pending_hard then ' + contrôle du train (atterrissage dur)' else '' end);
    update public.aircraft_state set condition = c1, pending_maint = 0, pending_hard = false, updated_at = now() where reg = s.reg;
  elsif coalesce(p_maint_minutes, 0) > 0 then
    update public.aircraft_bookings set kind = 'maintenance', taken_at = now(),
      until = now() + make_interval(mins => least(greatest(p_maint_minutes, 15), 360))
      where reg = upper(p_reg) and kind = 'vol' and (user_id = auth.uid() or public.is_admin())
      returning * into r;
  else
    delete from public.aircraft_bookings where reg = upper(p_reg) and ((user_id = auth.uid() and kind = 'vol') or public.is_admin());
  end if;
  return r;
end $$;

-- Direction : terminer une maintenance, déplacer, retirer / remettre, ajouter un avion.
create or replace function public.hangar_admin(p_action text, p_reg text, p_value text default null, p_type text default null)
returns public.aircraft_state
language plpgsql security definer set search_path = public as $$
declare s public.aircraft_state; me public.pilots;
begin
  if not public.is_admin() then raise exception 'DIRECTION_SEULEMENT'; end if;
  select * into me from public.pilots where id = auth.uid();
  if p_action = 'add' then
    insert into public.aircraft_state (reg, type, label, engine, sim, location)
      values (upper(p_reg), coalesce(nullif(p_type, ''), 'A320'), coalesce(p_value, ''), '', '', 'LFPG')
      on conflict (reg) do update set active = true returning * into s;
  elsif p_action = 'end_maint' then
    delete from public.aircraft_bookings where reg = upper(p_reg) and kind = 'maintenance';
    update public.aircraft_state set condition = greatest(condition, 60), updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'move' then
    update public.aircraft_state set location = upper(left(coalesce(p_value, 'LFPG'), 4)), updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'retire' then
    update public.aircraft_state set active = false, updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'restore' then
    update public.aircraft_state set active = true, updated_at = now() where reg = upper(p_reg) returning * into s;
  else
    raise exception 'ACTION_INCONNUE';
  end if;
  insert into public.aircraft_log (reg, kind, user_id, pilot, note) values (upper(p_reg), 'direction', me.id, me.pseudo, p_action || coalesce(' ' || p_value, ''));
  return s;
end $$;

grant execute on function public.finish_flight(text, text, text, text, int, int, boolean), public.take_aircraft(text, timestamptz), public.release_aircraft(text, int), public.hangar_admin(text, text, text, text) to authenticated;

-- Livrée de chaque avion choisie par la direction (identifiant du catalogue des livrées ; vide = livrée par défaut)
alter table public.aircraft_state add column if not exists livery text not null default '' check (char_length(livery) <= 60);
create or replace function public.hangar_admin(p_action text, p_reg text, p_value text default null, p_type text default null)
returns public.aircraft_state
language plpgsql security definer set search_path = public as $$
declare s public.aircraft_state; me public.pilots;
begin
  if not public.is_admin() then raise exception 'DIRECTION_SEULEMENT'; end if;
  select * into me from public.pilots where id = auth.uid();
  if p_action = 'add' then
    insert into public.aircraft_state (reg, type, label, engine, sim, location)
      values (upper(p_reg), coalesce(nullif(p_type, ''), 'A320'), coalesce(p_value, ''), '', '', 'LFPG')
      on conflict (reg) do update set active = true returning * into s;
  elsif p_action = 'end_maint' then
    delete from public.aircraft_bookings where reg = upper(p_reg) and kind = 'maintenance';
    update public.aircraft_state set condition = greatest(condition, 60), updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'move' then
    update public.aircraft_state set location = upper(left(coalesce(p_value, 'LFPG'), 4)), updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'retire' then
    update public.aircraft_state set active = false, updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'restore' then
    update public.aircraft_state set active = true, updated_at = now() where reg = upper(p_reg) returning * into s;
  elsif p_action = 'livery' then
    if coalesce(p_value, '') !~ '^[a-z0-9-]{0,60}$' then raise exception 'LIVREE_INVALIDE'; end if;
    update public.aircraft_state set livery = coalesce(p_value, ''), updated_at = now() where reg = upper(p_reg) returning * into s;
  else
    raise exception 'ACTION_INCONNUE';
  end if;
  insert into public.aircraft_log (reg, kind, user_id, pilot, note) values (upper(p_reg), 'direction', me.id, me.pseudo, p_action || coalesce(' ' || p_value, ''));
  return s;
end $$;
