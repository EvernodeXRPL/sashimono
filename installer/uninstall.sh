#!/bin/sh
# Sashimono agent uninstall script.

sashimono_user=sashimono
docker_user=sashidockerd
dockerd_service=sashimono-dockerd

# Stop and uninstall our systemd services.
echo "Stopping $dockerd_service service..."
sudo systemctl stop $dockerd_service
sudo systemctl disable $dockerd_service
sudo rm /etc/systemd/system/$dockerd_service.service
sudo systemctl daemon-reload
sudo systemctl reset-failed

# Kill all processes for users.
echo "Killing any user processes..."
sudo pkill -SIGKILL -u $sashimono_user
sudo pkill -SIGKILL -u $docker_user

echo "Deleting users..."
sudo userdel $sashimono_user
sudo userdel $docker_user

sudo rm -r /home/$sashimono_user
sudo rm -r /home/$docker_user

echo "Done."
