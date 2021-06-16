#!/bin/bash
# Sashimono agent uninstall script.

sashimono_user=sashimono
dockerd_user=sashidockerd
dockerd_user_dir=/home/$dockerd_user

# Uninstall rootless dockerd.
echo "Uninstalling rootless dockerd..."
sudo -u $dockerd_user bash -i -c "$dockerd_user_dir/bin/dockerd-rootless-setuptool.sh uninstall"
echo "Removing rootless Docker data..."
sudo -u $dockerd_user $dockerd_user_dir/bin/rootlesskit rm -rf $dockerd_user_dir/.local/share/docker

# Kill all processes for users.
echo "Killing user processes..."
loginctl disable-linger $dockerd_user
pkill -SIGKILL -u $dockerd_user
pkill -SIGKILL -u $sashimono_user

echo "Deleting users..."
userdel $sashimono_user # Remove sashimono user first because it's in docker user's group.
userdel $dockerd_user

rm -r /home/$sashimono_user
rm -r /home/$dockerd_user

echo "Done."
