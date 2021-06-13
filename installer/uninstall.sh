#!/bin/sh
# Sashimono agent uninstall script.

sashimono_user=sashimono
docker_user=sashidocker
dockerd_service=sashimono-dockerd

# Stop and uninstall our systemd services.
sudo systemctl stop $dockerd_service
sudo systemctl disable $dockerd_service
sudo rm /etc/systemd/system/$dockerd_service.service
sudo systemctl daemon-reload
sudo systemctl reset-failed

# Kill all processes for users.
sudo pkill -SIGKILL -u $sashimono_user
sudo pkill -SIGKILL -u $docker_user

sudo userdel $sashimono_user
sudo userdel $docker_user

sudo rm -r /home/$sashimono_user
sudo rm -r /home/$docker_user

echo "Done."
