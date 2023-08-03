#!/bin/bash
# Sashimono agent uninstall script.
# This must be executed with root privileges.

[ "$UPGRADE" == "0" ] && echo "---Sashimono uninstaller---" || echo "---Sashimono uninstaller (for upgrade)---"

force=$1

function confirm() {
    echo -en $1" [Y/n] "
    local yn=""
    read yn </dev/tty

    # Default choice is 'y'
    [ -z $yn ] && yn="y"
    while ! [[ $yn =~ ^[Yy|Nn]$ ]]; do
        read -p "'y' or 'n' expected: " yn </dev/tty
    done

    echo ""                                     # Insert new line after answering.
    [[ $yn =~ ^[Yy]$ ]] && return 0 || return 1 # 0 means success.
}

function cgrulesengd_servicename() {
    # Find the cgroups rules engine service.
    local cgrulesengd_filepath=$(grep "ExecStart.*=.*/cgrulesengd$" /etc/systemd/system/*.service | head -1 | awk -F : ' { print $1 } ')
    if [ -n "$cgrulesengd_filepath" ]; then
        local cgrulesengd_filename=$(basename $cgrulesengd_filepath)
        echo "${cgrulesengd_filename%.*}"
    fi
}

function remove_evernode_auto_updater() {

    echo "Removing Evernode auto update timer..."
    systemctl stop $EVERNODE_AUTO_UPDATE_SERVICE.timer
    systemctl disable $EVERNODE_AUTO_UPDATE_SERVICE.timer
    service_path="/etc/systemd/system/$EVERNODE_AUTO_UPDATE_SERVICE.timer"
    rm $service_path

    echo "Removing Evernode auto update service..."
    systemctl stop $EVERNODE_AUTO_UPDATE_SERVICE.service
    systemctl disable $EVERNODE_AUTO_UPDATE_SERVICE.service
    service_path="/etc/systemd/system/$EVERNODE_AUTO_UPDATE_SERVICE.service"
    rm $service_path

    # Reload the systemd daemon.
    systemctl daemon-reload
}

function cleanup_certbot_ssl() {
    # revoke/delete certs if certbot is used.
    if command -v certbot &>/dev/null && [ -f "$SASHIMONO_DATA/sa.cfg" ]; then
        local inet_addr=$(jq -r '.hp.host_address' $SASHIMONO_DATA/sa.cfg)
        local deploy_hook_script="/etc/letsencrypt/renewal-hooks/deploy/sashimono-$inet_addr.sh"
        if [ -f $deploy_hook_script ]; then
            echo "Cleaning up letsencrypt ssl certs for '$inet_addr'"
            rm $deploy_hook_script
            certbot -n revoke --cert-name $inet_addr

            # cleaning up firewall rule for domain validation
            echo "Cleaning up firewall rule for SSL validation"
            ufw delete allow 80/tcp
        fi

        # If there are no certificates unregister.
        local count=$(certbot certificates 2>/dev/null | grep -c "Certificate Name")
        [ $count -eq 0 ] && certbot unregister -n
    fi
}

[ ! -d $SASHIMONO_BIN ] && echo "$SASHIMONO_BIN does not exist. Aborting uninstall." && exit 1

# Message board---------------------
# Check whether mb user exists. If so stop the message board service.
# We do this at the begining so redeem requests won't be accepted while uninstallation.
if grep -q "^$MB_XRPL_USER:" /etc/passwd; then

    mb_user_dir=/home/"$MB_XRPL_USER"
    mb_user_id=$(id -u "$MB_XRPL_USER")
    mb_user_runtime_dir="/run/user/$mb_user_id"
    mb_service_path="$mb_user_dir"/.config/systemd/user/$MB_XRPL_SERVICE.service
    # Remove xrpl message board service if exists.
    if [ -f $mb_service_path ]; then
        sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user stop $MB_XRPL_SERVICE
        sudo -u "$MB_XRPL_USER" XDG_RUNTIME_DIR="$mb_user_runtime_dir" systemctl --user disable $MB_XRPL_SERVICE
    fi

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
            homedir=$(eval echo ~$user)
            cfgpath=$(find $homedir/ -type f -regex ^$homedir/[^/]+/cfg/hp.cfg$ 2>/dev/null | head -n 1)
            instancename=$(echo $cfgpath | rev | cut -d '/' -f 3 | rev)
            peerport=$(jq .mesh.port $cfgpath)
            userport=$(jq .user.port $cfgpath)
            output=$($SASHIMONO_BIN/user-uninstall.sh $user $peerport $userport $instancename | tee /dev/stderr)
            [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
        done
    fi

    # Find if there are any garbage rules that are created by sashimono and remove them.
    prefix="sashi"
    ufw status | grep -E ^[0-9]+,[0-9]+/tcp\\s+ALLOW\\s+Anywhere\\s+\#\\s$prefix-.+$ | while read -r line; do
        ports=$(echo $line | cut -d ' ' -f 1)
        echo "Removing found garbage ufw $ports rule..."
        p1=$(echo $ports | cut -d ',' -f 1)
        p2=$(echo $ports | cut -d ',' -f 2 | cut -d '/' -f 1)
        ufw delete allow "$p1","$p2"/tcp
    done
fi

echo "Removing Sashimono cgroup creation service..."
systemctl stop $CGCREATE_SERVICE
systemctl disable $CGCREATE_SERVICE
rm /etc/systemd/system/$CGCREATE_SERVICE.service

echo "Removing Sashimono service..."
systemctl stop $SASHIMONO_SERVICE
systemctl disable $SASHIMONO_SERVICE
service_path="/etc/systemd/system/$SASHIMONO_SERVICE.service"
rm $service_path

# Reload the systemd daemon after removing the service
systemctl daemon-reload

if [ -f $SASHIMONO_BIN/docker-registry-uninstall.sh ]; then
    echo "Removing Sashimono private docker registry..."
    $SASHIMONO_BIN/docker-registry-uninstall.sh
fi

# Delete binaries except message board and sashimnono uninstall script.
# We keep uninstall script so user can uninstall again if error occured at later steps.
# We'll remove these after deregistration.
echo "Deleting binaries..."
find $SASHIMONO_BIN -mindepth 1 ! \( -regex "^$MB_XRPL_BIN\(/.*\)?" -o -path $SASHIMONO_BIN/sashimono-uninstall.sh \) -delete

echo "Deleting Sashimono CLI..."
rm $USER_BIN/sashi

if [ "$UPGRADE" == "0" ]; then
    # When removing the cgrules service, we first edit the config and restart the service to apply the config.
    # Then we remove the attached group.
    echo "Deleting cgroup rules..."
    sed -i -r "/^@$SASHIUSER_GROUP\s+cpu,memory\s+%u$CG_SUFFIX/d" /etc/cgrules.conf

    cgrulesengd_service=$(cgrulesengd_servicename)
    [ -z "$cgrulesengd_service" ] && echo "Warning: cgroups rules engine service does not exist."

    echo "Restarting the '$cgrulesengd_service' service..."
    systemctl restart $cgrulesengd_service
    groupdel $SASHIUSER_GROUP
fi

# Deregistration---------------------
# Check whether mb user exists. If so deregister and remove the user.
if grep -q "^$MB_XRPL_USER:" /etc/passwd; then

    if [ "$UPGRADE" == "0" ] && [ "$TRANSFER" == "0" ]; then
        # Deregister evernode message board host registration.
        echo "Attempting Evernode host deregistration..."
        # Message board service is created at the end of the installation. So, if this exists previous installation is a successfull one.
        # If not force or quiet mode and deregistration failed and if the previous installation a successful one,
        # Exit the uninstallation, So user can try uninstall again with deregistration.
        if ! sudo -u $MB_XRPL_USER MB_DATA_DIR=$MB_XRPL_DATA node $MB_XRPL_BIN deregister &&
            [ "$force" != "-f" ] && [ -f $mb_service_path ]; then
            ! confirm "Evernode host deregistration failed. Still do you want to continue uninstallation?" && echo "Aborting uninstallation. Try again later." && exit 1
            echo "Continuing uninstallation..."
        fi
    fi

    echo "Deleting message board user..."
    # Killall command is not found in every linux systems, therefore pkill command is used.
    # A small timeout(0.5 second) is applied before deleting the user because it takes some time to kill all the processes
    loginctl disable-linger $MB_XRPL_USER
    pkill -u $MB_XRPL_USER # Kill any running processes.
    sleep 0.5
    userdel -f "$MB_XRPL_USER"
    rm -r /home/"${MB_XRPL_USER:?}"

fi

# Delete all the data and bin directories.
echo "Deleting binaries..."
rm -r $SASHIMONO_BIN

if [ "$UPGRADE" == "0" ]; then

    cleanup_certbot_ssl

    echo "Deleting data directory..."
    rm -r $SASHIMONO_DATA
fi

groupdel $SASHIADMIN_GROUP

[ "$UPGRADE" == "0" ] && echo "Sashimono uninstalled successfully." || echo "Sashimono uninstalled successfully. Your data has been preserved."

# Remove the Evernode Auto Updater Service.
[ "$UPGRADE" == "0" ] && remove_evernode_auto_updater

exit 0
