#!/bin/bash
# Sashimono agent uninstall script.
# This must be executed with root privileges.

echo "---Sashimono uninstaller--- (upgrade:$UPGRADE)"

function cgrulesengd_servicename() {
    # Find the cgroups rules engine service.
    local cgrulesengd_filepath=$(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } ')
    if [ -n "$cgrulesengd_filepath" ] ; then
        local cgrulesengd_filename=$(basename $cgrulesengd_filepath)
        echo "${cgrulesengd_filename%.*}"
    fi
}

[ ! -d $SASHIMONO_BIN ] && echo "$SASHIMONO_BIN does not exist. Aborting uninstall." && exit 1

# Message board---------------------
# Check whether mb user exists. If so uninstall message board.
if grep -q "^$MB_XRPL_USER:" /etc/passwd ; then

    mb_user_dir=/home/"$MB_XRPL_USER"
    mb_user_id=$(id -u "$MB_XRPL_USER")
    mb_user_runtime_dir="/run/user/$mb_user_id"
    # Remove xrpl message board service if exists.
    if [ -f "$mb_user_dir"/.config/systemd/user/$MB_XRPL_SERVICE.service ]; then
        sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user stop $MB_XRPL_SERVICE
        sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user disable $MB_XRPL_SERVICE
    fi

    if [ "$UPGRADE" == "0" ]; then
        # Deregister evernode message board host registration.
        echo "Attempting Evernode host deregistration..."
        sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN deregister
    fi

    echo "Deleting message board user..."
    killall -u $MB_XRPL_USER # Kill any running processes.
    userdel -f "$MB_XRPL_USER"
    rm -r /home/"${MB_XRPL_USER:?}"

fi

# Uninstall all contract instance users---------------------------
if [ "$UPGRADE" == "0" ]; then
    users=$(cut -d: -f1 /etc/passwd | grep "^$SASHIUSER_PREFIX" | sort)
    readarray -t userarr <<<"$users"
    sashiusers=()
    for user in "${userarr[@]}"; do
        [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$SASHIUSER_PREFIX[0-9]+$ ]] && continue
        sashiusers+=("$user")
    done

    ucount=${#sashiusers[@]}
    if [ $ucount -gt 0 ]; then

        echo "Detected $ucount contract instances."
        for user in "${sashiusers[@]}"; do
            echo "$user"
        done

        echo "Deleting $ucount contract instances..."
        for user in "${sashiusers[@]}"; do
            output=$($SASHIMONO_BIN/user-uninstall.sh $user | tee /dev/stderr)
            [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
        done
    fi
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
# ./registry-uninstall.sh $DOCKER_BIN $DOCKER_REGISTRY_USER

echo "Deleting binaries..."
rm -r $SASHIMONO_BIN

echo "Deleting Sashimono CLI..."
rm $USER_BIN/sashi

if [ "$UPGRADE" == "0" ]; then
    echo "Deleting data directory..."
    rm -r $SASHIMONO_DATA
fi

# When removing the cgrules service, we first edit the config and restart the service to apply the config.
# Then we remove the attached group.
echo "Deleting cgroup rules..."
sed -i -r "/^@$SASHIUSER_GROUP\s+cpu,memory\s+%u$CG_SUFFIX/d" /etc/cgrules.conf

cgrulesengd_service=$(cgrulesengd_servicename)
[ -z "$cgrulesengd_service" ] && echo "Warning: cgroups rules engine service does not exist."

echo "Restarting the '$cgrulesengd_service' service..."
systemctl restart $cgrulesengd_service
groupdel $SASHIUSER_GROUP

groupdel $SASHIADMIN_GROUP

[ "$UPGRADE" == "0" ] && echo "Sashimono uninstalled successfully." || echo "Sashimono uninstalled successfully. Your data has been preserved."

exit 0