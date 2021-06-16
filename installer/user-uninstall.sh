#!/bin/bash
# Sashimono instance user uninstall script.

# $1 - A number with 25 or less digits.
[ -z "$1" ] && echo "ARGS,INSTALL_ERR" && exit 0
[ ${#1} -gt 25 ] && echo "ARGS,INSTALL_ERR" && exit 0
[[ "$1" =~ [^0-9] ]] && echo "ARGS,INSTALL_ERR" && exit 0

user="sashi$1"
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-dockerbin

# Check if users exists.
if [[ `id -u $user 2>/dev/null || echo -1` -ge 0 ]]; then
        :
else
        echo "NOUSER,INSTALL_ERR"
        exit 0
fi

# Uninstall rootless dockerd.
sudo -u $user bash -i -c "$docker_bin/dockerd-rootless-setuptool.sh uninstall"
# Remove rootless Docker data.
sudo -u $user $docker_bin/rootlesskit rm -rf $user_dir/.local/share/docker

# Gracefully terminate user processes.
loginctl disable-linger $user
pkill -SIGINT -u $user
sleep 0.5
# Unmount any filesystems (hpfs).
fsmounts=$(cat /proc/mounts | cut -d ' ' -f 2 | grep "/home/$user")
readarray -t mntarr <<<"$fsmounts"
for mnt in "${mntarr[@]}"
do
   [ -z "$mnt" ] || umount $mnt
done

# Force kill user processes.
sleep 0.5
pkill -SIGKILL -u $user

# Delete user.
userdel $user
rm -r /home/$user

echo "INSTALL_SUC"

exit 0
