#!/bin/bash
# Sashimono agent uninstall script.
# This must be executed with root privileges.

echo "---Sashimono uninstaller---"

[ ! -d $SASHIMONO_BIN ] && echo "$SASHIMONO_BIN does not exist. Aborting uninstall." && exit 1

# Find the cgroups rules engine service.
cgrulesengd_filename=$(basename $(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } '))
cgrulesengd_service="${cgrulesengd_filename%.*}"
[ -z "$cgrulesengd_service" ] && echo "Warning: cgroups rules engine service does not exist."

# Message board user.
mb_user_dir=/home/"$MB_XRPL_USER"
mb_user_id=$(id -u "$MB_XRPL_USER")
mb_user_runtime_dir="/run/user/$mb_user_id"
# Remove xrpl message board service if exists.
if [ -f "$mb_user_dir"/.config/systemd/user/$MB_XRPL_SERVICE.service ]; then
    sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user stop $MB_XRPL_SERVICE
    sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user disable $MB_XRPL_SERVICE
fi

# Deregister evernode message board host registration.
echo "Attempting Evernode xrpl message board host deregistration..."
sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN deregister

echo "Deleting message board user..."
killall -u $MB_XRPL_USER # Kill any running processes.
userdel -f "$MB_XRPL_USER"
rm -r /home/"${MB_XRPL_USER:?}"

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
        output=$($SASHIMONO_BIN/user-uninstall.sh $user | tee /dev/stderr)
        [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
    done
fi

echo "Removing Sashimono cgroup creation service..."
systemctl stop $CGCREATE_SERVICE
systemctl disable $CGCREATE_SERVICE
rm /etc/systemd/system/$CGCREATE_SERVICE.service

echo "Removing Sashimono service..."
systemctl stop $SASHIMONO_SERVICE
systemctl disable $SASHIMONO_SERVICE
rm /etc/systemd/system/$SASHIMONO_SERVICE.service

# echo "Removing Sashimono private docker registry..."
# ./registry-uninstall.sh $DOCKER_BIN $REGISTRY_USER

echo "Deleting binaries..."
rm -r $SASHIMONO_BIN

echo "Deleting Sashimono CLI..."
rm $USER_BIN/sashi

echo "Deleting data folder..."
rm -r $SASHIMONO_DATA

# When removing the cgrule,
# We first edit the config and restart the service to apply the config.
# Then we remove the attached group.
echo "Deleting cgroup rules..."
sed -i -r "/^@$SASHIUSER_GROUP\s+cpu,memory\s+%u$CG_SUFFIX/d" /etc/cgrules.conf
echo "Restarting the '$cgrulesengd_service' service..."
systemctl restart $cgrulesengd_service
groupdel $SASHIUSER_GROUP

groupdel $SASHIADMIN_GROUP

echo "Sashimono uninstalled successfully."
exit 0