#!/bin/bash
# Sashimono docker registry installation script.

user=$DOCKER_REGISTRY_USER

# Check if users exists.
if [[ $(id -u "$user" 2>/dev/null || echo -1) -ge 0 ]]; then
    :
else
    echo "$user does not exist. Nothing to uninstall"
    exit 0
fi

user_dir=/home/$user
user_id=$(id -u "$user")
user_runtime_dir="/run/user/$user_id"

# Uninstall rootless dockerd.
echo "Uninstalling rootless dockerd."
sudo -H -u "$user" PATH="$DOCKER_BIN":"$PATH" XDG_RUNTIME_DIR="$user_runtime_dir" "$DOCKER_BIN"/dockerd-rootless-setuptool.sh uninstall

# Gracefully terminate user processes.
echo "Terminating user processes."
loginctl disable-linger $user
pkill -SIGINT -u $user
sleep 0.5

# Force kill user processes.
procs=$(ps -U $user 2>/dev/null | wc -l)
if [ "$procs" != "0" ]; then

    # Wait for some time and check again.
    sleep 1
    procs=$(ps -U $user 2>/dev/null | wc -l)
    if [ "$procs" != "0" ]; then
        echo "Force killing user processes."
        pkill -SIGKILL -u "$user"
    fi

fi


echo "Deleting user '$user'"
userdel "$user"
rm -r /home/"${user:?}"
exit 0