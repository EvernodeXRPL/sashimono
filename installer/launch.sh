#!/bin/bash

# User that sashimono agent and docker will oeprate under.
sauser=sashimono

# Check if user already exists.
[ `id -u $sauser 2>/dev/null || echo -1` -ge 0 ] && echo "User '$sauser' already exists." && exit 1

# Create sashimono user with home dir.
sudo useradd --create-home $sauser
# Prevent log in.
sudo usermod -L $sauser
echo "Created '$sauser' user."

# Install curl if not eixts (required to download rootless docker install script).
[ ! command -v curl &> /dev/null ] && sudo apt-get install -y curl

# Execute installation script as sashimono user
echo "Installing as '$sauser' user..."
sudo -u $sauser bash -i -c "./install.sh launcher"
