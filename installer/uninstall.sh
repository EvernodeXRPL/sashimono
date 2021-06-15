#!/bin/sh
# Sashimono agent uninstall script.

sashimono_user=sashimono
dockerd_user=sashidockerd
dockerd_user_dir=/home/$dockerd_user

# Uninstall rootless dockerd.
echo "Uninstalling rootless dockerd..."
sudo -u $dockerd_user $dockerd_user_dir/bin/dockerd-rootless-setuptool.sh uninstall
sudo -u $dockerd_user $dockerd_user_dir/bin/rootlesskit rm -rf $dockerd_user_dir/.local/share/docker

# Kill all processes for users.
echo "Killing user processes..."
sudo loginctl disable-linger $dockerd_user
sudo pkill -SIGKILL -u $dockerd_user
sudo pkill -SIGKILL -u $sashimono_user

echo "Deleting users..."
sudo userdel $dockerd_user
sudo userdel $sashimono_user

sudo rm -r /home/$dockerd_user
sudo rm -r /home/$sashimono_user

echo "Done."
