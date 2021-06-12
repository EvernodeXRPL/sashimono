#!/bin/bash
# Sashimono agent and rootless docker installation script.

# Safety check to avoid running this script directly because we need to be run
# under sahimono dedicated user account.
[ "$1" != "launcher" ] && echo "This script must be run via launcher script." && exit 1

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at ~/bin/
curl --silent -fSL https://get.docker.com/rootless | bash > /dev/null

sauser=$(whoami)

# Add rootless docker env variables to .bashrc
echo "export XDG_RUNTIME_DIR=/home/$sauser/.docker/run" >> ~/.bashrc
echo "export PATH=/home/$sauser/bin:$PATH" >> ~/.bashrc
echo "export DOCKER_HOST=unix:///home/$sauser/.docker/run/docker.sock" >> ~/.bashrc
