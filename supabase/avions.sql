-- Avions de la compagnie (F-HLAT, F-HLAU…) : un avion pris par un pilote n'est pas disponible pour les autres.
-- À coller dans Supabase > SQL Editor > Run (après chat.sql, qui crée la table des pilotes).
-- On peut le relancer sans risque : c'est comme ça qu'on ajoute les nouveautés (ex. la maintenance).
-- Après un vol, l'avion rentre au hangar en maintenance : personne ne peut le prendre avant la fin.
-- Tout est vérifié ici, côté serveur : deux pilotes ne peuvent pas prendre le même avion, même en même temps.

create table if not exists public.aircraft_bookings (
  reg text primary key check (reg ~ '^[A-Z0-9-]{3,10}$'),
  user_id uuid not null references public.pilots(id) on delete cascade,
  pseudo text not null,
  taken_at timestamptz not null default now(),
  until timestamptz not null
);
-- « vol » : un pilote l'a pris ; « maintenance » : au hangar après un vol, indisponible jusqu'à « until »
alter table public.aircraft_bookings add column if not exists kind text not null default 'vol' check (kind in ('vol', 'maintenance'));
alter table public.aircraft_bookings enable row level security;
grant select on public.aircraft_bookings to authenticated;
drop policy if exists bookings_read on public.aircraft_bookings;
create policy bookings_read on public.aircraft_bookings for select to authenticated using (true);
-- aucune écriture directe : uniquement par les deux fonctions ci-dessous

-- Prendre un avion jusqu'à « p_until » (entre 30 min et 24 h). Un pilote n'a qu'un avion à la fois.
create or replace function public.take_aircraft(p_reg text, p_until timestamptz)
returns public.aircraft_bookings
language plpgsql security definer set search_path = public as $$
declare p public.pilots; r public.aircraft_bookings; u timestamptz;
begin
  select * into p from public.pilots where id = auth.uid();
  if not found or p.banned then raise exception 'PILOTE_INCONNU'; end if;
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

-- Rendre l'avion (le pilote qui l'a pris, ou la direction). Après un vol, p_maint_minutes > 0 :
-- l'avion part en maintenance au hangar (de 15 min à 6 h) au lieu d'être libre tout de suite.
-- La direction peut aussi terminer une maintenance (p_maint_minutes = 0).
drop function if exists public.release_aircraft(text);
create or replace function public.release_aircraft(p_reg text, p_maint_minutes int default 0) returns public.aircraft_bookings
language plpgsql security definer set search_path = public as $$
declare r public.aircraft_bookings;
begin
  if coalesce(p_maint_minutes, 0) > 0 then
    update public.aircraft_bookings set kind = 'maintenance', taken_at = now(),
      until = now() + make_interval(mins => least(greatest(p_maint_minutes, 15), 360))
      where reg = upper(p_reg) and kind = 'vol' and (user_id = auth.uid() or public.is_admin())
      returning * into r;
  else
    delete from public.aircraft_bookings where reg = upper(p_reg) and ((user_id = auth.uid() and kind = 'vol') or public.is_admin());
  end if;
  return r;
end $$;

grant execute on function public.take_aircraft(text, timestamptz), public.release_aircraft(text, int) to authenticated;
