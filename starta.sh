#!/bin/bash
# starta.sh – gör så att iPhonen kan öppna Löpkoll när den är på samma wifi som datorn.
cd "$(dirname "$0")"
IP=$(hostname -I | awk '{print $1}')
echo "Öppna i Safari på iPhonen:  http://$IP:8082"
echo "(Stäng med Ctrl+C)"
python3 -m http.server 8082 --bind 0.0.0.0
