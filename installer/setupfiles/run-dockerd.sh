#!/bin/sh

work_dir=$(pwd)

# Add rootless docker env variables to .bashrc
export XDG_RUNTIME_DIR=$work_dir/.docker/run
export DOCKER_HOST=unix://$work_dir/.docker/run/docker.sock
$work_dir/bin/dockerd-rootless.sh
