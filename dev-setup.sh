#!/bin/bash
# Usage ./dev-setup.sh
# Sashimono agent build environment setup script.

set -e # exit on error

sudo apt-get update
sudo apt-get install -y build-essential libssl-dev

scriptdir=$(dirname $(realpath $0))
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
sudo cp -r include/jsoncons_ext/jsonpath /usr/local/include/jsoncons_ext/
popd > /dev/null 2>&1
rm v0.153.3.tar.gz && rm -r jsoncons-0.153.3

# Plog
wget https://github.com/SergiusTheBest/plog/archive/1.1.5.tar.gz
tar -zxvf 1.1.5.tar.gz
pushd plog-1.1.5 > /dev/null 2>&1
sudo cp -r include/plog /usr/local/include/
popd > /dev/null 2>&1
rm 1.1.5.tar.gz && rm -r plog-1.1.5

# Reader-Writer queue
wget https://github.com/cameron314/readerwriterqueue/archive/v1.0.3.tar.gz
tar -zxvf v1.0.3.tar.gz
pushd readerwriterqueue-1.0.3 > /dev/null 2>&1
mkdir build
pushd build > /dev/null 2>&1
cmake ..
sudo make install
popd > /dev/null 2>&1
popd > /dev/null 2>&1
rm v1.0.3.tar.gz && sudo rm -r readerwriterqueue-1.0.3

# Concurrent queue
wget https://github.com/cameron314/concurrentqueue/archive/1.0.2.tar.gz
tar -zxvf 1.0.2.tar.gz
pushd concurrentqueue-1.0.2 > /dev/null 2>&1
sudo cp concurrentqueue.h /usr/local/include/
popd > /dev/null 2>&1
rm 1.0.2.tar.gz && sudo rm -r concurrentqueue-1.0.2

# CLI11
wget https://github.com/CLIUtils/CLI11/archive/refs/tags/v2.0.0.tar.gz
tar -zxvf v2.0.0.tar.gz
pushd CLI11-2.0.0 > /dev/null 2>&1
mkdir build
pushd build > /dev/null 2>&1
cmake ..
sudo make install/fast
popd > /dev/null 2>&1
popd > /dev/null 2>&1
rm v2.0.0.tar.gz && sudo rm -r CLI11-2.0.0

# Library and tools dependencies.
sudo apt-get install -y \
    libsodium-dev \
    sqlite3 libsqlite3-dev \
    libboost-stacktrace-dev \
    fuse3 \
    jq

sudo cp $scriptdir/dependencies/libblake3.so /usr/local/lib/

# NodeJs
sudo apt-get install -y ca-certificates # In case nodejs package certitficates are renewed.
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get install -y nodejs

# Update linker library cache.
sudo ldconfig

# Pop workdir
popd > /dev/null 2>&1
sudo rm -r $workdir

# Setting up cgroup rules.
group="sashiuser"
cgroupsuffix="-cg"
! sudo groupadd $group && echo "Group creation failed."
! sudo echo "@$group       cpu,memory              %u$cgroupsuffix" >>/etc/cgrules.conf && echo "Cgroup rule creation failed."

# Setting up Sashimono admin group.
admin_group="sashiadmin"
! sudo groupadd $admin_group && echo "Admin group creation failed."

# Build sagent
cmake .
make