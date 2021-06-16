#!/bin/sh
# Sashimono instance user uninstall script.

# $1 - 32-character lowercase user GUID
[ -z "$1" ] && echo '{"error":"no_guid"}' && exit 0
[ ${#1} -ne 32 ] && echo '{"error":"invalid_len"}' && exit 0
[[ "$1" =~ [^a-z0-9] ]] && echo '{"error":"invalid_format"}' && exit 0

user=$1
user_dir=/home/$user

# Uninstall rootless dockerd.
sudo -u $user bash -i -c "$user_dir/bin/dockerd-rootless-setuptool.sh uninstall"
# Remove rootless Docker data.
sudo -u $user $user_dir/bin/rootlesskit rm -rf $user_dir/.local/share/docker

# Kill user processes.
loginctl disable-linger $user
pkill -SIGKILL -u $user

# Delete user.
userdel $user
rm -r /home/$user

echo '{}'
exit 0
