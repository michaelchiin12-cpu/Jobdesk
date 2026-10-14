-- =====================================================================
-- Jobdesk CS: skema lengkap. IDEMPOTENT: aman dijalankan berulang,
-- baik di database kosong maupun yang sudah dipakai versi sebelumnya.
-- Hanya menambah struktur. Tidak ada DROP TABLE atau DROP COLUMN.
-- Jalankan seluruh file ini di Supabase > SQL Editor > Run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Skema privat dan ekstensi
-- ---------------------------------------------------------------------
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- Ekstensi untuk scheduler background. Jika gagal, skema tetap terpasang
-- dan aplikasi menampilkan status "scheduler belum aktif".
do $$ begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron tidak dapat diaktifkan: %', sqlerrm;
end $$;

do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net tidak dapat diaktifkan: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 1. Tabel inti (versi awal) dan kolom baru
-- ---------------------------------------------------------------------
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  absent_on text,
  created_at timestamptz not null default now()
);
alter table public.team_members add column if not exists archived_at timestamptz;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  pic text not null,
  due_at timestamptz not null,
  note text default '',
  repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekdays')),
  done boolean not null default false,
  done_at timestamptz,
  spawned boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.tasks
  add column if not exists priority text not null default 'medium',
  add column if not exists status text not null default 'todo',
  add column if not exists started_at timestamptz,
  add column if not exists original_due_at timestamptz,
  add column if not exists original_pic text,
  add column if not exists late_reason text,
  add column if not exists late_note text,
  add column if not exists remind_enabled boolean not null default true,
  add column if not exists remind_before_min integer not null default 10,
  add column if not exists template_id uuid,
  add column if not exists occurrence_date date,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by text,
  add column if not exists archived_at timestamptz;

-- Data lama: isi kolom baru dari data yang sudah ada (tanpa mengubah isi lama).
update public.tasks set status = 'done' where done and status <> 'done';
update public.tasks set original_due_at = due_at where original_due_at is null;
update public.tasks set original_pic = pic where original_pic is null;

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text default '',
  pic text not null,
  priority text not null default 'medium',
  repeat_type text not null,
  weekday smallint,
  month_day smallint,
  due_time time not null default '17:00',
  remind_enabled boolean not null default true,
  remind_before_min integer not null default 10,
  starts_on date not null default ((now() at time zone 'Asia/Jakarta')::date),
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  task_id uuid,
  task_title text not null,
  action text not null,
  actor text not null,
  old_value text,
  new_value text,
  meta jsonb not null default '{}'::jsonb,
  dedup_key text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  kind text not null,
  task_id uuid,
  audience text not null default 'all',
  audience_pic text,
  title text not null,
  body text not null default '',
  urgent boolean not null default false,
  dedup_key text not null unique,
  push_state text not null default 'pending',
  push_sent integer not null default 0,
  push_failed integer not null default 0,
  push_request_id bigint,
  push_queued_at timestamptz,
  push_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  role text not null,
  member_name text,
  kinds text[] not null default array['reminder','overdue','assigned','task_changed','lead_overdue','digest_morning','digest_evening'],
  user_agent text,
  failed_count integer not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_roles (
  email text primary key,
  role text not null check (role in ('lead', 'cs')),
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists app_private.settings (
  key text primary key,
  value text not null
);

create table if not exists app_private.scheduler_state (
  id integer primary key default 1 check (id = 1),
  last_run timestamptz
);
insert into app_private.scheduler_state (id, last_run) values (1, null) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Constraint, indeks, dan data awal
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_chk') then
    alter table public.tasks add constraint tasks_priority_chk check (priority in ('high', 'medium', 'low'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_status_chk') then
    alter table public.tasks add constraint tasks_status_chk check (status in ('todo', 'in_progress', 'waiting', 'done'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_remind_chk') then
    alter table public.tasks add constraint tasks_remind_chk check (remind_before_min between 1 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_late_reason_chk') then
    alter table public.tasks add constraint tasks_late_reason_chk
      check (late_reason is null or late_reason in ('high_workload', 'waiting_info', 'system_issue', 'priority_changed', 'bad_estimate', 'other'));
  end if;
  -- NOT VALID: hanya baris baru yang diperiksa, data lama tidak ditolak.
  if not exists (select 1 from pg_constraint where conname = 'tasks_title_len_chk') then
    alter table public.tasks add constraint tasks_title_len_chk check (char_length(trim(title)) between 1 and 120) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_note_len_chk') then
    alter table public.tasks add constraint tasks_note_len_chk check (char_length(coalesce(note, '')) <= 1000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_late_note_len_chk') then
    alter table public.tasks add constraint tasks_late_note_len_chk check (char_length(coalesce(late_note, '')) <= 500) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_updated_by_len_chk') then
    alter table public.tasks add constraint tasks_updated_by_len_chk check (char_length(coalesce(updated_by, '')) <= 60) not valid;
  end if;

  -- coalesce(..., false): weekday/month_day yang kosong harus ditolak (NULL di CHECK dianggap lulus).
  -- Dibuat ulang agar versi lama yang lolos NULL diganti; NOT VALID supaya data lama tidak menggagalkan skrip.
  alter table public.task_templates drop constraint if exists templates_repeat_chk;
  alter table public.task_templates add constraint templates_repeat_chk check (
    repeat_type in ('daily', 'weekdays', 'weekly', 'monthly')
    and (repeat_type <> 'weekly' or coalesce(weekday between 1 and 7, false))
    and (repeat_type <> 'monthly' or coalesce(month_day between 1 and 31, false))
  ) not valid;
  if not exists (select 1 from pg_constraint where conname = 'templates_priority_chk') then
    alter table public.task_templates add constraint templates_priority_chk check (priority in ('high', 'medium', 'low'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'templates_remind_chk') then
    alter table public.task_templates add constraint templates_remind_chk check (remind_before_min between 1 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'templates_title_len_chk') then
    alter table public.task_templates add constraint templates_title_len_chk check (char_length(trim(title)) between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_template_fk') then
    alter table public.tasks add constraint tasks_template_fk
      foreign key (template_id) references public.task_templates (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_key_chk') then
    alter table public.app_settings add constraint app_settings_key_chk check (key in (
      'cs_can_manage', 'lead_escalation', 'escalation_minutes', 'digests_enabled', 'digest_morning', 'digest_evening'));
  end if;
end $$;

-- Satu occurrence per template per tanggal: kunci anti-duplikasi untuk tugas berulang.
create unique index if not exists tasks_template_occurrence_uq on public.tasks (template_id, occurrence_date);
create index if not exists tasks_due_at_idx on public.tasks (due_at desc);
create index if not exists tasks_open_idx on public.tasks (due_at) where not done and archived_at is null;
create index if not exists tasks_pic_idx on public.tasks (pic);
create index if not exists task_events_created_idx on public.task_events (created_at desc);
create index if not exists task_events_task_idx on public.task_events (task_id);
create index if not exists notifications_created_idx on public.notifications (created_at desc);
create index if not exists notifications_pending_idx on public.notifications (id) where push_state in ('pending', 'queued');

insert into public.app_roles (email, role) values
  ('tim@jobdesk.example.com', 'cs'),
  ('lead@jobdesk.example.com', 'lead')
on conflict (email) do nothing;

insert into public.app_settings (key, value) values
  ('cs_can_manage', 'false'::jsonb),
  ('lead_escalation', 'true'::jsonb),
  ('escalation_minutes', '15'::jsonb),
  ('digests_enabled', 'true'::jsonb),
  ('digest_morning', '"08:30"'::jsonb),
  ('digest_evening', '"17:30"'::jsonb)
on conflict (key) do nothing;

-- Jobdesk berulang versi lama (dibuat browser) dipindah menjadi template, sekali saja.
do $$
declare g record; v_id uuid;
begin
  if exists (select 1 from public.task_templates) then return; end if;
  for g in
    select distinct on (title, pic, repeat) id, title, note, pic, due_at, repeat, priority, remind_enabled, remind_before_min
    from public.tasks
    where repeat in ('daily', 'weekdays') and not done and archived_at is null and template_id is null
    order by title, pic, repeat, due_at
  loop
    insert into public.task_templates (title, note, pic, priority, repeat_type, due_time, remind_enabled, remind_before_min, starts_on, created_by)
    values (g.title, coalesce(g.note, ''), g.pic, g.priority, g.repeat,
            (g.due_at at time zone 'Asia/Jakarta')::time, g.remind_enabled, g.remind_before_min,
            (g.due_at at time zone 'Asia/Jakarta')::date, 'Migrasi')
    returning id into v_id;
    update public.tasks
       set template_id = v_id, occurrence_date = (due_at at time zone 'Asia/Jakarta')::date, spawned = true
     where id = g.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Fungsi bantu: peran, pengaturan
-- ---------------------------------------------------------------------
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select r.role from public.app_roles r
  where lower(r.email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1
$$;

create or replace function public.is_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'lead', false)
$$;

create or replace function public.setting_text(p_key text, p_default text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select s.value #>> '{}' from public.app_settings s where s.key = p_key), p_default)
$$;

create or replace function public.setting_bool(p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (s.value #>> '{}')::boolean from public.app_settings s where s.key = p_key), p_default)
$$;

create or replace function public.setting_int(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select (s.value #>> '{}')::integer from public.app_settings s where s.key = p_key), p_default)
$$;

create or replace function public.can_manage() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_lead() or (public.app_role() = 'cs' and public.setting_bool('cs_can_manage', false))
$$;

-- True bila dipanggil tanpa JWT (pg_cron, SQL editor, migrasi). Klien API selalu membawa JWT.
create or replace function public.is_internal() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = ''
$$;

-- ---------------------------------------------------------------------
-- 4. Trigger tugas: status, waktu penyelesaian, aturan hak akses
-- ---------------------------------------------------------------------
create or replace function public.tasks_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_internal boolean := public.is_internal();
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.done or new.status = 'done' then
      new.done := true; new.status := 'done'; new.done_at := now();
    else
      new.done_at := null;
    end if;
    new.original_due_at := new.due_at;
    new.original_pic := new.pic;
    -- Waktu dibuat dan waktu mulai selalu dari jam server, tidak bisa diisi klien.
    new.created_at := now();
    new.started_at := case when new.status = 'in_progress' then now() else null end;
    return new;
  end if;

  -- UPDATE
  if not v_internal then
    if v_role is null then
      raise exception 'Akses ditolak' using errcode = '42501';
    end if;
    if v_role = 'cs' and not public.can_manage() then
      if (new.title, new.note, new.pic, new.due_at, new.priority, new.remind_enabled, new.remind_before_min,
          new.archived_at, new.template_id, new.occurrence_date)
         is distinct from
         (old.title, old.note, old.pic, old.due_at, old.priority, old.remind_enabled, old.remind_before_min,
          old.archived_at, old.template_id, old.occurrence_date) then
        raise exception 'Akun CS hanya boleh mengubah status, waktu mulai, dan alasan keterlambatan' using errcode = '42501';
      end if;
    end if;
    new.template_id := old.template_id;
    new.occurrence_date := old.occurrence_date;
  end if;

  new.id := old.id;
  new.created_at := old.created_at;
  new.original_due_at := old.original_due_at;
  new.original_pic := old.original_pic;

  -- Sinkron status dan done. Waktu selesai selalu jam server.
  if new.done is distinct from old.done then
    if new.done then
      new.status := 'done'; new.done_at := now();
    else
      new.done_at := null;
      if new.status = 'done' then new.status := 'todo'; end if;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'done' then
      new.done := true; new.done_at := now();
    elsif old.status = 'done' then
      new.done := false; new.done_at := null;
    end if;
  end if;
  if new.done and old.done then new.done_at := old.done_at; end if;
  if not new.done then new.done_at := null; end if;
  if new.status = 'in_progress' and new.started_at is null then new.started_at := now(); end if;
  return new;
end $$;

create or replace function public.tasks_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_actor text;
  v_meta jsonb;
  v_epoch bigint := extract(epoch from new.updated_at)::bigint;
begin
  v_actor := coalesce(nullif(new.updated_by, ''),
    case v_role when 'lead' then 'CS Lead' when 'cs' then 'Tim CS' else 'Sistem' end);
  v_meta := jsonb_build_object('role', coalesce(v_role, 'system'));

  if tg_op = 'INSERT' then
    insert into public.task_events (task_id, task_title, action, actor, new_value, meta)
    values (new.id, new.title, 'created', v_actor, new.pic,
            v_meta || jsonb_build_object('priority', new.priority, 'due_at', new.due_at));
    if not (new.template_id is not null and v_actor = 'Sistem') and v_actor is distinct from new.pic and not new.done then
      insert into public.notifications (kind, task_id, audience, audience_pic, title, body, urgent, dedup_key)
      values ('assigned', new.id, 'pic', new.pic, 'Jobdesk baru untuk ' || new.pic,
              new.title || ' · tenggat ' || to_char(new.due_at at time zone 'Asia/Jakarta', 'DD/MM HH24:MI') || ' WIB',
              new.priority = 'high', 'assigned:' || new.id || ':' || new.pic || ':new')
      on conflict (dedup_key) do nothing;
    end if;
    return new;
  end if;

  if new.pic is distinct from old.pic then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'pic_changed', v_actor, old.pic, new.pic, v_meta);
    if v_actor is distinct from new.pic and not new.done and new.archived_at is null then
      insert into public.notifications (kind, task_id, audience, audience_pic, title, body, urgent, dedup_key)
      values ('assigned', new.id, 'pic', new.pic, 'Jobdesk dialihkan ke ' || new.pic,
              new.title || ' · tenggat ' || to_char(new.due_at at time zone 'Asia/Jakarta', 'DD/MM HH24:MI') || ' WIB',
              new.priority = 'high', 'assigned:' || new.id || ':' || new.pic || ':' || v_epoch)
      on conflict (dedup_key) do nothing;
    end if;
  end if;

  if new.due_at is distinct from old.due_at then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'due_changed', v_actor,
            to_char(old.due_at at time zone 'Asia/Jakarta', 'DD/MM/YYYY HH24:MI'),
            to_char(new.due_at at time zone 'Asia/Jakarta', 'DD/MM/YYYY HH24:MI'), v_meta);
    if v_actor is distinct from new.pic and not new.done and new.archived_at is null then
      insert into public.notifications (kind, task_id, audience, audience_pic, title, body, urgent, dedup_key)
      values ('task_changed', new.id, 'pic', new.pic, 'Deadline berubah: ' || new.title,
              'Tenggat baru ' || to_char(new.due_at at time zone 'Asia/Jakarta', 'DD/MM HH24:MI') || ' WIB',
              false, 'changed:' || new.id || ':due:' || v_epoch)
      on conflict (dedup_key) do nothing;
    end if;
  end if;

  if new.priority is distinct from old.priority then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'priority_changed', v_actor, old.priority, new.priority, v_meta);
    if new.priority = 'high' and v_actor is distinct from new.pic and not new.done and new.archived_at is null then
      insert into public.notifications (kind, task_id, audience, audience_pic, title, body, urgent, dedup_key)
      values ('task_changed', new.id, 'pic', new.pic, 'Prioritas tinggi: ' || new.title,
              'Jobdesk ini sekarang berprioritas tinggi.', true, 'changed:' || new.id || ':prio:' || v_epoch)
      on conflict (dedup_key) do nothing;
    end if;
  end if;

  if new.status is distinct from old.status and new.status <> 'done' and old.status <> 'done' then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'status_changed', v_actor, old.status, new.status, v_meta);
  end if;

  if new.done and not old.done then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'completed', v_actor, old.status, 'done',
            v_meta || jsonb_build_object('late', new.done_at > new.due_at, 'done_at', new.done_at));
  elsif old.done and not new.done then
    insert into public.task_events (task_id, task_title, action, actor, old_value, new_value, meta)
    values (new.id, new.title, 'reopened', v_actor, 'done', new.status, v_meta);
  end if;

  if new.archived_at is distinct from old.archived_at then
    insert into public.task_events (task_id, task_title, action, actor, meta)
    values (new.id, new.title, case when new.archived_at is null then 'restored' else 'archived' end, v_actor, v_meta);
  end if;

  if new.late_reason is distinct from old.late_reason and new.late_reason is not null then
    insert into public.task_events (task_id, task_title, action, actor, new_value, meta)
    values (new.id, new.title, 'late_reason_set', v_actor, new.late_reason,
            v_meta || jsonb_build_object('note', coalesce(new.late_note, '')));
  end if;
  return new;
end $$;

drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

drop trigger if exists tasks_after_write on public.tasks;
create trigger tasks_after_write after insert or update on public.tasks
  for each row execute function public.tasks_after_write();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists templates_touch on public.task_templates;
create trigger templates_touch before update on public.task_templates
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.team_members enable row level security;
alter table public.task_templates enable row level security;
alter table public.task_events enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_roles enable row level security;
alter table public.app_settings enable row level security;

-- Kebijakan lama (satu akun bersama punya akses penuh) harus dihapus.
drop policy if exists "tim bersama" on public.tasks;
drop policy if exists "tim bersama" on public.team_members;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated using (
  (select public.app_role()) is not null
  and ((select public.is_lead())
       or (archived_at is null and (not done or done_at >= now() - interval '14 days')))
);
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.can_manage()));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using ((select public.app_role()) is not null and ((select public.is_lead()) or archived_at is null))
  with check ((select public.app_role()) is not null);
-- Tidak ada kebijakan DELETE: jobdesk hanya diarsipkan (archived_at).

drop policy if exists members_select on public.team_members;
create policy members_select on public.team_members for select to authenticated using (
  (select public.app_role()) is not null and (archived_at is null or (select public.is_lead()))
);
drop policy if exists members_insert on public.team_members;
create policy members_insert on public.team_members for insert to authenticated with check ((select public.can_manage()));
drop policy if exists members_update on public.team_members;
create policy members_update on public.team_members for update to authenticated
  using ((select public.can_manage())) with check ((select public.can_manage()));
drop policy if exists members_delete on public.team_members;
create policy members_delete on public.team_members for delete to authenticated using ((select public.is_lead()));

drop policy if exists templates_all on public.task_templates;
create policy templates_all on public.task_templates for all to authenticated
  using ((select public.is_lead())) with check ((select public.is_lead()));

drop policy if exists events_select on public.task_events;
create policy events_select on public.task_events for select to authenticated using (
  (select public.app_role()) is not null
  and ((select public.is_lead()) or created_at >= now() - interval '14 days')
);

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated using (
  (select public.app_role()) is not null and ((select public.is_lead()) or audience <> 'lead')
);

drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to authenticated
  using ((select public.app_role()) is not null);
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for insert to authenticated with check ((select public.is_lead()));
drop policy if exists settings_update on public.app_settings;
create policy settings_update on public.app_settings for update to authenticated
  using ((select public.is_lead())) with check ((select public.is_lead()));

-- Tabel sensitif: tidak ada kebijakan sama sekali, akses hanya lewat fungsi di bawah.
revoke all on public.app_roles from anon, authenticated;
revoke all on public.push_subscriptions from anon, authenticated;
revoke insert, update, delete on public.task_events from anon, authenticated;
revoke insert, update, delete on public.notifications from anon, authenticated;
revoke delete on public.tasks from anon, authenticated;
revoke all on public.tasks, public.team_members, public.task_templates, public.task_events,
  public.notifications, public.app_settings from anon;

-- ---------------------------------------------------------------------
-- 6. Fungsi RPC untuk klien
-- ---------------------------------------------------------------------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$ select public.app_role() $$;

create or replace function public.upsert_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_member text, p_kinds text[], p_ua text
) returns void language plpgsql security definer set search_path = public as $$
declare v_role text := public.app_role();
begin
  if v_role is null then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then
    raise exception 'Endpoint tidak valid' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth, role, member_name, kinds, user_agent)
  values (p_endpoint, p_p256dh, p_auth, v_role, nullif(left(p_member, 60), ''),
          coalesce(p_kinds, array['reminder','overdue','assigned','task_changed','lead_overdue','digest_morning','digest_evening']),
          left(p_ua, 200))
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh, auth = excluded.auth, role = excluded.role,
    member_name = excluded.member_name, kinds = excluded.kinds, user_agent = excluded.user_agent,
    failed_count = 0, updated_at = now();
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() is null then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
end $$;

create or replace function public.get_my_push_subscription(p_endpoint text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if public.app_role() is null then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  select jsonb_build_object('member_name', member_name, 'kinds', to_jsonb(kinds), 'last_success_at', last_success_at)
    into v from public.push_subscriptions where endpoint = p_endpoint;
  return v;
end $$;

-- Dipanggil route /api/push setelah mengirim. Hanya berisi hasil, dilindungi secret bersama.
create or replace function public.confirm_push(p_secret text, p_id bigint, p_results jsonb) returns void
language plpgsql security definer set search_path = public, app_private as $$
declare v_secret text; v_sent integer; v_total integer;
begin
  select value into v_secret from app_private.settings where key = 'push_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    raise exception 'Tidak diizinkan' using errcode = '42501';
  end if;
  v_total := jsonb_array_length(coalesce(p_results, '[]'::jsonb));
  select count(*) into v_sent from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e(v)
   where coalesce((e.v ->> 'ok')::boolean, false);

  update public.notifications set
    push_state = case when v_total = 0 then 'no_subscribers' when v_sent = 0 then 'failed'
                      when v_sent = v_total then 'sent' else 'partial' end,
    push_sent = v_sent, push_failed = v_total - v_sent, push_confirmed_at = now()
  where id = p_id;

  update public.push_subscriptions s set last_success_at = now(), failed_count = 0
    from jsonb_array_elements(p_results) e(v)
   where s.endpoint = e.v ->> 'endpoint' and coalesce((e.v ->> 'ok')::boolean, false);
  update public.push_subscriptions s set failed_count = s.failed_count + 1
    from jsonb_array_elements(p_results) e(v)
   where s.endpoint = e.v ->> 'endpoint' and not coalesce((e.v ->> 'ok')::boolean, false);
  delete from public.push_subscriptions s using jsonb_array_elements(p_results) e(v)
   where s.endpoint = e.v ->> 'endpoint' and (e.v ->> 'status') in ('404', '410');
  delete from public.push_subscriptions where failed_count >= 5;
end $$;

create or replace function public.scheduler_status() returns jsonb
language plpgsql stable security definer set search_path = public, app_private as $$
declare v_cron boolean := false;
begin
  if public.app_role() is null then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  begin
    execute 'select exists (select 1 from cron.job where jobname = ''jobdesk-scheduler'')' into v_cron;
  exception when others then v_cron := false;
  end;
  return jsonb_build_object(
    'last_run', (select last_run from app_private.scheduler_state where id = 1),
    'cron_job', v_cron,
    'push_configured', exists (select 1 from app_private.settings where key = 'push_url')
                       and exists (select 1 from app_private.settings where key = 'push_secret'));
end $$;

-- ---------------------------------------------------------------------
-- 7. Tugas berulang dari template (idempoten)
-- ---------------------------------------------------------------------
-- Aturan jadwal dalam satu fungsi murni agar bisa diuji untuk tanggal mana pun.
-- Bulanan: tanggal 31 jatuh di akhir bulan pada bulan yang lebih pendek (30, 28, atau 29 Februari).
create or replace function public.template_occurs_on(p_type text, p_weekday integer, p_month_day integer, p_date date)
returns boolean language sql immutable as $$
  select case p_type
    when 'daily' then true
    when 'weekdays' then extract(isodow from p_date) between 1 and 5
    when 'weekly' then extract(isodow from p_date) = p_weekday
    when 'monthly' then extract(day from p_date) = least(p_month_day,
      extract(day from (date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day'))::integer)
    else false end
$$;

create or replace function public.generate_recurring_tasks(p_horizon_days integer default 1) returns integer
language plpgsql security definer set search_path = public as $$
declare
  t record; d date; v_ok boolean; v_rows integer; v_total integer := 0;
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  if not public.is_internal() and not public.can_manage() then
    raise exception 'Akses ditolak' using errcode = '42501';
  end if;
  for t in select * from public.task_templates where active and archived_at is null loop
    for d in select g::date from generate_series(greatest(v_today, t.starts_on)::timestamp,
                                                 (v_today + least(greatest(p_horizon_days, 0), 7))::timestamp,
                                                 interval '1 day') g loop
      v_ok := public.template_occurs_on(t.repeat_type, t.weekday, t.month_day, d);
      if v_ok then
        insert into public.tasks (title, note, pic, due_at, priority, remind_enabled, remind_before_min,
                                  template_id, occurrence_date, updated_by)
        values (t.title, coalesce(t.note, ''), t.pic, (d + t.due_time) at time zone 'Asia/Jakarta',
                t.priority, t.remind_enabled, t.remind_before_min, t.id, d, 'Sistem')
        on conflict (template_id, occurrence_date) do nothing;
        get diagnostics v_rows = row_count;
        v_total := v_total + v_rows;
      end if;
    end loop;
  end loop;
  return v_total;
end $$;

-- Terapkan isi template ke tugas yang belum selesai (pilihan eksplisit lead).
create or replace function public.apply_template_to_open_tasks(p_template uuid, p_actor text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare t public.task_templates; v_rows integer;
begin
  if not public.is_lead() then raise exception 'Hanya CS Lead yang boleh mengubah template' using errcode = '42501'; end if;
  select * into t from public.task_templates where id = p_template;
  if not found then raise exception 'Template tidak ditemukan' using errcode = 'P0002'; end if;
  update public.tasks set
    title = t.title, note = coalesce(t.note, ''), pic = t.pic, priority = t.priority,
    remind_enabled = t.remind_enabled, remind_before_min = t.remind_before_min,
    due_at = (occurrence_date + t.due_time) at time zone 'Asia/Jakarta',
    updated_by = left(coalesce(nullif(p_actor, ''), 'CS Lead'), 60)
  where template_id = p_template and not done and archived_at is null and occurrence_date is not null;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- Hentikan pengulangan. Tugas yang sudah dibuat tetap ada, kecuali lead memilih mengarsipkan
-- yang belum dimulai dan belum jatuh tempo.
create or replace function public.stop_template(p_template uuid, p_archive_open boolean default false, p_actor text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v_rows integer := 0;
begin
  if not public.is_lead() then raise exception 'Hanya CS Lead yang boleh mengubah template' using errcode = '42501'; end if;
  update public.task_templates set active = false, archived_at = now(), updated_by = left(coalesce(nullif(p_actor, ''), 'CS Lead'), 60)
   where id = p_template;
  if p_archive_open then
    update public.tasks set archived_at = now(), updated_by = left(coalesce(nullif(p_actor, ''), 'CS Lead'), 60)
     where template_id = p_template and not done and archived_at is null and status = 'todo' and due_at > now();
    get diagnostics v_rows = row_count;
  end if;
  return v_rows;
end $$;

-- ---------------------------------------------------------------------
-- 8. Scheduler background (dijalankan pg_cron tiap menit)
-- ---------------------------------------------------------------------
create or replace function app_private.run_scheduler() returns void
language plpgsql security definer set search_path = public, app_private as $$
declare
  n record; v_subs jsonb; v_url text; v_secret text; v_req bigint;
  v_local timestamp := now() at time zone 'Asia/Jakarta';
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_open integer; v_late integer; v_done integer; v_due_today integer; v_list text;
begin
  if not pg_try_advisory_xact_lock(hashtext('jobdesk_scheduler')) then return; end if;
  update app_private.scheduler_state set last_run = now() where id = 1;

  perform public.generate_recurring_tasks(1);

  -- Catat kejadian "terlambat" sekali per tenggat.
  insert into public.task_events (task_id, task_title, action, actor, new_value, dedup_key, meta, created_at)
  select t.id, t.title, 'became_late', 'Sistem', t.pic,
         'late:' || t.id || ':' || extract(epoch from t.due_at)::bigint,
         jsonb_build_object('due_at', t.due_at), t.due_at
  from public.tasks t
  where not t.done and t.archived_at is null and t.due_at < now() and t.due_at > now() - interval '7 days'
  on conflict (dedup_key) do nothing;

  -- Pengingat sebelum tenggat (sekali per tenggat).
  insert into public.notifications (kind, task_id, audience, title, body, urgent, dedup_key)
  select 'reminder', t.id, 'all', 'Segera jatuh tempo: ' || t.title,
         'PIC ' || t.pic || ' · tenggat ' || to_char(t.due_at at time zone 'Asia/Jakarta', 'HH24:MI') || ' WIB',
         t.priority = 'high', 'reminder:' || t.id || ':' || extract(epoch from t.due_at)::bigint
  from public.tasks t
  where not t.done and t.archived_at is null and t.remind_enabled
    and t.due_at > now() and now() >= t.due_at - make_interval(mins => t.remind_before_min)
  on conflict (dedup_key) do nothing;

  -- Tenggat terlewat (sekali per tenggat, hanya yang lewat kurang dari 1 hari).
  insert into public.notifications (kind, task_id, audience, title, body, urgent, dedup_key)
  select 'overdue', t.id, 'all', 'Terlambat: ' || t.title,
         'PIC ' || t.pic || ' · tenggat ' || to_char(t.due_at at time zone 'Asia/Jakarta', 'HH24:MI') || ' WIB',
         true, 'overdue:' || t.id || ':' || extract(epoch from t.due_at)::bigint
  from public.tasks t
  where not t.done and t.archived_at is null and t.remind_enabled
    and t.due_at <= now() and t.due_at > now() - interval '1 day'
  on conflict (dedup_key) do nothing;

  -- Eskalasi ke CS Lead untuk prioritas tinggi yang terlambat.
  if public.setting_bool('lead_escalation', true) then
    insert into public.notifications (kind, task_id, audience, title, body, urgent, dedup_key)
    select 'lead_overdue', t.id, 'lead', 'Prioritas tinggi terlambat: ' || t.title,
           'PIC ' || t.pic || ' · tenggat ' || to_char(t.due_at at time zone 'Asia/Jakarta', 'HH24:MI') || ' WIB',
           true, 'lead_overdue:' || t.id || ':' || extract(epoch from t.due_at)::bigint
    from public.tasks t
    where not t.done and t.archived_at is null and t.priority = 'high'
      and t.due_at <= now() - make_interval(mins => public.setting_int('escalation_minutes', 15))
      and t.due_at > now() - interval '1 day'
    on conflict (dedup_key) do nothing;
  end if;

  -- Ringkasan pagi dan akhir hari (Asia/Jakarta, hanya dalam 2 jam setelah jadwal).
  if public.setting_bool('digests_enabled', true) then
    select count(*) filter (where not done),
           count(*) filter (where not done and due_at < now()),
           count(*) filter (where done and (done_at at time zone 'Asia/Jakarta')::date = v_today),
           count(*) filter (where (due_at at time zone 'Asia/Jakarta')::date = v_today)
      into v_open, v_late, v_done, v_due_today
    from public.tasks where archived_at is null;

    if extract(epoch from (v_local::time - public.setting_text('digest_morning', '08:30')::time)) between 0 and 7200
       and v_open > 0 then
      select string_agg(x.title || ' (' || x.pic || ')', ', ' order by x.is_high desc, x.due_at) into v_list
      from (select title, pic, due_at, (priority = 'high') as is_high from public.tasks
            where not done and archived_at is null and due_at < now()
            order by (priority = 'high') desc, due_at limit 3) x;
      insert into public.notifications (kind, audience, title, body, urgent, dedup_key)
      values ('digest_morning', 'all', 'Ringkasan pagi: ' || v_open || ' jobdesk belum selesai',
              case when v_late > 0 then v_late || ' terlambat: ' || coalesce(v_list, '') else 'Tidak ada yang terlambat.' end,
              v_late > 0, 'digest_morning:' || v_today)
      on conflict (dedup_key) do nothing;
    end if;

    if extract(epoch from (v_local::time - public.setting_text('digest_evening', '17:30')::time)) between 0 and 7200
       and (v_open + v_done) > 0 then
      insert into public.notifications (kind, audience, title, body, urgent, dedup_key)
      values ('digest_evening', 'all', 'Ringkasan akhir hari: ' || v_done || ' selesai, ' || v_open || ' belum selesai',
              case when v_late > 0 then v_late || ' jobdesk terlambat dan perlu tindak lanjut.' else 'Tidak ada jobdesk terlambat.' end,
              v_late > 0, 'digest_evening:' || v_today)
      on conflict (dedup_key) do nothing;
    end if;
  end if;

  -- Pengiriman Web Push. Status "sent" hanya diisi setelah route /api/push mengonfirmasi.
  update public.notifications set push_state = 'unconfirmed'
   where push_state = 'queued' and push_queued_at < now() - interval '3 minutes';

  select value into v_url from app_private.settings where key = 'push_url';
  select value into v_secret from app_private.settings where key = 'push_secret';

  for n in select * from public.notifications where push_state = 'pending' order by id limit 50 loop
    begin
      select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
        into v_subs
      from public.push_subscriptions s
      where n.kind = any (s.kinds)
        and (n.audience = 'all'
             or (n.audience = 'lead' and s.role = 'lead')
             or (n.audience = 'pic' and s.member_name = n.audience_pic));

      if jsonb_array_length(v_subs) = 0 then
        update public.notifications set push_state = 'no_subscribers' where id = n.id;
      elsif v_url is null or v_secret is null then
        update public.notifications set push_state = 'not_configured' where id = n.id;
      else
        select net.http_post(
          url := v_url,
          body := jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body,
                                     'urgent', n.urgent, 'task_id', n.task_id, 'subscriptions', v_subs),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
          timeout_milliseconds := 8000) into v_req;
        update public.notifications set push_state = 'queued', push_request_id = v_req, push_queued_at = now()
         where id = n.id;
      end if;
    exception when others then
      update public.notifications set push_state = 'failed' where id = n.id;
    end;
  end loop;

  delete from public.notifications where created_at < now() - interval '30 days';
end $$;

-- Pasang jadwal tiap menit. Gagal dengan pesan jelas jika pg_cron belum aktif.
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'jobdesk-scheduler';
  perform cron.schedule('jobdesk-scheduler', '* * * * *', 'select app_private.run_scheduler()');
exception when others then
  raise notice 'Scheduler belum terpasang (aktifkan pg_cron di Database > Extensions): %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 9. Hak eksekusi fungsi
-- ---------------------------------------------------------------------
revoke all on function public.tasks_before_write() from public;
revoke all on function public.tasks_after_write() from public;
revoke all on function app_private.run_scheduler() from public, anon, authenticated;

revoke all on function public.template_occurs_on(text, integer, integer, date) from public, anon;
revoke all on function public.generate_recurring_tasks(integer) from public, anon;
revoke all on function public.apply_template_to_open_tasks(uuid, text) from public, anon;
revoke all on function public.stop_template(uuid, boolean, text) from public, anon;
revoke all on function public.upsert_push_subscription(text, text, text, text, text[], text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
revoke all on function public.get_my_push_subscription(text) from public, anon;
revoke all on function public.scheduler_status() from public, anon;
revoke all on function public.my_role() from public, anon;
revoke all on function public.app_role() from public, anon;
revoke all on function public.is_lead() from public, anon;
revoke all on function public.can_manage() from public, anon;
revoke all on function public.is_internal() from public, anon;
revoke all on function public.setting_text(text, text) from public, anon;
revoke all on function public.setting_bool(text, boolean) from public, anon;
revoke all on function public.setting_int(text, integer) from public, anon;

grant execute on function public.template_occurs_on(text, integer, integer, date) to authenticated;
grant execute on function public.generate_recurring_tasks(integer) to authenticated;
grant execute on function public.apply_template_to_open_tasks(uuid, text) to authenticated;
grant execute on function public.stop_template(uuid, boolean, text) to authenticated;
grant execute on function public.upsert_push_subscription(text, text, text, text, text[], text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.get_my_push_subscription(text) to authenticated;
grant execute on function public.scheduler_status() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.app_role() to authenticated;
grant execute on function public.is_lead() to authenticated;
grant execute on function public.can_manage() to authenticated;
grant execute on function public.is_internal() to authenticated;
grant execute on function public.setting_text(text, text) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;
grant execute on function public.setting_int(text, integer) to authenticated;
-- confirm_push dipanggil route server memakai anon key; dijaga oleh secret bersama.
grant execute on function public.confirm_push(text, bigint, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. Realtime
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tasks', 'team_members', 'notifications', 'task_events', 'app_settings'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then raise notice 'publication supabase_realtime tidak ditemukan';
    end;
  end loop;
end $$;
