#!/bin/bash
# Sashimono instance user uninstall script.

# $1 - A number with 25 or less digits.
[ -z "$1" ] && echo "ARGS,RESULT_ERR" && exit 1
[ ${#1} -gt 25 ] && echo "ARGS,RESULT_ERR" && exit 1
[[ "$1" =~ [^0-9] ]] && echo "ARGS,RESULT_ERR" && exit 1

user="sashi$1"
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-dockerbin

# Check if users exists.
if [[ `id -u $user 2>/dev/null || echo -1` -ge 0 ]]; then
        :
else
        echo "NO_USER,RESULT_ERR"
        exit 1
fi

# Uninstall rootless dockerd.
echo "Uninstalling rootless dockerd."
sudo -u $user bash -i -c "$docker_bin/dockerd-rootless-setuptool.sh uninstall"
echo "Removing rootless docker data."
sudo -u $user $docker_bin/rootlesskit rm -rf $user_dir/.local/share/docker

# Gracefully terminate user processes.
echo "Terminating user processes."
loginctl disable-linger $user
pkill -SIGINT -u $user
sleep 0.5
echo "Unmounting user filesystems."
fsmounts=$(cat /proc/mounts | cut -d ' ' -f 2 | grep "/home/$user")
readarray -t mntarr <<<"$fsmounts"
for mnt in "${mntarr[@]}"
do
   [ -z "$mnt" ] || umount $mnt
done

# Force kill user processes.
procs=$(ps -U root 2>/dev/null | wc -l)
if [ "$procs" != "0" ]; then

    # Wait for some time and check again.
    sleep 1
    procs=$(ps -U root 2>/dev/null | wc -l)
    if [ "$procs" != "0" ]; then
        echo "Force killing user processes."
        pkill -SIGKILL -u $user
    fi

fi

echo "Deleting user."
userdel $user
rm -r /home/$user

[ -d /home/$user ] && echo "NOT_CLEAN,RESULT_ERR" && exit 1

echo "RESULT_SUC"
exit 0
