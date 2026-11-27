mv wsb.txt wsb
chmod +x wsb

./wsb --version
# Output: wsb 0.2.0

cp wsb ~/.local/bin/   # or: sudo cp wsb /usr/local/bin/

.wsb server -c config.server.toml