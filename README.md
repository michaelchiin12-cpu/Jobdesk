# Papan Jobdesk

Papan jobdesk tim yang realtime di semua PC. Jobdesk yang belum dicentang memunculkan peringatan di semua layar 10 menit sebelum tenggat, lengkap dengan nama PIC. Anggota yang tidak masuk bisa ditandai agar jobdesk mereka dialihkan.

Teknologi: Next.js (App Router), Supabase (database + realtime + auth), deploy di Vercel.

## Cara kerja akses

Seluruh tim memakai satu kode akses. Kode itu adalah password dari satu akun bersama di Supabase Auth. Data hanya bisa dibaca dan ditulis oleh akun itu (aturan RLS di `supabase/schema.sql`).

## Pengaturan Supabase (sekali saja)

1. Buka Supabase > SQL Editor, tempel seluruh isi `supabase/schema.sql`, lalu Run.
2. Buka Authentication > Users > Add user > Create new user.
   - Email: `tim@jobdesk.example.com` (harus sama dengan `NEXT_PUBLIC_TEAM_EMAIL` dan dengan email di `schema.sql`)
   - Password: kode akses tim yang Anda pilih
   - Centang **Auto Confirm User**
3. Buka Authentication > Sign In / Providers, lalu matikan **Allow new users to sign up** dan **Allow anonymous sign-ins**.

## Environment variables

| Nama | Isi |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon (publik) key Supabase |
| `NEXT_PUBLIC_TEAM_EMAIL` | Email akun bersama (opsional, bawaan `tim@jobdesk.example.com`) |

Jangan memakai service role key di proyek ini.

## Menjalankan lokal

```bash
npm install
cp .env.example .env.local   # isi nilainya
npm run dev
```

## Deploy

Hubungkan repo ke Vercel, isi environment variables di atas, lalu deploy. Setiap push ke branch utama otomatis ter-deploy.
