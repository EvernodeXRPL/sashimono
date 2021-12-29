#!/bin/bash
# Sashimono agent uninstall script.
# This must be executed with root privileges.

echo "---Sashimono uninstaller---"

[ ! -d $sashimono_bin ] && echo "$sashimono_bin does not exist. Aborting uninstall." && exit 1

# Find the cgroups rules engine service.
cgrulesengd_filename=$(basename $(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } '))
cgrulesengd_service="${cgrulesengd_filename%.*}"
[ -z "$cgrulesengd_service" ] && echo "Warning: cgroups rules engine service does not exist."

# Message board user.
mb_user_dir=/home/"$mb_user"
mb_user_id=$(id -u "$mb_user")
mb_user_runtime_dir="/run/user/$mb_user_id"
# Remove xrpl message board service if exists.
if [ -f "$mb_user_dir"/.config/systemd/user/$mb_xrpl_service.service ]; then
    sudo -u "$mb_user" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user stop $mb_xrpl_service
    sudo -u "$mb_user" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user disable $mb_xrpl_service
fi

# Deregister evernode message board host registration.
echo "Attempting Evernode xrpl message board host deregistration..."
sudo -u $mb_user MB_DATA_DIR=$mb_xrpl_data node $mb_xrpl_bin deregister

echo "Deleting message board user..."
killall -u $mb_user # Kill any running processes.
userdel -f "$mb_user"
rm -r /home/"${mb_user:?}"

# Uninstall all contract instance users
prefix="sashi"
users=$(cut -d: -f1 /etc/passwd | grep "^$prefix" | sort)
readarray -t userarr <<<"$users"
validusers=()
for user in "${userarr[@]}"; do
    [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$prefix[0-9]+$ ]] && continue
    validusers+=("$user")
done

ucount=${#validusers[@]}
if [ $ucount -gt 0 ]; then

    echo "Detected $ucount Sashimono contract instances."
    for user in "${validusers[@]}"; do
        echo "$user"
    done

    echo "Deleting $ucount contract instances..."
    for user in "${validusers[@]}"; do
        output=$($sashimono_bin/user-uninstall.sh $user | tee /dev/stderr)
        [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
    done
fi

echo "Removing Sashimono cgroup creation service..."
systemctl stop $cgcreate_service
systemctl disable $cgcreate_service
rm /etc/systemd/system/$cgcreate_service.service

echo "Removing Sashimono service..."
systemctl stop $sashimono_service
systemctl disable $sashimono_service
rm /etc/systemd/system/$sashimono_service.service

# echo "Removing Sashimono private docker registry..."
# ./registry-uninstall.sh $docker_bin $registryuser

echo "Deleting binaries..."
rm -r $sashimono_bin

echo "Deleting Sashimono CLI..."
rm $user_bin/sashi

echo "Deleting data folder..."
rm -r $sashimono_data

# When removing the cgrule,
# We first edit the config and restart the service to apply the config.
# Then we remove the attached group.
echo "Deleting cgroup rules..."
sed -i -r "/^@$group\s+cpu,memory\s+%u$cgroupsuffix/d" /etc/cgrules.conf
echo "Restarting the '$cgrulesengd_service' service..."
systemctl restart $cgrulesengd_service
groupdel $group

groupdel $admin_group

echo "Sashimono uninstalled successfully."
exit 0
