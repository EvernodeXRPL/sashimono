#!/bin/bash

# User that sashimono agent and docker will oeprate under.
sauser=sahimono

# Check if user already exists.
[ `id -u $sauser 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sauser' already exists." && exit 1

# Create sashimono user
sudo useradd $sauser

# Execute installation script as sashimono user
sudo -u $sauser bash -i -c install.sh launcher
