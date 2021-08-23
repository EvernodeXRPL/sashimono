#!/bin/bash
# Sashimono cloud installer script.
# This will download, extract and install the Sashimono installer package.

package="https://sthotpocket.blob.core.windows.net/sashimono/sashimono-installer.tar.gz"

tmp=$(mktemp -d)
cd $tmp
curl $package --output installer.tgz
tar zxf $tmp/installer.tgz --strip-components=1
rm installer.tgz

./sashimono-install.sh

rm -r $tmp