#!/bin/sh
# Sashimono agent uninstall script.

sashimono_user=sashimono
docker_user=sashidocker

# Kill all processes for users.
pkill -SIGKILL -u $sashimono_user
pkill -SIGKILL -u $docker_user

sudo userdel $sashimono_user
sudo userdel $docker_user

rm -r /home/$sashimono_user

echo "Done."