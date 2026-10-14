# Audit Jobdesk CS (sebelum upgrade)

Dasar audit: kode di `main` commit `19a0646`, build dan type-check lolos, `npm audit` 0 kerentanan. Tidak ada test, lint, atau CI.

## Arsitektur yang ada

- Next.js 16 (App Router) + React 19 + TypeScript, hosting Vercel.
- Supabase: Postgres + Realtime + Auth. Akses hanya lewat anon key di browser (tidak ada service-role key).
- Tabel: `tasks`, `team_members`. Satu akun bersama (`tim@jobdesk.example.com`), kode akses = password akun itu.
- Realtime: `postgres_changes` pada kedua tabel, ditambah polling 30 detik dan reload saat tab aktif kembali.
- Notifikasi: murni di browser. Banner 10 menit sebelum tenggat dihitung di tab yang sedang terbuka, suara opsional, `Notification` hanya saat tab tersembunyi tetapi masih terbuka.
- Pengulangan: dibuat oleh browser saat jobdesk dicentang (`spawned`).

## Fitur yang sudah berjalan (dipertahankan)

Tambah jobdesk (judul, PIC, tenggat, catatan, ulang), centang selesai, alihkan PIC, tandai anggota tidak masuk (otomatis hilang besok), banner peringatan dengan nama PIC, filter per PIC, hitung mundur, suara notifikasi, login satu kode.

## Masalah yang ditemukan

| # | Temuan | Dampak | Tingkat |
|---|--------|--------|---------|
| 1 | RLS hanya mengecek satu email yang ditulis langsung di SQL (`tim@jobdesk.example.com`). Tidak ada peran. Siapa pun dengan kode bisa menghapus, mengalihkan, atau mengubah apa saja. Email yang sama juga ada di env `NEXT_PUBLIC_TEAM_EMAIL` (dua sumber kebenaran). | Tidak ada pemisahan CS Lead dan CS | Tinggi |
| 2 | `canWrite` selalu `true` di UI. Izin tidak pernah diperiksa. | Tombol tidak mencerminkan hak akses | Sedang |
| 3 | Pengingat hanya jalan di tab yang terbuka. Tidak ada scheduler atau Web Push. Tab ditutup berarti tidak ada notifikasi. | Pekerjaan bisa terlewat tanpa disadari | Tinggi |
| 4 | Pengulangan dibuat di browser dengan dua langkah (tandai `spawned`, lalu insert tugas berikutnya). Jika langkah kedua gagal, tugas berulang berhenti selamanya karena `spawned` sudah `true`. Perhitungan tanggal memakai zona waktu browser. | Tugas rutin bisa hilang diam-diam | Tinggi |
| 5 | Hapus jobdesk adalah hard delete, dan jobdesk selesai dihapus permanen setelah 14 hari oleh browser mana pun. | Tidak ada riwayat untuk laporan dan evaluasi | Tinggi |
| 6 | `done_at` diisi jam browser. Jam komputer yang salah menghasilkan waktu selesai yang salah. | Data evaluasi tidak bisa dipercaya | Sedang |
| 7 | Zona waktu mengikuti browser, bukan Asia/Jakarta. | Tanggal bisa bergeser antar-perangkat | Sedang |
| 8 | PIC disimpan sebagai teks nama bebas. Menghapus anggota membuat jobdesknya yatim. Tidak ada riwayat perubahan PIC atau tenggat. | Tidak ada jejak audit | Sedang |
| 9 | Query dibatasi 500 baris tanpa pemberitahuan. | Data lama hilang dari tampilan diam-diam | Rendah |
| 10 | Seluruh aplikasi dirender ulang tiap detik (`useNow(1000)`). | Boros CPU saat daftar bertambah | Rendah |
| 11 | Tidak ada status pengerjaan, prioritas, edit jobdesk, pencarian, atau laporan. | Belum memenuhi kebutuhan monitoring | Fitur |

Tidak ditemukan secret yang bocor di frontend. Input teks selalu di-escape oleh React, dan batas panjang ada di form (belum di database).

## Rencana implementasi

Prinsip: framework dan database tetap (Next.js + Supabase), perubahan skema hanya menambah (aditif), data lama tidak dihapus.

1. Skema aditif dan idempotent di `supabase/schema.sql`: kolom prioritas, status, riwayat, arsip; tabel template, riwayat aktivitas, notifikasi, langganan push, peran. Satu file yang aman dijalankan ulang.
2. Peran `lead` dan `cs` ditegakkan di database lewat RLS dan trigger, bukan hanya di UI.
3. Scheduler `pg_cron` per menit untuk pengingat, notifikasi lewat tenggat, ringkasan, dan pembuatan tugas berulang (idempoten). Pengiriman Web Push lewat route `/api/push` di Vercel tanpa service-role key.
4. Redesain dashboard, monitoring tim, aktivitas, template, laporan.
5. Test logika (statistik, filter, metrik, CSV) dan test skema di Postgres lokal (RLS, trigger, pengulangan).
6. Karena migrasi harus dijalankan manual di Supabase, kode dikirim ke branch `upgrade-workboard` dulu, dan `main` (production) baru diperbarui setelah migrasi dijalankan.
