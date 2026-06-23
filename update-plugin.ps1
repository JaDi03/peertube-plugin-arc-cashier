# Build and package the plugin
Write-Host "1. Building the plugin..."
npm run build
npm pack

# Find the latest tarball
$Tarball = Get-ChildItem -Filter "peertube-plugin-tessera-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $Tarball) {
    Write-Host "Error: Tarball not found. Build may have failed."
    exit 1
}

# Find the PeerTube container dynamically
$Container = $env:PEERTUBE_CONTAINER
if (-not $Container) {
    $Container = & "C:\Program Files\Docker\Docker\resources\bin\docker.exe" ps --format '{{.Names}}' | Where-Object { $_ -match 'peertube' -and $_ -notmatch 'redis|postgres|postfix|webserver|reloader' } | Select-Object -First 1
}

# Prepare the container and copy the file
Write-Host "2. Copying the plugin to Docker..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec $Container sh -c "rm -rf /tmp/peertube-plugin-tessera /tmp/peertube-plugin-tessera-*.tgz"
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" cp $Tarball.FullName $Container:/tmp/

# Extract and install using the internal PeerTube CLI
Write-Host "3. Installing in PeerTube..."
& "C:\Program Files\Docker\Docker\resources\bin\docker.exe" exec $Container sh -c "grep -ho '/tmp/peertube-plugin-[a-zA-Z0-9\.-]*' /data/plugins/package.json /data/plugins/pnpm-lock.yaml 2>/dev/null | xargs mkdir -p 2>/dev/null || true; EXTRACT_DIR=/tmp/`$(basename $($Tarball.Name) .tgz) && mkdir -p `$EXTRACT_DIR && tar -xzf /tmp/$($Tarball.Name) -C `$EXTRACT_DIR --strip-components=1 && npm run plugin:uninstall -- --npm-name peertube-plugin-tessera || true && npm run plugin:install -- --plugin-path `$EXTRACT_DIR"

Write-Host "========================================="
Write-Host "Plugin updated and reloaded successfully!"
Write-Host "========================================="
