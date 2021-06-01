#!/bin/bash
# Usage ./dev-setup.sh
# Sashimono agent build environment setup script.

set -e # exit on error

sudo apt-get update
sudo apt-get install -y build-essential libssl-dev

workdir=~/sagent-setup

mkdir $workdir
pushd $workdir > /dev/null 2>&1

# CMAKE
cmake=cmake-3.16.0-rc3-Linux-x86_64
wget https://github.com/Kitware/CMake/releases/download/v3.16.0-rc3/$cmake.tar.gz
tar -zxvf $cmake.tar.gz
sudo cp -r $cmake/bin/* /usr/local/bin/
sudo cp -r $cmake/share/* /usr/local/share/
rm $cmake.tar.gz && rm -r $cmake

# jsoncons
wget https://github.com/danielaparker/jsoncons/archive/v0.153.3.tar.gz
tar -zxvf v0.153.3.tar.gz
pushd jsoncons-0.153.3 > /dev/null 2>&1
sudo cp -r include/jsoncons /usr/local/include/
sudo mkdir -p /usr/local/include/jsoncons_ext/
sudo cp -r include/jsoncons_ext/bson /usr/local/include/jsoncons_ext/
popd > /dev/null 2>&1
rm v0.153.3.tar.gz && rm -r jsoncons-0.153.3

# Update linker library cache.
sudo ldconfig

# Pop workdir
popd > /dev/null 2>&1
rm -r $workdir

# Build sagent
cmake .
make