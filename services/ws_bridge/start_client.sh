chmod 755 ./wsb
./wsb client -c config.client.toml
cloudflared tunnel --url http://127.0.0.1:8766 --no-autoupdate