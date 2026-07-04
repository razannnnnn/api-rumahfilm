### Backend Rumahfilm

```bash
git clone https://github.com/razannnnnn/rumahfilm.git
cd rumahfilm
npm install

# Buat .env
echo "FILMS_PATH=/mnt/harddisk/Film" > .env
echo "ALLOWED_ORIGIN=https://rumahfilm.vercel.app" >> .env
echo "PORT=4000" >> .env

# Jalankan dengan PM2
pm2 start server.js --name "rumahfilm-api"
pm2 startup && pm2 save
```
