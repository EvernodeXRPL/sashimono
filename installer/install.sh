#!/bin/sh
# Sashimono agent and rootless docker installation script.

# Safety checks to avoid running this script directly because we need to be run
# under sashimono dedicated user account.
[ "$1" == "" ] && echo "This script must be run via launcher script. Missing setup dir arg." && exit 1
[ "$2" == "" ] && echo "Missing sashimono dir arg." && exit 1
[ "$3" == "" ] && echo "Missing docker dir arg." && exit 1

setup_dir=$1
sashimono_dir=$2
docker_dir=$3

# Download and install Sashimono agent binaries.
# TODO.

# Download and extract Docker rootless package.
# This will extract the Docker rootless binaries at ~/docker/bin
mkdir -p $docker_dir
export DOCKER_BIN=$docker_dir/bin
curl --silent -fSL https://get.docker.com/rootless | sh > /dev/null

cp $setup_dir/run-dockerd.sh $docker_dir/
