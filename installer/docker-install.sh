#!/bin/bash
# Rootless docker installation script.

docker_bin=$(realpath $1)

# Silently exit if docker_bin is not empty.
[ ! -z "$(ls -A $docker_bin 2>/dev/null)" ] && exit 0

mkdir -p $docker_bin

# Download docker packages into a tmp dir and extract into docker bin.
echo "Installing rootless docker packages into $docker_bin"

tmp=$(mktemp -d)
cd $tmp
curl -s https://download.docker.com/linux/static/stable/x86_64/docker-20.10.7.tgz --output docker.tgz
curl -s https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

cd $docker_bin
tar zxf $tmp/docker.tgz --strip-components=1
tar zxf $tmp/rootless.tgz --strip-components=1
rm -r $tmp
chown -R $(id -u):$(id -g) $docker_bin/*

exit 0
