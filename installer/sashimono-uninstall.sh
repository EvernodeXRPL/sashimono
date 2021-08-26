#!/bin/bash
# Sashimono agent uninstall script.
# -q for non-interactive (quiet) mode

user_bin=/usr/bin
sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-agent/dockerbin
sashimono_data=/etc/sashimono
sashimono_service="sashimono-agent"
cgcreate_service="sashimono-cgcreate"
mb_xrpl_service="sashimono-mb-xrpl"
registryuser="sashidockerreg"
group="sashimonousers"
admin_group="sashiadmin"
cgroupsuffix="-cg"
quiet=$1

[ ! -d $sashimono_bin ] && echo "$sashimono_bin does not exist. Aborting uninstall." && exit 1

if [ "$quiet" != "-q" ]; then
    echo "Are you sure you want to uninstall Sashimono?"
    read -p "Type 'yes' to confirm uninstall: " confirmation < /dev/tty
    [ "$confirmation" != "yes" ] && echo "Uninstall cancelled." && exit 0
fi

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

    if [ "$quiet" != "-q" ]; then
        echo "Are you sure you want to delete all $ucount Sashimono contract instances?"
        read -p "Type $ucount to confirm deletion:" confirmation < /dev/tty
    else
        confirmation="$ucount"
    fi

    if [ "$confirmation" == "$ucount" ]; then
        echo "Deleting $ucount contract instances..."
        for user in "${validusers[@]}"; do
            output=$($sashimono_bin/user-uninstall.sh $user | tee /dev/stderr)
            [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
        done
    else
        echo "Uninstall cancelled."
        exit 0
    fi
fi

# Remove xrpl message board service if exists.
if [ -f /etc/systemd/system/$mb_xrpl_service.service ]; then
    systemctl stop $mb_xrpl_service
    systemctl disable $mb_xrpl_service
    rm /etc/systemd/system/$mb_xrpl_service.service
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

echo "Deleting cgroup rules..."
groupdel $group
sed -i -r "/^@$group\s+cpu,memory\s+%u$cgroupsuffix/d" /etc/cgrules.conf

groupdel $admin_group

echo "Sashimono uninstalled successfully."
exit 0
