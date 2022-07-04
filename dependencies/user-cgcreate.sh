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

# Calculate resources

# Read config values
max_mem_kbytes=$(jq '.system.max_mem_kbytes' $saconfig)
max_swap_kbytes=$(jq '.system.max_swap_kbytes' $saconfig)
max_cpu_us=$(jq '.system.max_cpu_us' $saconfig)
max_instance_count=$(jq '.system.max_instance_count' $saconfig)

([ "$max_instance_count" == "" ] || [ ${#max_instance_count} -eq 0 ] || [ "$max_instance_count" -le 0 ]) && echo "max_instance_count cannot be empty." && exit 1

instance_mem_kbytes=0
if [ "$max_mem_kbytes" != "" ] && [ ! ${#max_mem_kbytes} -eq 0 ] && [ "$max_mem_kbytes" -gt 0 ]; then
    ! instance_mem_kbytes=$(expr $max_mem_kbytes / $max_instance_count) && echo "Max memory limit calculation error." && exit 1
fi

instance_swap_kbytes=0
if [ "$max_swap_kbytes" != "" ] && [ ! ${#max_swap_kbytes} -eq 0 ] && [ "$max_swap_kbytes" -gt 0 ]; then
    ! instance_swap_kbytes=$(expr $instance_mem_kbytes + $max_swap_kbytes / $max_instance_count) && echo "Max swap memory limit calculation error." && exit 1
fi

instance_cpu_quota=0
# In the Sashimono configuration, CPU time is 1000000us Sashimono is given max_cpu_us out of it.
# Instance allocation is multiplied by number of cores to determined the number of cores per instance and devided by 10 since cfs_period_us is set to 100000us
if [ "$max_cpu_us" != "" ] && [ ! ${#max_cpu_us} -eq 0 ] && [ "$max_cpu_us" -gt 0 ]; then
    cores=$(grep -c ^processor /proc/cpuinfo)
    ! instance_cpu_quota=$(expr $(expr $cores \* $max_cpu_us) / $(expr $max_instance_count \* 10)) && echo "Max cpu limit calculation error." && exit 1
fi

prefix="sashi"
cgroupsuffix="-cg"
users=$(cut -d: -f1 /etc/passwd | grep "^$prefix" | sort)
readarray -t userarr <<<"$users"
validusers=()
for user in "${userarr[@]}"; do
    [ ${#user} -lt 24 ] || [ ${#user} -gt 32 ] || [[ ! "$user" =~ ^$prefix[0-9]+$ ]] && continue
    validusers+=("$user")
done

has_err=0
for user in "${validusers[@]}"; do
    # Setup user cgroup.
    if [ $instance_cpu_quota -gt 0 ] &&
        ! (cgcreate -g cpu:$user$cgroupsuffix &&
            echo "100000" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_period_us &&
            echo "$instance_cpu_quota" >/sys/fs/cgroup/cpu/$user$cgroupsuffix/cpu.cfs_quota_us); then
        echo "CPU cgroup creation for $user failed."
        has_err=1
    fi

    if [ $instance_mem_kbytes -gt 0 ] &&
        ! (cgcreate -g memory:$user$cgroupsuffix &&
            echo "${instance_mem_kbytes}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.limit_in_bytes &&
            echo "${instance_swap_kbytes}K" >/sys/fs/cgroup/memory/$user$cgroupsuffix/memory.memsw.limit_in_bytes); then
        echo "Memory cgroup creation for $user failed."
        has_err=1
    fi
done

[ $has_err -eq 1 ] && exit 1
exit 0
