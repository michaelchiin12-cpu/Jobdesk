-- Rekap Kerjaan Hari Ini: laporan manual per PIC dan tanggal.
-- Additive migration; existing tasks and team_members are not modified.

create table if not exists public.daily_work_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  pic_name text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_work_reports_pic_date_unique unique (report_date, pic_name),
  constraint daily_work_reports_pic_name_nonempty check (length(trim(pic_name)) > 0),
  constraint daily_work_reports_content_nonempty check (length(trim(content)) > 0)
);

create index if not exists daily_work_reports_date_idx
  on public.daily_work_reports (report_date desc, pic_name asc);

create or replace function public.set_daily_work_reports_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_work_reports_updated_at on public.daily_work_reports;
create trigger daily_work_reports_updated_at
before update on public.daily_work_reports
for each row execute function public.set_daily_work_reports_updated_at();

alter table public.daily_work_reports enable row level security;

drop policy if exists "tim bersama" on public.daily_work_reports;
create policy "tim bersama" on public.daily_work_reports
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com')
  with check (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com');

do $$
begin
  begin
    alter publication supabase_realtime add table public.daily_work_reports;
  exception when duplicate_object then null;
  end;
end $$;
