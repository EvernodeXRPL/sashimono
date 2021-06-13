#!/bin/sh
# Sashimono agent uninstall script.

sashimono_user=sashimono
docker_user=sashidocker
dockerd_service=sashimono-docker

# Stop and uninstall our systemd services.
sudo systemctl stop $dockerd_service
systemctl disable $dockerd_service
sudo rm /etc/systemd/system/$dockerd_service.service
systemctl daemon-reload
systemctl reset-failed

# Kill all processes for users.
pkill -SIGKILL -u $sashimono_user
pkill -SIGKILL -u $docker_user

sudo userdel $sashimono_user
sudo userdel $docker_user

rm -r /home/$sashimono_user

echo "Done."
