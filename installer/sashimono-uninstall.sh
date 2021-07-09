#!/bin/bash
# Sashimono agent uninstall script.

sashimono_bin=/usr/bin/sashimono-agent
sashimono_data=/etc/sashimono
sashimono_service="sashimono-agent"
group="sashimonousers"
cgroupsuffix="-cg"

[ ! -d $sashimono_bin ] && echo "$sashimono_bin does not exist. Aborting uninstall." && exit 1

echo "Are you sure you want to uninstall Sashimono?"
echo "Type 'yes' to confirm uninstall:"
read yes
[ "$yes" != "yes" ] && echo "Uninstall cancelled." && exit 0

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
    echo "Are you sure you want to delete all $ucount Sashimono contract instances?"
    for user in "${validusers[@]}"; do
        echo "$user"
    done
    echo "Type $ucount to confirm deletion:"
    read confirmation

    if [ "$confirmation" == "$ucount" ]; then
        echo "Deleting $ucount contract instances..."
        for user in "${validusers[@]}"; do
            output=$($(pwd)/user-uninstall.sh $user | tee /dev/stderr)
            [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
        done
    else
        echo "Uninstall cancelled."
        exit 0
    fi
fi

echo "Removing Sashimono service..."
systemctl stop $sashimono_service
systemctl disable $sashimono_service
rm /etc/systemd/system/$sashimono_service.service

echo "Deleting binaries..."
rm -r $sashimono_bin

echo "Deleting data folder..."
rm -r $sashimono_data

echo "Deleting cgroup rules..."
groupdel $group
sed -i -r "/^@$group\s+cpu,memory\s+%u$cgroupsuffix/d" /etc/cgrules.conf

echo "Sashimono uninstalled successfully."
echo "Please restart your cgroup rule generator service or reboot your server for changes to apply."
exit 0
