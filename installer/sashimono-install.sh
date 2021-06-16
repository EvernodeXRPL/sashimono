#!/bin/bash
# Sashimono agent installation script.
# This must be executed with root priviledges.

user=sashimono
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-dockerbin

# Check if users already exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] && echo "User '$user' already exists." && exit 1

# Install curl if not exists (required to download installation artifacts).
if ! command -v curl &> /dev/null
then
    sudo apt-get install -y curl
fi

# Create sashimono user.
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
chmod o-rwx $user_dir
usermod -aG sudo $user # Add to sudo group.
loginctl enable-linger $user # Enable lingering to support Sashimono service installation.
echo "Created '$user' user."

# Setup a password for sashimono user.
echo "Configure a password for '$user' user:"
passwd $user

# Run rest of the script as sashimono user.
# Download and extract the dockerd rootless packages.
mkdir -p $docker_bin
tmp=$(sudo -u $user mktemp -d)
echo "
# Download packages into a tmp dir and extract into user home docker bin.
cd \$1
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-20.10.7.tgz --output docker.tgz
curl https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-20.10.7.tgz --output rootless.tgz

cd $docker_bin
tar zxf \$1/docker.tgz --strip-components=1
tar zxf \$1/rootless.tgz --strip-components=1" >$tmp/install.sh
chmod a+x $tmp/install.sh
sudo -u $user sudo bash -c "$tmp/install.sh $tmp"
rm -r $tmp

echo "Done."
exit 0
