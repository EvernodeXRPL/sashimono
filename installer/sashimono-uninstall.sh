#!/bin/bash
# Sashimono agent uninstall script.
# -q for non-interactive (quiet) mode

user_bin=/usr/bin
sashimono_bin=/usr/bin/sashimono-agent
mb_xrpl_bin=$sashimono_bin/mb-xrpl
docker_bin=$sashimono_bin/dockerbin
sashimono_data=/etc/sashimono
mb_xrpl_data=$sashimono_data/mb-xrpl
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

# Remove xrpl message board service if exists.
if [ -f /etc/systemd/system/$mb_xrpl_service.service ]; then
    systemctl stop $mb_xrpl_service
    systemctl disable $mb_xrpl_service
    rm /etc/systemd/system/$mb_xrpl_service.service
fi
if [ "$quiet" == "-q" ]; then
    # We only perform this for our testing setup during development.
    echo "Cleaning up host XRP account..."

    hook_address="r3q12vGjcvXXEvRvcDwczesmG2jR81tvsE"
    func_url="https://func-hotpocket.azurewebsites.net/api/evrfaucet?code=pPUyV1q838ryrihA5NVlobVXj8ZGgn9HsQjGGjl6Vhgxlfha4/xCgQ=="

    mb_xrpl_conf=$mb_xrpl_data/mb-xrpl.cfg
    xrp_address=$(jq -r '.xrpl.address' $mb_xrpl_conf)
    xrp_secret=$(jq -r '.xrpl.secret' $mb_xrpl_conf)

    if [ "$xrp_address" != "" ] && [ "$xrp_secret" != "" ]; then
        acc_clean_func="$func_url&action=cleanhost&hookaddr=$hook_address&addr=$xrp_address&secret=$xrp_secret"
        func_code=$(curl -o /dev/null -s -w "%{http_code}\n" -d "" -X POST $acc_clean_func)
        [ "$func_code" != "200" ] && echo "Host XRP account cleanup failed. code:$func_code"
        [ "$func_code" == "200" ] && echo "Cleaned up host XRP account."
    fi
fi

# Deregister evernode message board host registration.
echo "Attempting Evernode xrpl message board host deregistration..."
MB_DATA_DIR=$mb_xrpl_data MB_LOG=1 MB_DEREGISTER=1 node $mb_xrpl_bin

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
