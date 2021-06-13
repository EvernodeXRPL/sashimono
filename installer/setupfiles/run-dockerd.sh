#!/bin/sh

docker_dir=$(pwd)

# Add rootless docker env variables to .bashrc
export XDG_RUNTIME_DIR=$docker_dir/run
export DOCKER_HOST=unix://$docker_dir/run/docker.sock
$docker_dir/bin/dockerd-rootless.sh
