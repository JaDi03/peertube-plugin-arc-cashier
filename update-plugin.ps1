# Construye y empaqueta el plugin
Write-Host "1. Construyendo el plugin..."
npm run build
npm pack

# Prepara el contenedor y copia el archivo
Write-Host "2. Copiando el plugin a Docker..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "rm -rf /tmp/peertube-plugin-arc-cashier /tmp/peertube-plugin-arc-cashier-1.0.9.tgz"
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" cp "peertube-plugin-arc-cashier-1.0.9.tgz" docker-peertube-peertube-1:/tmp/

# Extrae e instala usando el CLI interno de PeerTube
Write-Host "3. Instalando en PeerTube..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec docker-peertube-peertube-1 sh -c "mkdir -p /tmp/peertube-plugin-arc-cashier && tar -xzf /tmp/peertube-plugin-arc-cashier-1.0.9.tgz -C /tmp/peertube-plugin-arc-cashier --strip-components=1 && rm -f /tmp/peertube-plugin-arc-cashier/peertube-plugin-arc-cashier-1.0.9.tgz && rm -f /tmp/peertube-plugin-arc-cashier/peertube-plugin-arc-cashier-1.0.8.tgz && npm run plugin:install -- --plugin-path /tmp/peertube-plugin-arc-cashier"

Write-Host "========================================="
Write-Host "¡Plugin actualizado y recargado con éxito!"
Write-Host "========================================="
