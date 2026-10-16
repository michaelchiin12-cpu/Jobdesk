# Jobdesk CS

Dasbor kerja untuk CS Lead dan tim CS: jobdesk, PIC, deadline, status, beban kerja per orang, riwayat perubahan, pengingat, jobdesk berulang, dan laporan. Data realtime di semua PC.

Teknologi: Next.js 16 (App Router), React 19, Supabase (Postgres, Realtime, Auth, pg_cron), Web Push, deploy di Vercel.

## Peran

| Peran | Bisa |
| --- | --- |
| **CS Lead** (`lead@jobdesk.example.com`) | Semuanya: buat/ubah/arsipkan jobdesk, kelola tim dan template, pengaturan, laporan, arsip |
| **Tim CS** (`tim@jobdesk.example.com`) | Melihat semua, mengubah status, mencatat alasan terlambat. Bisa diperluas lewat pengaturan "Tim CS boleh membuat dan mengubah jobdesk" |

Peran ditegakkan di database (RLS + trigger), bukan hanya disembunyikan di tampilan. Tidak ada hard delete: jobdesk diarsipkan dan bisa dipulihkan.

## Pengaturan Supabase

Urutan penting karena skema membaca akun yang sudah ada.

1. **Authentication > Users > Add user**, centang Auto Confirm:
   - `tim@jobdesk.example.com`, password = kode akses tim (sudah ada bila Anda memakai versi lama)
   - `lead@jobdesk.example.com`, password = kode akses CS Lead
2. **Authentication > Sign In / Providers**: matikan *Allow new users to sign up* dan *Allow anonymous sign-ins*.
3. **Database > Extensions**: aktifkan `pg_cron` dan `pg_net` (diperlukan penjadwal pengingat dan push).
4. **SQL Editor**: tempel seluruh `supabase/schema.sql`, Run. Aman dijalankan ulang dan tidak menghapus data lama.

Setelah migrasi, akun `tim@` berperan CS (tidak bisa membuat jobdesk). Aktifkan "Tim CS boleh membuat dan mengubah jobdesk" di Pengaturan bila itu yang Anda inginkan.

## Notifikasi saat tab ditutup (Web Push)

1. `npx web-push generate-vapid-keys`, lalu isi `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, dan buat `PUSH_SECRET` acak (panjang) di Vercel. Deploy ulang.
2. Di Supabase SQL Editor, beri tahu database ke mana mengirim:
   ```sql
   insert into app_private.settings (key, value) values
     ('push_url', 'https://DOMAIN-ANDA/api/push'),
     ('push_secret', 'ISI_SAMA_DENGAN_PUSH_SECRET')
   on conflict (key) do update set value = excluded.value;
   ```
3. Tiap PC: buka Pengaturan > Aktifkan notifikasi > Kirim notifikasi uji.

Status "Diterima layanan push" di Notifikasi hanya muncul setelah layanan push benar-benar menjawab sukses. Bila belum dikonfigurasi, statusnya jujur ditampilkan sebagai "belum dikonfigurasi". Pengingat tetap tampil sebagai banner di dasbor yang terbuka.

## Environment variables

Lihat `.env.example`. Jangan pernah memakai service role key.

## Pengembangan dan tes

```bash
npm install
cp .env.example .env.local
npm run dev
npm run typecheck
npm test            # database di PGlite + logika
npm run test:pg     # database di PostgreSQL 16 sungguhan (perlu postgresql-16 terpasang)
node --import tsx tests/e2e/run.ts   # skenario browser (perlu Chromium dan biner PostgREST)
```

Semua tanggal dan jam memakai Asia/Jakarta (WIB), apa pun zona waktu browser.

Dokumen: `docs/AUDIT.md` (audit awal), `docs/LAPORAN_UPGRADE.md` (laporan upgrade).
