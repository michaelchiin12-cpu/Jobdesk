# Laporan upgrade Jobdesk CS

## Yang berubah
- Dasbor gelap (navy + teal): kartu statistik yang bisa diklik, tab, pencarian, filter PIC/status/prioritas, urutan, daftar berkelompok, ubah status cepat, laci tambah/ubah, panel tim, riwayat aktivitas, pusat notifikasi, pengaturan, arsip + pulihkan.
- Peran CS Lead dan Tim CS ditegakkan di database (RLS + trigger). Tidak ada hard delete.
- Riwayat perubahan (PIC, deadline, prioritas, status, selesai, alasan terlambat) dicatat oleh trigger.
- Penjadwal pg_cron tiap menit: pengingat, terlambat, eskalasi ke CS Lead, ringkasan 08:30 dan 17:30 WIB, tanpa duplikat (dedup_key).
- Web Push dengan konfirmasi hasil nyata; status tidak pernah mengklaim terkirim sebelum layanan push menjawab.
- Template jobdesk berulang di sisi database (tanpa duplikat, indeks unik per template dan tanggal).
- Laporan harian/mingguan/bulanan, metrik terdefinisi, grafik tren, ekspor CSV (aman dari injeksi rumus).
- Semua waktu dalam WIB.

## Migrasi database
`supabase/schema.sql` (idempoten, aditif). Urutan: buat user `lead@jobdesk.example.com` di Auth, aktifkan pg_cron dan pg_net, jalankan schema.sql, lalu merge ke main. Akun `tim@` menjadi CS.

## Environment variable
`NEXT_PUBLIC_LEAD_EMAIL`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_SECRET`, ditambah `push_url` dan `push_secret` di `app_private.settings` (lihat README).

## Yang diuji
- 144 tes (PGlite) dan 134 tes (PostgreSQL 16 sungguhan): migrasi dari skema lama tanpa kehilangan data, idempotensi, RLS dan peran, trigger/riwayat, recurrence, scheduler dan antrean push, zona waktu, statistik, filter, metrik laporan, CSV, validasi, handler route push.
- 17 skenario browser (Chromium + PostgREST + PostgreSQL 16): login, statistik, WIB di browser zona lain, filter/cari, tambah, ubah status, alasan terlambat, panel tim, banner, template, laporan + unduh CSV, akun CS dibatasi (termasuk tulis langsung ditolak RLS), polling, tanpa overflow di 1440/768/390, offline, tanpa error JS.

## Belum teruji / keterbatasan
- Realtime websocket Supabase tidak bisa dijalankan di lingkungan tes; hanya jalur polling 30 detik dan penggabungan data yang diuji.
- Pengiriman push sungguhan ke perangkat belum diuji (perlu kunci VAPID, domain, dan izin browser). Handler diuji dengan pengganti.
- pg_cron dan pg_net asli Supabase tidak ada di tes; dipakai stub.
- Deploy Vercel dan env belum diubah.
