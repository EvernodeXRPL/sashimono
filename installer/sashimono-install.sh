#!/bin/bash
# Sashimono agent installation script.

user=sashimono
user_dir=/home/$user

# Check if users already exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$user' already exists." && exit 1

# Install curl if not exists (required to download installation artifacts).
[ ! $(command -v curl &> /dev/null) ] && apt-get install -y curl

# --------------------------------------
# Setup Sashimono user and agent.
# --------------------------------------
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
chmod o-rwx $user_dir
usermod -aG sudo $user
loginctl enable-linger $user # Enable lingering to support Sashimono service installation.
echo "Created '$user' user."

# Run rest of the script as sashimono user.
sudo -u $user bash<<_
# Download and extract rootless dockerd setup package.

tmp=$(mktemp -d)
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-20.10.7.tgz --output docker.tgz
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

mkdir -p "$user_dir/dockerbin"
cd "$user_dir/dockerbin"
tar zxf "$tmp/docker.tgz" --strip-components=1
tar zxf "$tmp/rootless.tgz" --strip-components=1
_

echo "Done."
