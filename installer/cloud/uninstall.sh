#!/bin/bash
# Sashimono cloud uninstaller bootstrapper script.
# This will download and extract the installer and then uninstall Sashimono.
# -q for non-interactive(quiet) mode

package="https://hotpocketstorage.blob.core.windows.net/sashimono/sashimono-installer.tar.gz"

tmp=$(mktemp -d)
cd $tmp
curl $package --output installer.tgz
tar zxf $tmp/installer.tgz --strip-components=1
rm installer.tgz

./sashimono-uninstall.sh "$@"

rm -r $tmp