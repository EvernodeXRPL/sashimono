#!/bin/bash
# Sashimono agent uninstall script.

sauser=sashimono

# Kill all processes for user.
pkill -SIGKILL -u $sauser

sudo userdel $sauser
rm -r /home/$sauser

echo "Done."