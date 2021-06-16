#!/bin/bash
# Sashimono instance user uninstall script.

# $1 - A number with 25 or less digits.
[ -z "$1" ] && echo '{"error":"no_id"}' && exit 0
[ ${#1} -gt 25 ] && echo '{"error":"invalid_len"}' && exit 0
[[ "$1" =~ [^0-9] ]] && echo '{"error":"invalid_format"}' && exit 0

user="sashi$1"
user_dir=/home/$user

# Check if users exists.
[ `id -u $user 2>/dev/null || echo -1` -ge 0 ] || echo '{"error":"user_not_found"}' && exit 0

# Uninstall rootless dockerd.
sudo -u $user bash -i -c "$user_dir/bin/dockerd-rootless-setuptool.sh uninstall"
# Remove rootless Docker data.
sudo -u $user $user_dir/bin/rootlesskit rm -rf $user_dir/.local/share/docker

# Gracefully terminate user processes.
loginctl disable-linger $user
pkill -SIGINT -u $user
sleep 0.5
# Unmount any filesystems (hpfs).
fsmounts=$(cat /proc/mounts | cut -d ' ' -f 2 | grep "/home/$user")
readarray -t mntarr <<<"$fsmounts"
for mnt in "${mntarr[@]}"
do
   umount $mnt
done

# Force kill user processes.
sleep 0.5
pkill -SIGKILL -u $user

# Delete user.
userdel $user
rm -r /home/$user

echo '{}'
exit 0
