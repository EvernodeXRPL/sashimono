#!/bin/bash
# Sashimono contract instance user uninstall script.
# This is intended to be called by Sashimono agent or via the user-install script for rollback.

user=$1
# Check whether this is a valid sashimono username.
prefix="sashi"
[ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] ||  [[ ! "$user" =~ ^$prefix[0-9]+$ ]] && echo "ARGS,UNINST_ERR" && exit 1

# Check if users exists.
if [[ $(id -u "$user" 2>/dev/null || echo -1) -ge 0 ]]; then
        :
else
        echo "NO_USER,UNINST_ERR"
        exit 1
fi

cgroupsuffix="-cg"
user_dir=/home/$user
user_id=$(id -u "$user")
user_runtime_dir="/run/user/$user_id"
script_dir=$(dirname "$(realpath "$0")")
docker_bin=$script_dir/dockerbin

echo "Uninstalling user '$user'."

echo "Stopping and cleaning hpfs systemd services."
contract_fs_service="contract_fs"
ledger_fs_service="ledger_fs"
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user stop "$contract_fs_service"
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user stop "$ledger_fs_service"
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user disable "$contract_fs_service"
sudo -u "$user" XDG_RUNTIME_DIR="$user_runtime_dir" systemctl --user disable "$ledger_fs_service"

# Uninstall rootless dockerd.
echo "Uninstalling rootless dockerd."
sudo -H -u "$user" PATH="$docker_bin":"$PATH" XDG_RUNTIME_DIR="$user_runtime_dir" "$docker_bin"/dockerd-rootless-setuptool.sh uninstall

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
   [ -z "$mnt" ] || umount "$mnt"
done

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

echo "Removing cgroups"
# Delete config values.
cgdelete -g cpu:$user$cgroupsuffix
cgdelete -g memory:$user$cgroupsuffix

# Removing applied disk quota of the user before deleting.
setquota -u -F vfsv0 "$user" 0 0 0 0 /

echo "Deleting user '$user'"
userdel "$user"
rm -r /home/"${user:?}"

[ -d /home/"$user" ] && echo "NOT_CLEAN,UNINST_ERR" && exit 1

echo "UNINST_SUC"
exit 0
