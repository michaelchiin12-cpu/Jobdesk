-- Papan Jobdesk: jalankan seluruh file ini sekali di Supabase > SQL Editor.
-- Ganti email di bawah jika Anda memakai NEXT_PUBLIC_TEAM_EMAIL yang berbeda.

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  absent_on text,
  created_at timestamptz not null default now()
);

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

create index if not exists tasks_due_at_idx on public.tasks (due_at desc);

alter table public.team_members enable row level security;
alter table public.tasks enable row level security;

-- Hanya akun bersama tim yang boleh membaca dan menulis.
drop policy if exists "tim bersama" on public.team_members;
create policy "tim bersama" on public.team_members
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com')
  with check (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com');

drop policy if exists "tim bersama" on public.tasks;
create policy "tim bersama" on public.tasks
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com')
  with check (lower(auth.jwt() ->> 'email') = 'tim@jobdesk.example.com');

-- Aktifkan realtime untuk kedua tabel.
do $$
begin
  begin
    alter publication supabase_realtime add table public.tasks;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.team_members;
  exception when duplicate_object then null;
  end;
end $$;
