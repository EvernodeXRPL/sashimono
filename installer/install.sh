#!/bin/bash
# Sashimono agent and rootless docker isntallation script.

# Safety check to avoid running this script directly because we need to be run
# under sahimono dedicated user account.
[ "$1" != "launcher" ] && echo "This script must be run via launcher script." && exit 1

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at ~/bin/
curl -fsSL https://get.docker.com/rootless | bash > /dev/null

# Add rootless docker env variables to .bashrc
echo "export XDG_RUNTIME_DIR=~/.docker/run" >> ~/.bashrc
echo "export PATH=~/bin:$PATH" >> ~/.bashrc
echo "export DOCKER_HOST=unix:///~/.docker/run/docker.sock" >> ~/.bashrc
