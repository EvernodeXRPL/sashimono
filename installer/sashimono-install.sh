#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root priviledges.

docker_bin=/usr/bin/sashimono-dockerbin

# Install curl if not exists (required to download installation artifacts).
if ! command -v curl &> /dev/null
then
    sudo apt-get install -y curl
fi

# Download docker packages into a tmp dir and extract into docker bin.
echo "Installing rootless docker packages into $docker_bin"
tmp=$(mktemp -d)
cd $tmp
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-20.10.7.tgz --output docker.tgz
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

mkdir -p $docker_bin
cd $docker_bin
tar zxf $tmp/docker.tgz --strip-components=1
tar zxf $tmp/rootless.tgz --strip-components=1

rm -r $tmp

# Check whether installation dir is still empty.
[ -z "$(ls -A $docker_bin 2>/dev/null)" ] && echo "Installation failed." && exit 1

echo "Done."
exit 0
