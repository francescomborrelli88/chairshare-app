-- =====================================================================
-- ChairShare: Suite Freelance (recensioni verificate, note private sui clienti)
-- Esegui DOPO: chairshare_agenda.sql, chairshare_uffici.sql, chairshare_link_nome.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. NOTE PRIVATE SUGLI APPUNTAMENTI (le vede e modifica solo il freelance proprietario)
-- ---------------------------------------------------------------------
alter table public.client_appointments add column if not exists private_notes text;
do $$ begin
  alter table public.client_appointments add constraint ca_private_notes_len
    check (private_notes is null or char_length(private_notes) <= 1000);
exception when duplicate_object then null; end $$;
-- la policy ca_update (freelance_id = auth.uid()) esiste già: aggiungiamo solo il permesso sulla colonna
grant update (private_notes) on public.client_appointments to authenticated;

-- ---------------------------------------------------------------------
-- 2. RECENSIONI DEI CLIENTI AL FREELANCE
-- ---------------------------------------------------------------------
create table if not exists public.freelance_reviews (
  id uuid primary key default gen_random_uuid(),
  freelance_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null,
  client_phone text,
  rating integer not null check (rating >= 1 and rating <= 5),
  comment text check (comment is null or char_length(comment) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists freelance_reviews_freelance on public.freelance_reviews (freelance_id, created_at desc);
-- una sola recensione per cliente (numero) e per freelance
create unique index if not exists freelance_reviews_uno_per_cliente on public.freelance_reviews (freelance_id, client_phone);

alter table public.freelance_reviews enable row level security;
drop policy if exists fr_select_own on public.freelance_reviews;
create policy fr_select_own on public.freelance_reviews for select to authenticated using (freelance_id = auth.uid());
-- nessuna scrittura diretta: si inserisce solo tramite la funzione qui sotto
revoke all on public.freelance_reviews from anon, authenticated;
grant select on public.freelance_reviews to authenticated;

-- numero di telefono confrontabile (solo cifre, senza prefisso +39 / 0039)
create or replace function public.norm_tel(t text)
returns text language sql immutable set search_path = public as $$
  select case when d like '0039%' then substr(d, 5)
              when length(d) >= 11 and d like '39%' then substr(d, 3)
              else d end
  from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x;
$$;

-- da link (nome o ID) a freelance
create or replace function public.risolvi_freelance(p_ref text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare r text := lower(btrim(coalesce(p_ref, ''))); pid uuid;
begin
  if r ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into pid from public.profiles where id = r::uuid and role = 'guest';
  else
    select id into pid from public.profiles where slug = r and role = 'guest';
  end if;
  return pid;
end;
$$;

-- nome del professionista per la pagina "lascia una recensione"
create or replace function public.get_review_target(p_ref text)
returns json language plpgsql stable security definer set search_path = public as $$
declare pid uuid := public.risolvi_freelance(p_ref); nome text;
begin
  if pid is null then return null; end if;
  select full_name into nome from public.profiles where id = pid;
  return json_build_object('name', coalesce(nullif(btrim(nome), ''), 'Professionista'));
end;
$$;

-- Invio recensione: valida solo chi ha davvero avuto un appuntamento già concluso con quel professionista
create or replace function public.submit_freelance_review(p_ref text, p_name text, p_phone text, p_rating integer, p_comment text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  fid uuid := public.risolvi_freelance(p_ref);
  nome text := btrim(coalesce(p_name, ''));
  tel text := public.norm_tel(p_phone);
  com text := nullif(btrim(coalesce(p_comment, '')), '');
  adesso timestamp := now() at time zone 'Europe/Rome';
begin
  if fid is null then raise exception 'NON_TROVATO' using errcode = 'P0001'; end if;
  if char_length(nome) < 2 or char_length(nome) > 80 or char_length(tel) < 6 or char_length(tel) > 15
     or p_rating is null or p_rating < 1 or p_rating > 5 or (com is not null and char_length(com) > 500) then
    raise exception 'DATI_NON_VALIDI' using errcode = 'P0001';
  end if;
  if (select count(*) from public.freelance_reviews where freelance_id = fid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'TROPPE_RICHIESTE' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.client_appointments a
                 where a.freelance_id = fid and a.status <> 'cancelled'
                   and public.norm_tel(a.client_phone) = tel
                   and (a.day + a.end_time) < adesso) then
    raise exception 'NON_VERIFICATO' using errcode = 'P0001';
  end if;
  begin
    insert into public.freelance_reviews (freelance_id, client_name, client_phone, rating, comment)
    values (fid, nome, tel, p_rating, com);
  exception when unique_violation then
    raise exception 'GIA_RECENSITO' using errcode = 'P0001';
  end;
  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. PAGINA PUBBLICA DI PRENOTAZIONE: aggiunge reputazione e ultime recensioni
-- ---------------------------------------------------------------------
create or replace function public.get_booking_page(p_freelance uuid)
returns json
language plpgsql stable security definer set search_path = public as $$
declare
  oggi date := (now() at time zone 'Europe/Rome')::date;
  nome text;
  risultato json;
begin
  select full_name into nome from public.profiles where id = p_freelance and role = 'guest';
  if not found then return null; end if;
  select json_build_object(
    'name', coalesce(nullif(btrim(nome), ''), 'Professionista'),
    'services', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'duration', s.duration_min, 'price', s.price)
                          order by s.created_at) from public.freelance_services s where s.user_id = p_freelance), '[]'::json),
    'blocks', coalesce((select json_agg(json_build_object('id', b.id, 'day', b.day, 'start', to_char(b.start_time, 'HH24:MI'),
                          'end', to_char(b.end_time, 'HH24:MI'), 'salon', sp.name, 'city', sp.city) order by b.day, b.start_time)
                        from public.chair_blocks b join public.spaces sp on sp.id = b.space_id
                        where b.user_id = p_freelance and b.day >= oggi and b.day <= oggi + 60
                          and sp.type not in ('scrivania', 'ufficio', 'sala_riunioni', 'coworking')), '[]'::json),
    'busy', coalesce((select json_agg(json_build_object('block', a.block_id, 'start', to_char(a.start_time, 'HH24:MI'),
                          'end', to_char(a.end_time, 'HH24:MI')))
                      from public.client_appointments a
                      where a.freelance_id = p_freelance and a.day >= oggi and a.status <> 'cancelled'), '[]'::json),
    'rating', (select round(avg(r.rating)::numeric, 1) from public.freelance_reviews r where r.freelance_id = p_freelance),
    'reviews_count', (select count(*) from public.freelance_reviews r where r.freelance_id = p_freelance),
    'reviews', coalesce((select json_agg(x) from (
                  select split_part(btrim(r.client_name), ' ', 1)
                         || coalesce(' ' || left(nullif(split_part(btrim(r.client_name), ' ', 2), ''), 1) || '.', '') as name,
                         r.rating, r.comment, (r.created_at at time zone 'Europe/Rome')::date as day
                  from public.freelance_reviews r where r.freelance_id = p_freelance
                  order by r.created_at desc limit 10) x), '[]'::json)
  ) into risultato;
  return risultato;
end;
$$;

revoke execute on function public.get_booking_page(uuid) from public;
revoke execute on function public.risolvi_freelance(text) from public, anon, authenticated;
revoke execute on function public.get_review_target(text) from public;
revoke execute on function public.submit_freelance_review(text, text, text, integer, text) from public;
grant execute on function public.get_booking_page(uuid) to anon, authenticated;
grant execute on function public.get_review_target(text) to anon, authenticated;
grant execute on function public.submit_freelance_review(text, text, text, integer, text) to anon, authenticated;
grant execute on function public.norm_tel(text) to anon, authenticated;
