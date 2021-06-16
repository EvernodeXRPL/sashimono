#!/bin/bash
# Sashimono agent uninstall script.

user=sashimono
docker_bin=/usr/bin/sashimono-dockerbin

# Kill all processes for user.
echo "Killing user processes..."
loginctl disable-linger $user
pkill -SIGINT -u $user
sleep 0.5
pkill -SIGKILL -u $user

echo "Deleting user..."
userdel $user
rm -r /home/$user

echo "Deleting binaries..."
rm -r $docker_bin

echo "Done."
