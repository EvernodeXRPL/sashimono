#!/bin/bash
# Sashimono agent uninstall script.

sashimono_bin=/usr/bin/sashimono-agent

cgrulesgend_service=sashi-cgrulesgend

# Uninstall all contract instance users
prefix="sashi"
users=$(cut -d: -f1 /etc/passwd | grep "^$prefix" | sort)
readarray -t userarr <<<"$users"
validusers=()
for user in "${userarr[@]}"
do
    [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] ||  [[ ! "$user" =~ ^$prefix[0-9]+$ ]] && continue
    validusers+=("$user")
done

ucount=${#validusers[@]}
if [ $ucount -gt 0 ]; then
    echo "Are you sure you want to delete all $ucount Sashimono contract instances?"
    for user in "${validusers[@]}"
    do
        echo "$user"
    done
    echo "Type $ucount to confirm deletion:"
    read confirmation

    if [ "$confirmation" == "$ucount" ]; then
        echo "Deleting $ucount contract instances..."
        for user in "${validusers[@]}"
        do
           output=$($(pwd)/user-uninstall.sh $user | tee /dev/stderr)
           [ "${output: -10}" != "UNINST_SUC" ] && echo "Uninstall user '$user' failed. Aborting." && exit 1
        done
    else
        echo "Uninstall cancelled."
        exit 0
    fi
fi

echo "Removing $cgrulesgend_service services..."

systemctl stop $cgrulesgend_service
systemctl disable $cgrulesgend_service
rm /etc/systemd/system/$cgrulesgend_service.service

systemctl daemon-reload
systemctl reset-failed

echo "Deleting binaries..."
rm -r $sashimono_bin

echo "Done."
exit 0