#!/bin/bash
# Sashimono contract instance user installation script.
# This is intended to be called by Sashimono agent.

# Check for user cpu and memory quotas.
cpu=$1
memory=$2
disk=$3
if [ -z "$cpu" ] || [ -z "$memory" ] || [ -z "$disk" ]; then
    echo "Expected: user-install <cpu quota microseconds> <memory quota kbytes> <disk quota kbytes>"
    echo "INVALID_PARAMS,INST_ERR" && exit 1
fi

prefix="sashi"
suffix=$(date +%s%N) # Epoch nanoseconds
user="$prefix$suffix"
group="sashimono"
user_dir=/home/$user
docker_bin=/usr/bin/sashimono-agent/dockerbin

# Check if users already exists.
[ $(id -u $user 2>/dev/null || echo -1) -ge 0 ] && echo "HAS_USER,INST_ERR" && exit 1

# Check cgroup rule config and mounts exists.
([ ! -d /sys/fs/cgroup/cpu ] || [ ! -d /sys/fs/cgroup/memory ]) && echo "Cgroup is not configured. Make sure you've confgured cgroup and installed cgroup-tools." && exit 1

function rollback() {
    echo "Rolling back user installation. $1"
    $(pwd)/user-uninstall.sh $user
    echo "Rolled back the installation."
    echo "$1,INST_ERR" && exit 1
}

# Setup user and dockerd service.
useradd --shell /usr/sbin/nologin -m $user
usermod --lock $user
usermod -a -G $group $user
loginctl enable-linger $user # Enable lingering to support rootless dockerd service installation.
chmod o-rwx $user_dir
echo "Created '$user' user."

user_id=$(id -u $user)
user_runtime_dir="/run/user/$user_id"
dockerd_socket="unix://$user_runtime_dir/docker.sock"

# Setup user cgroup.
! (cgcreate -g cpu:$user$group &&
    echo "$cpu" > /sys/fs/cgroup/cpu/$user$group/cpu.cfs_quota_us) && echo rollback "CGROUP_CPU_CREAT"
! (cgcreate -g memory:$user$group &&
    echo "${memory}K" > /sys/fs/cgroup/memory/$user$group/memory.limit_in_bytes &&
    echo "${memory}K" > /sys/fs/cgroup/memory/$user$group/memory.memsw.limit_in_bytes) && echo rollback "CGROUP_MEM_CREAT"

# Adding disk quota to the new user.
sudo setquota -u -F vfsv0 "$user" "$disk" "$disk" 0 0 /

echo "Configured the resources"

# Setup env variables for the user.
echo "
export XDG_RUNTIME_DIR=$user_runtime_dir
export PATH=$docker_bin:\$PATH
export DOCKER_HOST=$dockerd_socket" >>$user_dir/.bashrc
echo "Updated user .bashrc."

# Wait until user systemd is functioning.
user_systemd=""
for ((i = 0; i < 30; i++)); do
    sleep 0.1
    user_systemd=$(sudo -u $user XDG_RUNTIME_DIR=$user_runtime_dir systemctl --user is-system-running 2>/dev/null)
    [ "$user_systemd" == "running" ] && break
done
[ "$user_systemd" != "running" ] && rollback "NO_SYSTEMD"

echo "Installing rootless dockerd for user."
sudo -H -u $user PATH=$docker_bin:$PATH XDG_RUNTIME_DIR=$user_runtime_dir $docker_bin/dockerd-rootless-setuptool.sh install

svcstat=$(sudo -u $user XDG_RUNTIME_DIR=$user_runtime_dir systemctl --user is-active docker.service)
[ "$svcstat" != "active" ] && rollback "NO_DOCKERSVC"

echo "Installed rootless dockerd."
echo "$user_id,$user,$dockerd_socket,INST_SUC"
exit 0
