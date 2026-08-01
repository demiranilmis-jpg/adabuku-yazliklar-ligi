# Adabükü Yazlıklar Ligi

Node.js + Express + PostgreSQL ile hazırlanmış, mobil uyumlu lig yönetim sitesi.

## Özellikler
- Halka açık ana sayfa
- Fikstür ve maç sonuçları
- Otomatik puan durumu
- Gol, asist ve kurtarış krallığı
- Takımlar ve oyuncular
- Şifreli yönetici paneli
- Lig adı, sezon, renk ve logo yönetimi

## Yerelde çalıştırma
1. Node.js 20+ ve PostgreSQL kurun.
2. `.env.example` dosyasını `.env` adıyla kopyalayın.
3. `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` değerlerini girin.
4. Terminalde:
   npm install
   npm start
5. Tarayıcıdan `http://localhost:3000` adresine gidin.

## Halka açık yayınlama: Render + Neon
1. Neon'da ücretsiz PostgreSQL veritabanı oluşturun ve bağlantı adresini alın.
2. Projeyi GitHub deposuna yükleyin.
3. Render'da New > Web Service seçip GitHub deposunu bağlayın.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment Variables:
   - DATABASE_URL = Neon bağlantı adresi
   - SESSION_SECRET = uzun rastgele bir metin
   - ADMIN_USERNAME = admin
   - ADMIN_PASSWORD = güçlü ve yeni bir şifre
   - NODE_ENV = production
7. Deploy düğmesine basın. Render size halka açık bir adres verir.

## Güvenlik
İlk kurulumda verilen `ulel1209` şifresini yayına almadan önce mutlaka değiştirin. Şifre `.env` içinde tutulur; GitHub'a `.env` dosyasını yüklemeyin.
