#!/bin/bash
# Sashimono agent and rootless docker isntallation script.

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at ~/bin/
sudo apt-get install -y curl
curl -fsSL https://get.docker.com/rootless | sh

# Add rootless docker env variables to .bashrc
echo "export XDG_RUNTIME_DIR=~/.docker/run" >> ~/.bashrc
echo "export PATH=~/bin:$PATH" >> ~/.bashrc
echo "export DOCKER_HOST=unix:///~/.docker/run/docker.sock" >> ~/.bashrc
