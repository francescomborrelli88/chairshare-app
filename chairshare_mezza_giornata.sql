-- =====================================================================
-- ChairShare: mezza giornata con fascia oraria + niente affitto "a ore" per le categorie non ammesse
-- Esegui DOPO chairshare_ore_intere.sql (che sostituisce create_chair_block)
-- =====================================================================

-- 1. "€ / Ora" non ammesso per barbieri, estetica e massaggi.
--    (Psicoterapia, coworking, scrivanie, uffici, sale riunioni e foto/video restano a ore.)
--    Controlla solo quando cambia il tipo o la modalità, così gli annunci già pubblicati non si bloccano.
create or replace function public.spaces_unita_ammessa()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.price_unit = 'ora' and new.type in ('barbiere', 'estetica', 'massaggi')
     and (tg_op = 'INSERT' or new.price_unit is distinct from old.price_unit or new.type is distinct from old.type) then
    raise exception 'UNITA_NON_AMMESSA' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_spaces_unita_ammessa on public.spaces;
create trigger trg_spaces_unita_ammessa before insert or update on public.spaces
  for each row execute function public.spaces_unita_ammessa();

-- 2. Blocco postazione: se l'annuncio è a mezza giornata, la fascia dura esattamente 4 ore
--    ed è dentro l'orario di apertura dell'host per quel giorno.
create or replace function public.create_chair_block(p_space uuid, p_day date, p_start time, p_end time)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  oggi date := (now() at time zone 'Europe/Rome')::date;
  capienza int;
  unita text;
  orari jsonb;
  orario text;
  apertura time;
  chiusura time;
  nuovo uuid;
begin
  if uid is null then raise exception 'NON_AUTENTICATO' using errcode = 'P0001'; end if;
  if p_day is null or p_start is null or p_end is null or p_space is null then
    raise exception 'DATI_NON_VALIDI' using errcode = 'P0001';
  end if;
  if p_end <= p_start or (p_end - p_start) > interval '14 hours' then
    raise exception 'ORARIO_NON_VALIDO' using errcode = 'P0001';
  end if;
  if extract(minute from p_start) <> 0 or extract(minute from p_end) <> 0 or extract(second from p_start) <> 0 or extract(second from p_end) <> 0 then
    raise exception 'ORE_INTERE' using errcode = 'P0001';
  end if;
  if p_day < oggi or p_day > oggi + 120 then
    raise exception 'DATA_NON_VALIDA' using errcode = 'P0001';
  end if;
  select available_chairs, price_unit, daily_schedule::jsonb into capienza, unita, orari from public.spaces where id = p_space;
  if not found then raise exception 'SPAZIO_NON_TROVATO' using errcode = 'P0001'; end if;
  if unita = 'mezza_giornata' then
    if (p_end - p_start) <> interval '4 hours' then
      raise exception 'MEZZA_GIORNATA' using errcode = 'P0001';
    end if;
    -- orario di apertura del giorno (formato "09:00 - 19:00"); se il dato non è leggibile il controllo viene saltato
    orario := orari ->> (array['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato','Domenica'])[extract(isodow from p_day)::int];
    if orari is not null and orari <> '{}'::jsonb and orario is null then
      raise exception 'GIORNO_CHIUSO' using errcode = 'P0001';
    end if;
    if orario is not null then
      begin
        apertura := btrim(split_part(orario, ' - ', 1))::time;
        chiusura := btrim(split_part(orario, ' - ', 2))::time;
      exception when others then apertura := null; chiusura := null;
      end;
      if apertura is not null and (p_start < apertura or p_end > chiusura) then
        raise exception 'FUORI_ORARIO_HOST' using errcode = 'P0001';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.contact_unlocks where user_id = uid and space_id = p_space)
     and not exists (select 1 from public.spaces where id = p_space and user_id = uid) then
    raise exception 'CONTATTO_NON_SBLOCCATO' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('cb' || uid::text));
  perform pg_advisory_xact_lock(hashtext('sp' || p_space::text));
  if exists (select 1 from public.chair_blocks
             where user_id = uid and day = p_day and p_start < end_time and p_end > start_time) then
    raise exception 'BLOCCO_SOVRAPPOSTO' using errcode = 'P0001';
  end if;
  if public.max_blocchi_contemporanei(p_space, p_day, p_start, p_end) >= capienza then
    raise exception 'POSTAZIONI_ESAURITE' using errcode = 'P0001';
  end if;
  if (select count(*) from public.chair_blocks where user_id = uid and day >= oggi) >= 100 then
    raise exception 'LIMITE_BLOCCHI' using errcode = 'P0001';
  end if;
  insert into public.chair_blocks (user_id, space_id, day, start_time, end_time)
  values (uid, p_space, p_day, p_start, p_end) returning id into nuovo;
  return nuovo;
end;
$$;

revoke execute on function public.create_chair_block(uuid, date, time, time) from public, anon;
grant execute on function public.create_chair_block(uuid, date, time, time) to authenticated;
