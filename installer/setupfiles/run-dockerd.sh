#!/bin/sh

home_dir=$(realpath ~)

# Add rootless docker env variables to .bashrc
export XDG_RUNTIME_DIR=$home_dir/.docker/run
export PATH=$home_dir/bin:$PATH
export DOCKER_HOST=unix://$home_dir/.docker/run/docker.sock
$home_dir/bin/dockerd-rootless.sh
