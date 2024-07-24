#!/bin/bash
# Call 'cgcreate' for all Sashimono users to specify resource restrictions for each user.

datadir=$1
if [ -z "$datadir" ]; then
    echo "Invalid arguments."
    echo "Expected: user-cgcreate.sh <sashimino data dir>"
    exit 1
fi

saconfig="$1/sa.cfg"
if [ ! -f "$saconfig" ]; then
    echo "Config file does not exist."
    echo "Run \"sagent new $datadir\" command."
    exit 1
fi

# Function to create or update cgroup limits based on user and process
apply_limits() {

    echo "Apply limits $1"

    local user=$1
    local user_id=$(id -u $user)
    local max_mem_kbytes=$(jq '.system.max_mem_kbytes' $saconfig)
    local max_swap_kbytes=$(jq '.system.max_swap_kbytes' $saconfig)
    local max_cpu_us=$(jq '.system.max_cpu_us' $saconfig)
    local max_instance_count=$(jq '.system.max_instance_count' $saconfig)
    local cores=$(grep -c ^processor /proc/cpuinfo)

    ([ "$max_instance_count" == "" ] || [ ${#max_instance_count} -eq 0 ] || [ "$max_instance_count" -le 0 ]) && echo "max_instance_count cannot be empty." && exit 1

    local instance_mem_kbytes=0
    if [ "$max_mem_kbytes" != "" ] && [ ! ${#max_mem_kbytes} -eq 0 ] && [ "$max_mem_kbytes" -gt 0 ]; then
        ! instance_mem_kbytes=$(expr $max_mem_kbytes / $max_instance_count) && echo "Max memory limit calculation error." && exit 1
    fi

    local instance_swap_kbytes=0
    if [ "$max_swap_kbytes" != "" ] && [ ! ${#max_swap_kbytes} -eq 0 ] && [ "$max_swap_kbytes" -gt 0 ]; then
        ! instance_swap_kbytes=$(expr $instance_mem_kbytes + $max_swap_kbytes / $max_instance_count) && echo "Max swap memory limit calculation error." && exit 1
    fi

    local instance_cpu_quota=0
    # In the Sashimono configuration, CPU time is 1000000us Sashimono is given max_cpu_us out of it.
    # Instance allocation is multiplied by number of cores to determined the number of cores per instance and devided by 10 since cfs_period_us is set to 100000us

    local CPU_PERIOD="1000000" # in microseconds
    if [ "$max_cpu_us" != "" ] && [ ! ${#max_cpu_us} -eq 0 ] && [ "$max_cpu_us" -gt 0 ]; then
        cores=$(grep -c ^processor /proc/cpuinfo)
        ! instance_cpu_quota=$(expr $(expr $cores \* $max_cpu_us \* 100) / $(expr $max_instance_count \* $CPU_PERIOD)) && echo "Max cpu limit calculation error." && exit 1
    fi

    echo "[Slice]
CPUQuota=${instance_cpu_quota}% 
MemoryMax=${instance_mem_kbytes}K
MemorySwapMax=${instance_swap_kbytes}K" | sudo tee /etc/systemd/system/user-$user_id.slice.d/override.conf

    sudo systemctl daemon-reload
    sudo systemctl restart user-$user_id.slice
}

# Allow unpriviledged user namespaces (By Default restricted in Ubuntu 24.04)
sudo sysctl -w kernel.apparmor_restrict_unprivileged_unconfined=0
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

# Monitor processes and assign them to appropriate cgroups
# Get usernames matching the pattern
users=$(cut -d: -f1 /etc/passwd | grep "^sashi" | sort)
readarray -t userarr <<<"$users"

has_err=0
for user in "${userarr[@]}"; do
    [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^sashi[0-9]+$ ]] && continue
    ! apply_limits "$user" && has_err=1
done

[ $has_err -eq 1 ] && exit 1
exit 0
